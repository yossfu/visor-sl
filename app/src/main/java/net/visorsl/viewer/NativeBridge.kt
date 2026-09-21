package net.visorsl.viewer

import android.app.Activity
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
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
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
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
        private const val MAX_RX_QUEUE = 2048
        private const val RX_FLUSH_MS = 20L
    }

    private val httpPool = Executors.newFixedThreadPool(4)

    /**
     * Socket setup and sending run here — never on the WebView "JavaBridge"
     * thread, which is blocked (the page is waiting on us) and which some
     * devices/ROMs refuse to let create sockets. One thread, so datagrams keep
     * their order.
     */
    private val udpPool = Executors.newSingleThreadExecutor { r ->
        Thread(r, "visor-udp-io").apply { isDaemon = true }
    }

    /** A blocked probe (waiting seconds for a reply) must not hold up udpPool. */
    private val probePool = Executors.newCachedThreadPool()

    private val udpChannels = ConcurrentHashMap<String, UdpChannel>()

    /** Received datagrams wait here and go to JS in batches (one call per ~20 ms). */
    private val rxQueue = ConcurrentLinkedQueue<JSONObject>()
    private var rxDropped = 0
    private val flusher = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "visor-udp-rx").apply { isDaemon = true }
    }

    @Volatile private var modalOpen = false

    init {
        flusher.scheduleAtFixedRate({
            try {
                flushRx()
            } catch (t: Throwable) {
                Log.w(TAG, "rx flush: $t")
            }
        }, 0, RX_FLUSH_MS, TimeUnit.MILLISECONDS)
    }

    inner class UdpChannel() {
        val socket = DatagramSocket()
        val running = AtomicBoolean(true)
        @Volatile var peer: InetSocketAddress? = null
        var thread: Thread? = null
        @Volatile var sent = 0
        @Volatile var sentBytes = 0
        @Volatile var received = 0
        @Volatile var receivedBytes = 0
    }

    @JavascriptInterface
    fun platform(): String {
        val o = JSONObject()
        o.put("platform", "android")
        o.put("sdk", android.os.Build.VERSION.SDK_INT)
        o.put("model", android.os.Build.MODEL)
        o.put("manufacturer", android.os.Build.MANUFACTURER)
        o.put("appVersion", BuildConfig.VERSION_NAME)
        o.put("appBuild", BuildConfig.VERSION_CODE)
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
        val id = req.optString("id")
        val chan = req.optString("chan", id)
        val host = req.getString("host")
        val port = req.getInt("port")
        Log.i(TAG, "udpOpen $host:$port (chan=$chan)")
        udpPool.execute {
            val out = JSONObject()
            out.put("id", id); out.put("chan", chan); out.put("kind", "udpOpen")
            try {
                closeChannel(chan)
                val ch = UdpChannel()
                ch.peer = InetSocketAddress(InetAddress.getByName(host), port)
                val rx = Thread { receiveLoop(chan, ch) }
                rx.isDaemon = true
                rx.name = "visor-udp-rx-$chan"
                ch.thread = rx
                rx.start()
                udpChannels[chan] = ch
                out.put("ok", true)
                out.put("localPort", ch.socket.localPort)
                Log.i(TAG, "udpOpen ok local=${ch.socket.localPort}")
            } catch (t: Throwable) {
                out.put("ok", false)
                out.put("error", describe(t))
                Log.e(TAG, "udpOpen $host:$port falló: ${describe(t)}")
            }
            push(out)
        }
        return ack(id)
    }

    @JavascriptInterface
    fun udpSend(requestJson: String): String {
        val req = JSONObject(requestJson)
        val id = req.optString("id")
        val chan = req.optString("chan", id)
        val dataB64 = req.optString("data", "")
        val host = if (req.has("host")) req.getString("host") else null
        val port = if (req.has("port")) req.getInt("port") else 0
        udpPool.execute {
            val out = JSONObject()
            out.put("id", id); out.put("chan", chan); out.put("kind", "udpSend")
            val ch = udpChannels[chan]
            if (ch == null) {
                out.put("ok", false); out.put("error", "no hay canal UDP abierto ($chan)")
                push(out)
                return@execute
            }
            try {
                val data = Base64.decode(dataB64, Base64.DEFAULT)
                val peer = if (host != null) {
                    InetSocketAddress(InetAddress.getByName(host), port)
                } else ch.peer
                if (peer == null) throw IllegalStateException("el canal no tiene destino")
                ch.socket.send(DatagramPacket(data, data.size, peer))
                ch.sent++
                ch.sentBytes += data.size
                out.put("ok", true); out.put("sent", data.size)
            } catch (t: Throwable) {
                out.put("ok", false); out.put("error", describe(t))
                Log.w(TAG, "udpSend falló: ${describe(t)}")
            }
            push(out)
        }
        return ack(id)
    }

    @JavascriptInterface
    fun udpClose(requestJson: String): String {
        val req = JSONObject(requestJson)
        val id = req.optString("id")
        val chan = req.optString("chan", id)
        udpPool.execute { closeChannel(chan) }
        return ack(id)
    }

    /**
     * Sends one datagram from a *throwaway* socket and waits for any reply.
     * Used by the HUD diagnostic to tell apart "the socket cannot be created",
     * "outbound UDP is blocked", and "the simulator never answered".
     */
    @JavascriptInterface
    fun udpProbe(requestJson: String): String {
        val req = JSONObject(requestJson)
        val id = req.optString("id")
        val host = req.getString("host")
        val port = req.getInt("port")
        val data = Base64.decode(req.optString("data", ""), Base64.DEFAULT)
        val waitMs = req.optInt("waitMs", 4000)
        probePool.execute {
            val out = JSONObject()
            out.put("id", id); out.put("kind", "udpProbe")
            out.put("host", host); out.put("port", port)
            var sock: DatagramSocket? = null
            try {
                val s = DatagramSocket()
                sock = s
                out.put("localPort", s.localPort)
                s.soTimeout = 500
                val addr = InetAddress.getByName(host)
                s.send(DatagramPacket(data, data.size, InetSocketAddress(addr, port)))
                out.put("sent", data.size)
                val buf = ByteArray(MAX_DATAGRAM)
                val deadline = System.currentTimeMillis() + waitMs
                var got = 0
                var from = ""
                var fromPort = 0
                while (System.currentTimeMillis() < deadline) {
                    val pkt = DatagramPacket(buf, buf.size)
                    try {
                        s.receive(pkt)
                    } catch (_: java.net.SocketTimeoutException) {
                        continue
                    }
                    got += pkt.length
                    from = pkt.address?.hostAddress ?: ""
                    fromPort = pkt.port
                    break
                }
                out.put("ok", true)
                out.put("received", got)
                out.put("from", from)
                out.put("fromPort", fromPort)
                Log.i(TAG, "udpProbe $host:$port recibidos=$got de=$from:$fromPort")
            } catch (t: Throwable) {
                out.put("ok", false); out.put("error", describe(t))
                Log.e(TAG, "udpProbe $host:$port falló: ${describe(t)}")
            } finally {
                try { sock?.close() } catch (_: Exception) {}
            }
            push(out)
        }
        return ack(id)
    }

    /** Active network (wifi/mobile/vpn), whether it is validated, and whether a UDP socket can even be created here. */
    @JavascriptInterface
    fun netInfo(): String {
        val o = JSONObject()
        try {
            val cm = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val net = cm.activeNetwork
            val caps = if (net != null) cm.getNetworkCapabilities(net) else null
            val tipo = when {
                caps == null -> "sin red"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "datos móviles"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "VPN"
                else -> "otra"
            }
            o.put("tipo", tipo)
            o.put("validada", caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) ?: false)
            o.put("sinMedir", caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) ?: false)
        } catch (t: Throwable) {
            o.put("errorRed", describe(t))
        }
        try {
            val s = DatagramSocket()
            o.put("udpOk", true)
            o.put("puertoDePrueba", s.localPort)
            s.close()
        } catch (t: Throwable) {
            o.put("udpOk", false)
            o.put("udpError", describe(t))
        }
        return o.toString()
    }

    private fun receiveLoop(chan: String, ch: UdpChannel) {
        val buf = ByteArray(MAX_DATAGRAM)
        var reportedErrors = 0
        while (ch.running.get()) {
            try {
                val pkt = DatagramPacket(buf, buf.size)
                ch.socket.receive(pkt)
                ch.peer = InetSocketAddress(pkt.address, pkt.port)
                ch.received++
                ch.receivedBytes += pkt.length
                val msg = JSONObject()
                msg.put("chan", chan)
                msg.put("data", Base64.encodeToString(buf, 0, pkt.length, Base64.NO_WRAP))
                msg.put("from", pkt.address?.hostAddress ?: "")
                msg.put("port", pkt.port)
                if (rxQueue.size < MAX_RX_QUEUE) rxQueue.add(msg) else rxDropped++
            } catch (t: Throwable) {
                if (!ch.running.get()) return
                if (reportedErrors++ < 3) {
                    Log.w(TAG, "udp recv: ${describe(t)}")
                    val err = JSONObject()
                    err.put("id", chan); err.put("chan", chan); err.put("kind", "udpError"); err.put("ok", false)
                    err.put("error", "recepción: " + describe(t))
                    push(err)
                }
            }
        }
    }

    /** Hands the queued datagrams to the page as one JSON array. */
    private fun flushRx() {
        if (rxQueue.isEmpty() && rxDropped == 0) return
        val arr = JSONArray()
        while (arr.length() < 96) {
            val o = rxQueue.poll() ?: break
            arr.put(o)
        }
        val dropped = rxDropped
        rxDropped = 0
        if (arr.length() == 0 && dropped == 0) return
        val msg = JSONObject()
        msg.put("id", "rx"); msg.put("kind", "udpBatch")
        msg.put("batch", arr)
        if (dropped > 0) msg.put("dropped", dropped)
        push(msg)
    }

    private fun closeChannel(id: String) {
        udpChannels.remove(id)?.let { ch ->
            ch.running.set(false)
            try { ch.socket.close() } catch (_: Exception) {}
        }
    }

    private fun describe(t: Throwable): String {
        val sb = StringBuilder(t.javaClass.simpleName)
        t.message?.let { if (it.isNotEmpty()) sb.append(": ").append(it) }
        var c = t.cause
        var depth = 0
        while (c != null && depth < 3) {
            sb.append(" ← ").append(c.javaClass.simpleName)
            c.message?.let { if (it.isNotEmpty()) sb.append(": ").append(it) }
            c = c.cause
            depth++
        }
        return sb.toString()
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
        try { flusher.shutdownNow() } catch (_: Exception) {}
        try { probePool.shutdownNow() } catch (_: Exception) {}
        try { udpPool.shutdownNow() } catch (_: Exception) {}
        httpPool.shutdownNow()
    }

    /** Convenience for a JSON array of bytes (unused placeholder for parity). */
    private fun toArray(bytes: ByteArray): JSONArray {
        val a = JSONArray()
        for (b in bytes) a.put(b.toInt() and 0xFF)
        return a
    }
}
