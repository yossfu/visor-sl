// VisorDiag.kt -- el puente de DEPURACION E INFORMES de la app.
//
// POR QUE EXISTE
// El visor web (src/diag.js) sabe montar un informe muy completo: entorno,
// estado de los subsistemas, resumen de errores y el registro de consola. En un
// navegador eso se descarga o se copia. Dentro del APK, en cambio, no hay
// descargas fiables y el usuario necesita poder SACAR el informe del telefono
// para mandarlo y que se puedan arreglar los problemas. Este archivo es ese
// puente: expone `window.VisorDiag` al WebView y vuelca los informes a una
// carpeta del telefono, ademas de compartirlos.
//
// QUE EXPONE (window.VisorDiag)
//   info()                 -> JSON con los datos de la app/dispositivo y las
//                             ultimas lineas del registro NATIVO (lo que no ve
//                             la consola del navegador: arranque de servidores,
//                             pings del enlace, errores de HTTP...).
//   saveReport(nombre, txt) -> escribe el informe en <externo>/informes/ y
//                             devuelve la ruta.
//   shareReport(nombre, txt)-> escribe el informe y abre la hoja de compartir
//                             de Android (para mandarlo por donde quieras).
//   listReports()          -> JSON con los informes guardados.
//   readReport(nombre)     -> el texto de un informe guardado.
//   clearReports()         -> borra los informes guardados.
//   toast(texto)           -> un aviso breve en pantalla.
//   ping()                 -> devuelve true: sirve para comprobar el puente.
//   logNativo(texto)       -> una linea del visor en el registro NATIVO. La
//                             consola del WebView no se ve en el telefono (haría
//                             falta un cable y chrome://inspect), así que este
//                             es el camino para que lo que el visor descubre de
//                             la parte nativa (por ejemplo, si la salida a
//                             internet funciona) acabe en el informe.
//
// El puente es OPCIONAL para el visor: `diag.js` lo detecta y, si no esta,
// usa la descarga/copia del navegador. Aqui siempre esta.
//
// SEGURIDAD: la carpeta es la de la propia app (`getExternalFilesDir`), no hace
// falta ningun permiso de almacenamiento, y los informes NO contienen la
// contrasena (RelayServer.kt solo registra el MODO de login, nunca la clave).

package org.visor.sl

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.widget.Toast
import java.io.File
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale

// --- registro nativo ---------------------------------------------------------
// Un anillo corto en memoria con lo ultimo que ha dicho la parte nativa. Viaja
// dentro de `info()` para que el informe lo incluya: asi, cuando algo va mal en
// la app (no en el visor web), el informe tambien lo cuenta.
object VisorNativeLog {
    private const val MAX = 300
    private val lines = ArrayDeque<String>()
    private val fmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
    private var file: File? = null

    // La app llama a esto para apuntar la carpeta de informes. A partir de ahi,
    // cada linea se escribe tambien en `informes/nativo.log` (append), para que
    // sobreviva al cierre de la app.
    fun attach(dir: File) {
        try {
            if (!dir.exists()) dir.mkdirs()
            file = File(dir, "nativo.log")
        } catch (e: Exception) { file = null }
    }

    @Synchronized
    fun add(text: String) {
        val line = fmt.format(Date()) + "  " + text
        Log.i("VisorSL", text)
        lines.addLast(line)
        while (lines.size > MAX) lines.removeFirst()
        val f = file ?: return
        try { f.appendText(line + "\n") } catch (e: Exception) { /* el log nunca rompe la app */ }
    }

    @Synchronized
    fun tail(maxLines: Int = 120): String {
        val n = Math.min(maxLines, lines.size)
        return lines.toList().subList(lines.size - n, lines.size).joinToString("\n")
    }

    @Synchronized
    fun clear() { lines.clear() }
}

// --- el puente que ve el WebView ---------------------------------------------
class VisorDiagBridge(private val activity: Activity) {

    private val ui = Handler(Looper.getMainLooper())
    private val dir: File? get() = activity.getExternalFilesDir("informes")

    @JavascriptInterface
    fun ping(): Boolean = true

    // Una linea del visor en el registro nativo (y por tanto en el informe).
    // Sirve para lo que solo el visor sabe y solo el registro nativo enseña: la
    // consola del WebView no es visible en el telefono.
    @JavascriptInterface
    fun logNativo(texto: String) {
        VisorNativeLog.add("[visor] " + texto.take(400))
    }

    // Datos que el visor mete en la cabecera del informe ("app nativa",
    // "dispositivo", "carpeta de informes", ...) y el registro nativo.
    @JavascriptInterface
    fun info(): String {
        val d = dir
        if (d != null && !d.exists()) d.mkdirs()
        VisorNativeLog.attach(d ?: return basicInfo(false))
        return buildInfo(d)
    }

    private fun basicInfo(withDir: Boolean): String = buildInfo(if (withDir) dir else null)

    private fun buildInfo(d: File?): String {
        val dm = activity.resources.displayMetrics
        val sb = StringBuilder()
        sb.append("{")
        sb.append("\"app\":\"").append(esc("Visor SL " + appVersionName())).append("\",")
        sb.append("\"android\":\"").append(esc(Build.VERSION.RELEASE ?: "?")).append("\",")
        sb.append("\"sdk\":").append(Build.VERSION.SDK_INT).append(",")
        sb.append("\"modelo\":\"").append(esc(Build.MODEL ?: "?")).append("\",")
        sb.append("\"fabricante\":\"").append(esc(Build.MANUFACTURER ?: "?")).append("\",")
        sb.append("\"pantalla\":\"").append(dm.widthPixels).append("x").append(dm.heightPixels)
            .append(" @").append(dm.density).append("x\"").append(",")
        sb.append("\"informes\":\"").append(esc(d?.absolutePath ?: "(sin almacenamiento externo)")).append("\",")
        sb.append("\"registro\":\"").append(esc(VisorNativeLog.tail())).append("\"")
        sb.append("}")
        return sb.toString()
    }

    private fun appVersionName(): String = try {
        val p = activity.packageManager.getPackageInfo(activity.packageName, 0)
        p.versionName ?: "?"
    } catch (e: Exception) { "?" }

    // Escribe el informe y devuelve su ruta absoluta.
    @JavascriptInterface
    fun saveReport(name: String, text: String): String? {
        val f = write(name, text) ?: return null
        VisorNativeLog.add("informe guardado: " + f.name + " (" + f.length() + " bytes)")
        return f.absolutePath
    }

    // Escribe el informe y abre la hoja de compartir de Android. Se comparte el
    // TEXTO (no hace falta FileProvider ni depender del tipo de archivo): asi el
    // informe se puede mandar por correo, mensajeria o guardarlo donde sea.
    @JavascriptInterface
    fun shareReport(name: String, text: String): Boolean {
        val f = write(name, text)
        if (f != null) VisorNativeLog.add("informe para compartir: " + f.name)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, name)
            putExtra(Intent.EXTRA_TEXT, text)
        }
        ui.post {
            try {
                val chooser = Intent.createChooser(intent, "Compartir informe del visor")
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                activity.startActivity(chooser)
            } catch (e: Exception) {
                VisorNativeLog.add("no se pudo abrir la hoja de compartir: " + (e.message ?: e.toString()))
            }
        }
        return true
    }

    @JavascriptInterface
    fun listReports(): String {
        val d = dir ?: return "[]"
        val files = (d.listFiles() ?: emptyArray())
            .filter { it.isFile && it.name.endsWith(".txt") }
            .sortedByDescending { it.lastModified() }
        val sb = StringBuilder("[")
        files.forEachIndexed { i, f ->
            if (i > 0) sb.append(",")
            sb.append("{\"nombre\":\"").append(esc(f.name)).append("\",")
            sb.append("\"bytes\":").append(f.length()).append(",")
            sb.append("\"ms\":").append(f.lastModified()).append("}")
        }
        sb.append("]")
        return sb.toString()
    }

    @JavascriptInterface
    fun readReport(name: String): String? {
        val f = safeFile(name) ?: return null
        if (!f.exists()) return null
        return try { f.readText() } catch (e: Exception) { null }
    }

    @JavascriptInterface
    fun deleteReport(name: String): Boolean {
        val f = safeFile(name) ?: return false
        return try { f.delete() } catch (e: Exception) { false }
    }

    @JavascriptInterface
    fun clearReports(): Int {
        val d = dir ?: return 0
        var n = 0
        (d.listFiles() ?: emptyArray()).forEach { if (it.isFile && it.name.endsWith(".txt")) if (it.delete()) n++ }
        VisorNativeLog.add("informes borrados: " + n)
        return n
    }

    @JavascriptInterface
    fun toast(text: String) {
        ui.post { try { Toast.makeText(activity, text, Toast.LENGTH_SHORT).show() } catch (e: Exception) { /* nada */ } }
    }

    // --- utilidades ------------------------------------------------------------

    private fun write(name: String, text: String): File? {
        val d = dir ?: return null
        if (!d.exists()) d.mkdirs()
        val f = safeFile(name) ?: File(d, "informe.txt")
        return try { f.writeText(text); f } catch (e: Exception) {
            VisorNativeLog.add("no se pudo escribir el informe: " + (e.message ?: e.toString()))
            null
        }
    }

    // Impide que un nombre raro se salga de la carpeta de informes.
    private fun safeFile(name: String): File? {
        val d = dir ?: return null
        val base = File(name).name.replace("\\", "").replace("/", "").trim()
        if (base.isEmpty()) return null
        return File(d, base)
    }

    private fun esc(s: String): String {
        val sb = StringBuilder(s.length + 8)
        for (c in s) when (c) {
            '\\' -> sb.append("\\\\")
            '"' -> sb.append("\\\"")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            else -> if (c < ' ') sb.append("\\u").append(String.format("%04x", c.code)) else sb.append(c)
        }
        return sb.toString()
    }
}
