package io.mobilecron

import android.content.Context
import com.t6x.plugins.nativeagent.MemoryProviderImpl
import com.t6x.plugins.nativeagent.NativeNotifierImpl
import java.util.concurrent.atomic.AtomicBoolean
import uniffi.native_agent_ffi.NativeAgentHandle
import uniffi.native_agent_ffi.createHandleFromPersistedConfig

object NativeAgentBridge {
    private const val STORAGE_FILE = "CapacitorStorage"
    private const val CONFIG_PATH_KEY = "mobilecron:native-agent-config-path"

    @Volatile
    private var handle: NativeAgentHandle? = null
    private val libraryLoaded = AtomicBoolean(false)

    fun handleWake(context: Context, source: String): Boolean {
        return runCatching {
            val agentHandle = getOrCreateHandle(context) ?: return false
            agentHandle.handleWake(source)
            true
        }.getOrDefault(false)
    }

    private fun getOrCreateHandle(context: Context): NativeAgentHandle? {
        handle?.let { return it }
        synchronized(this) {
            handle?.let { return it }
            ensureLibraryLoaded()
            val configPath = context
                .getSharedPreferences(STORAGE_FILE, Context.MODE_PRIVATE)
                .getString(CONFIG_PATH_KEY, null)
                ?: return null

            val agentHandle = runCatching {
                createHandleFromPersistedConfig(configPath)
            }.getOrNull() ?: return null

            runCatching {
                agentHandle.setNotifier(NativeNotifierImpl(context.applicationContext))
            }
            runCatching {
                val memoryProvider = MemoryProviderImpl(context.applicationContext)
                if (memoryProvider.isAvailable()) {
                    agentHandle.setMemoryProvider(memoryProvider)
                }
            }

            handle = agentHandle
            return agentHandle
        }
    }

    private fun ensureLibraryLoaded() {
        if (libraryLoaded.get()) {
            return
        }
        synchronized(libraryLoaded) {
            if (libraryLoaded.get()) {
                return
            }
            System.loadLibrary("native_agent_ffi")
            libraryLoaded.set(true)
        }
    }
}
