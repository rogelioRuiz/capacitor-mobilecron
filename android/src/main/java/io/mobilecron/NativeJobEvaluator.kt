package io.mobilecron

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.os.BatteryManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar
import java.util.TimeZone

object NativeJobEvaluator {
    private const val STORAGE_FILE = "CapacitorStorage"
    private const val STORAGE_KEY = "mobilecron:state"
    private val CLOCK_REGEX = Regex("""^(\d{2}):(\d{2})$""")

    fun evaluate(context: Context, source: String): List<JSONObject> {
        val prefs = context.getSharedPreferences(STORAGE_FILE, Context.MODE_PRIVATE)
        val raw = prefs.getString(STORAGE_KEY, null) ?: return emptyList()
        val state = runCatching { JSONObject(raw) }.getOrNull() ?: return emptyList()

        val jobs = state.optJSONArray("jobs") ?: JSONArray()
        val pendingEvents = state.optJSONArray("pendingNativeEvents") ?: JSONArray()
        val firedEvents = mutableListOf<JSONObject>()
        val now = System.currentTimeMillis()
        val paused = state.optBoolean("paused", false)
        var mutated = false

        for (index in 0 until jobs.length()) {
            val job = jobs.optJSONObject(index) ?: continue
            if (!job.optBoolean("enabled", false)) continue

            if (readLong(job.opt("nextDueAt")) == null) {
                val computed = computeNextDueAt(job.optJSONObject("schedule"), now)
                if (computed != null) {
                    job.put("nextDueAt", computed)
                    mutated = true
                }
            }

            val nextDueAt = readLong(job.opt("nextDueAt"))
            if (nextDueAt == null || nextDueAt > now) continue

            val schedule = job.optJSONObject("schedule")
            if (getSkipReason(context, job, paused, now) != null) {
                job.put("consecutiveSkips", job.optInt("consecutiveSkips", 0) + 1)
                job.put("updatedAt", now)
                if (schedule?.optString("kind") == "every") {
                    val next = computeNextDueAt(schedule, now)
                    if (next != null) {
                        job.put("nextDueAt", next)
                    } else {
                        job.remove("nextDueAt")
                    }
                }
                mutated = true
                continue
            }

            job.put("lastFiredAt", now)
            job.put("updatedAt", now)
            job.put("consecutiveSkips", 0)

            val event = JSONObject().apply {
                put("id", job.optString("id"))
                put("name", job.optString("name"))
                put("firedAt", now)
                put("source", source)
                val data = job.opt("data")
                if (data != null && data != JSONObject.NULL) {
                    put("data", data)
                }
            }

            if (schedule?.optString("kind") == "at") {
                job.put("enabled", false)
                job.remove("nextDueAt")
            } else {
                val next = computeNextDueAt(schedule, now)
                if (next != null) {
                    job.put("nextDueAt", next)
                } else {
                    job.remove("nextDueAt")
                }
            }

            pendingEvents.put(event)
            firedEvents.add(event)
            mutated = true
        }

        if (mutated) {
            state.put("jobs", jobs)
            if (pendingEvents.length() > 0) {
                state.put("pendingNativeEvents", pendingEvents)
            } else {
                state.remove("pendingNativeEvents")
            }
            prefs.edit().putString(STORAGE_KEY, state.toString()).apply()
        }

        return firedEvents
    }

    internal fun computeNextDueAt(schedule: JSONObject?, nowMs: Long): Long? {
        if (schedule == null) return null
        return when (schedule.optString("kind")) {
            "at" -> {
                val atMs = readLong(schedule.opt("atMs")) ?: return null
                if (atMs > nowMs) atMs else null
            }
            "every" -> {
                val everyMs = readLong(schedule.opt("everyMs")) ?: return null
                if (everyMs <= 0) return null

                val anchorMs = readLong(schedule.opt("anchorMs")) ?: nowMs
                if (nowMs < anchorMs) return anchorMs

                val elapsed = nowMs - anchorMs
                val steps = (elapsed / everyMs) + 1
                anchorMs + (steps * everyMs)
            }
            else -> null
        }
    }

    internal fun isWithinActiveHours(activeHours: JSONObject, nowMs: Long): Boolean {
        val start = parseClock(activeHours.optString("start"))
        val end = parseClock(activeHours.optString("end"))
        if (start == null || end == null) return true

        val tzId = activeHours.optString("tz").takeIf { it.isNotBlank() }
        val timeZone = if (tzId != null) TimeZone.getTimeZone(tzId) else TimeZone.getDefault()
        val calendar = Calendar.getInstance(timeZone).apply { timeInMillis = nowMs }
        val nowMinutes = calendar.get(Calendar.HOUR_OF_DAY) * 60 + calendar.get(Calendar.MINUTE)

        if (start == end) return true
        if (start < end) {
            return nowMinutes >= start && nowMinutes < end
        }
        return nowMinutes >= start || nowMinutes < end
    }

    internal fun parseClock(value: String): Int? {
        val match = CLOCK_REGEX.matchEntire(value) ?: return null
        val hh = match.groupValues[1].toIntOrNull() ?: return null
        val mm = match.groupValues[2].toIntOrNull() ?: return null
        if (hh !in 0..23 || mm !in 0..59) return null
        return hh * 60 + mm
    }

    private fun getSkipReason(context: Context, job: JSONObject, paused: Boolean, nowMs: Long): String? {
        if (paused) return "paused"

        val activeHours = job.optJSONObject("activeHours")
        if (activeHours != null && !isWithinActiveHours(activeHours, nowMs)) {
            return "outside_active_hours"
        }

        if (job.optBoolean("requiresNetwork", false) && !isNetworkAvailable(context)) {
            return "requires_network"
        }

        if (job.optBoolean("requiresCharging", false) && !isChargingAvailable(context)) {
            return "requires_charging"
        }

        return null
    }

    private fun isNetworkAvailable(context: Context): Boolean {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return true
        return try {
            manager.activeNetworkInfo?.isConnected == true
        } catch (_: SecurityException) {
            true
        }
    }

    private fun isChargingAvailable(context: Context): Boolean {
        val batteryIntent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return false
        val status = batteryIntent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        return status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
    }

    private fun readLong(value: Any?): Long? {
        return when (value) {
            null, JSONObject.NULL -> null
            is Number -> value.toLong()
            is String -> value.toLongOrNull()
            else -> null
        }
    }
}
