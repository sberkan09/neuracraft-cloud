#ifndef NC_WORKER_HTTP_H
#define NC_WORKER_HTTP_H

#include <string>
#include <vector>

// A small libcurl client: JSON calls to the API, downloads to files (hashed as they arrive) and
// uploads from files.
struct HttpResponse {
    long status = 0;
    std::string body;
};

class Http {
public:
    Http(std::string base, std::string token);
    // POST JSON to base + path with the worker token.
    HttpResponse post(const std::string& path, const std::string& json, long timeoutSeconds = 60) const;
    // GET url into file (a signed URL: no token); returns the SHA-256 of what arrived.
    std::string download(const std::string& url, const std::string& file) const;
    // PUT the file to url (a signed URL).
    HttpResponse upload(const std::string& url, const std::string& file, const std::string& contentType) const;

private:
    std::string base_, token_;
};

#endif
