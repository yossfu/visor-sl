package net.visorsl.viewer

import android.app.Activity
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Native side of the viewer:
 *  - HTTP proxy (bypasses CORS for the login/capability/event-queue calls)
 *  - raw UDP socket wrapper (the Second Life circuit needs UDP; a WebView
 *    cannot open one)
 *  - texture/asset download helper
 *
 * Every call receives a JSON object with an "id"; results are pushed back to
 * the page through window.visornative(JSON). Bodies are base64 so binary is
 * preserved.
 */
class NativeBridge(private val activity: Activity) {
    companion object {
        var webViewRef: WebView? = null
        private const val TAG = "VisorSL"
        private const val MAX_DATAGRAM = 4096
    }

    private val httpPool = Executors.newFixedThreadPool(4)
    private val udpChannels = ConcurrentHashMap<String, UdpChannel>()
    @Volatile private var modalOpen = false

    inner class UdpChannel(val host: String, var port: Int) {
        val socket = DatagramSocket()
        val running = AtomicBoolean(true)
        var lastPeer: InetSocketAddress? = null
        var thread: Thread? = null
    }

    @JavascriptInterface
    fun platform(): String {
        val o = JSONObject()
        o.put("platform", "android")
        o.put("sdk", android.os.Build.VERSION.SDK_INT)
        o.put("model", android.os.Build.MODEL)
        o.put("manufacturer", android.os.Build.MANUFACTURER)
        o.put("nativeBridge", true)
        o.put("udp", true)
        return o.toString()
    }

    @JavascriptInterface
    fun log(message: String) {
        Log.i(TAG, message)
    }

    @JavascriptInterface
    fun setModal(open: Boolean) {
        modalOpen = open
    }

    fun hasModal(): Boolean = modalOpen

    @JavascriptInterface
    fun http(requestJson: String): String {
        val req = JSONObject(requestJson)
        val id = req.optString("id")
        httpPool.execute {
            val result = JSONObject()
            result.put("id", id)
            result.put("kind", "http")
            var conn: HttpURLConnection? = null
            try {
                val url = URL(req.getString("url"))
                conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = req.optString("method", "GET")
                conn.connectTimeout = req.optInt("connectTimeout", 15000)
                conn.readTimeout = req.optInt("timeout", 45000)
                conn.instanceFollowRedirects = true
                conn.useCaches = false
                val headers = req.optJSONObject("headers")
                if (headers != null) {
                    val it = headers.keys()
                    while (it.hasNext()) {
                        val k = it.next()
                        conn.setRequestProperty(k, headers.getString(k))
                    }
                }
                val bodyB64 = req.optString("body", "")
                if (bodyB64.isNotEmpty()) {
                    conn.doOutput = true
                    val bytes = Base64.decode(bodyB64, Base64.DEFAULT)
                    conn.setRequestProperty("Content-Length", bytes.size.toString())
                    conn.outputStream.use { it.write(bytes) }
                }
                val status = conn.responseCode
                val stream = if (status in 200..399) conn.inputStream else conn.errorStream
                val bytes = stream?.let { readAll(it) } ?: ByteArray(0)
                result.put("ok", true)
                result.put("status", status)
                val hdrs = JSONObject()
                conn.headerFields.forEach { (k, v) ->
                    if (k != null && v != null && v.isNotEmpty()) hdrs.put(k, v[0])
                }
                result.put("headers", hdrs)
                result.put("body", Base64.encodeToString(bytes, Base64.NO_WRAP))
            } catch (t: Throwable) {
                result.put("ok", false)
                result.put("error", t.javaClass.simpleName + ": " + (t.message ?: ""))
            } finally {
                conn?.disconnect()
            }
            push(result)
        }
        return ack(id)
    }

    @JavascriptInterface
    fun udpOpen(requestJson: String): String {
        val req = JSONObject(requestJson)
        val id = req.getString("id")
        val host = req.getString("host")
        val port = req.getInt("port")
        closeChannel(id)
        try {
            val ch = UdpChannel(host, port)
            ch.socket.soTimeout = 0
            ch.lastPeer = InetSocketAddress(InetAddress.getByName(host), port)
            val t = Thread {
                val buf = ByteArray(MAX_DATAGRAM)
                while (ch.running.get()) {
                    try {
                        val pkt = DatagramPacket(buf, buf.size)
                        ch.socket.receive(pkt)
                        ch.lastPeer = InetSocketAddress(pkt.address, pkt.port)
                        val msg = JSONObject()
                        msg.put("id", id)
                        msg.put("kind", "udp")
                        msg.put("data", Base64.encodeToString(buf, 0, pkt.length, Base64.NO_WRAP))
                        msg.put("from", pkt.address?.hostAddress ?: "")
                        msg.put("port", pkt.port)
                        push(msg)
                    } catch (e: Exception) {
                        if (ch.running.get()) Log.w(TAG, "udp recv: ${e.message}")
                    }
                }
            }
            t.isDaemon = true
            t.name = "visor-udp-$id"
            ch.thread = t
            t.start()
            udpChannels[id] = ch
            val ok = JSONObject()
            ok.put("id", id); ok.put("kind", "udpOpen"); ok.put("ok", true)
            ok.put("localPort", ch.socket.localPort)
            push(ok)
        } catch (t: Throwable) {
            val err = JSONObject()
            err.put("id", id); err.put("kind", "udpOpen"); err.put("ok", false)
            err.put("error", t.javaClass.simpleName + ": " + (t.message ?: ""))
            push(err)
        }
        return ack(id)
    }

    @JavascriptInterface
    fun udpSend(requestJson: String): String {
        val req = JSONObject(requestJson)
        val id = req.getString("id")
        val ch = udpChannels[id] ?: return ack(id, false, "no channel")
        return try {
            val data = Base64.decode(req.getString("data"), Base64.DEFAULT)
            val peer = if (req.has("host")) {
                InetSocketAddress(InetAddress.getByName(req.getString("host")), req.getInt("port"))
            } else ch.lastPeer
            if (peer == null) return ack(id, false, "no peer")
            ch.socket.send(DatagramPacket(data, data.size, peer))
            ack(id)
        } catch (t: Throwable) {
            ack(id, false, t.message ?: t.javaClass.simpleName)
        }
    }

    @JavascriptInterface
    fun udpClose(requestJson: String): String {
        val id = JSONObject(requestJson).optString("id")
        closeChannel(id)
        return ack(id)
    }

    private fun closeChannel(id: String) {
        udpChannels.remove(id)?.let { ch ->
            ch.running.set(false)
            try { ch.socket.close() } catch (_: Exception) {}
        }
    }

    private fun readAll(stream: java.io.InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        BufferedInputStream(stream).use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                out.write(buf, 0, n)
            }
        }
        return out.toByteArray()
    }

    private fun ack(id: String, ok: Boolean = true, error: String? = null): String {
        val o = JSONObject()
        o.put("id", id); o.put("ok", ok)
        if (error != null) o.put("error", error)
        return o.toString()
    }

    private fun push(obj: JSONObject) {
        val js = "window.visornative && window.visornative(" + JSONObject.quote(obj.toString()) + ")"
        runOnUi { evalJs(js) }
    }

    private fun runOnUi(block: () -> Unit) {
        activity.runOnUiThread { try { block() } catch (t: Throwable) { Log.w(TAG, "ui: $t") } }
    }

    fun evalJs(js: String) {
        webViewRef?.let { runOnUi { it.evaluateJavascript(js, null) } }
    }

    fun shutdown() {
        udpChannels.keys.toList().forEach { closeChannel(it) }
        httpPool.shutdownNow()
    }

    /** Convenience for a JSON array of bytes (unused placeholder for parity). */
    private fun toArray(bytes: ByteArray): JSONArray {
        val a = JSONArray()
        for (b in bytes) a.put(b.toInt() and 0xFF)
        return a
    }
}
