package io.mobilecron

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

class CronWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        NativeJobEvaluator.evaluate(applicationContext, "workmanager")
        CronBridge.wake("workmanager")
        return Result.success()
    }
}
