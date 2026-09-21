package net.visorsl.viewer

import android.content.Context
import android.graphics.Color
import android.view.Choreographer
import android.view.SurfaceView
import android.widget.FrameLayout
import android.widget.TextView
import com.google.android.filament.Camera
import com.google.android.filament.Engine
import com.google.android.filament.EntityManager
import com.google.android.filament.IndexBuffer
import com.google.android.filament.Material
import com.google.android.filament.RenderableManager
import com.google.android.filament.Scene
import com.google.android.filament.SwapChain
import com.google.android.filament.View
import com.google.android.filament.VertexBuffer
import com.google.android.filament.Viewport
import com.google.android.filament.android.UiHelper
import com.google.android.filament.filamat.MaterialBuilder
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.GZIPInputStream

class NativeFilamentView(context: Context) : FrameLayout(context) {
    private val surface = SurfaceView(context)
    private val uiHelper = UiHelper(UiHelper.ContextErrorPolicy.DONT_CHECK)
    private val choreographer = Choreographer.getInstance()

    private var engine: Engine? = null
    private var renderer: com.google.android.filament.Renderer? = null
    private var scene: Scene? = null
    private var view: View? = null
    private var camera: Camera? = null
    private var swapChain: SwapChain? = null
    private var material: Material? = null
    private val entities = mutableListOf<Int>()
    private var running = true
    private var frameQueued = false

    private val frameCallback = Choreographer.FrameCallback {
        frameQueued = false
        if (running) { renderFrame(); queueFrame() }
    }

    init {
        setBackgroundColor(Color.rgb(7, 10, 15))
        addView(surface, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        val hud = TextView(context).apply {
            setTextColor(Color.WHITE)
            textSize = 13f
            setPadding(22, 18, 22, 18)
            setBackgroundColor(Color.argb(165, 7, 10, 15))
            text = "VISOR SL NATIVE  •  FILAMENT 1.77  •  C++/JNI LLM"
        }
        addView(hud, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        initFilament()
        surface.post { loadAvatar() }
        queueFrame()
    }

    private fun initFilament() {
        val e = Engine.create(Engine.Backend.OPENGL)
        MaterialBuilder.init()
        engine = e
        renderer = e.createRenderer()
        scene = e.createScene()
        val cameraEntity = EntityManager.get().create()
        camera = e.createCamera(cameraEntity)
        view = e.createView().apply {
            scene = this@NativeFilamentView.scene
            camera = this@NativeFilamentView.camera
            viewport = Viewport(0, 0, 1, 1)
            renderQuality.hdrColorBuffer = View.RenderQuality.HDRColorBuffer.FP16
        }
        configureCamera()

        val packageData = MaterialBuilder()
            .name("SLAvatar")
            .platform(MaterialBuilder.Platform.MOBILE)
            .shading(MaterialBuilder.Shading.UNLIT)
            .optimization(MaterialBuilder.Optimization.PERFORMANCE)
            .doubleSided(true)
            .material(
                """
                material(inout MaterialInputs material) {
                    prepareMaterial(material);
                    material.baseColor = vec4(0.74, 0.52, 0.42, 1.0);
                }
                """.trimIndent()
            )
            .build(e)
        check(packageData.isValid) { "Filament MaterialBuilder devolvió un material inválido" }
        material = Material.Builder()
            .payload(packageData.buffer, packageData.buffer.remaining())
            .build(e)

        uiHelper.renderCallback = object : UiHelper.RendererCallback {
            override fun onNativeWindowChanged(surface: android.view.Surface) {
                swapChain?.let { e.destroySwapChain(it) }
                swapChain = e.createSwapChain(surface)
            }
            override fun onDetachedFromSurface() {
                swapChain?.let { e.destroySwapChain(it) }
                swapChain = null
            }
        }
        uiHelper.attachTo(surface)
    }

    private fun configureCamera() {
        val v = view ?: return
        val c = camera ?: return
        c.setProjection(45.0, 0.1, 100.0, Camera.Fov.VERTICAL)
        c.lookAt(0.0, 1.0, 4.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0)
        v.viewport = Viewport(0, 0, width.coerceAtLeast(1), height.coerceAtLeast(1))
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        view?.viewport = Viewport(0, 0, w.coerceAtLeast(1), h.coerceAtLeast(1))
    }

    private fun loadAvatar() {
        val e = engine ?: return
        val s = scene ?: return
        val mat = material ?: return
        val parts = listOf(
            "avatar_lower_body.llm.gz",
            "avatar_upper_body.llm.gz",
            "avatar_head.llm.gz",
            "avatar_eyelashes.llm.gz",
        )
        for (file in parts) {
            try {
                val mesh = NativeLlm.parseLLM(readGzipAsset(file))
                val vb = createVertexBuffer(e, mesh)
                val ib = createIndexBuffer(e, mesh)
                val entity = EntityManager.get().create()
                RenderableManager.Builder(1)
                    .geometry(0, RenderableManager.PrimitiveType.TRIANGLES, vb, ib, 0, mesh.indexCount)
                    .material(0, mat.createInstance())
                    .culling(false)
                    .build(e, entity)
                entities += entity
                s.addEntity(entity)
            } catch (t: Throwable) {
                throw IllegalStateException("No se pudo cargar el mesh nativo $file", t)
            }
        }
    }

    private fun createVertexBuffer(e: Engine, mesh: NativeLlmMesh): VertexBuffer {
        val stride = 8 * 4
        val interleaved = ByteBuffer.allocateDirect(mesh.vertexCount * stride).order(ByteOrder.nativeOrder())
        repeat(mesh.vertexCount) { i ->
            interleaved.putFloat(mesh.positions[i * 3])
            interleaved.putFloat(mesh.positions[i * 3 + 1])
            interleaved.putFloat(mesh.positions[i * 3 + 2])
            interleaved.putFloat(mesh.normals[i * 3])
            interleaved.putFloat(mesh.normals[i * 3 + 1])
            interleaved.putFloat(mesh.normals[i * 3 + 2])
            interleaved.putFloat(mesh.uvs[i * 2])
            interleaved.putFloat(mesh.uvs[i * 2 + 1])
        }
        interleaved.flip()
        return VertexBuffer.Builder()
            .bufferCount(1)
            .vertexCount(mesh.vertexCount)
            .attribute(VertexBuffer.VertexAttribute.POSITION, 0, VertexBuffer.AttributeType.FLOAT3, 0, stride)
            .attribute(VertexBuffer.VertexAttribute.NORMAL, 0, VertexBuffer.AttributeType.FLOAT3, 12, stride)
            .attribute(VertexBuffer.VertexAttribute.UV0, 0, VertexBuffer.AttributeType.FLOAT2, 24, stride)
            .build(e)
            .also { it.setBufferAt(e, 0, VertexBuffer.BufferDescriptor(interleaved)) }
    }

    private fun createIndexBuffer(e: Engine, mesh: NativeLlmMesh): IndexBuffer {
        val data = ByteBuffer.allocateDirect(mesh.indexCount * 2).order(ByteOrder.nativeOrder())
        mesh.indices.forEach(data::putShort)
        data.flip()
        return IndexBuffer.Builder()
            .indexCount(mesh.indexCount)
            .bufferType(IndexBuffer.Builder.IndexType.USHORT)
            .build(e)
            .also { it.setBuffer(e, IndexBuffer.BufferDescriptor(data)) }
    }

    private fun readGzipAsset(name: String): ByteArray =
        assets.open("avatar/$name").use { input -> GZIPInputStream(input).use { it.readBytes() } }

    fun resume() { running = true; queueFrame() }
    fun pause() {
        running = false
        if (frameQueued) { choreographer.removeFrameCallback(frameCallback); frameQueued = false }
    }
    private fun queueFrame() {
        if (running && !frameQueued) { frameQueued = true; choreographer.postFrameCallback(frameCallback) }
    }
    private fun renderFrame() {
        val r = renderer ?: return
        val sc = swapChain ?: return
        val v = view ?: return
        if (r.beginFrame(sc)) { r.render(v); r.endFrame() }
    }
    fun destroy() {
        pause()
        val e = engine ?: return
        entities.forEach { entity -> scene?.remove(entity); EntityManager.get().destroy(entity) }
        entities.clear()
        material?.let(e::destroyMaterial)
        view?.let(e::destroyView)
        scene?.let(e::destroyScene)
        renderer?.let(e::destroyRenderer)
        swapChain?.let(e::destroySwapChain)
        camera?.let { e.destroyCameraComponent(it.entity) }
        e.destroy()
        MaterialBuilder.shutdown()
        engine = null
    }
}
