// neuracraft-worker: claims jobs from the NeuraCraft Cloud API and runs them with the engine.
//
//   API_URL=http://localhost:8080 WORKER_TOKEN=... neuracraft-worker
//
// Environment: API_URL, WORKER_TOKEN (required); WORKER_CLASS (cpu), CACHE_DIR (.data/cache),
// WORK_DIR (.data/jobs), CACHE_MAX_GB (20), ONCE=1 (run at most one job, then exit: tests).
#include "Http.h"
#include "Job.h"

#include "Json.h"

#include <chrono>
#include <csignal>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <thread>
#include <unistd.h>

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

    using nc::json::makeNumber;
    using nc::json::makeString;
    const long cores = sysconf(_SC_NPROCESSORS_ONLN);
    const double memory = static_cast<double>(sysconf(_SC_PHYS_PAGES)) * static_cast<double>(sysconf(_SC_PAGE_SIZE));
    const std::string caps = nc::json::dump(nc::json::makeObject({{"class", makeString(env("WORKER_CLASS", "cpu"))},
                                                                  {"cores", makeNumber(static_cast<double>(cores))},
                                                                  {"memoryBytes", makeNumber(memory)},
                                                                  {"engineVersion", makeString(NEURACRAFT_WORKER_ENGINE)}}));
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
            const std::string body = nc::json::dump(nc::json::makeObject(
                {{"workerId", makeString(s.workerId)}, {"loadedModels", nc::json::makeArray()}, {"waitSeconds", makeNumber(once ? 5 : 20)}}));
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
            if (once) return 0;
        } catch (const std::exception& e) {
            std::cerr << "neuracraft-worker: " << e.what() << "\n";
            std::this_thread::sleep_for(std::chrono::seconds(3));
        }
    }
    return 0;
}
