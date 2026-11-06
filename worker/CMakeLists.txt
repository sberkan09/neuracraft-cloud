cmake_minimum_required(VERSION 3.24)
project(neuracraft_worker LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

# The engine, at the version this service is tested with. NEURACRAFT_DIR=<checkout> builds a local
# copy instead (engine development).
set(NEURACRAFT_COMMIT b317b6c530c73727eb3e23a60ec8d95a2681aca8 CACHE STRING "NeuraCraft commit the worker builds")
set(NEURACRAFT_DIR "" CACHE PATH "Local NeuraCraft checkout (instead of NEURACRAFT_COMMIT)")
set(NEURACRAFT_BUILD_TESTS OFF CACHE BOOL "" FORCE)
include(FetchContent)
if(NEURACRAFT_DIR)
    add_subdirectory(${NEURACRAFT_DIR} neuracraft EXCLUDE_FROM_ALL)
else()
    FetchContent_Declare(neuracraft GIT_REPOSITORY https://github.com/sberkan09/NeuraCraft.git GIT_TAG ${NEURACRAFT_COMMIT})
    FetchContent_GetProperties(neuracraft)
    if(NOT neuracraft_POPULATED)
        FetchContent_Populate(neuracraft)
        add_subdirectory(${neuracraft_SOURCE_DIR} ${neuracraft_BINARY_DIR} EXCLUDE_FROM_ALL)
    endif()
endif()

find_package(CURL REQUIRED)
find_package(Threads REQUIRED)

add_executable(neuracraft-worker src/main.cpp src/Http.cpp src/Sha256.cpp src/Job.cpp)
target_link_libraries(neuracraft-worker PRIVATE neuracraft_lib CURL::libcurl Threads::Threads)
target_compile_options(neuracraft-worker PRIVATE -Wall -Wextra)
target_compile_definitions(neuracraft-worker PRIVATE NEURACRAFT_WORKER_ENGINE="${NEURACRAFT_COMMIT}")
