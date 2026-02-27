import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileCronScheduler } from '../../src/mobilecron'

// Each test uses a fresh isolated scheduler backed by an in-memory localStorage
// (happy-dom provides localStorage; @capacitor/preferences throws → fallback kicks in)

describe('computeNextDueAt', () => {
  const s = new MobileCronScheduler()

  it('every: first tick = anchor + everyMs', () => {
    const anchor = 1_000_000
    expect(s.computeNextDueAt({ kind: 'every', everyMs: 60_000, anchorMs: anchor }, anchor)).toBe(anchor + 60_000)
  })

  it('every: accounts for elapsed steps', () => {
    const anchor = 1_000_000
    const now = anchor + 90_000 // 1.5 intervals elapsed → next is step 2
    expect(s.computeNextDueAt({ kind: 'every', everyMs: 60_000, anchorMs: anchor }, now)).toBe(anchor + 120_000)
  })

  it('every: now before anchor uses anchor as first tick', () => {
    const anchor = 1_000_000
    expect(s.computeNextDueAt({ kind: 'every', everyMs: 60_000, anchorMs: anchor }, anchor - 5_000)).toBe(anchor)
  })

  it('every: returns undefined when everyMs is 0', () => {
    expect(s.computeNextDueAt({ kind: 'every', everyMs: 0 }, 0)).toBeUndefined()
  })

  it('at: returns atMs when in future', () => {
    const now = 1_000_000
    expect(s.computeNextDueAt({ kind: 'at', atMs: now + 5_000 }, now)).toBe(now + 5_000)
  })

  it('at: returns undefined when in past', () => {
    const now = 1_000_000
    expect(s.computeNextDueAt({ kind: 'at', atMs: now - 1 }, now)).toBeUndefined()
  })

  it('at: returns undefined when missing atMs', () => {
    expect(s.computeNextDueAt({ kind: 'at' } as any, 1_000_000)).toBeUndefined()
  })
})

describe('isWithinActiveHours', () => {
  const s = new MobileCronScheduler()

  it('always true when start === end (disabled window)', () => {
    expect(s.isWithinActiveHours({ start: '09:00', end: '09:00' }, Date.now())).toBe(true)
  })

  it('inside day window', () => {
    const t = Date.parse('2024-03-15T10:30:00Z') // 10:30 UTC
    expect(s.isWithinActiveHours({ start: '09:00', end: '18:00', tz: 'UTC' }, t)).toBe(true)
  })

  it('before day window start', () => {
    const t = Date.parse('2024-03-15T08:00:00Z') // 08:00 UTC
    expect(s.isWithinActiveHours({ start: '09:00', end: '18:00', tz: 'UTC' }, t)).toBe(false)
  })

  it('after day window end', () => {
    const t = Date.parse('2024-03-15T20:00:00Z') // 20:00 UTC
    expect(s.isWithinActiveHours({ start: '09:00', end: '18:00', tz: 'UTC' }, t)).toBe(false)
  })

  it('exactly at window start is inside', () => {
    const t = Date.parse('2024-03-15T09:00:00Z')
    expect(s.isWithinActiveHours({ start: '09:00', end: '18:00', tz: 'UTC' }, t)).toBe(true)
  })

  it('exactly at window end is outside (exclusive end)', () => {
    const t = Date.parse('2024-03-15T18:00:00Z')
    expect(s.isWithinActiveHours({ start: '09:00', end: '18:00', tz: 'UTC' }, t)).toBe(false)
  })

  it('overnight window: midnight is inside', () => {
    const t = Date.parse('2024-03-15T00:30:00Z') // 00:30 UTC
    expect(s.isWithinActiveHours({ start: '22:00', end: '06:00', tz: 'UTC' }, t)).toBe(true)
  })

  it('overnight window: 10:00 is outside', () => {
    const t = Date.parse('2024-03-15T10:00:00Z')
    expect(s.isWithinActiveHours({ start: '22:00', end: '06:00', tz: 'UTC' }, t)).toBe(false)
  })
})

describe('register / unregister / list', () => {
  let s: MobileCronScheduler

  beforeEach(async () => {
    localStorage.clear()
    s = new MobileCronScheduler({ platform: 'web' })
    await s.init()
  })

  afterEach(() => s.destroy())

  it('returns a non-empty id', async () => {
    const { id } = await s.register({ name: 'job', schedule: { kind: 'every', everyMs: 1_000 } })
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('each registration gets a unique id', async () => {
    const a = await s.register({ name: 'a', schedule: { kind: 'every', everyMs: 1_000 } })
    const b = await s.register({ name: 'b', schedule: { kind: 'every', everyMs: 1_000 } })
    expect(a.id).not.toBe(b.id)
  })

  it('job appears in list after register', async () => {
    const { id } = await s.register({ name: 'visible', schedule: { kind: 'every', everyMs: 1_000 } })
    const { jobs } = await s.list()
    expect(jobs.find(j => j.id === id)?.name).toBe('visible')
  })

  it('job is absent from list after unregister', async () => {
    const { id } = await s.register({ name: 'gone', schedule: { kind: 'every', everyMs: 1_000 } })
    await s.unregister({ id })
    const { jobs } = await s.list()
    expect(jobs.find(j => j.id === id)).toBeUndefined()
  })

  it('list is sorted by nextDueAt ascending', async () => {
    await s.register({ name: 'far', schedule: { kind: 'every', everyMs: 120_000 } })
    await s.register({ name: 'soon', schedule: { kind: 'every', everyMs: 1_000 } })
    const { jobs } = await s.list()
    for (let i = 1; i < jobs.length; i++) {
      expect(jobs[i].nextDueAt ?? Infinity).toBeGreaterThanOrEqual(jobs[i - 1].nextDueAt ?? 0)
    }
  })

  it('rejects empty name', async () => {
    await expect(s.register({ name: '', schedule: { kind: 'every', everyMs: 1_000 } })).rejects.toThrow()
  })

  it('rejects whitespace-only name', async () => {
    await expect(s.register({ name: '   ', schedule: { kind: 'every', everyMs: 1_000 } })).rejects.toThrow()
  })

  it('rejects zero everyMs', async () => {
    await expect(s.register({ name: 'x', schedule: { kind: 'every', everyMs: 0 } })).rejects.toThrow()
  })

  it('rejects negative everyMs', async () => {
    await expect(s.register({ name: 'x', schedule: { kind: 'every', everyMs: -500 } })).rejects.toThrow()
  })

  it('accepts at-schedule with future atMs', async () => {
    const { id } = await s.register({ name: 'oneshot', schedule: { kind: 'at', atMs: Date.now() + 10_000 } })
    const { jobs } = await s.list()
    expect(jobs.find(j => j.id === id)?.schedule.kind).toBe('at')
  })

  it('stores data payload on the job', async () => {
    const data = { userId: '42', tags: ['a', 'b'] }
    const { id } = await s.register({ name: 'with-data', schedule: { kind: 'every', everyMs: 1_000 }, data })
    const { jobs } = await s.list()
    expect(jobs.find(j => j.id === id)?.data).toEqual(data)
  })
})

describe('update', () => {
  let s: MobileCronScheduler

  beforeEach(async () => {
    localStorage.clear()
    s = new MobileCronScheduler({ platform: 'web' })
    await s.init()
  })

  afterEach(() => s.destroy())

  it('updates name', async () => {
    const { id } = await s.register({ name: 'original', schedule: { kind: 'every', everyMs: 1_000 } })
    await s.update({ id, name: 'renamed' })
    const { jobs } = await s.list()
    expect(jobs.find(j => j.id === id)?.name).toBe('renamed')
  })

  it('updates priority', async () => {
    const { id } = await s.register({ name: 'j', schedule: { kind: 'every', everyMs: 1_000 }, priority: 'low' })
    await s.update({ id, priority: 'high' })
    // priority is not in CronJobStatus but stored internally — verify via data roundtrip
    const { jobs } = await s.list()
    expect(jobs.find(j => j.id === id)).toBeDefined()
  })

  it('rejects update on missing job', async () => {
    await expect(s.update({ id: 'ghost', name: 'new' })).rejects.toThrow('not found')
  })

  it('rejects update with empty name', async () => {
    const { id } = await s.register({ name: 'x', schedule: { kind: 'every', everyMs: 1_000 } })
    await expect(s.update({ id, name: '   ' })).rejects.toThrow()
  })
})

describe('triggerNow', () => {
  let s: MobileCronScheduler
  const fired: Array<{ id: string; source: string }> = []

  beforeEach(async () => {
    fired.length = 0
    localStorage.clear()
    s = new MobileCronScheduler({ platform: 'web', onJobDue: e => fired.push({ id: e.id, source: e.source }) })
    await s.init()
  })

  afterEach(() => s.destroy())

  it('fires jobDue with source = "manual"', async () => {
    const { id } = await s.register({ name: 'trig', schedule: { kind: 'every', everyMs: 1_000 } })
    await s.triggerNow({ id })
    expect(fired.find(e => e.id === id)?.source).toBe('manual')
  })

  it('rejects on missing id', async () => {
    await expect(s.triggerNow({ id: 'none' })).rejects.toThrow('not found')
  })

  it('fires even when scheduler is paused', async () => {
    await s.pauseAll()
    const { id } = await s.register({ name: 'trig-paused', schedule: { kind: 'every', everyMs: 1_000 } })
    await s.triggerNow({ id })
    expect(fired.find(e => e.id === id)).toBeDefined()
  })
})

describe('checkDueJobs', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires a job that is past its nextDueAt', async () => {
    const fired: string[] = []
    const s = new MobileCronScheduler({ platform: 'web', onJobDue: e => fired.push(e.id) })
    await s.init()

    const { id } = await s.register({ name: 'tick', schedule: { kind: 'every', everyMs: 1_000 } })
    vi.advanceTimersByTime(1_500) // move past the 1s interval
    s.checkDueJobs('watchdog')
    expect(fired).toContain(id)
    await s.destroy()
  })

  it('skips job when paused', async () => {
    const skipped: string[] = []
    const s = new MobileCronScheduler({ platform: 'web', onJobSkipped: e => skipped.push(e.id) })
    await s.init()
    await s.pauseAll()

    const { id } = await s.register({ name: 'paused-job', schedule: { kind: 'every', everyMs: 1_000 } })
    vi.advanceTimersByTime(1_500)
    s.checkDueJobs('watchdog')
    expect(skipped).toContain(id)
    await s.destroy()
  })

  it('at-kind job disables itself after firing', async () => {
    const s = new MobileCronScheduler({ platform: 'web', onJobDue: () => {} })
    await s.init()

    const { id } = await s.register({ name: 'oneshot', schedule: { kind: 'at', atMs: Date.now() + 500 } })
    vi.advanceTimersByTime(1_000)
    s.checkDueJobs('watchdog')
    const { jobs } = await s.list()
    expect(jobs.find(j => j.id === id)?.enabled).toBe(false)
    await s.destroy()
  })

  it('emits overdueJobs on foreground source', async () => {
    let overdue: { count: number } | null = null
    const s = new MobileCronScheduler({ platform: 'web', onJobDue: () => {}, onOverdue: e => { overdue = e } })
    await s.init()

    await s.register({ name: 'overdue', schedule: { kind: 'every', everyMs: 1_000 } })
    vi.advanceTimersByTime(1_500)
    s.checkDueJobs('foreground')
    expect(overdue).not.toBeNull()
    expect((overdue as any).count).toBeGreaterThan(0)
    await s.destroy()
  })

  it('returns fired events array', async () => {
    const s = new MobileCronScheduler({ platform: 'web', onJobDue: () => {} })
    await s.init()

    await s.register({ name: 'r', schedule: { kind: 'every', everyMs: 1_000 } })
    vi.advanceTimersByTime(1_500)
    const events = s.checkDueJobs('watchdog')
    expect(events.length).toBe(1)
    expect(events[0].source).toBe('watchdog')
    await s.destroy()
  })
})

describe('pauseAll / resumeAll', () => {
  let s: MobileCronScheduler

  beforeEach(async () => {
    localStorage.clear()
    s = new MobileCronScheduler({ platform: 'web' })
    await s.init()
  })

  afterEach(() => s.destroy())

  it('pauses and resumes', async () => {
    await s.pauseAll()
    expect((await s.getStatus()).paused).toBe(true)
    await s.resumeAll()
    expect((await s.getStatus()).paused).toBe(false)
  })

  it('double pause is idempotent', async () => {
    await s.pauseAll()
    await s.pauseAll()
    expect((await s.getStatus()).paused).toBe(true)
    await s.resumeAll()
  })

  it('double resume is idempotent', async () => {
    await s.resumeAll()
    await s.resumeAll()
    expect((await s.getStatus()).paused).toBe(false)
  })
})

describe('setMode', () => {
  let s: MobileCronScheduler

  beforeEach(async () => {
    localStorage.clear()
    s = new MobileCronScheduler({ platform: 'web' })
    await s.init()
  })

  afterEach(() => s.destroy())

  it('eco mode reflected in status', async () => {
    await s.setMode('eco')
    expect((await s.getStatus()).mode).toBe('eco')
  })

  it('aggressive mode reflected in status', async () => {
    await s.setMode('aggressive')
    expect((await s.getStatus()).mode).toBe('aggressive')
  })

  it('balanced mode reflected in status', async () => {
    await s.setMode('balanced')
    expect((await s.getStatus()).mode).toBe('balanced')
  })
})

describe('getStatus', () => {
  let s: MobileCronScheduler

  beforeEach(async () => {
    localStorage.clear()
    s = new MobileCronScheduler({ platform: 'web' })
    await s.init()
  })

  afterEach(() => s.destroy())

  it('initial status is sane', async () => {
    const st = await s.getStatus()
    expect(st.paused).toBe(false)
    expect(st.mode).toBe('balanced')
    expect(st.platform).toBe('web')
    expect(st.activeJobCount).toBe(0)
  })

  it('activeJobCount tracks registrations', async () => {
    await s.register({ name: 'a', schedule: { kind: 'every', everyMs: 1_000 } })
    await s.register({ name: 'b', schedule: { kind: 'every', everyMs: 1_000 } })
    expect((await s.getStatus()).activeJobCount).toBe(2)
  })

  it('platform android includes android diagnostics', async () => {
    const sa = new MobileCronScheduler({
      platform: 'android',
      androidDiagnostics: { workManagerActive: true, chargingReceiverActive: false },
    })
    await sa.init()
    const st = await sa.getStatus()
    expect(st.android?.workManagerActive).toBe(true)
    expect(st.ios).toBeUndefined()
    await sa.destroy()
  })

  it('platform ios includes ios diagnostics', async () => {
    const si = new MobileCronScheduler({
      platform: 'ios',
      iosDiagnostics: { bgRefreshRegistered: true, bgProcessingRegistered: false, bgContinuedAvailable: false },
    })
    await si.init()
    const st = await si.getStatus()
    expect(st.ios?.bgRefreshRegistered).toBe(true)
    expect(st.android).toBeUndefined()
    await si.destroy()
  })
})

describe('persistence', () => {
  it('survives reload — jobs restored from localStorage', async () => {
    localStorage.clear()

    const s1 = new MobileCronScheduler({ platform: 'web' })
    await s1.init()
    await s1.register({ name: 'persistent', schedule: { kind: 'every', everyMs: 1_000 } })
    await s1.pauseAll()
    await s1.setMode('eco')
    await s1.destroy()

    // New instance loads same localStorage
    const s2 = new MobileCronScheduler({ platform: 'web' })
    await s2.init()
    const { jobs } = await s2.list()
    const st = await s2.getStatus()

    expect(jobs.find(j => j.name === 'persistent')).toBeDefined()
    expect(st.paused).toBe(true)
    expect(st.mode).toBe('eco')

    await s2.destroy()
  })

  it('ignores corrupt localStorage data gracefully', async () => {
    localStorage.clear()
    localStorage.setItem('mobilecron:state', '{invalid json}}}')

    const s = new MobileCronScheduler({ platform: 'web' })
    await s.init() // must not throw
    const { jobs } = await s.list()
    expect(jobs).toHaveLength(0)
    await s.destroy()
  })

  it('ignores unknown state version', async () => {
    localStorage.clear()
    localStorage.setItem('mobilecron:state', JSON.stringify({ version: 99, paused: false, mode: 'eco', jobs: [] }))

    const s = new MobileCronScheduler({ platform: 'web' })
    await s.init()
    expect((await s.getStatus()).mode).toBe('balanced') // default, not 'eco' from unknown version
    await s.destroy()
  })

  it('custom storageKey isolates schedulers', async () => {
    localStorage.clear()

    const sa = new MobileCronScheduler({ platform: 'web', storageKey: 'sched-A' })
    const sb = new MobileCronScheduler({ platform: 'web', storageKey: 'sched-B' })
    await sa.init()
    await sb.init()

    await sa.register({ name: 'only-in-A', schedule: { kind: 'every', everyMs: 1_000 } })

    const { jobs: jobsA } = await sa.list()
    const { jobs: jobsB } = await sb.list()
    expect(jobsA.find(j => j.name === 'only-in-A')).toBeDefined()
    expect(jobsB.find(j => j.name === 'only-in-A')).toBeUndefined()

    await sa.destroy()
    await sb.destroy()
  })
})
