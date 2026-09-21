package net.visorsl.viewer

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.AssetManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream
import java.io.IOException

/**
 * Visor SL — thin Android shell around the WebGL viewer in assets/www.
 *
 * All network I/O (HTTPS + the raw UDP circuit that Second Life requires) is
 * performed natively by [NativeBridge] because a WebView cannot open UDP
 * sockets and cross-origin fetch() is blocked by CORS.
 *
 * Deliberately avoids androidx.work / WorkManager: its NetworkStateTracker
 * calls ConnectivityManager.registerDefaultNetworkCallback repeatedly, which
 * on recent Android versions (13+) throws TooManyRequestsException — the
 * crash reported against other viewers. We use a single ConnectivityManager
 * check plus the socket layer instead.
 */
class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var bridge: NativeBridge
    private var pendingStorageRequest: String? = null
    private var pendingFolderRequest: String? = null

    private companion object {
        const val TAG = "VisorSL"
        const val ASSET_ROOT = "www"
        const val HOST = "https://appassets.androidplatform.net"
        const val START_URL = "$HOST/$ASSET_ROOT/index.html"
        const val REQUEST_STORAGE = 1002
        const val REQUEST_FOLDER = 1003

        val MIME_TYPES = mapOf(
            "html" to "text/html", "htm" to "text/html",
            "js" to "text/javascript", "mjs" to "text/javascript",
            "css" to "text/css", "json" to "application/json",
            "map" to "application/json", "txt" to "text/plain",
            "msg" to "text/plain", "log" to "text/plain",
            "xml" to "application/xml", "svg" to "image/svg+xml",
            "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg",
            "gif" to "image/gif", "webp" to "image/webp", "bmp" to "image/bmp",
            "ico" to "image/x-icon", "ktx" to "image/ktx",
            "mp3" to "audio/mpeg", "ogg" to "audio/ogg", "wav" to "audio/wav",
            "wasm" to "application/wasm",
            "woff" to "font/woff", "woff2" to "font/woff2", "ttf" to "font/ttf",
            "glb" to "model/gltf-binary", "gltf" to "model/gltf+json",
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView = WebView(this)
        setContentView(webView)
        hideSystemUi()

        // Keep the bottom HUD clear of the gesture/navigation bar. The page has
        // no <meta viewport>, so env(safe-area-inset-*) is always 0 in a WebView;
        // the inset has to be applied natively.
        webView.setOnApplyWindowInsetsListener { view, insets ->
            val bottom = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                insets.getInsets(android.view.WindowInsets.Type.navigationBars()).bottom
            } else {
                @Suppress("DEPRECATION")
                insets.systemWindowInsetBottom
            }
            view.setPadding(0, 0, 0, bottom)
            insets
        }

        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        // GPU: let the WebView run WebGL2 with the device's real GL driver.
        settings.loadsImagesAutomatically = true
        settings.blockNetworkImage = false
        // Second Life serves textures over plain http; the WebView would drop
        // those requests from an https origin as mixed content.
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        // Keep the renderer (and therefore the WebGL context and the page's
        // timers) alive while the screen is off, so the background session does
        // not come back to a blank canvas.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        }
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        webView.setBackgroundColor(0xFF0B0E13.toInt())
        webView.isScrollbarFadingEnabled = true
        webView.overScrollMode = View.OVER_SCROLL_NEVER

        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

        requestNotificationPermission()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView, request: WebResourceRequest
            ): WebResourceResponse? {
                val url = request.url
                if (url.host != "appassets.androidplatform.net") return null
                return serveAsset(url.encodedPath ?: "/")
            }

            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, error: WebResourceError
            ) {
                Log.e(TAG, "error ${error.errorCode} ${error.description} en ${request.url}")
                if (request.isForMainFrame) showErrorPage("${error.errorCode}", error.description.toString())
            }

            override fun onReceivedHttpError(
                view: WebView, request: WebResourceRequest, response: WebResourceResponse
            ) {
                Log.e(TAG, "http ${response.statusCode} en ${request.url}")
                if (request.isForMainFrame) showErrorPage("HTTP ${response.statusCode}", "${request.url}")
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                Log.i(TAG, "${msg.message()} @${msg.lineNumber()}")
                return true
            }
        }

        bridge = NativeBridge(this)
        webView.addJavascriptInterface(bridge, "VisorNative")
        NativeBridge.webViewRef = webView

        webView.loadUrl(START_URL)
    }

    /**
     * Serves assets/www over https://appassets.androidplatform.net/www/...
     *
     * WebViewAssetLoader is not used on purpose: it strips the registered
     * prefix from the URL, so it can only serve files that sit at the very root
     * of assets/ (it would look for assets/index.html, not
     * assets/www/index.html), and it falls back to text/plain for unrecognised
     * extensions, which the browser rejects for ES modules.
     */
    private fun serveAsset(encodedPath: String): WebResourceResponse {
        var rel = Uri.decode(encodedPath.trimStart('/'))
        val prefix = "$ASSET_ROOT/"
        if (rel.startsWith(prefix)) rel = rel.substring(prefix.length)
        if (rel.isEmpty()) rel = "index.html"

        val safe = !rel.contains("..")
        val candidates: List<String> =
            if (safe) listOf("$ASSET_ROOT/$rel", rel) else emptyList()
        for (candidate in candidates) {
            try {
                val stream = assets.open(candidate, AssetManager.ACCESS_STREAMING)
                return WebResourceResponse(mimeOf(rel), null, 200, "OK", cacheHeaders(), stream)
            } catch (_: IOException) {
                // try the next candidate
            }
        }
        Log.w(TAG, "asset no encontrado: $rel")
        val body = "404 — no existe el recurso '$rel' dentro de la app.".toByteArray()
        return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", cacheHeaders(), ByteArrayInputStream(body))
    }

    private fun mimeOf(path: String): String {
        val dot = path.lastIndexOf('.')
        val ext = if (dot >= 0) path.substring(dot + 1).lowercase() else ""
        return MIME_TYPES[ext] ?: "application/octet-stream"
    }

    private fun cacheHeaders(): Map<String, String> =
        mapOf("Cache-Control" to "public, max-age=31536000", "Access-Control-Allow-Origin" to "*")

    // -----------------------------------------------------------------------
    // Storage: where the data lives, the permission dialog, and the folder
    // picker. The viewer works fine without any of this — its cache is in the
    // app's own folder — but a user who wants to see and choose the location
    // gets a real dialog instead of a shrug.
    // -----------------------------------------------------------------------

    private val prefs by lazy { getSharedPreferences("visor", MODE_PRIVATE) }

    fun folderName(): String = prefs.getString("visor.folder", "") ?: ""

    fun permissionState(): String {
        if (Build.VERSION.SDK_INT > 28) {
            // Android 10+ has no general storage permission for apps any more:
            // app folders, MediaStore exports and the folder picker cover it.
            return "not_needed"
        }
        return if (checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) {
            "granted"
        } else "denied"
    }

    /** JSON string the page shows in the storage panel. */
    fun storageStatus(): String {
        val o = org.json.JSONObject()
        try {
            o.put("sdk", Build.VERSION.SDK_INT)
            o.put("permission", permissionState())
            o.put("legacyPermission", Build.VERSION.SDK_INT <= 28)
            o.put("folder", folderName())
            o.put("appDir", filesDir.absolutePath)
            o.put("cacheDir", java.io.File(cacheDir, "vcache").absolutePath)
            val ext = getExternalFilesDir(null)
            if (ext != null) o.put("externalDir", ext.absolutePath)
            o.put("state", Environment.getExternalStorageState())
            o.put("freeBytes", filesDir.usableSpace)
        } catch (t: Throwable) {
            o.put("error", t.toString())
        }
        return o.toString()
    }

    /**
     * Asks for the storage permission. On Android 9 and older this is a real
     * system dialog; on 10+ the permission no longer exists, so the user is told
     * where the data is kept and offered the folder picker instead.
     */
    fun requestStoragePermission(requestId: String) {
        if (Build.VERSION.SDK_INT <= 28) {
            if (checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) {
                nativeBridge()?.pushResult("storagePermission", requestId, org.json.JSONObject().put("granted", true))
                return
            }
            pendingStorageRequest = requestId
            requestPermissions(
                arrayOf(
                    android.Manifest.permission.WRITE_EXTERNAL_STORAGE,
                    android.Manifest.permission.READ_EXTERNAL_STORAGE,
                ), REQUEST_STORAGE)
            return
        }
        val extra = org.json.JSONObject()
        extra.put("granted", true)
        extra.put("notNeeded", true)
        nativeBridge()?.pushResult("storagePermission", requestId, extra)
    }

    /** Opens the system folder picker so the user can choose where data goes. */
    fun pickFolder(requestId: String) {
        pendingFolderRequest = requestId
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            intent.addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION
                        or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            )
            startActivityForResult(intent, REQUEST_FOLDER)
        } catch (t: Throwable) {
            val extra = org.json.JSONObject()
            extra.put("ok", false)
            extra.put("error", t.toString())
            nativeBridge()?.pushResult("folder", requestId, extra)
        }
    }

    private fun nativeBridge(): NativeBridge? = if (::bridge.isInitialized) bridge else null

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_STORAGE) return
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        val id = pendingStorageRequest
        pendingStorageRequest = null
        if (id != null) {
            val extra = org.json.JSONObject()
            extra.put("granted", granted)
            nativeBridge()?.pushResult("storagePermission", id, extra)
        }
    }

    @Deprecated("startActivityForResult keeps this shell free of androidx dependencies")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_FOLDER) return
        val id = pendingFolderRequest
        pendingFolderRequest = null
        if (id == null) return
        val extra = org.json.JSONObject()
        val uri = data?.data
        if (resultCode == RESULT_OK && uri != null) {
            try {
                contentResolver.takePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            } catch (_: Throwable) {}
            val name = uri.lastPathSegment ?: uri.toString()
            prefs.edit().putString("visor.folder", name).apply()
            extra.put("ok", true)
            extra.put("folder", name)
        } else {
            extra.put("ok", false)
            extra.put("cancelled", true)
        }
        nativeBridge()?.pushResult("folder", id, extra)
    }

    private fun showErrorPage(code: String, detail: String) {
        val html = """
            <!doctype html><meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <body style="background:#0b0e13;color:#e8eef7;font:15px/1.5 system-ui;padding:24px">
            <h2 style="color:#ff7a7a">No se pudo cargar el visor</h2>
            <p>$code</p><p style="color:#9fb0c6">$detail</p>
            <p style="color:#9fb0c6">El motor web vive dentro de la app, en
            <code>assets/www</code>. Reinstala el APK completo
            (visor-sl-apk) o abre la app desde Android Studio.</p>
            <p><a style="color:#4ea1ff" href="$START_URL">Reintentar</a></p>
            </body>
        """.trimIndent()
        webView.loadDataWithBaseURL(HOST, html, "text/html", "utf-8", null)
    }

    private fun hideSystemUi() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )
    }

    /**
     * Android 13+ needs the user's permission to post the session notification
     * (the foreground service would otherwise start without showing anything).
     * Storage permissions are NOT requested: the viewer's cache lives in the
     * app's own folders, which never need one.
     */
    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        try {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1001)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "permiso de notificaciones: $t")
        }
    }

    override fun onBackPressed() {
        if (bridge.hasModal()) {
            bridge.evalJs("window.visor && window.visor.ui && window.visor.ui.hideModal()")
        } else {
            super.onBackPressed()
        }
    }

    override fun onPause() {
        super.onPause()
        // While a session is up the service keeps the WebView (and its UDP
        // socket) running in the background; pausing it here would freeze the
        // world the moment the screen locks or the user switches apps.
        if (!SessionService.active) webView.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        hideSystemUi()
    }

    override fun onDestroy() {
        bridge.shutdown()
        super.onDestroy()
    }
}
