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
//
// EL SOCKET NO SE ATA AL BUCLE (el fallo del 18-09-2026)
// ------------------------------------------------------
// Se abre con `DatagramSocket(0)` -- comodin 0.0.0.0 -- y NO con
// `DatagramSocket(0, 127.0.0.1)`. Un socket atado a 127.0.0.1 solo puede hablar
// por la interfaz de bucle: cualquier `sendto` hacia la IP publica de un
// simulador de Second Life lo rechaza el kernel con EINVAL ("Invalid argument")
// en el acto. El informe que mando el usuario desde el movil lo ensenaba con
// toda claridad -- el circuito abierto, el login hecho, y diez lineas seguidas
// de "puente UDP: no se pudo enviar (sendto failed: EINVAL)" con cero paquetes
// llegando del simulador --, porque la app estaba intentando salir a internet
// por el bucle. Se ata al comodin y el sistema elige puerto y direccion de
// origen, que es lo que hace cualquier visor de Second Life.
//
// Y como un fallo de envio no se puede distinguir "desde fuera" de un puerto
// bloqueado, el puente ahora AVISA al visor de ese fallo ({"sendError":...}),
// para que el informe del propio visor lo diga sin depender del registro nativo.
//
// IPv4 A LA FUERZA (lo que nos enseno el visor antiguo, Lumiya)
// -------------------------------------------------------------
// Quedaba un caso que este puente no cubria: el socket salia de doble pila
// (IPv6) y el simulador es siempre IPv4. En una red movil con CGNAT, un socket
// de doble pila manda los paquetes como IPv4-metido-en-IPv6 y la respuesta NO
// vuelve por el NAT de la operadora: "se envian paquetes y no llega ninguno",
// que es justo lo que se veia. Lumiya (la app antigua que si funcionaba) fuerza
// `java.net.preferIPv4Stack` en su constructor, antes de crear ningun socket, y
// el visor moderno Linkpoint documenta el mismo arreglo con capturas reales.
// Aqui se hace lo mismo (ver VisorApp.kt) y, ademas, ESTE fichero comprueba la
// familia: si el socket sale IPv6, lo descarta y abre uno IPv4 explicito
// (`DatagramChannel` de familia INET). La familia elegida va al informe.
//
// LA SONDA DE RED (`probe`)
// -------------------------
// Cierra la ultima duda posible: "¿este movil, en esta red, puede sacar un
// datagrama UDP y recibir la respuesta?". Se le dan bytes de peticion y un
// destino, manda uno y devuelve lo primero que llegue. El visor monta la
// peticion (un STUN publico) y lee la respuesta; aqui solo se mueven bytes,
// igual que en el resto del puente.

package org.visor.sl

import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import android.os.Build
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.StandardProtocolFamily
import java.nio.ByteBuffer
import java.nio.channels.DatagramChannel
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
        // Fallos de `send` (no de la red de arriba): si el socket no puede
        // sacar los datagramas, esto es lo unico que lo dice.
        @Volatile var fallosEnvio: Long = 0
        @Volatile var ultimoFallo: String = ""
        @Volatile var avisoEnvio: Boolean = false
        // Familia del socket local: "IPv4" o "IPv6". Es el dato que decide si
        // el simulador puede contestar o no (ver la cabecera del fichero).
        @Volatile var familia: String = ""

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
            return "puerto local " + s + " (" + (if (familia.isEmpty()) "familia ?" else familia) + ")" +
                " -> " + (if (host.isEmpty()) "(cualquiera)" else host + ":" + port) +
                " · recibidos " + datagramasIn + " (" + bytesIn + " B)" +
                " · enviados " + datagramasOut + " (" + bytesOut + " B)" +
                (if (descartes > 0) " · descartados " + descartes else "") +
                (if (fallosEnvio > 0) " · FALLOS DE ENVIO " + fallosEnvio + " (" + ultimoFallo + ")" else "")
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
            "probe" -> sonda(conn, message)
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

        val s = try { abrirSocketUdp() } catch (e: Exception) {
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
        p.familia = familiaDe(s)

        val hilo = Thread({ recibir(p, s) }, "puente-udp-recibe")
        hilo.isDaemon = true
        hilo.priority = Thread.NORM_PRIORITY + 2
        p.hilo = hilo
        hilo.start()

        // La familia del socket va en la misma linea que el resto: es el dato
        // que hay que mirar primero en el informe si el simulador no contesta.
        val familiaDestino = try {
            val a = InetAddress.getByName(host)
            if (a.address.size == 16) "IPv6" else "IPv4"
        } catch (e: Exception) {
            "no resuelta (" + (e.message ?: e.toString()) + ")"
        }
        log("puente UDP: socket listo en " + (s.localAddress.hostAddress ?: "?") + ":" + s.localPort +
            " (" + p.familia + ")" +
            ", destino " + (if (host.isEmpty()) "(cualquiera)" else host + ":" + port + " (" + familiaDestino + ")"))
        log(estadoPilaIpv4())
        responder(conn, "{\"ok\":true,\"localPort\":" + s.localPort + ",\"familia\":" + json(p.familia) + "}")
    }

    private fun familiaDe(s: DatagramSocket): String =
        if (s.localAddress != null && s.localAddress.address.size == 16) "IPv6" else "IPv4"

    // El socket de salida: comodin (0.0.0.0), puerto efimero, IPv4 a la fuerza.
    // Ni `connect()` ni atadura al bucle; ver la cabecera.
    //
    // La familia de la direccion importa mucho mas de lo que parece: un socket
    // de doble pila (IPv6) que manda a la IP IPv4 de un simulador sale del movil
    // como IPv4-metido-en-IPv6, y con el NAT de la operadora movil la respuesta
    // no vuelve. Lumiya lo resolvio forzando `preferIPv4Stack` antes de crear
    // ningun socket (VisorApp.kt hace lo mismo); aqui, ademas, se MIRA la
    // familia del socket recien abierto y, si ha salido IPv6, se descarta y se
    // abre uno IPv4 explicito. Es la diferencia entre "el simulador no
    // responde" y que responda.
    private fun abrirSocketUdp(): DatagramSocket {
        val comun = DatagramSocket(0)
        if (familiaDe(comun) == "IPv4") return comun

        // Ha salido IPv6. Se intenta un canal de familia INET (API 26+).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                val canal = DatagramChannel.open(StandardProtocolFamily.INET)
                canal.bind(InetSocketAddress(InetAddress.getByName("0.0.0.0"), 0))
                val s = canal.socket()
                if (familiaDe(s) == "IPv4") {
                    try { comun.close() } catch (e: Exception) { /* da igual */ }
                    log("puente UDP: el socket salio IPv6; se descarta y se abre uno IPv4 explicito (DatagramChannel INET)")
                    return s
                }
                log("puente UDP: el canal INET tampoco dio IPv4 (" + (s.localAddress?.hostAddress ?: "?") + ")")
                try { s.close() } catch (e: Exception) { /* da igual */ }
            } catch (e: Throwable) {
                // `Throwable` y no `Exception`: si esta version de Android no
                // tuviera el canal de familia INET, seria un `Error` (no una
                // excepcion) y tumbaría el hilo del puente.
                log("puente UDP: no se pudo abrir un socket IPv4 explicito: " + (e.message ?: e.toString()))
            }
        }
        log("puente UDP: aviso, el socket SIGUE siendo IPv6; si el simulador no recibe nada, esta es la causa")
        return comun
    }

    // --- la sonda de red (`probe`) --------------------------------------------
    //
    // La ultima duda que se puede cerrar sin tener un simulador delante: "¿este
    // movil, en esta red, saca un datagrama UDP y le vuelve la respuesta?".
    // Se manda lo que pida el visor a la direccion que pida el visor y se
    // devuelve lo primero que llegue. Aqui no se entiende el contenido: el visor
    // manda una peticion STUN (un servicio publico que solo hace eco de la
    // direccion de origen) y lee la respuesta; este fichero solo mueve bytes,
    // igual que en el resto del puente.
    //
    //   -> {"cmd":"probe","host":"stun.l.google.com","port":19302,"datos":[0,1,...]}
    //   <- {"probe":{"ok":true,"ms":123,"local":"0.0.0.0:53100","familia":"IPv4",
    //                "de":"1.2.3.4:19302","datos":[...]}}
    //   <- {"probe":{"ok":false,"ms":2505,"local":"...","familia":"...","error":"..."}}
    //
    // Un socket propio y de un solo uso: si el socket del circuito tiene la
    // familia equivocada, la sonda lo delata con sus propios datos (la familia
    // que va en la respuesta es la del socket de la sonda, abierto por el mismo
    // camino que el del circuito).
    private fun sonda(conn: WebSocket, message: String) {
        val j = try { org.json.JSONObject(message) } catch (e: Exception) { null }
        val host = (j?.optString("host", "") ?: "").trim()
        val puerto = j?.optInt("port", 0) ?: 0
        val arr = j?.optJSONArray("datos")
        if (host.isEmpty() || puerto <= 0 || arr == null || arr.length() == 0) {
            responder(conn, "{\"probe\":{\"ok\":false,\"error\":\"faltan host, port o datos\"}}")
            return
        }
        val datos = ByteArray(arr.length())
        for (i in 0 until arr.length()) datos[i] = arr.optInt(i, 0).toByte()

        Thread({
            val t0 = System.currentTimeMillis()
            var fallo = ""
            var recibido: ByteArray? = null
            var de = ""
            var local = ""
            var familia = ""
            var s: DatagramSocket? = null
            try {
                val sock = abrirSocketUdp()
                s = sock
                local = (sock.localAddress?.hostAddress ?: "?") + ":" + sock.localPort
                familia = familiaDe(sock)
                sock.soTimeout = 2500
                val dst = InetAddress.getByName(host)
                sock.send(DatagramPacket(datos, datos.size, dst, puerto))
                val buf = ByteArray(1200)
                val pkt = DatagramPacket(buf, buf.size)
                sock.receive(pkt)
                recibido = pkt.data.copyOfRange(pkt.offset, pkt.offset + pkt.length)
                de = (pkt.address?.hostAddress ?: "?") + ":" + pkt.port
            } catch (e: Exception) {
                fallo = e.message ?: e.toString()
            } finally {
                try { s?.close() } catch (e: Exception) { /* da igual */ }
            }
            val ms = System.currentTimeMillis() - t0
            val r = recibido
            val cuerpo = if (r != null) {
                "{\"ok\":true,\"ms\":" + ms + ",\"local\":" + json(local) +
                    ",\"familia\":" + json(familia) + ",\"de\":" + json(de) +
                    ",\"datos\":[" + r.joinToString(",") { (it.toInt() and 255).toString() } + "]}"
            } else {
                "{\"ok\":false,\"ms\":" + ms + ",\"local\":" + json(local) +
                    ",\"familia\":" + json(familia) + ",\"error\":" +
                    json(if (fallo.isEmpty()) "sin respuesta" else fallo) + "}"
            }
            log("puente UDP: sonda a " + host + ":" + puerto + " -> " +
                (if (r != null) "respuesta de " + de + " en " + ms + " ms (" + r.size + " B)" else "SIN respuesta en " + ms + " ms (" + fallo + ")"))
            responder(conn, "{\"probe\":" + cuerpo + "}")
        }, "puente-udp-sonda").apply { isDaemon = true }.start()
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
            p.fallosEnvio++
            p.ultimoFallo = e.message ?: e.toString()
            // El primer fallo (y luego uno de cada diez) va al registro con el
            // destino y el tamano: es lo que hace falta para saber si el
            // problema es la red o el socket. No se escribe uno por datagrama,
            // que el circuito reenvia cada pocos segundos y llenaria el informe.
            if (p.fallosEnvio == 1L || p.fallosEnvio % 10L == 0L) {
                log("puente UDP: no se pudo enviar (" + p.ultimoFallo + ") a " +
                    p.host + ":" + p.port + " · " + datos.size + " B · fallos: " + p.fallosEnvio)
            }
            // Y se le dice al visor, la primera vez: asi el informe del propio
            // visor dice "el puente no pudo enviar" en vez de dejar al usuario
            // pensando en un puerto bloqueado del simulador.
            if (!p.avisoEnvio) {
                p.avisoEnvio = true
                responder(p.conn, "{\"sendError\":" + json(p.ultimoFallo) +
                    ",\"host\":" + json(p.host) + ",\"port\":" + p.port +
                    ",\"localPort\":" + s.localPort + "}")
            }
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
