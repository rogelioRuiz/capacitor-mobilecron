package io.mobilecron

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

class CronChainWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        NativeJobEvaluator.evaluate(applicationContext, "workmanager_chain")
        CronBridge.wake("workmanager_chain")
        enqueueNext(applicationContext, 5)
        return Result.success()
    }

    companion object {
        private const val UNIQUE_NAME = "mobilecron_chain"

        fun enqueueNext(context: Context, delayMinutes: Long) {
            val request = OneTimeWorkRequestBuilder<CronChainWorker>()
                .setInitialDelay(delayMinutes, TimeUnit.MINUTES)
                .build()

            WorkManager.getInstance(context).enqueueUniqueWork(
                UNIQUE_NAME,
                ExistingWorkPolicy.REPLACE,
                request
            )
        }
    }
}
