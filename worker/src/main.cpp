// neuracraft-worker: claims jobs from the NeuraCraft Cloud API and runs them with the engine.
//
//   API_URL=http://localhost:8080 WORKER_TOKEN=... neuracraft-worker
//
// Environment: API_URL, WORKER_TOKEN (required); WORKER_CLASS (cpu, or gpu: runs on the GPU and
// fails to start without one), CACHE_DIR (.data/cache), WORK_DIR (.data/jobs), CACHE_MAX_GB (20),
// KEEP_MODELS (2: models kept loaded between jobs), ONCE=1 (at most one job, then exit: tests).
#include "Http.h"
#include "Job.h"

#include "Backend.h"
#include "ImageTo3D.h"
#include "Json.h"
#include "ModelCache.h"

#include <algorithm>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <thread>
#include <unistd.h>
#include <vector>

namespace {
volatile std::sig_atomic_t stopping = 0;
std::string env(const char* k, const std::string& d = "") {
    const char* v = std::getenv(k);
    return v && *v ? v : d;
}
} // namespace

int main() {
    const std::string url = env("API_URL"), token = env("WORKER_TOKEN");
    if (url.empty() || token.empty()) {
        std::cerr << "neuracraft-worker: set API_URL and WORKER_TOKEN\n";
        return 2;
    }
    std::signal(SIGTERM, [](int) { stopping = 1; });
    std::signal(SIGINT, [](int) { stopping = 1; });
    const Http api(url, token);
    WorkerSettings s;
    s.cacheDir = std::filesystem::absolute(env("CACHE_DIR", ".data/cache")).string();
    s.workDir = std::filesystem::absolute(env("WORK_DIR", ".data/jobs")).string();
    s.cacheMaxBytes = static_cast<unsigned long long>(std::stod(env("CACHE_MAX_GB", "20")) * (1ull << 30));
    std::filesystem::create_directories(s.cacheDir);
    std::filesystem::create_directories(s.workDir);
    const bool once = env("ONCE") == "1";
    const std::string workerClass = env("WORKER_CLASS", "cpu");
    if (workerClass == "gpu" && !nc::setDevice(nc::Device::GPU)) {
        std::cerr << "neuracraft-worker: WORKER_CLASS=gpu, but no GPU is available (" << nc::gpuBackendName() << ")\n";
        return 2;
    }
    // Models (and their GPU copies) stay loaded from job to job; the most recent few survive.
    const nc::ModelCacheScope modelCache;
    nc::setModelCacheKeep(static_cast<std::size_t>(std::stoul(env("KEEP_MODELS", "2"))));
    const nc::GpuWeightScope gpuWeights;

    using nc::json::makeNumber;
    using nc::json::makeString;
    const long cores = sysconf(_SC_NPROCESSORS_ONLN);
    const double memory = static_cast<double>(sysconf(_SC_PHYS_PAGES)) * static_cast<double>(sysconf(_SC_PAGE_SIZE));
    nc::json::Value capsValue = nc::json::makeObject({{"class", makeString(workerClass)},
                                                      {"cores", makeNumber(static_cast<double>(cores))},
                                                      {"memoryBytes", makeNumber(memory)},
                                                      {"engineVersion", makeString(NEURACRAFT_WORKER_ENGINE)}});
    if (nc::currentDevice() == nc::Device::GPU) capsValue.object.push_back({"gpu", makeString(nc::gpuName())});
    // A 3D service next to a GPU worker (NEURACRAFT_3D_URL, services/trellis2 in the engine): it may take
    // image_to_3d jobs. Waits for the service's model to load before saying so.
    if (workerClass == "gpu" && !nc::imageTo3DService().empty()) {
        for (int i = 0; !stopping && !nc::imageTo3DAvailable(); ++i) {
            if (i % 12 == 0) std::cerr << "neuracraft-worker: waiting for the 3D service at " << nc::imageTo3DService() << "\n";
            std::this_thread::sleep_for(std::chrono::seconds(5));
        }
        capsValue.object.push_back({"features", nc::json::makeArray({makeString("3d")})});
    }
    const std::string caps = nc::json::dump(capsValue);
    std::vector<std::string> recentModels;  // model asset ids of the last jobs (likely still loaded)
    while (!stopping && s.workerId.empty()) {
        try {
            const HttpResponse r = api.post("/v1/worker/register", caps);
            if (r.status == 200) s.workerId = nc::json::parse(r.body).at("workerId").string;
            else std::cerr << "neuracraft-worker: register: " << r.status << " " << r.body << "\n";
        } catch (const std::exception& e) {
            std::cerr << "neuracraft-worker: register: " << e.what() << "\n";
        }
        if (s.workerId.empty()) std::this_thread::sleep_for(std::chrono::seconds(3));
    }
    std::cerr << "neuracraft-worker: registered as " << s.workerId << " (" << cores << " cores)\n";
    while (!stopping) {
        try {
            nc::json::Value loaded = nc::json::makeArray();
            for (const std::string& m : recentModels) loaded.array.push_back(makeString(m));
            const std::string body = nc::json::dump(nc::json::makeObject(
                {{"workerId", makeString(s.workerId)}, {"loadedModels", loaded}, {"waitSeconds", makeNumber(once ? 5 : 20)}}));
            const HttpResponse r = api.post("/v1/worker/claim", body, 40);
            if (r.status != 200) {
                std::cerr << "neuracraft-worker: claim: " << r.status << " " << r.body << "\n";
                std::this_thread::sleep_for(std::chrono::seconds(3));
                continue;
            }
            const nc::json::Value v = nc::json::parse(r.body);
            const nc::json::Value* job = v.find("job");
            if (!job || !job->isObject()) {
                if (once) return 1;
                continue;
            }
            runJob(api, s, *job);
            if (const nc::json::Value* files = job->find("files"))
                for (const nc::json::Value& f : files->array)
                    if (const nc::json::Value* kind = f.find("kind"); kind && kind->string == "model" && f.find("assetId")) {
                        const std::string id = f.at("assetId").string;
                        recentModels.erase(std::remove(recentModels.begin(), recentModels.end(), id), recentModels.end());
                        recentModels.push_back(id);
                    }
            while (recentModels.size() > std::max<std::size_t>(1, nc::modelCacheKeep()) * 2) recentModels.erase(recentModels.begin());
            if (once) return 0;
        } catch (const std::exception& e) {
            std::cerr << "neuracraft-worker: " << e.what() << "\n";
            std::this_thread::sleep_for(std::chrono::seconds(3));
        }
    }
    return 0;
}
