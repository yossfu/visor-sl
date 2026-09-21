cmake_minimum_required(VERSION 3.22.1)
project(slcore LANGUAGES CXX)

add_library(slcore SHARED native_sl.cpp)

target_compile_features(slcore PRIVATE cxx_std_20)
target_compile_options(slcore PRIVATE -O2 -ffast-math)

target_link_libraries(slcore log)
