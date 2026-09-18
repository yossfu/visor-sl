// MainActivity.kt -- la app entera cabe aqui.
//
// Arranca dos servidores locales (el del visor y el PUENTE UDP), crea un WebView
// y le carga el visor desde http://127.0.0.1. El visor se conecta despues, el
// solo, al puente en ws://127.0.0.1:PUERTO (el puerto viaja en la direccion
// como `?udp=`). Con eso la app es autonoma y habla LLUDP con un simulador de
// Second Life DE VERDAD: un solo APK, sin ninguna otra app ni proceso de por
// medio, y sin retransmisor externo.
//
// El reparto es a proposito: aqui (Kotlin) solo se mueven datagramas UDP, y el
// protocolo de Second Life entero vive en `viewer/src/sl/lludp/` en JavaScript,
// que es el mismo codigo que corre en el navegador y que se prueba con el
// simulador en JS. Menos codigo nativo = menos que pueda fallar sin dejar
// rastro en un telefono.

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
    private var puente: UdpBridgeServer? = null
    private var webView: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        // Lo primero del todo: forzar IPv4 (ver VisorApp.kt). Va aqui tambien
        // porque `MainActivity` puede arrancar en un proceso que ya hubiera
        // tocado las clases de red antes de que corriera la Application.
        val avisoRed = forzarIPv4()
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
        log(avisoRed)
        log(estadoPilaIpv4())
        VisorNativeLog.add("dispositivo: " + android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL +
            " · android " + android.os.Build.VERSION.RELEASE + " (sdk " + android.os.Build.VERSION.SDK_INT + ")")

        Thread({ startServers() }, "visor-arranque").apply { isDaemon = true }.start()
    }

    private fun startServers() {
        try {
            val v = ViewerServer(assets, 0, ::log)
            v.start()
            viewer = v

            // El puerto del puente lo elegimos aqui y se lo pasamos; no se
            // pregunta a UdpBridgeServer (su clase base ya tiene un getPort() y
            // pedirlo por nombre daria un choque de firmas en Kotlin).
            val puertoPuente = freePort()
            val p = UdpBridgeServer(puertoPuente, ::log)
            p.start()
            puente = p

            val puenteUrl = "ws://127.0.0.1:" + puertoPuente
            // `?udp=` es lo que le dice al visor que abra el circuito LLUDP por
            // este puente: no hace falta retransmisor ni escribir ninguna
            // direccion a mano. `#sl` abre directamente la pantalla de entrada
            // (nombre y contraseña), que es la pantalla natural de la app. Sin
            // el `#sl` el visor arrancaria en el mundo vacio y habria que buscar
            // "Iniciar sesion" en la barra de arriba.
            val url = "http://127.0.0.1:" + v.port + "/index.html?udp=" +
                URLEncoder.encode(puenteUrl, "UTF-8") + "#sl"
            log("visor en " + url)
            log("puente UDP: " + puenteUrl + " (el visor hablara LLUDP por aqui)")
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
        try { puente?.stop() } catch (e: Exception) { /* ya parado */ }
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
