package io.mobilecron

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class ChargingReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        val appContext = context ?: return
        if (intent?.action != Intent.ACTION_POWER_CONNECTED) return

        NativeJobEvaluator.evaluate(appContext, "charging")
        CronBridge.wake("charging")
    }
}
