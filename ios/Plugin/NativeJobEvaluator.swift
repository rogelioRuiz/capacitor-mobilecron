import Foundation

struct NativeJobEvent {
    let id: String
    let name: String
    let firedAt: Int64
    let source: String
    let data: [String: Any]?
}

final class NativeJobEvaluator {
    private static let storageKey = "mobilecron:state"
    private static let clockRegex = try? NSRegularExpression(pattern: #"^(\d{2}):(\d{2})$"#)

    // ── Shared I/O ─────────────────────────────────────────────────────────────

    /// JSON file in Application Support — survives simctl terminate (synchronous atomic write).
    static var stateFileURL: URL? {
        guard let dir = try? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ) else { return nil }
        return dir.appendingPathComponent("mobilecron-state.json")
    }

    /// Reads raw JSON: file preferred (reliable); UserDefaults as fallback.
    static func readStateRaw() -> String? {
        if let url = stateFileURL,
           let raw = try? String(contentsOf: url, encoding: .utf8),
           !raw.isEmpty {
            return raw
        }
        return UserDefaults.standard.string(forKey: storageKey)
    }

    /// Writes raw JSON atomically to file AND to UserDefaults (belt-and-suspenders).
    static func writeStateRaw(_ raw: String) {
        if let url = stateFileURL {
            try? raw.write(to: url, atomically: true, encoding: .utf8)
        }
        UserDefaults.standard.set(raw, forKey: storageKey)
    }

    // ── Evaluation ─────────────────────────────────────────────────────────────

    static func evaluate(source: String) -> [NativeJobEvent] {
        guard let raw = readStateRaw(),
              let data = raw.data(using: .utf8),
              var state = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return []
        }

        var jobs = state["jobs"] as? [[String: Any]] ?? []
        var pendingEvents = state["pendingNativeEvents"] as? [[String: Any]] ?? []
        var firedEvents: [NativeJobEvent] = []
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let paused = bool(from: state["paused"]) ?? false
        var mutated = false

        for index in jobs.indices {
            var job = jobs[index]
            defer { jobs[index] = job }

            guard (bool(from: job["enabled"]) ?? false) else { continue }

            if int64(from: job["nextDueAt"]) == nil,
               let computed = computeNextDueAt(schedule: job["schedule"] as? [String: Any], nowMs: now) {
                job["nextDueAt"] = computed
                mutated = true
            }

            guard let nextDueAt = int64(from: job["nextDueAt"]), nextDueAt <= now else { continue }

            if getSkipReason(job: job, paused: paused, nowMs: now) != nil {
                job["consecutiveSkips"] = (int64(from: job["consecutiveSkips"]) ?? 0) + 1
                job["updatedAt"] = now
                if scheduleKind(job["schedule"] as? [String: Any]) == "every" {
                    if let next = computeNextDueAt(schedule: job["schedule"] as? [String: Any], nowMs: now) {
                        job["nextDueAt"] = next
                    } else {
                        job.removeValue(forKey: "nextDueAt")
                    }
                }
                mutated = true
                continue
            }

            job["lastFiredAt"] = now
            job["updatedAt"] = now
            job["consecutiveSkips"] = 0

            var eventPayload: [String: Any] = [
                "id": (job["id"] as? String) ?? "",
                "name": (job["name"] as? String) ?? "",
                "firedAt": now,
                "source": source
            ]
            if let eventData = job["data"] as? [String: Any] {
                eventPayload["data"] = eventData
            }

            if scheduleKind(job["schedule"] as? [String: Any]) == "at" {
                job["enabled"] = false
                job.removeValue(forKey: "nextDueAt")
            } else {
                if let next = computeNextDueAt(schedule: job["schedule"] as? [String: Any], nowMs: now) {
                    job["nextDueAt"] = next
                } else {
                    job.removeValue(forKey: "nextDueAt")
                }
            }

            pendingEvents.append(eventPayload)
            firedEvents.append(
                NativeJobEvent(
                    id: eventPayload["id"] as? String ?? "",
                    name: eventPayload["name"] as? String ?? "",
                    firedAt: int64(from: eventPayload["firedAt"]) ?? now,
                    source: eventPayload["source"] as? String ?? source,
                    data: eventPayload["data"] as? [String: Any]
                )
            )
            mutated = true
        }

        if mutated {
            state["jobs"] = jobs
            if pendingEvents.isEmpty {
                state.removeValue(forKey: "pendingNativeEvents")
            } else {
                state["pendingNativeEvents"] = pendingEvents
            }

            if let nextData = try? JSONSerialization.data(withJSONObject: state),
               let nextRaw = String(data: nextData, encoding: .utf8) {
                writeStateRaw(nextRaw)
            }
        }

        return firedEvents
    }

    private static func computeNextDueAt(schedule: [String: Any]?, nowMs: Int64) -> Int64? {
        guard let schedule else { return nil }
        switch scheduleKind(schedule) {
        case "at":
            guard let atMs = int64(from: schedule["atMs"]) else { return nil }
            return atMs > nowMs ? atMs : nil
        case "every":
            guard let everyMs = int64(from: schedule["everyMs"]), everyMs > 0 else { return nil }
            let anchorMs = int64(from: schedule["anchorMs"]) ?? nowMs
            if nowMs < anchorMs { return anchorMs }
            let elapsed = nowMs - anchorMs
            let steps = (elapsed / everyMs) + 1
            return anchorMs + (steps * everyMs)
        default:
            return nil
        }
    }

    private static func getSkipReason(job: [String: Any], paused: Bool, nowMs: Int64) -> String? {
        if paused { return "paused" }
        if let activeHours = job["activeHours"] as? [String: Any],
           !isWithinActiveHours(activeHours: activeHours, nowMs: nowMs) {
            return "outside_active_hours"
        }

        // BGTask constraints should enforce network/charging requirements on iOS.
        return nil
    }

    private static func isWithinActiveHours(activeHours: [String: Any], nowMs: Int64) -> Bool {
        guard let startValue = activeHours["start"] as? String,
              let endValue = activeHours["end"] as? String,
              let start = parseClock(startValue),
              let end = parseClock(endValue) else {
            return true
        }

        let timeZone: TimeZone
        if let tzId = activeHours["tz"] as? String, let tz = TimeZone(identifier: tzId) {
            timeZone = tz
        } else {
            timeZone = .current
        }

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let nowDate = Date(timeIntervalSince1970: TimeInterval(nowMs) / 1000.0)
        let components = calendar.dateComponents([.hour, .minute], from: nowDate)
        let nowMinutes = (components.hour ?? 0) * 60 + (components.minute ?? 0)

        if start == end { return true }
        if start < end {
            return nowMinutes >= start && nowMinutes < end
        }
        return nowMinutes >= start || nowMinutes < end
    }

    private static func parseClock(_ value: String) -> Int? {
        let nsValue = value as NSString
        let range = NSRange(location: 0, length: nsValue.length)
        guard let regex = clockRegex,
              let match = regex.firstMatch(in: value, options: [], range: range),
              match.numberOfRanges == 3 else {
            return nil
        }

        let hhRange = match.range(at: 1)
        let mmRange = match.range(at: 2)
        guard hhRange.location != NSNotFound, mmRange.location != NSNotFound else {
            return nil
        }

        let hh = Int(nsValue.substring(with: hhRange))
        let mm = Int(nsValue.substring(with: mmRange))
        guard let hh, let mm, (0...23).contains(hh), (0...59).contains(mm) else {
            return nil
        }
        return (hh * 60) + mm
    }

    private static func scheduleKind(_ schedule: [String: Any]?) -> String {
        (schedule?["kind"] as? String) ?? ""
    }

    private static func int64(from value: Any?) -> Int64? {
        switch value {
        case nil:
            return nil
        case let n as Int64:
            return n
        case let n as Int:
            return Int64(n)
        case let n as Double:
            return Int64(n)
        case let n as NSNumber:
            return n.int64Value
        case let s as String:
            return Int64(s)
        default:
            return nil
        }
    }

    private static func bool(from value: Any?) -> Bool? {
        switch value {
        case nil:
            return nil
        case let b as Bool:
            return b
        case let n as NSNumber:
            return n.boolValue
        case let s as String:
            let normalized = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if normalized == "true" { return true }
            if normalized == "false" { return false }
            return nil
        default:
            return nil
        }
    }
}
