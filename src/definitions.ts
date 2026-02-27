import type { PluginListenerHandle } from '@capacitor/core'

export interface MobileCronPlugin {
  register(options: CronJobOptions): Promise<{ id: string }>
  unregister(options: { id: string }): Promise<void>
  update(options: { id: string } & Partial<CronJobOptions>): Promise<void>
  list(): Promise<{ jobs: CronJobStatus[] }>
  triggerNow(options: { id: string }): Promise<void>

  pauseAll(): Promise<void>
  resumeAll(): Promise<void>
  setMode(options: { mode: SchedulingMode }): Promise<void>
  getStatus(): Promise<CronStatus>

  addListener(event: 'jobDue', handler: (data: JobDueEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'jobSkipped', handler: (data: JobSkippedEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'overdueJobs', handler: (data: OverdueEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'statusChanged', handler: (data: CronStatus) => void): Promise<PluginListenerHandle>
  addListener(event: 'nativeWake', handler: (data: { source: WakeSource; paused?: boolean }) => void): Promise<PluginListenerHandle>

  // E2E test hooks (not for production use)
  testNativeEvaluate(): Promise<{ firedCount: number }>
  testSetNextDueAt(options: { id: string; nextDueAtMs: number }): Promise<void>
  testInjectPendingEvent(options: { event: Record<string, unknown> }): Promise<void>
  testGetPendingCount(): Promise<{ count: number }>
}

export interface CronJobOptions {
  name: string
  schedule: CronSchedule
  activeHours?: ActiveHours
  requiresNetwork?: boolean
  requiresCharging?: boolean
  priority?: 'low' | 'normal' | 'high'
  data?: Record<string, unknown>
}

export interface CronSchedule {
  kind: 'every' | 'at'
  everyMs?: number
  anchorMs?: number
  atMs?: number
}

export interface ActiveHours {
  start: string
  end: string
  tz?: string
}

export type SchedulingMode = 'eco' | 'balanced' | 'aggressive'

export interface CronJobStatus {
  id: string
  name: string
  enabled: boolean
  schedule: CronSchedule
  lastFiredAt?: number
  nextDueAt?: number
  consecutiveSkips: number
  data?: Record<string, unknown>
}

export interface CronStatus {
  paused: boolean
  mode: SchedulingMode
  platform: 'android' | 'ios' | 'web'
  activeJobCount: number
  nextDueAt?: number
  android?: { workManagerActive: boolean; chargingReceiverActive: boolean }
  ios?: {
    bgRefreshRegistered: boolean
    bgProcessingRegistered: boolean
    bgContinuedAvailable: boolean
  }
}

export type WakeSource =
  | 'watchdog'
  | 'workmanager'
  | 'workmanager_chain'
  | 'charging'
  | 'foreground'
  | 'bgtask_refresh'
  | 'bgtask_processing'
  | 'bgtask_continued'
  | 'manual'

export type NativeFiredEvent = {
  id: string
  name: string
  firedAt: number
  source: WakeSource
  data?: Record<string, unknown>
}

export type JobDueEvent = NativeFiredEvent

export interface JobSkippedEvent {
  id: string
  name: string
  reason: 'outside_active_hours' | 'paused' | 'requires_network' | 'requires_charging'
}

export interface OverdueEvent {
  count: number
  jobs: Array<{ id: string; name: string; overdueMs: number }>
}
