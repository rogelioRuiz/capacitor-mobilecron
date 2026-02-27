package io.mobilecron

import android.os.Handler
import android.os.Looper

object CronBridge {
    @Volatile
    var plugin: MobileCronPlugin? = null

    fun wake(source: String) {
        val current = plugin ?: return
        if (Looper.myLooper() == Looper.getMainLooper()) {
            current.notifyFromBackground(source)
        } else {
            Handler(Looper.getMainLooper()).post {
                plugin?.notifyFromBackground(source)
            }
        }
    }
}
