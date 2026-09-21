package net.visorsl.viewer

import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader

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
        // WebGL needs hardware acceleration (on by default) and a decent viewport.
        webView.setBackgroundColor(0xFF0B0E13.toInt())

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/www/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView, request: WebResourceRequest
            ): WebResourceResponse? {
                return assetLoader.shouldInterceptRequest(request.url)
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                android.util.Log.i("VisorSL", "${msg.message()} @${msg.lineNumber()}")
                return true
            }
        }

        bridge = NativeBridge(this)
        webView.addJavascriptInterface(bridge, "VisorNative")
        // Allow the page to fetch remote textures directly when CORS permits.
        NativeBridge.webViewRef = webView

        webView.loadUrl("https://appassets.androidplatform.net/www/index.html")
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
