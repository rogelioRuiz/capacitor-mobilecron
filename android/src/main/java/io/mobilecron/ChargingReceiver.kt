package io.mobilecron

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class ChargingReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action == Intent.ACTION_POWER_CONNECTED) {
            CronBridge.wake("charging")
        }
    }
}
