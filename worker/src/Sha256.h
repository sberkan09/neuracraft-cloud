#ifndef NC_WORKER_SHA256_H
#define NC_WORKER_SHA256_H

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>

// SHA-256 (FIPS 180-4), streaming: what the worker checks every download with.
class Sha256 {
public:
    Sha256();
    void update(const void* data, std::size_t size);
    std::string hex();  // finishes

private:
    void block(const std::uint8_t* p);
    std::array<std::uint32_t, 8> h_;
    std::uint8_t buf_[64];
    std::size_t used_ = 0;
    std::uint64_t total_ = 0;
};

std::string sha256File(const std::string& path);

#endif
