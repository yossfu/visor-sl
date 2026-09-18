// ViewerServer.kt -- sirve el visor (HTML+JS+Css) desde los assets de la app.
//
// POR QUE UN SERVIDOR Y NO file://
// Los modulos ES y los `fetch("src/...")` del visor no funcionan bien desde
// file:// (origen opaco, sin fetch relativo fiable). Un servidor diminuto en
// 127.0.0.1 da un ORIGEN estable (http://127.0.0.1:<puerto>) en el que el visor
// se comporta igual que en la web: modulos, IndexedDB y WebSocket a
// ws://127.0.0.1:<puerto> sin mezcla de contenido.
//
// TAMBIEN ES EL PUENTE DE RED (`/proxy?url=...`).
// El WebView aplica CORS igual que Chrome, y los servidores de Second Life no
// mandan cabeceras CORS: `https://login.agni.lindenlab.com/cgi-bin/login.cgi`
// responde bien a curl, pero el navegador descarta la respuesta y `fetch` muere
// con un "Failed to fetch" que no dice nada. Eso no se arregla desde JavaScript
// (ni con cabeceras, ni con `mode`, ni con mixedContentMode): la peticion tiene
// que salir de fuera del navegador. Aqui la hace Kotlin y el visor se la pide a
// NUESTRO origen (`/proxy?url=...`), que es el mismo que el de la pagina, asi
// que el navegador no tiene nada que comprobar. Es el equivalente local del
// plugin `super-fetch` de perchance; lo usa `root.superFetch` (ver `env.js`).

package org.visor.sl

import android.content.res.AssetManager
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.net.URLDecoder

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

    // Cuantas peticiones externas ha hecho el puente, para el registro.
    private var proxied = 0L

    private companion object {
        // Tope de tamaño de una respuesta que se trae el puente (32 MiB: sobra
        // para el XML del login y para cualquier malla del CDN de SL).
        const val MAX_RESPUESTA = 32 * 1024 * 1024

        // Linden Lab mira el user-agent en algunos cortafuegos; uno honesto.
        const val AGENTE = "VisorSL/0.1.0 (Android)"
    }

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
                val path = if (target.contains('?')) target.substring(0, target.indexOf('?')) else target

                // El puente: todo lo que el visor necesite pedir fuera del
                // aparato entra por aqui (ver la cabecera de este archivo).
                if (path == "/proxy" || path == "/proxy/") {
                    proxy(target, method, input, lines, out)
                    return
                }

                if (method != "GET") {
                    write(out, 405, "text/plain; charset=utf-8", "solo GET".toByteArray(Charsets.UTF_8))
                    return
                }
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

    // --- el puente de red ---------------------------------------------------
    //
    // GET/POST /proxy?url=https%3A%2F%2F...  ->  la peticion de verdad la hace
    // Kotlin y devuelve cuerpo, estado y content-type tal cual. Desde el visor
    // se pide a un camino del MISMO origen, asi que el WebView no aplica CORS.

    private fun proxy(
        target: String,
        method: String,
        input: InputStream,
        lines: List<String>,
        out: BufferedOutputStream,
    ) {
        // Preflight: con peticiones del mismo origen no llega nunca, pero si
        // algun dia el visor pide el puente desde otro origen hay que contestar.
        if (method == "OPTIONS") {
            writeCors(out, 204, "text/plain; charset=utf-8", ByteArray(0))
            return
        }

        val raw = queryParam(target, "url")
        if (raw.isNullOrBlank()) {
            writeCors(out, 400, "text/plain; charset=utf-8", "falta ?url=".toByteArray(Charsets.UTF_8))
            return
        }

        val destino = try { URL(raw) } catch (e: Exception) {
            writeCors(out, 400, "text/plain; charset=utf-8", ("direccion invalida: " + raw).toByteArray(Charsets.UTF_8))
            return
        }
        if (destino.protocol != "http" && destino.protocol != "https") {
            writeCors(out, 400, "text/plain; charset=utf-8", "el puente solo habla http y https".toByteArray(Charsets.UTF_8))
            return
        }

        val cuerpo = readRequestBody(input, headerValue(lines, "Content-Length"))
        var abierta: HttpURLConnection? = null
        try {
            // `c` es una constante: asi Kotlin sabe que no es nula en cada linea.
            val c = destino.openConnection() as HttpURLConnection
            abierta = c
            c.requestMethod = method
            c.connectTimeout = 20000
            c.readTimeout = 90000
            c.instanceFollowRedirects = true
            c.setRequestProperty("User-Agent", AGENTE)
            c.setRequestProperty("Accept", headerValue(lines, "Accept") ?: "*/*")
            val tipoPeticion = headerValue(lines, "Content-Type")
            if (tipoPeticion != null) c.setRequestProperty("Content-Type", tipoPeticion)
            if (cuerpo != null && cuerpo.isNotEmpty()) {
                c.doOutput = true
                c.setFixedLengthStreamingMode(cuerpo.size)
                c.outputStream.use { it.write(cuerpo) }
            }

            val estado = c.responseCode
            val flujo = if (estado >= 400) c.errorStream else c.inputStream
            val bytes = (try { flujo?.use { readAll(it) } } catch (e: Exception) { null }) ?: ByteArray(0)
            val tipo = c.contentType ?: "application/octet-stream"

            proxied++
            if (proxied == 1L) log("el puente ha hecho su primera peticion externa (" + destino.host + ")")
            writeCors(out, estado, tipo, bytes)
        } catch (e: Exception) {
            val msg = e.message ?: e.toString()
            log("puente: " + raw + " -> " + msg)
            val texto = "El puente de la app no pudo pedir " + raw + ": " + msg
            writeCors(out, 502, "text/plain; charset=utf-8", texto.toByteArray(Charsets.UTF_8))
        } finally {
            try { abierta?.disconnect() } catch (e: Exception) { /* ya da igual */ }
        }
    }

    // Cuerpo de la peticion que llega (el XML del login, por ejemplo). Si el
    // navegador no manda Content-Length, se asume que no hay cuerpo.
    private fun readRequestBody(input: InputStream, contentLength: String?): ByteArray? {
        val n = contentLength?.trim()?.toIntOrNull() ?: return null
        if (n <= 0) return ByteArray(0)
        if (n > MAX_RESPUESTA) return null
        val buf = ByteArray(n)
        var leido = 0
        while (leido < n) {
            val r = input.read(buf, leido, n - leido)
            if (r < 0) break
            leido += r
        }
        return if (leido == n) buf else buf.copyOf(leido)
    }

    private fun readAll(input: InputStream): ByteArray {
        val buf = ByteArrayOutputStream()
        val trozo = ByteArray(16384)
        var total = 0
        while (true) {
            val r = input.read(trozo)
            if (r < 0) break
            total += r
            if (total > MAX_RESPUESTA) throw IOException("respuesta mayor de " + (MAX_RESPUESTA / 1024 / 1024) + " MiB")
            buf.write(trozo, 0, r)
        }
        return buf.toByteArray()
    }

    private fun queryParam(target: String, name: String): String? {
        val q = target.indexOf('?')
        if (q < 0) return null
        for (par in target.substring(q + 1).split('&')) {
            val i = par.indexOf('=')
            val clave = if (i < 0) par else par.substring(0, i)
            if (clave != name) continue
            val valor = if (i < 0) "" else par.substring(i + 1)
            return try { URLDecoder.decode(valor, "UTF-8") } catch (e: Exception) { valor }
        }
        return null
    }

    private fun headerValue(lines: List<String>, name: String): String? {
        for (i in 1 until lines.size) {
            val l = lines[i]
            val c = l.indexOf(':')
            if (c <= 0) continue
            if (l.substring(0, c).trim().equals(name, ignoreCase = true)) return l.substring(c + 1).trim()
        }
        return null
    }

    // Respuesta con permiso explicito de CORS. Con peticiones del mismo origen
    // no hace falta, pero deja el puente usable aunque algun dia el visor viva
    // en otro dominio.
    private fun writeCors(out: BufferedOutputStream, status: Int, type: String, body: ByteArray) {
        val head = "HTTP/1.1 " + status + " " + statusText(status) + "\r\n" +
            "Content-Type: " + type + "\r\n" +
            "Content-Length: " + body.size + "\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Access-Control-Allow-Headers: *\r\n" +
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n"
        out.write(head.toByteArray(Charsets.UTF_8))
        out.write(body)
        out.flush()
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
        200 -> "OK"; 201 -> "Created"; 204 -> "No Content"; 301 -> "Moved Permanently"
        302 -> "Found"; 303 -> "See Other"; 304 -> "Not Modified"; 307 -> "Temporary Redirect"
        308 -> "Permanent Redirect"; 400 -> "Bad Request"; 401 -> "Unauthorized"
        403 -> "Forbidden"; 404 -> "Not Found"; 405 -> "Method Not Allowed"
        408 -> "Request Timeout"; 429 -> "Too Many Requests"; 500 -> "Internal Server Error"
        502 -> "Bad Gateway"; 503 -> "Service Unavailable"; 504 -> "Gateway Timeout"
        else -> "Status"
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
