// ViewerServer.kt -- sirve el visor (HTML+JS+Css) desde los assets de la app.
//
// POR QUE UN SERVIDOR Y NO file://
// Los modulos ES y los `fetch("src/...")` del visor no funcionan bien desde
// file:// (origen opaco, sin fetch relativo fiable). Un servidor diminuto en
// 127.0.0.1 da un ORIGEN estable (http://127.0.0.1:<puerto>) en el que el visor
// se comporta igual que en la web: modulos, IndexedDB y WebSocket a
// ws://127.0.0.1:<puerto> sin mezcla de contenido.

package org.visor.sl

import android.content.res.AssetManager
import java.io.BufferedOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

class ViewerServer(
    private val assets: AssetManager,
    port: Int,
    private val log: (String) -> Unit,
) {
    private val server = ServerSocket(port, 24, InetAddress.getByName("127.0.0.1"))
    val port: Int get() = server.localPort

    @Volatile
    private var running = true

    // Cuantos archivos ha pedido ya el visor (para el registro del informe).
    private var served = 0L

    fun start() {
        Thread({ acceptLoop() }, "visor-http").apply { isDaemon = true }.start()
    }

    fun stop() {
        running = false
        try { server.close() } catch (e: Exception) { /* ya estaba cerrado */ }
    }

    private fun acceptLoop() {
        while (running) {
            val sock = try { server.accept() } catch (e: Exception) { break }
            Thread({ handle(sock) }, "visor-http-conn").apply { isDaemon = true }.start()
        }
    }

    private fun handle(sock: Socket) {
        try {
            sock.use {
                val input = sock.getInputStream()
                val head = readHead(input) ?: return
                val lines = head.split("\r\n")
                if (lines.isEmpty()) return
                val parts = lines[0].split(" ")
                if (parts.size < 2) return
                val method = parts[0]
                val target = parts[1]
                val out = BufferedOutputStream(sock.getOutputStream())
                if (method != "GET") {
                    write(out, 405, "text/plain; charset=utf-8", "solo GET".toByteArray(Charsets.UTF_8))
                    return
                }
                val path = if (target.contains('?')) target.substring(0, target.indexOf('?')) else target
                serve(path, out)
            }
        } catch (e: Exception) {
            log("http: " + (e.message ?: e.toString()))
        }
    }

    private fun serve(path: String, out: BufferedOutputStream) {
        var rel = path.trimStart('/')
        if (rel.isEmpty()) rel = "index.html"
        if (rel.contains("..")) {
            write(out, 403, "text/plain; charset=utf-8", "prohibido".toByteArray(Charsets.UTF_8))
            return
        }
        val bytes = try {
            assets.open("viewer/" + rel).use { it.readBytes() }
        } catch (e: Exception) {
            log("http 404: " + rel)
            write(out, 404, "text/plain; charset=utf-8", ("no encontrado: " + rel).toByteArray(Charsets.UTF_8))
            return
        }
        if (served == 0L) log("el visor ha pedido su primera pagina (" + rel + ")")
        served++
        write(out, 200, contentType(rel), bytes)
    }

    private fun write(out: BufferedOutputStream, status: Int, type: String, body: ByteArray) {
        val head = "HTTP/1.1 " + status + " " + statusText(status) + "\r\n" +
            "Content-Type: " + type + "\r\n" +
            "Content-Length: " + body.size + "\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n"
        out.write(head.toByteArray(Charsets.UTF_8))
        out.write(body)
        out.flush()
    }

    private fun readHead(input: InputStream): String? {
        val buf = StringBuilder()
        var last4 = 0
        while (buf.length < 16384) {
            val b = input.read()
            if (b < 0) return if (buf.isEmpty()) null else buf.toString()
            buf.append(b.toChar())
            last4 = (last4 shl 8) or (b and 0xff)
            if (last4 == 0x0d0a0d0a) return buf.toString()
        }
        return null
    }

    private fun statusText(status: Int): String = when (status) {
        200 -> "OK"; 403 -> "Forbidden"; 404 -> "Not Found"; 405 -> "Method Not Allowed"
        else -> "OK"
    }

    private fun contentType(rel: String): String {
        val name = rel.substringAfterLast('/').lowercase()
        val ext = if (name.contains('.')) name.substringAfterLast('.') else ""
        return when (ext) {
            "html", "htm" -> "text/html; charset=utf-8"
            "js", "mjs" -> "text/javascript; charset=utf-8"
            "css" -> "text/css; charset=utf-8"
            "json" -> "application/json; charset=utf-8"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "webp" -> "image/webp"
            "gif" -> "image/gif"
            "wasm" -> "application/wasm"
            "txt", "md" -> "text/plain; charset=utf-8"
            else -> "application/octet-stream"
        }
    }
}
