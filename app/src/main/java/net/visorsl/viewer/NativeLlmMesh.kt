package net.visorsl.viewer

data class NativeLlmMesh(
    val positions: FloatArray,
    val normals: FloatArray,
    val uvs: FloatArray,
    val indices: ShortArray,
    val vertexCount: Int,
) {
    val indexCount: Int get() = indices.size
}

object NativeLlm {
    init { System.loadLibrary("slcore") }
    external fun parseLLM(bytes: ByteArray): NativeLlmMesh
}
