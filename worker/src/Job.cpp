#include "Job.h"
#include "Sha256.h"

#include "Image.h"
#include "Workflow.h"

#include <atomic>
#include <chrono>
#include <algorithm>
#include <cctype>
#include <condition_variable>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <map>
#include <mutex>
#include <random>
#include <regex>
#include <system_error>
#include <thread>

#include <cerrno>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

namespace fs = std::filesystem;
using nc::json::Value;

namespace {

std::string safeName(const std::string& name) {
    std::string out;
    for (char c : name) out += (std::isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '-' || c == '_') ? c : '_';
    if (out.empty() || out[0] == '.') out = "file" + out;
    return out.substr(0, 120);
}

// A relative path inside a bundle: no root, no "..".
bool safeRelative(const std::string& p) {
    const fs::path path(p);
    if (p.empty() || path.is_absolute() || path.has_root_name()) return false;
    for (const auto& part : path)
        if (part == ".." || part == ".") return false;
    return true;
}

// Several workers may share one cache folder (docker compose replicas on one volume):
//   blobs/<sha256>             shared; written once (a private .part file, then link(): never replaced)
//   assets/<worker id>/<id>/   each worker's links to the blobs, so a model keeps its path from job to
//                              job and no other worker relinks it under a running job
// A job holds a shared flock on every blob it uses; trimCache removes only blobs it can lock
// exclusively, so nobody's file disappears under a running job.
constexpr auto kStaleDownload = std::chrono::hours(1);   // a .part file this old: its worker died
constexpr auto kStaleWorker = std::chrono::hours(24);    // links and job folders of a worker gone this long

bool sameFile(int fd, const fs::path& p) {
    struct stat a {}, b {};
    return ::fstat(fd, &a) == 0 && ::stat(p.c_str(), &b) == 0 && a.st_ino == b.st_ino && a.st_dev == b.st_dev;
}

// Shared locks on the blobs a job uses, released when the job is done.
class BlobLocks {
public:
    BlobLocks() = default;
    BlobLocks(const BlobLocks&) = delete;
    BlobLocks& operator=(const BlobLocks&) = delete;
    ~BlobLocks() { release(); }
    void release() {
        for (int fd : fds_) ::close(fd);
        fds_.clear();
    }
    // Locks the blob at p; false when it is not there (or was removed while we waited for the lock).
    bool hold(const fs::path& p) {
        const int fd = ::open(p.c_str(), O_RDONLY | O_CLOEXEC);
        if (fd < 0) return false;
        if (::flock(fd, LOCK_SH) != 0 || !sameFile(fd, p)) {
            ::close(fd);
            return false;
        }
        fds_.push_back(fd);
        return true;
    }

private:
    std::vector<int> fds_;
};

std::string randomSuffix() {
    static std::mt19937_64 rng{std::random_device{}()};
    static std::mutex m;
    std::lock_guard<std::mutex> lock(m);
    char buf[17];
    std::snprintf(buf, sizeof buf, "%016llx", static_cast<unsigned long long>(rng()));
    return buf;
}

// The cached copy of a blob, downloaded (and checked) when missing, locked for the job.
std::string cachedBlob(const Http& api, const WorkerSettings& s, BlobLocks& locks, const std::string& sha256, const std::string& url) {
    if (!std::regex_match(sha256, std::regex("[0-9a-f]{64}"))) throw std::runtime_error("bad file hash from the API");
    const fs::path blob = fs::path(s.cacheDir) / "blobs" / sha256;
    for (int attempt = 0; attempt < 3; ++attempt) {
        if (locks.hold(blob)) {
            std::error_code ec;
            fs::last_write_time(blob, fs::file_time_type::clock::now(), ec);  // recently used
            return blob.string();
        }
        fs::create_directories(blob.parent_path());
        // Private to this download: other workers may be fetching the same blob right now (and in
        // containers every worker is pid 1, so the pid alone would not do).
        const std::string part = blob.string() + ".part." + safeName(s.workerId) + "." + randomSuffix();
        std::string got;
        try {
            got = api.download(url, part);
        } catch (...) {
            std::error_code ec;
            fs::remove(part, ec);
            throw;
        }
        if (got != sha256) {
            std::error_code ec;
            fs::remove(part, ec);
            throw std::runtime_error("download of " + sha256 + " arrived corrupted");
        }
        // link() never replaces: if another worker got there first, theirs stays (it may be locked).
        const int linked = ::link(part.c_str(), blob.c_str()) == 0 ? 0 : errno;
        std::error_code ec;
        fs::remove(part, ec);
        if (linked != 0 && linked != EEXIST) throw std::system_error(linked, std::generic_category(), "caching " + sha256);
    }
    throw std::runtime_error("cached copy of " + sha256 + " kept disappearing");
}

// Drops the least recently used blobs no job is using while the cache is over its size, downloads
// left behind by a worker that died, and the links and job folders of workers long gone (a worker
// registers with a new id each time it starts).
void trimCache(const WorkerSettings& s) {
    const auto now = fs::file_time_type::clock::now();
    std::vector<std::pair<fs::file_time_type, fs::path>> files;
    unsigned long long total = 0;
    std::error_code ec;
    for (const auto& e : fs::directory_iterator(fs::path(s.cacheDir) / "blobs", ec)) {
        std::error_code fe;
        if (!e.is_regular_file(fe)) continue;
        const auto when = e.last_write_time(fe);
        if (fe) continue;
        if (e.path().filename().string().find(".part.") != std::string::npos) {
            if (now - when > kStaleDownload) fs::remove(e.path(), fe);
            continue;
        }
        total += e.file_size(fe);
        files.push_back({when, e.path()});
    }
    std::sort(files.begin(), files.end());
    for (const auto& [t, p] : files) {
        if (total <= s.cacheMaxBytes) break;
        const int fd = ::open(p.c_str(), O_RDONLY | O_CLOEXEC);
        if (fd < 0) continue;  // another worker trimmed it
        struct stat st {};
        // In use (a shared lock held by some job) or replaced: leave it.
        if (::flock(fd, LOCK_EX | LOCK_NB) == 0 && ::fstat(fd, &st) == 0 && sameFile(fd, p) && ::unlink(p.c_str()) == 0)
            total -= std::min<unsigned long long>(total, static_cast<unsigned long long>(st.st_size));
        ::close(fd);
    }
    for (const fs::path& root : {fs::path(s.cacheDir) / "assets", fs::path(s.workDir)})
        for (const auto& e : fs::directory_iterator(root, ec)) {
            std::error_code fe;
            if (e.path().filename() == safeName(s.workerId) || !e.is_directory(fe)) continue;
            const auto when = e.last_write_time(fe);
            if (!fe && now - when > kStaleWorker) fs::remove_all(e.path(), fe);
        }
}

// This worker's own folder under root (created, and marked as in use).
fs::path ownFolder(const fs::path& root, const WorkerSettings& s) {
    const fs::path p = root / safeName(s.workerId);
    fs::create_directories(p);
    std::error_code ec;
    fs::last_write_time(p, fs::file_time_type::clock::now(), ec);
    return p;
}

std::string contentType(const std::string& name) {
    auto ends = [&](const char* e) { return name.size() >= std::strlen(e) && name.compare(name.size() - std::strlen(e), std::strlen(e), e) == 0; };
    if (ends(".png")) return "image/png";
    if (ends(".jpg") || ends(".jpeg")) return "image/jpeg";
    if (ends(".gif")) return "image/gif";
    if (ends(".mov")) return "video/quicktime";
    return "application/octet-stream";
}

std::string str(const Value& v, const char* key) {
    const Value* x = v.find(key);
    return x && x->isString() ? x->string : std::string();
}

void report(const Http& api, const std::string& path, const Value& body) {
    for (int attempt = 0; attempt < 5; ++attempt) {
        try {
            const HttpResponse r = api.post(path, nc::json::dump(body));
            if (r.status < 500) {
                if (r.status >= 400) std::cerr << "worker: " << path << " -> " << r.status << " " << r.body << "\n";
                return;
            }
        } catch (const std::exception& e) {
            std::cerr << "worker: " << path << ": " << e.what() << "\n";
        }
        std::this_thread::sleep_for(std::chrono::seconds(1 << attempt));
    }
}

} // namespace

std::string errorCode(const std::exception& e) {
    const std::string m = e.what();
    if (dynamic_cast<const nc::WorkflowCancelled*>(&e)) return "cancelled";
    if (dynamic_cast<const nc::WorkflowLimitExceeded*>(&e)) {
        if (m.find("ran longer") != std::string::npos) return "limit.time";
        if (m.find("pixel") != std::string::npos || m.find(" x ") != std::string::npos) return "limit.pixels";
        if (m.find("frame") != std::string::npos) return "limit.frames";
        if (m.find("denoising") != std::string::npos) return "limit.denoise_steps";
        if (m.find("steps,") != std::string::npos) return "limit.steps";
        return "workflow.path_not_allowed";
    }
    if (m.find("is not supported") != std::string::npos || m.find("unsupported") != std::string::npos) return "model.unsupported";
    if (m.find("too big to decode") != std::string::npos) return "limit.pixels";
    if (dynamic_cast<const std::invalid_argument*>(&e)) return "workflow.invalid";
    return "job.failed";
}

void runJob(const Http& api, const WorkerSettings& s, const Value& job) {
    const std::string jobId = str(job, "jobId");
    // Under the worker's own folder: a job whose lease ran out may be running on another worker too.
    const fs::path dir = ownFolder(s.workDir, s) / safeName(jobId);
    BlobLocks locks;  // held until the job is over
    std::vector<fs::path> transient;  // links of the job's pictures (only models keep theirs)
    const auto started = std::chrono::steady_clock::now();
    auto seconds = [&] { return std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count(); };

    // Heartbeats keep the lease and carry progress; their answer may ask to cancel.
    std::atomic<bool> cancel{false}, done{false};
    std::mutex mutex;
    std::condition_variable wake;
    Value progress;
    bool fresh = false;
    std::thread beat([&] {
        std::unique_lock<std::mutex> lock(mutex);
        while (!done) {
            wake.wait_for(lock, std::chrono::duration<double>(s.heartbeatSeconds));
            if (done) break;
            Value body = nc::json::makeObject({{"workerId", nc::json::makeString(s.workerId)}});
            if (fresh) body.object.push_back({"progress", progress});
            fresh = false;
            lock.unlock();
            try {
                const HttpResponse r = api.post("/v1/worker/jobs/" + jobId + "/heartbeat", nc::json::dump(body), 15);
                if (r.status == 409) cancel = true;  // the lease is gone: stop working on it
                else if (r.status == 200) {
                    const Value v = nc::json::parse(r.body);
                    if (const Value* c = v.find("cancel"); c && c->boolean) cancel = true;
                }
            } catch (const std::exception& e) {
                std::cerr << "worker: heartbeat: " << e.what() << "\n";
            }
            lock.lock();
        }
    });
    auto finish = [&] {
        {
            std::lock_guard<std::mutex> lock(mutex);
            done = true;
        }
        wake.notify_all();
        beat.join();
        std::error_code ec;
        fs::remove_all(dir, ec);
        for (const fs::path& p : transient) fs::remove_all(p, ec);
    };

    try {
        fs::remove_all(dir);
        fs::create_directories(dir / "out");
        // The job's files, linked under readable names from the cache. The links live in the cache
        // too (assets/<worker id>/<id>/...), so a model keeps its path from job to job and the
        // engine's model cache finds it still loaded.
        std::map<std::string, std::string> local;  // asset id -> path the workflow gets
        const fs::path assets = ownFolder(fs::path(s.cacheDir) / "assets", s);
        if (const Value* files = job.find("files"))
            for (const Value& f : files->array) {
                const std::string id = safeName(str(f, "assetId"));
                const fs::path home = assets / id;
                std::error_code ec;
                fs::remove_all(home, ec);  // relinked each time: the blobs may have been trimmed (jobs of one worker run one at a time)
                fs::create_directories(home);
                if (str(f, "kind") != "model") transient.push_back(home);
                if (const Value* parts = f.find("files"); parts && !parts->array.empty()) {
                    for (const Value& p : parts->array) {
                        const std::string rel = str(p, "path");
                        if (!safeRelative(rel)) throw std::runtime_error("bad path in a model folder");
                        const fs::path target = home / rel;
                        fs::create_directories(target.parent_path());
                        fs::create_symlink(cachedBlob(api, s, locks, str(p, "sha256"), str(p, "url")), target);
                    }
                    const std::string entry = str(f, "entry");
                    if (!entry.empty() && !safeRelative(entry)) throw std::runtime_error("bad bundle entry");
                    local[str(f, "assetId")] = entry.empty() ? home.string() : (home / entry).string();
                } else {
                    const fs::path target = home / safeName(str(f, "name"));
                    fs::create_symlink(cachedBlob(api, s, locks, str(f, "sha256"), str(f, "url")), target);
                    local[str(f, "assetId")] = target.string();
                }
            }

        const nc::WorkflowOp* saveOp = nc::findWorkflowOp("save");
        const nc::WorkflowField* savePath = nullptr;
        for (const auto& fd : saveOp->fields)
            if (fd.name == "path") savePath = &fd;
        const std::regex outputName("[A-Za-z0-9][A-Za-z0-9._-]{0,63}\\.(png|jpe?g|gif|mov)");
        const std::string text = nc::mapWorkflowFiles(nc::json::dump(job.at("workflow")), [&](const nc::WorkflowField& field, const std::string& v) {
            if (&field == savePath) {
                if (!std::regex_match(v, outputName)) throw std::invalid_argument("save: bad output name " + v);
                return (dir / "out" / v).string();
            }
            if (v.rfind("asset:", 0) != 0 || !local.count(v.substr(6))) throw nc::WorkflowLimitExceeded("file " + v + " is not part of the job");
            return local.at(v.substr(6));
        });

        const Value& lim = job.at("limits");
        nc::WorkflowLimits limits;
        limits.readRoots = {s.cacheDir};
        limits.writeRoot = (dir / "out").string();
        limits.maxSteps = static_cast<std::size_t>(lim.numberOr("maxSteps", 0));
        limits.maxPixels = static_cast<std::size_t>(lim.numberOr("maxPixels", 0));
        limits.maxFrames = static_cast<std::size_t>(lim.numberOr("maxFrames", 0));
        limits.maxDenoiseSteps = static_cast<std::size_t>(lim.numberOr("maxDenoiseSteps", 0));
        limits.maxSeconds = lim.numberOr("maxSeconds", 0);

        nc::WorkflowEvents events;
        events.cancelled = [&] { return cancel.load(); };
        events.progress = [&](std::size_t step, std::size_t steps, const std::string& op, const std::string& stage, double fraction) {
            std::lock_guard<std::mutex> lock(mutex);
            progress = nc::json::makeObject({{"step", nc::json::makeNumber(static_cast<double>(step))},
                                             {"steps", nc::json::makeNumber(static_cast<double>(steps))},
                                             {"op", nc::json::makeString(op)},
                                             {"stage", nc::json::makeString(stage)},
                                             {"fraction", nc::json::makeNumber(fraction)}});
            fresh = true;
        };
        const auto clips = nc::runWorkflow(text, dir.string(), events, nullptr, limits);

        // Without a save step, the last clip made is the result.
        std::vector<fs::path> outputs;
        for (const auto& e : fs::directory_iterator(dir / "out"))
            if (e.is_regular_file()) outputs.push_back(e.path());
        if (outputs.empty()) {
            std::string last;
            for (const Value& st : job.at("workflow").at("steps").array) {
                const std::string op = str(st, "op");
                if (op == "save") continue;
                last = str(st, "out").empty() ? op : str(st, "out");
            }
            auto it = clips.find(last);
            if (it != clips.end() && !it->second.empty()) {
                const fs::path p = dir / "out" / (it->second.size() == 1 ? "result.png" : "result.gif");
                if (it->second.size() == 1) nc::savePng(p.string(), it->second.front());
                else nc::saveGif(p.string(), it->second, 8.0f);
                outputs.push_back(p);
            }
        }
        std::sort(outputs.begin(), outputs.end());

        Value list = nc::json::makeArray();
        for (const auto& p : outputs)
            list.array.push_back(nc::json::makeObject({{"name", nc::json::makeString(p.filename().string())},
                                                       {"bytes", nc::json::makeNumber(static_cast<double>(fs::file_size(p)))},
                                                       {"contentType", nc::json::makeString(contentType(p.filename().string()))}}));
        const HttpResponse up = api.post("/v1/worker/jobs/" + jobId + "/uploads",
                                         nc::json::dump(nc::json::makeObject({{"workerId", nc::json::makeString(s.workerId)}, {"outputs", list}})));
        if (up.status != 200) throw std::runtime_error("uploads refused: " + std::to_string(up.status) + " " + up.body);
        const Value grants = nc::json::parse(up.body);
        Value stored = nc::json::makeArray();
        for (std::size_t i = 0; i < outputs.size(); ++i) {
            const Value& g = grants.at("uploads").array.at(i);
            const std::string type = contentType(outputs[i].filename().string());
            const HttpResponse put = api.upload(str(g, "url"), outputs[i].string(), type);
            if (put.status != 200) throw std::runtime_error("upload failed: " + std::to_string(put.status));
            stored.array.push_back(nc::json::makeObject({{"name", nc::json::makeString(outputs[i].filename().string())},
                                                         {"key", nc::json::makeString(str(g, "key"))},
                                                         {"bytes", nc::json::makeNumber(static_cast<double>(fs::file_size(outputs[i])))},
                                                         {"sha256", nc::json::makeString(sha256File(outputs[i].string()))},
                                                         {"contentType", nc::json::makeString(type)}}));
        }
        const double used = seconds();
        finish();
        report(api, "/v1/worker/jobs/" + jobId + "/complete",
               nc::json::makeObject({{"workerId", nc::json::makeString(s.workerId)}, {"outputs", stored}, {"workerSeconds", nc::json::makeNumber(used)}}));
        std::cerr << "worker: job " << jobId << " done in " << used << " s, " << outputs.size() << " output(s)\n";
    } catch (const std::exception& e) {
        const double used = seconds();
        const std::string code = errorCode(e);
        finish();
        report(api, "/v1/worker/jobs/" + jobId + "/fail",
               nc::json::makeObject({{"workerId", nc::json::makeString(s.workerId)},
                                     {"code", nc::json::makeString(code)},
                                     {"detail", nc::json::makeString(std::string(e.what()).substr(0, 2000))},
                                     {"workerSeconds", nc::json::makeNumber(used)}}));
        std::cerr << "worker: job " << jobId << " failed (" << code << "): " << e.what() << "\n";
    }
    locks.release();
    trimCache(s);
}
