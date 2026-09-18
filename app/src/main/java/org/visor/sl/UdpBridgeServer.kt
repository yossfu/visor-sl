// UdpBridgeServer.kt -- el puente de datagramas UDP dentro de la app.
//
// POR QUE EXISTE
// --------------
// Un navegador no puede abrir un socket UDP: no hay API. Y sin UDP no se puede
// hablar con un simulador de Second Life, porque el protocolo del mundo (LLUDP)
// ES UDP. La solucion mas corta es NO meter el protocolo aqui dentro: este
// fichero solo mueve bytes.
//
//   visor JS (WebView)  ──WebSocket──►  ESTE PUENTE  ──UDP──►  simulador de SL
//
// El protocolo completo (circuito, acks, reenvios, terreno DCT, prims, avatares,
// chat) lo lleva `viewer/src/sl/lludp/`, que es el MISMO codigo que corre en el
// navegador y que se prueba entero con el simulador de `lludp/sim.js`. Aqui solo
// hay un DatagramSocket y un WebSocketServer.
//
// EL PROTOCOLO DEL PUENTE (el mismo que espera viewer/src/sl/lludp/udp.js)
// ------------------------------------------------------------------------
//   (texto)  {"cmd":"connect","host":"1.2.3.4","port":9000}
//         -> se abre un DatagramSocket local; se contesta
//            {"ok":true,"localPort":51234}
//        Con host vacio o puerto 0 se abre igual, pero sin destino fijo: es el
//        modo "escucha cualquiera" que hara falta para los teletransportes.
//   (binario) una trama = UN datagrama, en los dos sentidos, sin tocar nada.
//   (texto)  {"cmd":"close"}   -> se cierra el DatagramSocket.
//   (texto)  {"cmd":"status"}  -> el puente contesta con {"status":"..."} y el
//                                 visor lo apunta en su registro.
//
// EL SOCKET NO SE "CONECTA"
// -------------------------
// A proposito: `DatagramSocket()` sin `connect()`. El simulador de Second Life
// contesta desde puertos distintos del mismo IP segun el mensaje, asi que un
// socket conectado (que descarta todo lo que no venga de la direccion fijada)
// perderia respuestas. Se envia a host:puerto explicito y se recibe de
// cualquiera; el numero de puerto local es el que el simulador usa para
// identificar al cliente, exactamente como hace un visor de verdad.

package org.visor.sl

import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketException
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap

class UdpBridgeServer(
    // El puerto del propio puente (WebSocket). NO se llama `port` para no chocar
    // con `WebSocketServer.getPort()` (ver la explicacion en RelayServer.kt).
    private val bridgePort: Int,
    private val log: (String) -> Unit,
) : WebSocketServer(InetSocketAddress("127.0.0.1", bridgePort)) {

    // Un datagrama de LLUDP no pasa de ~1400 bytes, pero el buffer va holgado:
    // un datagrama truncado se decodificaria como un mensaje corrupto, y eso es
    // mucho peor que gastar unos kilobytes de mas.
    private val tamBuffer = 8192

    // Un puente por conexion: cada pestana del visor tiene su propio socket UDP
    // y su propio puerto local.
    private class Puente(val conn: WebSocket) {
        @Volatile var socket: DatagramSocket? = null
        @Volatile var hilo: Thread? = null
        @Volatile var host: String = ""
        @Volatile var port: Int = 0
        @Volatile var localPort: Int = 0
        @Volatile var cerrando: Boolean = false

        // Contadores para el informe de depuracion (y para el `{"cmd":"status"}`).
        @Volatile var datagramasIn: Long = 0
        @Volatile var datagramasOut: Long = 0
        @Volatile var bytesIn: Long = 0
        @Volatile var bytesOut: Long = 0
        @Volatile var descartes: Long = 0
        @Volatile var ultimoRecv: Long = 0
        @Volatile var ultimoEnvio: Long = 0

        fun abierto(): Boolean {
            val s = socket
            return s != null && !s.isClosed
        }

        fun cerrar() {
            cerrando = true
            try { socket?.close() } catch (e: Exception) { /* ya cerrado */ }
            socket = null
            val h = hilo
            hilo = null
            if (h != null) { try { h.join(400) } catch (e: InterruptedException) { /* da igual */ } }
        }

        fun resumen(): String {
            val s = socket?.localPort ?: localPort
            return "puerto local " + s + " -> " + (if (host.isEmpty()) "(cualquiera)" else host + ":" + port) +
                " · recibidos " + datagramasIn + " (" + bytesIn + " B)" +
                " · enviados " + datagramasOut + " (" + bytesOut + " B)" +
                (if (descartes > 0) " · descartados " + descartes else "")
        }
    }

    private val puentes = ConcurrentHashMap<WebSocket, Puente>()

    override fun onStart() {
        log("puente UDP escuchando en 127.0.0.1:" + bridgePort)
    }

    override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
        puentes[conn] = Puente(conn)
        log("puente UDP: el visor se ha conectado desde " + conn.remoteSocketAddress)
    }

    override fun onClose(conn: WebSocket, code: Int, reason: String, remote: Boolean) {
        val p = puentes.remove(conn)
        if (p != null) {
            log("puente UDP: el visor se ha ido (" + p.resumen() + ")")
            p.cerrar()
        }
    }

    override fun onError(conn: WebSocket?, ex: Exception) {
        log("puente UDP: error del enlace: " + (ex.message ?: ex.toString()))
        if (conn != null) {
            val p = puentes.remove(conn)
            p?.cerrar()
        }
    }

    // --- texto: las ordenes del puente ---------------------------------------

    override fun onMessage(conn: WebSocket, message: String) {
        val p = puentes[conn] ?: Puente(conn).also { puentes[conn] = it }
        val cmd = try {
            org.json.JSONObject(message).optString("cmd", "")
        } catch (e: Exception) {
            log("puente UDP: orden ilegible (se ignora): " + message.take(60))
            return
        }
        when (cmd) {
            "connect" -> conectar(conn, p, message)
            "close" -> {
                log("puente UDP: cerrado a peticion del visor (" + p.resumen() + ")")
                p.cerrar()
            }
            "status" -> responder(conn, "{\"status\":" + json(p.resumen()) + "}")
            else -> log("puente UDP: orden desconocida «" + cmd + "»")
        }
    }

    private fun conectar(conn: WebSocket, p: Puente, message: String) {
        val json = try { org.json.JSONObject(message) } catch (e: Exception) { null }
        val host = (json?.optString("host", "") ?: "").trim()
        val port = json?.optInt("port", 0) ?: 0

        // Repetir `connect` reutiliza el socket: el visor llama a `connect` otra
        // vez tras un teletransporte para reapuntar el mismo puerto local.
        val ya = p.socket
        if (ya != null && !ya.isClosed) {
            p.host = host
            p.port = port
            log("puente UDP: reapuntado a " + (if (host.isEmpty()) "(cualquiera)" else host + ":" + port) +
                " sin cambiar de puerto local")
            responder(conn, "{\"ok\":true,\"localPort\":" + ya.localPort + "}")
            return
        }

        val s = try { DatagramSocket(0, InetAddress.getByName("127.0.0.1")) } catch (e: Exception) {
            val detalle = e.message ?: e.toString()
            log("puente UDP: no se pudo abrir el socket UDP: " + detalle)
            responder(conn, "{\"error\":" + json("no se pudo abrir el socket UDP: " + detalle) + "}")
            return
        }
        // Un buffer de recepcion grande evita perder datagramas en rafagas
        // (justo cuando llega la region entera al entrar). Si el sistema no lo
        // concede, no pasa nada: se sigue con el de por defecto.
        try { s.receiveBufferSize = 1 shl 20 } catch (e: SocketException) { /* lo que haya */ }
        try { s.soTimeout = 500 } catch (e: SocketException) { /* lo que haya */ }

        p.socket = s
        p.host = host
        p.port = port
        p.localPort = s.localPort
        p.cerrando = false

        val hilo = Thread({ recibir(p, s) }, "puente-udp-recibe")
        hilo.isDaemon = true
        hilo.priority = Thread.NORM_PRIORITY + 2
        p.hilo = hilo
        hilo.start()

        log("puente UDP: socket listo en el puerto local " + s.localPort +
            ", destino " + (if (host.isEmpty()) "(cualquiera)" else host + ":" + port))
        responder(conn, "{\"ok\":true,\"localPort\":" + s.localPort + "}")
    }

    // --- binario: un datagrama por trama --------------------------------------

    override fun onMessage(conn: WebSocket, message: ByteBuffer) {
        val p = puentes[conn] ?: return
        val s = p.socket
        if (s == null || s.isClosed) {
            p.descartes++
            if (p.descartes == 1L || p.descartes % 50L == 0L) {
                log("puente UDP: datagramas descartados (no hay socket): " + p.descartes)
            }
            return
        }
        val datos = ByteArray(message.remaining())
        message.get(datos)
        if (datos.isEmpty()) return
        if (p.host.isEmpty() || p.port == 0) {
            p.descartes++
            if (p.descartes == 1L || p.descartes % 50L == 0L) {
                log("puente UDP: sin destino al que mandar (esperando un teletransporte): " + p.descartes)
            }
            return
        }
        try {
            val dst = InetAddress.getByName(p.host)
            s.send(DatagramPacket(datos, datos.size, dst, p.port))
            p.datagramasOut++
            p.bytesOut += datos.size
            p.ultimoEnvio = System.currentTimeMillis()
        } catch (e: Exception) {
            p.descartes++
            log("puente UDP: no se pudo enviar (" + (e.message ?: e.toString()) + ")")
        }
    }

    // --- el lado UDP que sube -------------------------------------------------

    private fun recibir(p: Puente, s: DatagramSocket) {
        val buf = ByteArray(tamBuffer)
        val pkt = DatagramPacket(buf, buf.size)
        while (!p.cerrando && !s.isClosed) {
            pkt.length = buf.size
            try {
                s.receive(pkt)
            } catch (e: SocketTimeoutException) {
                continue
            } catch (e: Exception) {
                if (p.cerrando || s.isClosed) break
                log("puente UDP: error al recibir: " + (e.message ?: e.toString()))
                break
            }
            val n = pkt.length
            if (n <= 0) continue
            p.datagramasIn++
            p.bytesIn += n
            p.ultimoRecv = System.currentTimeMillis()
            // El servidor de WebSocket escribe desde su propio hilo, asi que se
            // serializa el envio: dos `send` a la vez en la misma conexion no
            // estan garantizados.
            try {
                synchronized(p.conn) {
                    p.conn.send(ByteBuffer.wrap(buf, pkt.offset, n))
                }
            } catch (e: Exception) {
                if (!p.cerrando) log("puente UDP: no se pudo subir el datagrama: " + (e.message ?: e.toString()))
                break
            }
        }
    }

    private fun responder(conn: WebSocket, texto: String) {
        try { synchronized(conn) { conn.send(texto) } } catch (e: Exception) { /* el visor ya no esta */ }
    }

    // --- para el informe de depuracion ---------------------------------------

    fun resumen(): String {
        val activos = puentes.values.filter { it.abierto() }
        return if (activos.isEmpty()) "puente UDP: sin puentes abiertos (escuchando en " + bridgePort + ")"
        else "puente UDP: " + activos.joinToString(" | ") { it.resumen() }
    }

    // JSON minimo: escapa lo justo para que el texto no rompa el objeto. Sin
    // librerias: es una linea o dos al informe.
    private fun json(s: String): String {
        val sb = StringBuilder(s.length + 2)
        sb.append('"')
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (c < ' ') sb.append("\\u").append(String.format("%04x", c.code)) else sb.append(c)
            }
        }
        sb.append('"')
        return sb.toString()
    }
}
