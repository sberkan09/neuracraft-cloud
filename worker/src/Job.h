#ifndef NC_WORKER_JOB_H
#define NC_WORKER_JOB_H

#include "Http.h"
#include "Json.h"

#include <string>

struct WorkerSettings {
    std::string workerId;
    std::string cacheDir;            // downloaded files by hash, kept across jobs
    std::string workDir;             // one folder per running job
    unsigned long long cacheMaxBytes = 20ull << 30;
    double heartbeatSeconds = 3;
};

// Runs one claimed job (the API's ClaimedJob) to the end: fetches its files, maps "asset:<id>" names
// to them, runs the workflow inside the job's limits, uploads what it saved, and reports success or
// failure. Never throws. A warm-up job (POST /v1/worker/warmup) only runs: no heartbeats, uploads or
// reports, the outputs thrown away; what stays is the loaded models and the cached files.
void runJob(const Http& api, const WorkerSettings& settings, const nc::json::Value& job, bool warmup = false);

// Maps an engine error to an API error code (workflow.invalid, limit.pixels, model.unsupported, ...).
std::string errorCode(const std::exception& e);

#endif
