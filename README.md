# capacitor-mobilecron

> Lightweight Capacitor scheduling primitive — register jobs, get `jobDue` events when they fire, across web, Android, and iOS.

[![npm version](https://img.shields.io/npm/v/capacitor-mobilecron)](https://www.npmjs.com/package/capacitor-mobilecron)
[![CI](https://github.com/rogelioRuiz/capacitor-mobilecron/actions/workflows/ci.yml/badge.svg)](https://github.com/rogelioRuiz/capacitor-mobilecron/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Overview

`capacitor-mobilecron` manages a set of named, persistent cron-like jobs and emits events when they are due. It handles:

- **Repeating intervals** (`every: N ms`) with optional anchor alignment
- **One-shot schedules** (`at: epoch ms`) that auto-disable after firing
- **Active-hour windows** — restrict jobs to HH:MM–HH:MM ranges with timezone support
- **Network / charging constraints** — skip a job when connectivity or power is absent
- **Scheduling modes** — `eco` (60s watchdog), `balanced` (30s), `aggressive` (15s)
- **App foreground wakeup** — immediately checks overdue jobs when the app comes to the foreground
- **Persistent state** — job registry survives app restarts via `@capacitor/preferences` (falls back to `localStorage` on web)

The web implementation is fully functional and self-contained. Android and iOS stubs satisfy the Capacitor plugin contract and can be extended with native WorkManager / BGTaskScheduler wakeups.

## Installation

```bash
npm install capacitor-mobilecron
npx cap sync
```

**Peer dependencies** you need in your Capacitor app:

```bash
npm install @capacitor/core @capacitor/preferences
# @capacitor/app is optional — enables foreground-wakeup check
npm install @capacitor/app
```

## Quick start

```typescript
import { MobileCron } from 'capacitor-mobilecron'

// Listen for due events
await MobileCron.addListener('jobDue', ({ id, name, firedAt, source, data }) => {
  console.log(`Job "${name}" fired at ${new Date(firedAt).toISOString()} via ${source}`)
})

// Register a repeating job — every 5 minutes
const { id } = await MobileCron.register({
  name: 'sync-data',
  schedule: { kind: 'every', everyMs: 5 * 60 * 1000 },
})

// Register a one-shot job — fires at a specific time
await MobileCron.register({
  name: 'daily-reminder',
  schedule: { kind: 'at', atMs: Date.now() + 24 * 60 * 60 * 1000 },
})
```

## API

### `register(options)`

Register a new job. Returns the job `id`.

```typescript
const { id } = await MobileCron.register({
  name: 'my-job',
  schedule: { kind: 'every', everyMs: 60_000 },       // every 60 s
  activeHours: { start: '08:00', end: '22:00', tz: 'America/Chicago' },
  requiresNetwork: true,
  requiresCharging: false,
  priority: 'normal',
  data: { userId: '42' },                              // passed back in jobDue event
})
```

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Human-readable label |
| `schedule` | `CronSchedule` | When to fire (see below) |
| `activeHours` | `ActiveHours?` | Restrict firing to a time window |
| `requiresNetwork` | `boolean?` | Skip when offline |
| `requiresCharging` | `boolean?` | Skip when not charging |
| `priority` | `'low' \| 'normal' \| 'high'?` | Scheduling hint |
| `data` | `Record<string, unknown>?` | Arbitrary payload returned in events |

### Schedules

```typescript
// Repeat every N ms (minimum 60 000 ms on native)
{ kind: 'every', everyMs: 300_000 }

// Repeat every N ms, aligned to an anchor timestamp
{ kind: 'every', everyMs: 3600_000, anchorMs: Date.now() }

// Fire once at an absolute epoch timestamp
{ kind: 'at', atMs: Date.parse('2025-01-01T09:00:00Z') }
```

### `unregister({ id })`

Remove a job and stop it from firing.

```typescript
await MobileCron.unregister({ id })
```

### `update({ id, ...partial })`

Patch an existing job without losing its state.

```typescript
await MobileCron.update({
  id,
  schedule: { kind: 'every', everyMs: 10 * 60 * 1000 },
  activeHours: { start: '09:00', end: '17:00' },
})
```

### `list()`

Returns all registered jobs sorted by next due time.

```typescript
const { jobs } = await MobileCron.list()
for (const job of jobs) {
  console.log(job.name, 'next due at', new Date(job.nextDueAt ?? 0).toISOString())
}
```

### `triggerNow({ id })`

Force a job to fire immediately (source = `'manual'`).

```typescript
await MobileCron.triggerNow({ id })
```

### `pauseAll()` / `resumeAll()`

Suspend / resume all job checks globally.

```typescript
await MobileCron.pauseAll()
await MobileCron.resumeAll()
```

### `setMode({ mode })`

Control how frequently the watchdog timer checks for due jobs.

| Mode | Interval | Use case |
|------|----------|---------|
| `'eco'` | 60 s | Battery-sensitive background |
| `'balanced'` | 30 s | Default |
| `'aggressive'` | 15 s | Real-time UX needs |

```typescript
await MobileCron.setMode({ mode: 'aggressive' })
```

### `getStatus()`

Returns scheduler diagnostics.

```typescript
const status = await MobileCron.getStatus()
// {
//   paused: false,
//   mode: 'balanced',
//   platform: 'android',
//   activeJobCount: 3,
//   nextDueAt: 1719000000000,
//   android: { workManagerActive: true, chargingReceiverActive: false }
// }
```

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `jobDue` | `JobDueEvent` | A job fired |
| `jobSkipped` | `JobSkippedEvent` | A due job was skipped (constraint not met) |
| `overdueJobs` | `OverdueEvent` | Emitted on foreground resume if jobs are overdue |
| `statusChanged` | `CronStatus` | Scheduler state changed |

```typescript
MobileCron.addListener('jobSkipped', ({ id, name, reason }) => {
  // reason: 'outside_active_hours' | 'paused' | 'requires_network' | 'requires_charging'
  console.warn(`Job ${name} skipped: ${reason}`)
})

MobileCron.addListener('overdueJobs', ({ count, jobs }) => {
  console.warn(`${count} jobs were overdue on resume`)
})
```

## Advanced: `MobileCronScheduler`

The package also exports the plain TypeScript scheduler class that powers the web plugin. Use it directly in Node.js, React Native, or any non-Capacitor environment:

```typescript
import { MobileCronScheduler } from 'capacitor-mobilecron'

const scheduler = new MobileCronScheduler({
  platform: 'web',
  onJobDue: (event) => handleJobDue(event),
  onJobSkipped: (event) => console.warn('skipped', event),
})

await scheduler.init()

const { id } = await scheduler.register({
  name: 'heartbeat',
  schedule: { kind: 'every', everyMs: 30_000 },
})

// Later — check due jobs from a native wakeup callback
scheduler.checkDueJobs('workmanager')

// Teardown
await scheduler.destroy()
```

## iOS / Android native wakeups

The web/JS watchdog is the primary scheduling mechanism. For true background execution extend the native stubs:

### Android

Wire `CronWorker` into `WorkManager` periodic tasks and call `bridge.checkDueJobs("workmanager")`. Register `ChargingReceiver` in the manifest for charging wakeups.

### iOS

Register a `BGAppRefreshTask` / `BGProcessingTask` in your `AppDelegate` and call the plugin method to check due jobs from there.

## Testing

### Unit tests — no device needed

The scheduler core is pure TypeScript and fully testable without a phone:

```bash
npm test              # run 52 unit tests (instant)
npm run test:watch    # TDD watch mode
npm run test:coverage # coverage report
```

Tests cover schedule computation, active-hour windows, persistence, pause/resume, skip logic, and more.

### Device E2E tests (Android, via CDP)

Full integration suite against a running Android app — 7 sections, 40+ tests:

```bash
# 1. Forward CDP port from device
adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof io.mobileclaw.reference)

# 2. Run
npm run test:e2e
```

See [`tests/e2e/test-e2e.mjs`](tests/e2e/test-e2e.mjs) for coverage details.

## Contributing

```bash
git clone https://github.com/rogelioRuiz/capacitor-mobilecron.git
cd capacitor-mobilecron
npm install
npm test              # unit tests — runs in seconds, no device
npm run build         # compile TypeScript
npm run lint          # Biome linter
npm run typecheck     # TypeScript strict mode
```

## License

MIT © Rogelio Ruiz
