package net.visorsl.viewer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

/**
 * Foreground service that keeps the viewer session alive while the app is in the
 * background: the WebView (and therefore the WebGL world and the UDP circuit)
 * must not be frozen, and Android only allows that for a foreground service with
 * a persistent notification.
 *
 * The notification shows the region you are in, tapping it returns to the
 * viewer, and its "Desconectar" action tells the page to log out.
 *
 * WorkManager is deliberately not used (see NativeBridge): its network-state
 * tracker was the source of the ConnectivityManager$TooManyRequestsException
 * crash reported against similar viewers.
 */
class SessionService : Service() {

    companion object {
        const val TAG = "VisorSL"
        const val CHANNEL_ID = "visor-session"
        const val NOTIFICATION_ID = 42
        const val ACTION_STOP = "net.visorsl.viewer.STOP_SESSION"
        const val ACTION_UPDATE = "net.visorsl.viewer.UPDATE_SESSION"

        @Volatile var active = false

        fun start(context: Context, region: String, agent: String) {
            val intent = Intent(context, SessionService::class.java)
                .putExtra("region", region)
                .putExtra("agent", agent)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (t: Throwable) {
                Log.w(TAG, "no se pudo iniciar el servicio de sesión: $t")
            }
        }

        fun update(context: Context, region: String, agent: String) {
            if (!active) return
            val intent = Intent(context, SessionService::class.java)
                .setAction(ACTION_UPDATE)
                .putExtra("region", region)
                .putExtra("agent", agent)
            try {
                context.startService(intent)
            } catch (t: Throwable) {
                Log.w(TAG, "no se pudo actualizar el servicio de sesión: $t")
            }
        }

        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, SessionService::class.java))
            } catch (t: Throwable) {
                Log.w(TAG, "no se pudo parar el servicio de sesión: $t")
            }
        }
    }

    private var region = "Second Life"
    private var agent = ""
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    /**
     * A partial wake lock keeps the CPU (and therefore the socket) alive while the
     * screen is off. It is only held while the session is connected, and released
     * the moment the session ends, so it cannot drain the battery by itself.
     */
    private fun acquireWakeLock() {
        if (wakeLock != null) return
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "visor:session").apply {
                setReferenceCounted(false)
                acquire(6 * 60 * 60 * 1000L)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "wake lock: $t")
        }
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
        } catch (_: Throwable) {
        }
        wakeLock = null
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // Tell the page to log out, then take the notification down.
            NativeBridge.webViewRef?.post {
                NativeBridge.webViewRef?.evaluateJavascript(
                    "window.visor && window.visor.disconnect && window.visor.disconnect()", null)
            }
            active = false
            releaseWakeLock()
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }
        val r = intent?.getStringExtra("region")
        val a = intent?.getStringExtra("agent")
        if (!r.isNullOrBlank()) region = r
        if (!a.isNullOrBlank()) agent = a
        startForeground(NOTIFICATION_ID, buildNotification())
        acquireWakeLock()
        active = true
        return START_STICKY
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Sesión en Second Life",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Mantiene la sesión abierta mientras la app está en segundo plano"
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            pendingFlags()
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, SessionService::class.java).setAction(ACTION_STOP),
            pendingFlags()
        )
        val text = if (agent.isNotBlank()) "$agent · $region" else region
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("Conectado a Second Life")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(
                Notification.Action.Builder(
                    null, "Desconectar",
                    stop
                ).build()
            )
            .build()
    }

    private fun pendingFlags(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    override fun onDestroy() {
        active = false
        releaseWakeLock()
        super.onDestroy()
    }
}
