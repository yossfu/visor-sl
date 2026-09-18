// MainActivity.kt -- la app entera cabe aqui.
//
// Arranca dos servidores locales (el del visor y el del retransmisor interno),
// crea un WebView y le carga el visor desde http://127.0.0.1. El visor se
// conecta despues, el solo, a ws://127.0.0.1:PUERTO (el puerto viaja en la
// direccion como `?relay=`). Con eso la app es autonoma: un solo APK, sin
// ninguna otra app ni proceso de por medio.

package org.visor.sl

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebViewClient
import android.webkit.WebSettings
import android.webkit.WebView
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URLEncoder

class MainActivity : Activity() {

    private var viewer: ViewerServer? = null
    private var relay: RelayServer? = null
    private var webView: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView = WebView(this).apply {
            setBackgroundColor(0xFF10141C.toInt())
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            settings.allowFileAccess = false
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = false
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            settings.setSupportZoom(false)
            settings.builtInZoomControls = false
            // Todo lo que sea salir de 127.0.0.1 (los enlaces de la pantalla de
            // entrada, por ejemplo) se abre en el navegador de verdad, no dentro
            // del visor: dentro se quedaria sin barra de direcciones y sin vuelta.
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean {
                    val u = request.url
                    if (u.host == "127.0.0.1" || u.host == "localhost") return false
                    return try {
                        startActivity(Intent(Intent.ACTION_VIEW, u))
                        true
                    } catch (e: Exception) {
                        true
                    }
                }
            }
        }
        setContentView(webView)
        WebView.setWebContentsDebuggingEnabled(true)

        // El puente de informes: expone `window.VisorDiag` al visor (src/diag.js
        // lo detecta y guarda/comparte los informes por aqui). Ademas prepara la
        // carpeta de informes para el registro nativo.
        VisorNativeLog.attach(File(getExternalFilesDir("informes") ?: filesDir, ""))
        webView?.addJavascriptInterface(VisorDiagBridge(this), "VisorDiag")
        log("app arrancada · puente de informes listo · carpeta: " + (getExternalFilesDir("informes")?.absolutePath ?: "?"))
        VisorNativeLog.add("dispositivo: " + android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL +
            " · android " + android.os.Build.VERSION.RELEASE + " (sdk " + android.os.Build.VERSION.SDK_INT + ")")

        Thread({ startServers() }, "visor-arranque").apply { isDaemon = true }.start()
    }

    private fun startServers() {
        try {
            val v = ViewerServer(assets, 0, ::log)
            v.start()
            viewer = v

            // El puerto del retransmisor lo elegimos aqui y se lo pasamos; no
            // se pregunta a RelayServer (su clase base ya tiene un getPort() y
            // pedirlo por nombre daria un choque de firmas en Kotlin).
            val relayPort = freePort()
            val r = RelayServer(relayPort, ::log)
            r.start()
            relay = r

            val relayUrl = "ws://127.0.0.1:" + relayPort
            // `#sl` abre directamente la pantalla de entrada (nombre, contraseña
            // y retransmisor), que es la pantalla natural de la app: es la unica
            // forma de entrar en Second Life, y el retransmisor interno ya llega
            // relleno. Sin el `#sl` el visor arrancaria en el mundo vacio y
            // habria que buscar "Iniciar sesion" en la barra de arriba.
            val url = "http://127.0.0.1:" + v.port + "/index.html?relay=" +
                URLEncoder.encode(relayUrl, "UTF-8") + "#sl"
            log("visor en " + url)
            runOnUiThread { webView?.loadUrl(url) }
        } catch (e: Exception) {
            val detalle = e.message ?: e.toString()
            log("no se pudieron arrancar los servidores: " + detalle)
            runOnUiThread { mostrarError(detalle) }
        }
    }

    // Si algo falla antes de cargar el visor, mejor una pantalla que lo diga
    // (con el detalle) que un WebView en blanco sin pistas.
    private fun mostrarError(detalle: String) {
        val html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>" +
            "<body style='background:#10141C;color:#dfe6f2;font-family:sans-serif;padding:24px;" +
            "text-align:left'><h2>No se pudo arrancar el visor</h2>" +
            "<p>Los servidores internos de la app no arrancaron.</p>" +
            "<pre style='white-space:pre-wrap;color:#ff9b9b'>" +
            detalle.replace("<", "&lt;") + "</pre></body>"
        webView?.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    // Un puerto libre en la interfaz de bucle. El del visor ya esta ocupado, asi
    // que este no puede coincidir con el.
    private fun freePort(): Int =
        ServerSocket(0, 4, InetAddress.getByName("127.0.0.1")).use { it.localPort }

    private fun log(text: String) {
        // Todo lo nativo pasa por el anillo de `VisorNativeLog`, que ademas de
        // logcat lo vuelca al informe (src/diag.js lo recoge en `info()`).
        VisorNativeLog.add(text)
    }

    override fun onDestroy() {
        try { relay?.stop() } catch (e: Exception) { /* ya parado */ }
        try { viewer?.stop() } catch (e: Exception) { /* ya parado */ }
        try { webView?.destroy() } catch (e: Exception) { /* ya destruido */ }
        super.onDestroy()
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        val wv = webView
        if (wv != null && wv.canGoBack()) wv.goBack() else super.onBackPressed()
    }
}
