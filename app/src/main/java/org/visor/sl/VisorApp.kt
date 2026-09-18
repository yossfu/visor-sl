// VisorApp.kt -- lo PRIMERO que corre en el proceso: forzar IPv4.
//
// QUE SE APRENDIO DEL VISOR ANTIGUO (Lumiya)
// -----------------------------------------
// El usuario apunto al visor antiguo de Second Life para Android (Lumiya, cuya
// red se conserva en https://github.com/Kaleaon/Linkpoint) porque "esa app
// funcionaba y sigue funcionando para el login". Y tiene razon: mirando su
// `SLConnection.java` (la clase que abre el canal UDP) lo primero que hace el
// constructor es esto, ANTES de crear ningun socket:
//
//     System.setProperty("java.net.preferIPv4Stack", "true");
//     System.setProperty("java.net.preferIPv6Addresses", "false");
//
// Y Linkpoint, que es un visor moderno y ha depurado esto con capturas de
// trafico reales en movil, lo explica con todas las letras (`UDPConnectionFixed`):
//
//   "Second Life simulators only listen on IPv4. On cellular networks, Android
//    may create a dual-stack (IPv6) socket by default. When connecting to an
//    IPv4 simulator address from a dual-stack socket over cellular CGNAT,
//    outgoing packets are sent as IPv4-mapped IPv6 but return packets may not
//    be routed back correctly through the carrier's NAT. This causes 'packets
//    sent but none received.'"
//
// Es decir: el sintoma exacto que tenemos (el visor manda datagramas y no vuelve
// ninguno) es lo que pasa cuando el socket nace IPv6 de doble pila. Se sale por
// la red movil como IPv4-metido-en-IPv6, el NAT de la operadora no sabe devolver
// la respuesta, y todo parece "un puerto cerrado del simulador" sin serlo.
//
// POR QUE HAY QUE HACERLO TAN PRONTO
// ----------------------------------
// `java.net.preferIPv4Stack` se lee cuando se cargan las clases de red (es un
// campo estatico). Ponerlo despues de haber usado cualquier socket no sirve de
// nada. Por eso va en `Application.onCreate`, que es lo primero que corre en
// nuestro proceso, y ademas como primera linea de `MainActivity.onCreate`, por
// si acaso. El puente UDP (`UdpBridgeServer`) lo comprueba y, si aun asi el
// socket saliera IPv6, abre uno IPv4 explicito.
//
// (No hay riesgo de romper nada: este visor solo habla con direcciones IPv4 --
// la IP del simulador viene del login de Second Life y siempre lo es.)

package org.visor.sl

import android.app.Application

// Fuerza la pila IPv4 del proceso. Devuelve la linea que va al informe, porque
// el informe del movil es donde se mira esto cuando algo no llega.
fun forzarIPv4(): String {
    return try {
        System.setProperty("java.net.preferIPv4Stack", "true")
        System.setProperty("java.net.preferIPv6Addresses", "false")
        "red: pila IPv4 forzada (preferIPv4Stack=true) antes de abrir ningun socket"
    } catch (e: Exception) {
        "red: no se pudo forzar la pila IPv4: " + (e.message ?: e.toString())
    }
}

// Lo que el sistema tiene puesto AHORA, para el informe: si esto dice `true`
// pero el socket sale IPv6, el problema esta en otro sitio.
fun estadoPilaIpv4(): String =
    "red: del sistema preferIPv4Stack=" + System.getProperty("java.net.preferIPv4Stack") +
        " preferIPv6Addresses=" + System.getProperty("java.net.preferIPv6Addresses")

class VisorApp : Application() {
    override fun onCreate() {
        forzarIPv4()
        super.onCreate()
    }
}
