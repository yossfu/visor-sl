package net.visorsl.viewer

import android.app.Activity
import android.content.res.AssetManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
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

    private companion object {
        const val TAG = "VisorSL"
        const val ASSET_ROOT = "www"
        const val HOST = "https://appassets.androidplatform.net"
        const val START_URL = "$HOST/$ASSET_ROOT/index.html"

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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        }
        webView.setBackgroundColor(0xFF0B0E13.toInt())

        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

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
        mapOf("Cache-Control" to "no-store", "Access-Control-Allow-Origin" to "*")

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

    override fun onBackPressed() {
        if (bridge.hasModal()) {
            bridge.evalJs("window.visor && window.visor.ui && window.visor.ui.hideModal()")
        } else {
            super.onBackPressed()
        }
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
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
