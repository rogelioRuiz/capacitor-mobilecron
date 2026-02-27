import Foundation
import BackgroundTasks

final class BGTaskManager {
    struct Status {
        var bgRefreshRegistered: Bool = false
        var bgProcessingRegistered: Bool = false
        var bgContinuedAvailable: Bool = false
    }

    private weak var plugin: MobileCronPlugin?
    private(set) var status = Status()

    init(plugin: MobileCronPlugin) {
        self.plugin = plugin
        self.status.bgContinuedAvailable = false
    }

    func registerBGTasks() {
        status.bgRefreshRegistered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: "io.mobilecron.refresh",
            using: nil
        ) { [weak self] task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            self?.handleRefresh(refreshTask)
        }

        status.bgProcessingRegistered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: "io.mobilecron.processing",
            using: nil
        ) { [weak self] task in
            guard let processingTask = task as? BGProcessingTask else {
                task.setTaskCompleted(success: false)
                return
            }
            self?.handleProcessing(processingTask)
        }

        // iOS 26+ BGContinuedProcessingTask placeholder: keep runtime feature flag separate from compile-time SDK use.
        status.bgContinuedAvailable = false
    }

    func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: "io.mobilecron.refresh")
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    func scheduleProcessing(requiresExternalPower: Bool) {
        let request = BGProcessingTaskRequest(identifier: "io.mobilecron.processing")
        request.requiresExternalPower = requiresExternalPower
        request.requiresNetworkConnectivity = false
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private func handleRefresh(_ task: BGAppRefreshTask) {
        scheduleRefresh()
        task.expirationHandler = {
            task.setTaskCompleted(success: false)
        }
        _ = NativeJobEvaluator.evaluate(source: "bgtask_refresh")
        plugin?.handleBackgroundWake(source: "bgtask_refresh")
        task.setTaskCompleted(success: true)
    }

    private func handleProcessing(_ task: BGProcessingTask) {
        let mode = plugin?.currentMode ?? "balanced"
        scheduleProcessing(requiresExternalPower: mode != "aggressive")
        task.expirationHandler = {
            task.setTaskCompleted(success: false)
        }
        _ = NativeJobEvaluator.evaluate(source: "bgtask_processing")
        plugin?.handleBackgroundWake(source: "bgtask_processing")
        task.setTaskCompleted(success: true)
    }
}
