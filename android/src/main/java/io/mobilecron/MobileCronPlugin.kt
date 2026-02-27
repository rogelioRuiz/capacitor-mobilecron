package io.mobilecron

import android.content.Intent
import android.content.IntentFilter
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

@CapacitorPlugin(name = "MobileCron")
class MobileCronPlugin : Plugin() {
    private val jobs = ConcurrentHashMap<String, JSObject>()
    private var paused = false
    private var mode = "balanced"
    private var chargingReceiver: ChargingReceiver? = null

    override fun load() {
        super.load()
        CronBridge.plugin = this
        registerChargingReceiver()
        scheduleWorkManager()
    }

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        if (CronBridge.plugin === this) {
            CronBridge.plugin = null
        }
        chargingReceiver?.let {
            runCatching { context.unregisterReceiver(it) }
        }
        chargingReceiver = null
    }

    internal fun notifyFromBackground(source: String) {
        // Native phase-1 skeleton: background wakes are surfaced, but due-job evaluation is implemented in TS web layer.
        val payload = JSObject()
        payload.put("source", source)
        payload.put("paused", paused)
        notifyListeners("statusChanged", buildStatus())
        notifyListeners("nativeWake", payload)
    }

    private fun scheduleWorkManager() {
        val wm = WorkManager.getInstance(context)
        if (mode == "aggressive") {
            val request = OneTimeWorkRequestBuilder<CronChainWorker>()
                .setInitialDelay(5, TimeUnit.MINUTES)
                .build()
            wm.enqueueUniqueWork("mobilecron_chain", ExistingWorkPolicy.REPLACE, request)
            return
        }

        val constraintsBuilder = Constraints.Builder()
        if (mode == "eco") {
            constraintsBuilder.setRequiredNetworkType(NetworkType.UNMETERED)
            constraintsBuilder.setRequiresBatteryNotLow(true)
        } else {
            constraintsBuilder.setRequiredNetworkType(NetworkType.CONNECTED)
        }

        val request = PeriodicWorkRequestBuilder<CronWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraintsBuilder.build())
            .build()

        wm.enqueueUniquePeriodicWork(
            "mobilecron_periodic",
            ExistingPeriodicWorkPolicy.UPDATE,
            request
        )
    }

    private fun registerChargingReceiver() {
        if (chargingReceiver != null) return
        val receiver = ChargingReceiver()
        context.registerReceiver(receiver, IntentFilter(Intent.ACTION_POWER_CONNECTED))
        chargingReceiver = receiver
    }

    @PluginMethod
    fun register(call: PluginCall) {
        val name = call.getString("name")?.trim()
        if (name.isNullOrEmpty()) {
            call.reject("Job name is required")
            return
        }

        val id = UUID.randomUUID().toString()
        val record = JSObject()
        record.put("id", id)
        record.put("name", name)
        record.put("enabled", true)
        record.put("schedule", call.getObject("schedule") ?: JSObject())
        record.put("activeHours", call.getObject("activeHours"))
        record.put("requiresNetwork", call.getBoolean("requiresNetwork", false))
        record.put("requiresCharging", call.getBoolean("requiresCharging", false))
        record.put("priority", call.getString("priority", "normal"))
        call.getObject("data")?.let { record.put("data", it) }
        record.put("consecutiveSkips", 0)
        jobs[id] = record

        val result = JSObject()
        result.put("id", id)
        call.resolve(result)
        notifyListeners("statusChanged", buildStatus())
    }

    @PluginMethod
    fun unregister(call: PluginCall) {
        val id = call.getString("id")
        if (id == null) {
            call.reject("id is required")
            return
        }
        jobs.remove(id)
        call.resolve()
        notifyListeners("statusChanged", buildStatus())
    }

    @PluginMethod
    fun update(call: PluginCall) {
        val id = call.getString("id")
        if (id == null) {
            call.reject("id is required")
            return
        }
        val existing = jobs[id]
        if (existing == null) {
            call.reject("Job not found")
            return
        }

        call.getString("name")?.let { existing.put("name", it) }
        call.getObject("schedule")?.let { existing.put("schedule", it) }
        if (call.data.has("activeHours")) existing.put("activeHours", call.getObject("activeHours"))
        if (call.data.has("requiresNetwork")) existing.put("requiresNetwork", call.getBoolean("requiresNetwork", false))
        if (call.data.has("requiresCharging")) existing.put("requiresCharging", call.getBoolean("requiresCharging", false))
        call.getString("priority")?.let { existing.put("priority", it) }
        if (call.data.has("data")) existing.put("data", call.getObject("data"))

        jobs[id] = existing
        call.resolve()
        notifyListeners("statusChanged", buildStatus())
    }

    @PluginMethod
    fun list(call: PluginCall) {
        val arr = JSArray()
        jobs.values.forEach { arr.put(it) }
        val result = JSObject()
        result.put("jobs", arr)
        call.resolve(result)
    }

    @PluginMethod
    fun triggerNow(call: PluginCall) {
        val id = call.getString("id")
        if (id == null) {
            call.reject("id is required")
            return
        }
        val job = jobs[id]
        if (job == null) {
            call.reject("Job not found")
            return
        }

        val payload = JSObject()
        payload.put("id", id)
        payload.put("name", job.getString("name"))
        payload.put("firedAt", System.currentTimeMillis())
        payload.put("source", "manual")
        if (job.has("data")) payload.put("data", job.getJSONObject("data"))
        notifyListeners("jobDue", payload)
        call.resolve()
    }

    @PluginMethod
    fun pauseAll(call: PluginCall) {
        paused = true
        call.resolve()
        notifyListeners("statusChanged", buildStatus())
    }

    @PluginMethod
    fun resumeAll(call: PluginCall) {
        paused = false
        call.resolve()
        notifyListeners("statusChanged", buildStatus())
    }

    @PluginMethod
    fun setMode(call: PluginCall) {
        val next = call.getString("mode")
        if (next !in listOf("eco", "balanced", "aggressive")) {
            call.reject("mode must be eco|balanced|aggressive")
            return
        }
        mode = next!!
        scheduleWorkManager()
        call.resolve()
        notifyListeners("statusChanged", buildStatus())
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        call.resolve(buildStatus())
    }

    private fun buildStatus(): JSObject {
        val status = JSObject()
        status.put("paused", paused)
        status.put("mode", mode)
        status.put("platform", "android")
        status.put("activeJobCount", jobs.size)
        status.put("android", JSObject().apply {
            put("workManagerActive", true)
            put("chargingReceiverActive", chargingReceiver != null)
        })
        return status
    }
}
