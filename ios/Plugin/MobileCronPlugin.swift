import Foundation
import Capacitor

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
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise)
    ]

    private var jobs: [String: [String: Any]] = [:]
    private var paused = false
    private(set) var mode = "balanced"
    var currentMode: String { mode }
    private var bgManager: BGTaskManager?

    public override func load() {
        super.load()
        let manager = BGTaskManager(plugin: self)
        manager.registerBGTasks()
        manager.scheduleRefresh()
        manager.scheduleProcessing(requiresExternalPower: true)
        self.bgManager = manager
    }

    func handleBackgroundWake(source: String) {
        notifyListeners("statusChanged", data: buildStatus())
        notifyListeners("nativeWake", data: ["source": source, "paused": paused])
    }

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
        notifyListeners("statusChanged", data: buildStatus())
        call.resolve(["id": id])
    }

    @objc func unregister(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("id is required")
            return
        }
        jobs.removeValue(forKey: id)
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
        notifyListeners("statusChanged", data: buildStatus())
        call.resolve()
    }

    @objc func resumeAll(_ call: CAPPluginCall) {
        paused = false
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
        notifyListeners("statusChanged", data: buildStatus())
        call.resolve()
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve(buildStatus())
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
