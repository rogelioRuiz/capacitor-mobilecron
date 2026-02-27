import { Preferences } from '@capacitor/preferences'
import type {
  ActiveHours,
  CronJobOptions,
  CronJobStatus,
  CronSchedule,
  CronStatus,
  JobDueEvent,
  JobSkippedEvent,
  OverdueEvent,
  SchedulingMode,
  WakeSource,
} from './definitions'

type PlatformName = CronStatus['platform']

type CronJobState = {
  id: string
  name: string
  enabled: boolean
  schedule: CronSchedule
  activeHours?: ActiveHours
  requiresNetwork: boolean
  requiresCharging: boolean
  priority: 'low' | 'normal' | 'high'
  data?: Record<string, unknown>
  lastFiredAt?: number
  nextDueAt?: number
  consecutiveSkips: number
  createdAt: number
  updatedAt: number
}

type PersistedState = {
  version: 1
  paused: boolean
  mode: SchedulingMode
  jobs: CronJobState[]
}

type SchedulerHooks = {
  onJobDue?: (event: JobDueEvent) => void
  onJobSkipped?: (event: JobSkippedEvent) => void
  onOverdue?: (event: OverdueEvent) => void
  onStatusChanged?: (status: CronStatus) => void
}

export type MobileCronSchedulerOptions = SchedulerHooks & {
  platform?: PlatformName
  storageKey?: string
  androidDiagnostics?: CronStatus['android']
  iosDiagnostics?: CronStatus['ios']
}

const DEFAULT_STORAGE_KEY = 'mobilecron:state'
const MODE_TICKS: Record<SchedulingMode, number> = {
  eco: 60_000,
  balanced: 30_000,
  aggressive: 15_000,
}

export class MobileCronScheduler {
  private jobs = new Map<string, CronJobState>()
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private paused = false
  private mode: SchedulingMode = 'balanced'
  private readonly platform: PlatformName
  private readonly storageKey: string
  private readonly hooks: SchedulerHooks
  private readonly androidDiagnostics?: CronStatus['android']
  private readonly iosDiagnostics?: CronStatus['ios']
  private initialized = false
  private initPromise: Promise<void> | null = null
  private appListenerAttached = false
  private appIsActive = true

  constructor(options: MobileCronSchedulerOptions = {}) {
    this.platform = options.platform ?? 'web'
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY
    this.hooks = {
      onJobDue: options.onJobDue,
      onJobSkipped: options.onJobSkipped,
      onOverdue: options.onOverdue,
      onStatusChanged: options.onStatusChanged,
    }
    this.androidDiagnostics = options.androidDiagnostics
    this.iosDiagnostics = options.iosDiagnostics
  }

  async init(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      await this.load()
      this.startWatchdogIfNeeded()
      await this.attachAppStateListener()
      this.initialized = true
      this.emitStatusChanged()
    })()

    try {
      await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  async destroy(): Promise<void> {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  async register(options: CronJobOptions): Promise<{ id: string }> {
    await this.init()
    this.validateJobOptions(options)

    const now = Date.now()
    const id = this.createId()
    const schedule = this.normalizeSchedule(options.schedule, now)
    const job: CronJobState = {
      id,
      name: options.name.trim(),
      enabled: true,
      schedule,
      activeHours: options.activeHours,
      requiresNetwork: options.requiresNetwork ?? false,
      requiresCharging: options.requiresCharging ?? false,
      priority: options.priority ?? 'normal',
      data: options.data,
      consecutiveSkips: 0,
      createdAt: now,
      updatedAt: now,
      nextDueAt: this.computeNextDueAt(schedule, now),
    }

    this.jobs.set(id, job)
    await this.save()
    this.emitStatusChanged()
    return { id }
  }

  async unregister(options: { id: string }): Promise<void> {
    await this.init()
    this.jobs.delete(options.id)
    await this.save()
    this.emitStatusChanged()
  }

  async update(options: { id: string } & Partial<CronJobOptions>): Promise<void> {
    await this.init()
    const existing = this.jobs.get(options.id)
    if (!existing) throw new Error(`Job not found: ${options.id}`)

    const now = Date.now()
    const next: CronJobState = { ...existing }

    if (options.name !== undefined) {
      if (!options.name.trim()) throw new Error('Job name is required')
      next.name = options.name.trim()
    }
    if (options.schedule !== undefined) {
      this.validateSchedule(options.schedule)
      next.schedule = this.normalizeSchedule(options.schedule, now)
      next.nextDueAt = this.computeNextDueAt(next.schedule, now)
    }
    if (options.activeHours !== undefined) {
      if (options.activeHours) this.validateActiveHours(options.activeHours)
      next.activeHours = options.activeHours
    }
    if (options.requiresNetwork !== undefined) next.requiresNetwork = options.requiresNetwork
    if (options.requiresCharging !== undefined) next.requiresCharging = options.requiresCharging
    if (options.priority !== undefined) next.priority = options.priority
    if (options.data !== undefined) next.data = options.data

    next.updatedAt = now
    this.jobs.set(next.id, next)
    await this.save()
    this.emitStatusChanged()
  }

  async list(): Promise<{ jobs: CronJobStatus[] }> {
    await this.init()
    const now = Date.now()
    const jobs = Array.from(this.jobs.values())
      .map((job) => this.toStatus(job, now))
      .sort((a, b) => (a.nextDueAt ?? Number.MAX_SAFE_INTEGER) - (b.nextDueAt ?? Number.MAX_SAFE_INTEGER))
    return { jobs }
  }

  async triggerNow(options: { id: string }): Promise<void> {
    await this.init()
    const job = this.jobs.get(options.id)
    if (!job) throw new Error(`Job not found: ${options.id}`)

    const now = Date.now()
    const event = this.fireJob(job, now, 'manual')
    await this.save()
    this.hooks.onJobDue?.(event)
    this.emitStatusChanged()
  }

  async pauseAll(): Promise<void> {
    await this.init()
    this.paused = true
    await this.save()
    this.emitStatusChanged()
  }

  async resumeAll(): Promise<void> {
    await this.init()
    this.paused = false
    await this.save()
    this.emitStatusChanged()
  }

  async setMode(mode: SchedulingMode): Promise<void> {
    await this.init()
    this.mode = mode
    this.restartWatchdog()
    await this.save()
    this.emitStatusChanged()
  }

  async getStatus(): Promise<CronStatus> {
    await this.init()
    return this.buildStatus(Date.now())
  }

  checkDueJobs(source: WakeSource): JobDueEvent[] {
    const now = Date.now()
    const dueEvents: JobDueEvent[] = []
    const skippedEvents: JobSkippedEvent[] = []
    const overdueItems: OverdueEvent['jobs'] = []
    let mutated = false

    for (const job of this.jobs.values()) {
      if (!job.enabled) continue

      if (job.nextDueAt === undefined) {
        job.nextDueAt = this.computeNextDueAt(job.schedule, now)
        mutated = true
      }

      if (job.nextDueAt === undefined || job.nextDueAt > now) continue

      const dueAt = job.nextDueAt
      const skipReason = this.getSkipReason(job, now, source)
      if (skipReason) {
        job.consecutiveSkips += 1
        job.updatedAt = now
        skippedEvents.push({ id: job.id, name: job.name, reason: skipReason })
        if (job.schedule.kind === 'every') {
          job.nextDueAt = this.computeNextDueAt(job.schedule, now)
        }
        mutated = true
        continue
      }

      const event = this.fireJob(job, now, source)
      dueEvents.push(event)
      overdueItems.push({ id: job.id, name: job.name, overdueMs: Math.max(0, now - dueAt) })
      mutated = true
    }

    if (mutated) {
      void this.save()
      this.emitStatusChanged()
    }

    for (const event of skippedEvents) this.hooks.onJobSkipped?.(event)
    for (const event of dueEvents) this.hooks.onJobDue?.(event)

    if (source === 'foreground' && overdueItems.length > 0) {
      this.hooks.onOverdue?.({ count: overdueItems.length, jobs: overdueItems })
    }

    return dueEvents
  }

  computeNextDueAt(schedule: CronSchedule, nowMs: number): number | undefined {
    if (schedule.kind === 'at') {
      if (typeof schedule.atMs !== 'number') return undefined
      return schedule.atMs > nowMs ? schedule.atMs : undefined
    }

    const everyMs = schedule.everyMs
    if (typeof everyMs !== 'number' || everyMs <= 0) return undefined

    const anchorMs = typeof schedule.anchorMs === 'number' ? schedule.anchorMs : nowMs
    if (nowMs < anchorMs) return anchorMs

    const elapsed = nowMs - anchorMs
    const steps = Math.floor(elapsed / everyMs) + 1
    return anchorMs + steps * everyMs
  }

  isWithinActiveHours(hours: ActiveHours, nowMs: number): boolean {
    const start = this.parseClock(hours.start)
    const end = this.parseClock(hours.end)
    if (start === null || end === null) return true

    const parts = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: hours.tz,
    }).formatToParts(new Date(nowMs))

    const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
    const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
    const nowMinutes = hh * 60 + mm

    if (start === end) return true
    if (start < end) return nowMinutes >= start && nowMinutes < end
    return nowMinutes >= start || nowMinutes < end
  }

  async save(): Promise<void> {
    const state: PersistedState = {
      version: 1,
      paused: this.paused,
      mode: this.mode,
      jobs: Array.from(this.jobs.values()),
    }
    const serialized = JSON.stringify(state)

    try {
      await Preferences.set({ key: this.storageKey, value: serialized })
      return
    } catch {
      // Fall back to localStorage when Preferences is unavailable (web/dev)
    }

    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this.storageKey, serialized)
    }
  }

  async load(): Promise<void> {
    let raw: string | null = null
    try {
      const result = await Preferences.get({ key: this.storageKey })
      raw = result.value ?? null
    } catch {
      if (typeof localStorage !== 'undefined') {
        raw = localStorage.getItem(this.storageKey)
      }
    }

    if (!raw) return

    let parsed: PersistedState | null = null
    try {
      parsed = JSON.parse(raw) as PersistedState
    } catch {
      return
    }

    if (!parsed || parsed.version !== 1) return

    this.paused = parsed.paused ?? false
    this.mode = parsed.mode ?? 'balanced'
    this.jobs.clear()

    const now = Date.now()
    for (const job of parsed.jobs ?? []) {
      try {
        this.validateSchedule(job.schedule)
      } catch {
        continue
      }

      const restored: CronJobState = {
        id: String(job.id),
        name: String(job.name),
        enabled: Boolean(job.enabled),
        schedule: this.normalizeSchedule(job.schedule, now),
        activeHours: job.activeHours,
        requiresNetwork: Boolean(job.requiresNetwork),
        requiresCharging: Boolean(job.requiresCharging),
        priority: job.priority ?? 'normal',
        data: job.data,
        lastFiredAt: job.lastFiredAt,
        nextDueAt: job.nextDueAt,
        consecutiveSkips: Number(job.consecutiveSkips ?? 0),
        createdAt: Number(job.createdAt ?? now),
        updatedAt: Number(job.updatedAt ?? now),
      }

      if (restored.enabled && restored.nextDueAt === undefined) {
        restored.nextDueAt = this.computeNextDueAt(restored.schedule, now)
      }
      this.jobs.set(restored.id, restored)
    }
  }

  private buildStatus(now: number): CronStatus {
    const nextDueAt = this.getEarliestNextDue(now)
    return {
      paused: this.paused,
      mode: this.mode,
      platform: this.platform,
      activeJobCount: Array.from(this.jobs.values()).filter((j) => j.enabled).length,
      nextDueAt,
      android:
        this.platform === 'android'
          ? (this.androidDiagnostics ?? { workManagerActive: false, chargingReceiverActive: false })
          : undefined,
      ios:
        this.platform === 'ios'
          ? (this.iosDiagnostics ?? {
              bgRefreshRegistered: false,
              bgProcessingRegistered: false,
              bgContinuedAvailable: false,
            })
          : undefined,
    }
  }

  private getEarliestNextDue(now: number): number | undefined {
    let earliest: number | undefined
    for (const job of this.jobs.values()) {
      if (!job.enabled) continue
      const next = job.nextDueAt ?? this.computeNextDueAt(job.schedule, now)
      if (next === undefined) continue
      earliest = earliest === undefined ? next : Math.min(earliest, next)
    }
    return earliest
  }

  private toStatus(job: CronJobState, now: number): CronJobStatus {
    const nextDueAt = job.enabled ? (job.nextDueAt ?? this.computeNextDueAt(job.schedule, now)) : undefined
    return {
      id: job.id,
      name: job.name,
      enabled: job.enabled,
      schedule: { ...job.schedule },
      lastFiredAt: job.lastFiredAt,
      nextDueAt,
      consecutiveSkips: job.consecutiveSkips,
      data: job.data,
    }
  }

  private fireJob(job: CronJobState, now: number, source: WakeSource): JobDueEvent {
    job.lastFiredAt = now
    job.updatedAt = now
    job.consecutiveSkips = 0

    if (job.schedule.kind === 'at') {
      job.enabled = false
      job.nextDueAt = undefined
    } else {
      job.nextDueAt = this.computeNextDueAt(job.schedule, now)
    }

    return {
      id: job.id,
      name: job.name,
      firedAt: now,
      source,
      data: job.data,
    }
  }

  private getSkipReason(job: CronJobState, now: number, source: WakeSource): JobSkippedEvent['reason'] | null {
    if (this.paused) return 'paused'
    if (job.activeHours && !this.isWithinActiveHours(job.activeHours, now)) return 'outside_active_hours'
    if (job.requiresNetwork && !this.isNetworkAvailable()) return 'requires_network'
    if (job.requiresCharging && !this.isChargingAvailable(source)) return 'requires_charging'
    return null
  }

  private isNetworkAvailable(): boolean {
    if (typeof navigator === 'undefined') return true
    return navigator.onLine !== false
  }

  private isChargingAvailable(source?: WakeSource): boolean {
    if (source === 'charging') return true
    // Web fallback has no portable charging API. Native wake sources should enforce this.
    return false
  }

  private validateJobOptions(options: CronJobOptions): void {
    if (!options.name?.trim()) throw new Error('Job name is required')
    this.validateSchedule(options.schedule)
    if (options.activeHours) this.validateActiveHours(options.activeHours)
  }

  private validateSchedule(schedule: CronSchedule): void {
    if (schedule.kind === 'every') {
      if (typeof schedule.everyMs !== 'number' || !Number.isFinite(schedule.everyMs) || schedule.everyMs <= 0) {
        throw new Error('schedule.everyMs must be a positive number')
      }
      if (this.platform !== 'web' && schedule.everyMs < 60_000) {
        throw new Error('schedule.everyMs must be at least 60000 on mobile')
      }
      return
    }

    if (schedule.kind === 'at') {
      if (typeof schedule.atMs !== 'number' || !Number.isFinite(schedule.atMs)) {
        throw new Error('schedule.atMs must be a valid epoch milliseconds timestamp')
      }
      return
    }

    throw new Error(`Unsupported schedule kind: ${(schedule as { kind?: string }).kind ?? 'unknown'}`)
  }

  private validateActiveHours(hours: ActiveHours): void {
    if (this.parseClock(hours.start) === null) throw new Error('activeHours.start must be HH:MM')
    if (this.parseClock(hours.end) === null) throw new Error('activeHours.end must be HH:MM')
    if (hours.tz) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: hours.tz }).format(new Date())
      } catch {
        throw new Error(`Invalid time zone: ${hours.tz}`)
      }
    }
  }

  private parseClock(value: string): number | null {
    const m = /^(\d{2}):(\d{2})$/.exec(value)
    if (!m) return null
    const hh = Number(m[1])
    const mm = Number(m[2])
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
    return hh * 60 + mm
  }

  private normalizeSchedule(schedule: CronSchedule, now: number): CronSchedule {
    if (schedule.kind === 'every') {
      return {
        kind: 'every',
        everyMs: schedule.everyMs,
        anchorMs: schedule.anchorMs ?? now,
      }
    }

    return {
      kind: 'at',
      atMs: schedule.atMs,
    }
  }

  private createId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
    return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  }

  private startWatchdogIfNeeded(): void {
    if (this.watchdogTimer || !this.appIsActive) return
    const tickMs = MODE_TICKS[this.mode]
    this.watchdogTimer = setInterval(() => {
      this.checkDueJobs('watchdog')
    }, tickMs)
  }

  private restartWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
    this.startWatchdogIfNeeded()
  }

  private emitStatusChanged(): void {
    this.hooks.onStatusChanged?.(this.buildStatus(Date.now()))
  }

  private async attachAppStateListener(): Promise<void> {
    if (this.appListenerAttached) return

    try {
      const mod = await import('@capacitor/app')
      await mod.App.addListener('appStateChange', ({ isActive }) => {
        this.appIsActive = isActive
        if (isActive) {
          this.startWatchdogIfNeeded()
          this.checkDueJobs('foreground')
        } else if (this.watchdogTimer) {
          clearInterval(this.watchdogTimer)
          this.watchdogTimer = null
        }
      })
      this.appListenerAttached = true
    } catch {
      // App plugin is optional in some environments.
    }
  }
}
