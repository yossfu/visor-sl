#include <jni.h>
#include <android/log.h>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#define TAG "VisorSLNative"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace {
class Reader {
public:
    Reader(const uint8_t* data, size_t size) : p(data), end(data + size) {}
    bool can(size_t n) const { return p + n <= end; }
    uint8_t u8() { if (!can(1)) throw "eof"; return *p++; }
    uint16_t u16() {
        if (!can(2)) throw "eof";
        uint16_t v = uint16_t(p[0]) | (uint16_t(p[1]) << 8); p += 2; return v;
    }
    uint32_t u32() {
        if (!can(4)) throw "eof";
        uint32_t v = uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
        p += 4; return v;
    }
    int32_t i32() { return static_cast<int32_t>(u32()); }
    float f32() {
        const uint32_t bits = u32();
        float v; std::memcpy(&v, &bits, sizeof(v)); return v;
    }
    std::string str64() {
        if (!can(64)) throw "eof";
        size_t n = 0; while (n < 64 && p[n] != 0) ++n;
        std::string s(reinterpret_cast<const char*>(p), n); p += 64; return s;
    }
private:
    const uint8_t* p;
    const uint8_t* end;
};

struct ParsedMesh {
    std::vector<float> positions;
    std::vector<float> normals;
    std::vector<float> uvs;
    std::vector<uint16_t> indices;
};

ParsedMesh parseLLM(const uint8_t* data, size_t size) {
    if (size < 26) throw "truncated header";
    Reader r(data + 24, size - 24);

    char header[25] = {};
    std::memcpy(header, data, 24);
    if (std::string(header).rfind("Linden Binary Mesh 1.0", 0) != 0) throw "invalid LLM header";

    const bool hasWeights = r.u8() != 0;
    const bool hasDetailTexCoords = r.u8() != 0;
    for (int i = 0; i < 3; ++i) (void)r.f32(); // position
    for (int i = 0; i < 3; ++i) (void)r.f32(); // rotation
    (void)r.u8(); // rotation order
    for (int i = 0; i < 3; ++i) (void)r.f32(); // scale

    const uint16_t numVertices = r.u16();
    if (numVertices == 0) throw "invalid vertex count";

    ParsedMesh out;
    out.positions.resize(size_t(numVertices) * 3);
    out.normals.resize(size_t(numVertices) * 3);
    out.uvs.resize(size_t(numVertices) * 2);

    // Second Life is Z-up. Convert to a Y-up scene for Filament.
    for (uint32_t i = 0; i < numVertices; ++i) {
        const float x = r.f32(), y = r.f32(), z = r.f32();
        out.positions[i * 3 + 0] = x;
        out.positions[i * 3 + 1] = z;
        out.positions[i * 3 + 2] = -y;
    }
    for (uint32_t i = 0; i < numVertices; ++i) {
        const float x = r.f32(), y = r.f32(), z = r.f32();
        out.normals[i * 3 + 0] = x;
        out.normals[i * 3 + 1] = z;
        out.normals[i * 3 + 2] = -y;
    }
    for (uint32_t i = 0; i < numVertices; ++i) {
        (void)r.f32(); (void)r.f32(); (void)r.f32(); // binormal
    }
    for (uint32_t i = 0; i < numVertices; ++i) {
        out.uvs[i * 2 + 0] = r.f32();
        out.uvs[i * 2 + 1] = r.f32();
    }
    if (hasDetailTexCoords) {
        for (uint32_t i = 0; i < numVertices; ++i) { (void)r.f32(); (void)r.f32(); }
    }
    if (hasWeights) {
        for (uint32_t i = 0; i < numVertices; ++i) (void)r.f32();
    }

    const uint16_t numFaces = r.u16();
    if (numFaces == 0) throw "invalid face count";
    out.indices.resize(size_t(numFaces) * 3);
    for (auto& idx : out.indices) idx = r.u16();

    if (hasWeights) {
        const uint16_t joints = r.u16();
        if (joints > 512) throw "invalid joint count";
        for (uint16_t i = 0; i < joints; ++i) (void)r.str64();
    }

    // Consume morph targets to validate the complete stream, but do not upload
    // them yet. They become GPU morph targets in the next avatar milestone.
    while (r.can(64)) {
        const std::string name = r.str64();
        if (name.empty() || name == "End Morphs") break;
        const int32_t count = r.i32();
        if (count < 0 || count > 20000) break;
        constexpr size_t bytesPerVertex = 4 + 12 + 12 + 12 + 8;
        if (!r.can(size_t(count) * bytesPerVertex)) break;
        for (int32_t i = 0; i < count; ++i) {
            (void)r.u32();
            for (int k = 0; k < 11; ++k) (void)r.f32();
        }
    }
    return out;
}
} // namespace

extern "C" JNIEXPORT jobject JNICALL
Java_net_visorsl_viewer_NativeLlm_parseLLM(JNIEnv* env, jobject, jbyteArray input) {
    if (!input) return nullptr;
    const jsize len = env->GetArrayLength(input);
    std::vector<uint8_t> bytes(static_cast<size_t>(len));
    env->GetByteArrayRegion(input, 0, len, reinterpret_cast<jbyte*>(bytes.data()));

    try {
        ParsedMesh m = parseLLM(bytes.data(), bytes.size());
        jclass cls = env->FindClass("net/visorsl/viewer/NativeLlmMesh");
        if (!cls) return nullptr;
        jmethodID ctor = env->GetMethodID(cls, "<init>", "([F[F[F[SI)V");
        if (!ctor) return nullptr;

        jfloatArray pos = env->NewFloatArray(static_cast<jsize>(m.positions.size()));
        jfloatArray nrm = env->NewFloatArray(static_cast<jsize>(m.normals.size()));
        jfloatArray uv = env->NewFloatArray(static_cast<jsize>(m.uvs.size()));
        jshortArray idx = env->NewShortArray(static_cast<jsize>(m.indices.size()));
        if (!pos || !nrm || !uv || !idx) return nullptr;

        env->SetFloatArrayRegion(pos, 0, static_cast<jsize>(m.positions.size()), m.positions.data());
        env->SetFloatArrayRegion(nrm, 0, static_cast<jsize>(m.normals.size()), m.normals.data());
        env->SetFloatArrayRegion(uv, 0, static_cast<jsize>(m.uvs.size()), m.uvs.data());
        std::vector<jshort> shortIndices(m.indices.size());
        for (size_t i = 0; i < m.indices.size(); ++i) shortIndices[i] = static_cast<jshort>(m.indices[i]);
        env->SetShortArrayRegion(idx, 0, static_cast<jsize>(shortIndices.size()), shortIndices.data());

        jobject out = env->NewObject(cls, ctor, pos, nrm, uv, idx, static_cast<jint>(m.positions.size() / 3));
        env->DeleteLocalRef(pos); env->DeleteLocalRef(nrm); env->DeleteLocalRef(uv); env->DeleteLocalRef(idx);
        return out;
    } catch (const char* e) {
        LOGE("LLM parse failed: %s", e);
        jclass ex = env->FindClass("java/lang/IllegalArgumentException");
        if (ex) env->ThrowNew(ex, e);
        return nullptr;
    }
}
