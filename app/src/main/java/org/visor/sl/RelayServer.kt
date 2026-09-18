// RelayServer.kt -- el retransmisor DENTRO de la app.
//
// El visor JS (que corre en el WebView) se conecta por WebSocket a
// ws://127.0.0.1:<puerto> y habla el protocolo de src/sl/relay.js. Este es el
// lado servidor de ese protocolo. Como vive en el MISMO proceso que el WebView,
// no hace falta ninguna app ni proceso aparte: es lo que hace autonoma a la
// app (ver src/ANDROID.md).
//
// FASE 1 (esto): el enlace funciona, se contesta el saludo y se atiende el
//   latido. Aun NO hay mundo: el nucleo que habla LLUDP con el simulador de
//   Second Life es la Fase 2.
// FASE 2: aqui dentro se abre el socket UDP, se hace el login, las
//   capabilities y la cola de eventos, y se traduce todo a las tramas S.* de
//   arranque. El visor no cambia ni una linea.

package org.visor.sl

import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import java.net.InetSocketAddress
import java.nio.ByteBuffer

class RelayServer(
    port: Int,
    private val log: (String) -> Unit,
) : WebSocketServer(InetSocketAddress("127.0.0.1", port)) {

    val port: Int get() = address.port

    // Cuenta de latidos: se apunta el primero y luego uno de cada 60, para que
    // el informe diga si el enlace sigue vivo sin llenar el registro.
    private var pings = 0L

    override fun onStart() {
        log("retransmisor interno escuchando en 127.0.0.1:$port")
    }

    override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
        pings = 0L
        log("visor conectado al retransmisor interno desde " + conn.remoteSocketAddress)
    }

    override fun onClose(conn: WebSocket, code: Int, reason: String, remote: Boolean) {
        log("visor desconectado (codigo $code)")
    }

    override fun onError(conn: WebSocket?, ex: Exception) {
        log("error del enlace: " + (ex.message ?: ex.toString()))
    }

    override fun onMessage(conn: WebSocket, message: String) {
        log("texto inesperado por el enlace (se ignora): " + message.take(60))
    }

    override fun onMessage(conn: WebSocket, message: ByteBuffer) {
        val data = ByteArray(message.remaining())
        message.get(data)
        if (data.isEmpty()) return
        val type = data[0].toInt() and 0xff
        when (type) {
            Frame.C_HELLO -> onHello(conn, data)
            Frame.C_LOGIN -> onLogin(conn, data)
            Frame.C_PING -> onPing(conn, data)
            Frame.C_LOGOUT -> conn.close(1000, "adios")
            Frame.C_CHAT, Frame.C_MOVE, Frame.C_INTERACT, Frame.C_TELEPORT,
            Frame.C_REQUEST, Frame.C_OBJECT_EDIT, Frame.C_PARCEL_EDIT,
            Frame.C_INVENTORY, Frame.C_GROUP_IM ->
                log("trama " + Frame.name(type) + " recibida (sin mundo todavia: Fase 2)")
            else -> log("trama desconocida: " + Frame.name(type))
        }
    }

    // El visor manda C.LOGIN en cuanto recibe el saludo (su session.js llama a
    // sendLogin al quedar el enlace listo). Aqui todavia no hay simulador, asi
    // que en vez de dejar la pantalla girando para siempre se contesta con un
    // error claro y se deja el enlace en "desconectado". Es honesto con el
    // usuario y ademas deja el log util para la Fase 2.
    private fun onLogin(conn: WebSocket, data: ByteArray) {
        val mode = try {
            val r = Reader.of(data)
            r.u8()
            val info = r.str32()
            if (info.contains("\"credentials\"")) "credentials" else "session"
        } catch (e: Exception) {
            "?"
        }
        log("peticion de entrada (modo " + mode + "): el nucleo nativo aun no habla LLUDP")

        // La contrasena no se registra NUNCA: solo se dice el modo de login.
        val aviso = "El nucleo nativo de la app todavia no habla con Second Life " +
            "(llega en la Fase 2). Mientras tanto puedes usar el simulador de pruebas " +
            "con el boton de «solo mirar»."
        conn.send(frame(Frame.S_ERROR).u8(1).str("fase-2").str(aviso).build())
        sendState(conn, Frame.PHASE_DISCONNECTED, 0, aviso)
    }

    // El saludo del visor: se contesta con la region (vacia por ahora) y el
    // estado. `authModes` incluye "credentials" porque en la app el login lo
    // hara el nucleo nativo (la contrasena va al retransmisor interno, que es
    // este mismo proceso).
    private fun onHello(conn: WebSocket, data: ByteArray) {
        // El cuerpo del saludo trae {protocol, client, version, capabilities}.
        // No hace falta para contestar, pero se anota el nombre del cliente.
        try {
            val r = Reader.of(data)
            r.u8()
            val json = r.str32()
            log("saludo del visor: " + json.take(120))
        } catch (e: Exception) {
            log("saludo del visor (ilegible): " + (e.message ?: ""))
        }

        val welcome = "{" +
            "\"protocol\":" + Frame.PROTOCOL + "," +
            "\"relay\":\"visor-android\"," +
            "\"mock\":false," +
            "\"authModes\":[\"credentials\",\"session\"]," +
            "\"region\":{\"name\":\"\",\"handle\":[0,0]}" +
            "}"
        conn.send(frame(Frame.S_WELCOME).json(welcome).build())
        sendState(
            conn,
            Frame.PHASE_HANDSHAKE,
            10,
            "Enlace interno listo. El nucleo LLUDP nativo llega en la Fase 2."
        )
    }

    private fun onPing(conn: WebSocket, data: ByteArray) {
        pings++
        if (pings == 1L || pings % 60L == 0L) log("latido del visor nº " + pings)
        val t = try {
            val r = Reader.of(data)
            r.u8()
            r.f64()
        } catch (e: Exception) {
            0.0
        }
        conn.send(
            frame(Frame.S_PONG).f64(t).f64(System.currentTimeMillis().toDouble()).build()
        )
    }

    private fun sendState(conn: WebSocket, phase: Int, progress: Int, text: String) {
        conn.send(frame(Frame.S_STATE).u8(phase).u8(progress).str(text).build())
    }
}
