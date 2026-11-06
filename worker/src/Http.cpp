#include "Http.h"
#include "Sha256.h"

#include <curl/curl.h>

#include <cstdio>
#include <memory>
#include <stdexcept>

namespace {
struct Global {
    Global() { curl_global_init(CURL_GLOBAL_DEFAULT); }
    ~Global() { curl_global_cleanup(); }
} global;

using Easy = std::unique_ptr<CURL, decltype(&curl_easy_cleanup)>;
using List = std::unique_ptr<curl_slist, decltype(&curl_slist_free_all)>;

size_t toString(char* p, size_t size, size_t n, void* out) {
    static_cast<std::string*>(out)->append(p, size * n);
    return size * n;
}

struct Sink {
    std::FILE* f;
    Sha256 hash;
};
size_t toFile(char* p, size_t size, size_t n, void* out) {
    auto* s = static_cast<Sink*>(out);
    s->hash.update(p, size * n);
    return std::fwrite(p, size, n, s->f) * size;
}

void check(CURLcode c, const std::string& what) {
    if (c != CURLE_OK) throw std::runtime_error(what + ": " + curl_easy_strerror(c));
}
} // namespace

Http::Http(std::string base, std::string token) : base_(std::move(base)), token_(std::move(token)) {}

HttpResponse Http::post(const std::string& path, const std::string& json, long timeoutSeconds) const {
    Easy e(curl_easy_init(), curl_easy_cleanup);
    HttpResponse r;
    const std::string url = base_ + path, auth = "Authorization: Bearer " + token_;
    List headers(curl_slist_append(curl_slist_append(nullptr, "Content-Type: application/json"), auth.c_str()), curl_slist_free_all);
    curl_easy_setopt(e.get(), CURLOPT_URL, url.c_str());
    curl_easy_setopt(e.get(), CURLOPT_HTTPHEADER, headers.get());
    curl_easy_setopt(e.get(), CURLOPT_POSTFIELDS, json.c_str());
    curl_easy_setopt(e.get(), CURLOPT_POSTFIELDSIZE, static_cast<long>(json.size()));
    curl_easy_setopt(e.get(), CURLOPT_WRITEFUNCTION, toString);
    curl_easy_setopt(e.get(), CURLOPT_WRITEDATA, &r.body);
    curl_easy_setopt(e.get(), CURLOPT_TIMEOUT, timeoutSeconds);
    curl_easy_setopt(e.get(), CURLOPT_NOSIGNAL, 1L);
    check(curl_easy_perform(e.get()), "POST " + path);
    curl_easy_getinfo(e.get(), CURLINFO_RESPONSE_CODE, &r.status);
    return r;
}

std::string Http::download(const std::string& url, const std::string& file) const {
    Easy e(curl_easy_init(), curl_easy_cleanup);
    Sink sink{std::fopen(file.c_str(), "wb"), {}};
    if (!sink.f) throw std::runtime_error("cannot write " + file);
    curl_easy_setopt(e.get(), CURLOPT_URL, url.c_str());
    curl_easy_setopt(e.get(), CURLOPT_WRITEFUNCTION, toFile);
    curl_easy_setopt(e.get(), CURLOPT_WRITEDATA, &sink);
    curl_easy_setopt(e.get(), CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(e.get(), CURLOPT_FAILONERROR, 1L);
    curl_easy_setopt(e.get(), CURLOPT_NOSIGNAL, 1L);
    const CURLcode c = curl_easy_perform(e.get());
    std::fclose(sink.f);
    if (c != CURLE_OK) {
        std::remove(file.c_str());
        check(c, "download");
    }
    return sink.hash.hex();
}

HttpResponse Http::upload(const std::string& url, const std::string& file, const std::string& contentType) const {
    Easy e(curl_easy_init(), curl_easy_cleanup);
    std::FILE* f = std::fopen(file.c_str(), "rb");
    if (!f) throw std::runtime_error("cannot read " + file);
    std::fseek(f, 0, SEEK_END);
    const long size = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    HttpResponse r;
    const std::string type = "Content-Type: " + contentType;
    List headers(curl_slist_append(nullptr, type.c_str()), curl_slist_free_all);
    curl_easy_setopt(e.get(), CURLOPT_URL, url.c_str());
    curl_easy_setopt(e.get(), CURLOPT_UPLOAD, 1L);
    curl_easy_setopt(e.get(), CURLOPT_READDATA, f);
    curl_easy_setopt(e.get(), CURLOPT_INFILESIZE_LARGE, static_cast<curl_off_t>(size));
    curl_easy_setopt(e.get(), CURLOPT_HTTPHEADER, headers.get());
    curl_easy_setopt(e.get(), CURLOPT_WRITEFUNCTION, toString);
    curl_easy_setopt(e.get(), CURLOPT_WRITEDATA, &r.body);
    curl_easy_setopt(e.get(), CURLOPT_NOSIGNAL, 1L);
    const CURLcode c = curl_easy_perform(e.get());
    std::fclose(f);
    check(c, "upload");
    curl_easy_getinfo(e.get(), CURLINFO_RESPONSE_CODE, &r.status);
    return r;
}
