import Foundation

#if canImport(CapacitorNativeAgent)
import CapacitorNativeAgent
#elseif canImport(NativeAgentPlugin)
import NativeAgentPlugin
#endif

#if canImport(CapacitorNativeAgent) || canImport(NativeAgentPlugin)
final class NativeAgentBridge {
    static let shared = NativeAgentBridge()

    private let configPathKey = "mobilecron:native-agent-config-path"
    private let lock = NSLock()
    private var handle: NativeAgentHandle?

    func handleWake(_ source: String) -> Bool {
        guard let handle = getOrCreateHandle() else {
            return false
        }
        do {
            try handle.handleWake(source: source)
            return true
        } catch {
            return false
        }
    }

    private func getOrCreateHandle() -> NativeAgentHandle? {
        lock.lock()
        defer { lock.unlock() }

        if let handle {
            return handle
        }

        guard let configPath = UserDefaults.standard.string(forKey: configPathKey) else {
            return nil
        }

        do {
            let handle = try createHandleFromPersistedConfig(configPath: configPath)
            try handle.setNotifier(notifier: NativeNotifierImpl())
            if let memoryProvider = MemoryProviderImpl.makeIfAvailable() {
                try handle.setMemoryProvider(provider: memoryProvider)
            }
            self.handle = handle
            return handle
        } catch {
            return nil
        }
    }
}
#else
final class NativeAgentBridge {
    static let shared = NativeAgentBridge()

    func handleWake(_ source: String) -> Bool {
        false
    }
}
#endif
