import { type PluginListenerHandle, WebPlugin } from '@capacitor/core'
import type {
  CronJobOptions,
  CronStatus,
  JobDueEvent,
  JobSkippedEvent,
  MobileCronPlugin,
  OverdueEvent,
  SchedulingMode,
} from './definitions'
import { MobileCronScheduler } from './mobilecron'

export class MobileCronWeb extends WebPlugin implements MobileCronPlugin {
  private readonly scheduler: MobileCronScheduler
  private readonly ready: Promise<void>

  constructor() {
    super()
    this.scheduler = new MobileCronScheduler({
      platform: 'web',
      onJobDue: (event) => this.notifyListeners('jobDue', event),
      onJobSkipped: (event) => this.notifyListeners('jobSkipped', event),
      onOverdue: (event) => this.notifyListeners('overdueJobs', event),
      onStatusChanged: (status) => this.notifyListeners('statusChanged', status),
    })
    this.ready = this.scheduler.init()
  }

  async register(options: CronJobOptions): Promise<{ id: string }> {
    await this.ready
    return this.scheduler.register(options)
  }

  async unregister(options: { id: string }): Promise<void> {
    await this.ready
    return this.scheduler.unregister(options)
  }

  async update(options: { id: string } & Partial<CronJobOptions>): Promise<void> {
    await this.ready
    return this.scheduler.update(options)
  }

  async list(): Promise<{ jobs: import('./definitions').CronJobStatus[] }> {
    await this.ready
    return this.scheduler.list()
  }

  async triggerNow(options: { id: string }): Promise<void> {
    await this.ready
    return this.scheduler.triggerNow(options)
  }

  async pauseAll(): Promise<void> {
    await this.ready
    return this.scheduler.pauseAll()
  }

  async resumeAll(): Promise<void> {
    await this.ready
    return this.scheduler.resumeAll()
  }

  async setMode(options: { mode: SchedulingMode }): Promise<void> {
    await this.ready
    return this.scheduler.setMode(options.mode)
  }

  async getStatus(): Promise<CronStatus> {
    await this.ready
    return this.scheduler.getStatus()
  }

  async addListener(event: 'jobDue', handler: (data: JobDueEvent) => void): Promise<PluginListenerHandle>
  async addListener(event: 'jobSkipped', handler: (data: JobSkippedEvent) => void): Promise<PluginListenerHandle>
  async addListener(event: 'overdueJobs', handler: (data: OverdueEvent) => void): Promise<PluginListenerHandle>
  async addListener(event: 'statusChanged', handler: (data: CronStatus) => void): Promise<PluginListenerHandle>
  async addListener(eventName: string, listenerFunc: (data: any) => void): Promise<PluginListenerHandle> {
    return super.addListener(eventName, listenerFunc)
  }
}
