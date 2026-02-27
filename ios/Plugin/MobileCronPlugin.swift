import Foundation
import Capacitor
import UIKit

@objc(MobileCronPlugin)
public class MobileCronPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MobileCronPlugin"
    public let jsName = "MobileCron"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unregister", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "triggerNow", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pauseAll", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumeAll", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "testNativeEvaluate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "testSetNextDueAt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "testInjectPendingEvent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "testGetPendingCount", returnType: CAPPluginReturnPromise)
    ]

    private static let storageKey = "mobilecron:state"

    private var jobs: [String: [String: Any]] = [:]
    private var paused = false
    private(set) var mode = "balanced"
    var currentMode: String { mode }
    private var bgManager: BGTaskManager?

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    public override func load() {
        super.load()
        loadState()
        firePendingNativeEvents()
        let manager = BGTaskManager(plugin: self)
        manager.registerBGTasks()
        manager.scheduleRefresh()
        manager.scheduleProcessing(requiresExternalPower: true)
        self.bgManager = manager
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    @objc private func appDidBecomeActive() {
        firePendingNativeEvents()
    }

    func handleBackgroundWake(source: String) {
        firePendingNativeEvents()
        notifyListeners("statusChanged", data: buildStatus())
        notifyListeners("nativeWake", data: ["source": source, "paused": paused])
    }

    // ── Persistence ───────────────────────────────────────────────────────────

    private func loadState() {
        guard let raw = UserDefaults.standard.string(forKey: Self.storageKey),
              let data = raw.data(using: .utf8),
              let state = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return
        }
        paused = (state["paused"] as? Bool) ?? false
        mode = (state["mode"] as? String) ?? "balanced"
        jobs = [:]
        if let jobsArr = state["jobs"] as? [[String: Any]] {
            for job in jobsArr {
                if let id = job["id"] as? String, !id.isEmpty {
                    jobs[id] = job
                }
            }
        }
    }

    private func saveState() {
        var state: [String: Any] = [
            "version": 1,
            "paused": paused,
            "mode": mode,
            "jobs": Array(jobs.values)
        ]
        // Preserve any pendingNativeEvents written by NativeJobEvaluator
        if let raw = UserDefaults.standard.string(forKey: Self.storageKey),
           let data = raw.data(using: .utf8),
           let existing = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let pending = existing["pendingNativeEvents"] as? [[String: Any]],
           !pending.isEmpty {
            state["pendingNativeEvents"] = pending
        }
        guard let data = try? JSONSerialization.data(withJSONObject: state),
              let raw = String(data: data, encoding: .utf8) else { return }
        UserDefaults.standard.set(raw, forKey: Self.storageKey)
        // Force immediate disk flush so state survives simctl terminate / force-kill
        UserDefaults.standard.synchronize()
    }

    // ── Background wake ───────────────────────────────────────────────────────

    /// Read pendingNativeEvents from storage, emit each as jobDue, then clear them.
    private func firePendingNativeEvents() {
        guard let raw = UserDefaults.standard.string(forKey: Self.storageKey),
              let data = raw.data(using: .utf8),
              var state = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return
        }

        // Sync native-evaluated job fields (nextDueAt, lastFiredAt, consecutiveSkips) into memory.
        if let jobsArr = state["jobs"] as? [[String: Any]] {
            for nativeJob in jobsArr {
                if let id = nativeJob["id"] as? String, !id.isEmpty, jobs[id] != nil {
                    jobs[id] = nativeJob
                }
            }
        }

        guard let pending = state["pendingNativeEvents"] as? [[String: Any]], !pending.isEmpty else {
            return
        }

        for evt in pending {
            notifyListeners("jobDue", data: evt)
        }

        // Clear pendingNativeEvents and write back updated jobs.
        state.removeValue(forKey: "pendingNativeEvents")
        state["jobs"] = Array(jobs.values)
        if let newData = try? JSONSerialization.data(withJSONObject: state),
           let newRaw = String(data: newData, encoding: .utf8) {
            UserDefaults.standard.set(newRaw, forKey: Self.storageKey)
            UserDefaults.standard.synchronize()
        }
    }

    // ── Plugin methods ────────────────────────────────────────────────────────

    @objc func register(_ call: CAPPluginCall) {
        guard let name = call.getString("name")?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else {
            call.reject("Job name is required")
            return
        }

        let id = UUID().uuidString
        var record: [String: Any] = [
            "id": id,
            "name": name,
            "enabled": true,
            "consecutiveSkips": 0
        ]
        if let schedule = call.getObject("schedule") { record["schedule"] = schedule }
        if let activeHours = call.getObject("activeHours") { record["activeHours"] = activeHours }
        if call.options.keys.contains("requiresNetwork") { record["requiresNetwork"] = call.getBool("requiresNetwork") ?? false }
        if call.options.keys.contains("requiresCharging") { record["requiresCharging"] = call.getBool("requiresCharging") ?? false }
        if let priority = call.getString("priority") { record["priority"] = priority }
        if let data = call.getObject("data") { record["data"] = data }

        jobs[id] = record
        saveState()
        notifyListeners("statusChanged", data: buildStatus())
        call.resolve(["id": id])
    }

    @objc func unregister(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("id is required")
            return
        }
        jobs.removeValue(forKey: id)
        saveState()
        notifyListeners("statusChanged", data: buildStatus())
        call.resolve()
    }

    @objc func update(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("id is required")
            return
        }
        guard var existing = jobs[id] else {
            call.reject("Job not found")
            return
        }

        if let name = call.getString("name") { existing["name"] = name }
        if let schedule = call.getObject("schedule") { existing["schedule"] = schedule }
        if call.options.keys.contains("activeHours") { existing["activeHours"] = call.getObject("activeHours") }
        if call.options.keys.contains("requiresNetwork") { existing["requiresNetwork"] = call.getBool("requiresNetwork") ?? false }
        if call.options.keys.contains("requiresCharging") { existing["requiresCharging"] = call.getBool("requiresCharging") ?? false }
        if let priority = call.getString("priority") { existing["priority"] = priority }
        if call.options.keys.contains("data") { existing["data"] = call.getObject("data") }

        jobs[id] = existing
        saveState()
        notifyListeners("statusChanged", data: buildStatus())
        call.resolve()
    }

    @objc func list(_ call: CAPPluginCall) {
        call.resolve(["jobs": Array(jobs.values)])
    }

    @objc func triggerNow(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("id is required")
            return
        }
        guard let job = jobs[id] else {
            call.reject("Job not found")
            return
        }

        var payload: [String: Any] = [
            "id": id,
            "name": (job["name"] as? String) ?? "",
            "firedAt": Int(Date().timeIntervalSince1970 * 1000),
            "source": "manual"
        ]
        if let data = job["data"] {
            payload["data"] = data
        }
        notifyListeners("jobDue", data: payload)
        call.resolve()
    }

    @objc func pauseAll(_ call: CAPPluginCall) {
        paused = true
        saveState()
        notifyListeners("statusChanged", data: buildStatus())
        call.resolve()
    }

    @objc func resumeAll(_ call: CAPPluginCall) {
        paused = false
        saveState()
        notifyListeners("statusChanged", data: buildStatus())
        call.resolve()
    }

    @objc func setMode(_ call: CAPPluginCall) {
        guard let mode = call.getString("mode"), ["eco", "balanced", "aggressive"].contains(mode) else {
            call.reject("mode must be eco|balanced|aggressive")
            return
        }
        self.mode = mode
        if let bgManager {
            bgManager.scheduleRefresh()
            bgManager.scheduleProcessing(requiresExternalPower: mode != "aggressive")
        }
        saveState()
        notifyListeners("statusChanged", data: buildStatus())
        call.resolve()
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve(buildStatus())
    }

    // ── E2E test hooks (not for production use) ───────────────────────────────

    /// Calls NativeJobEvaluator.evaluate() directly and fires pending events.
    @objc func testNativeEvaluate(_ call: CAPPluginCall) {
        let events = NativeJobEvaluator.evaluate(source: "test_trigger")
        firePendingNativeEvents()
        call.resolve(["firedCount": events.count])
    }

    /// Sets a job's nextDueAt in memory and saves to UserDefaults.
    /// Allows tests to mark a job as "due" without waiting for real time to pass.
    @objc func testSetNextDueAt(_ call: CAPPluginCall) {
        guard let id = call.getString("id"),
              let nextDueAtMs = call.getInt("nextDueAtMs"),
              jobs[id] != nil else {
            call.reject("id or nextDueAtMs missing, or job not found")
            return
        }
        jobs[id]?["nextDueAt"] = nextDueAtMs
        saveState()
        call.resolve()
    }

    /// Appends a pending native event to UserDefaults storage.
    /// Allows tests to simulate what NativeJobEvaluator writes during background execution.
    @objc func testInjectPendingEvent(_ call: CAPPluginCall) {
        guard let event = call.getObject("event") else {
            call.reject("event is required")
            return
        }
        guard let raw = UserDefaults.standard.string(forKey: Self.storageKey),
              let data = raw.data(using: .utf8),
              var state = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            call.reject("State not found in UserDefaults")
            return
        }
        var pending = (state["pendingNativeEvents"] as? [[String: Any]]) ?? []
        pending.append(event)
        state["pendingNativeEvents"] = pending
        guard let newData = try? JSONSerialization.data(withJSONObject: state),
              let newRaw = String(data: newData, encoding: .utf8) else {
            call.reject("Serialization failed")
            return
        }
        UserDefaults.standard.set(newRaw, forKey: Self.storageKey)
        UserDefaults.standard.synchronize()
        call.resolve()
    }

    /// Returns the count of pendingNativeEvents currently in UserDefaults storage.
    @objc func testGetPendingCount(_ call: CAPPluginCall) {
        guard let raw = UserDefaults.standard.string(forKey: Self.storageKey),
              let data = raw.data(using: .utf8),
              let state = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            call.resolve(["count": 0])
            return
        }
        let count = (state["pendingNativeEvents"] as? [[String: Any]])?.count ?? 0
        call.resolve(["count": count])
    }

    private func buildStatus() -> [String: Any] {
        let diagnostics = bgManager?.status ?? .init()
        return [
            "paused": paused,
            "mode": mode,
            "platform": "ios",
            "activeJobCount": jobs.count,
            "ios": [
                "bgRefreshRegistered": diagnostics.bgRefreshRegistered,
                "bgProcessingRegistered": diagnostics.bgProcessingRegistered,
                "bgContinuedAvailable": diagnostics.bgContinuedAvailable
            ]
        ]
    }
}
