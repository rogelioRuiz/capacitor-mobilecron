# capacitor-mobilecron

> Lightweight Capacitor scheduling primitive — register jobs, get `jobDue` events when they fire, across web, Android (WorkManager), and iOS (BGTaskScheduler). Jobs evaluate natively even when the WebView is suspended.

[![npm version](https://img.shields.io/npm/v/capacitor-mobilecron)](https://www.npmjs.com/package/capacitor-mobilecron)
[![CI](https://github.com/rogelioRuiz/capacitor-mobilecron/actions/workflows/ci.yml/badge.svg)](https://github.com/rogelioRuiz/capacitor-mobilecron/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Overview

`capacitor-mobilecron` manages a set of named, persistent cron-like jobs and emits events when they are due. It handles:

- **Repeating intervals** (`every: N ms`) with optional anchor alignment
- **One-shot schedules** (`at: epoch ms`) that auto-disable after firing
- **Active-hour windows** — restrict jobs to HH:MM–HH:MM ranges with timezone support
- **Network / charging constraints** — skip a job when connectivity or power is absent
- **Scheduling modes** — `eco`, `balanced`, `aggressive` (controls WorkManager cadence)
- **True native background execution** — Android WorkManager and iOS BGTaskScheduler evaluate due jobs and fire `jobDue` events even when the WebView is suspended
- **Persistent state** — job registry survives app restarts via `CapacitorStorage` (SharedPreferences on Android, UserDefaults on iOS)

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

Control WorkManager scheduling cadence.

| Mode | WorkManager interval | Use case |
|------|----------------------|---------|
| `'eco'` | 15 min, Wi-Fi + battery-not-low | Battery-sensitive background |
| `'balanced'` | 15 min, network connected | Default |
| `'aggressive'` | 5 min chain (one-shot repeat) | Real-time needs |

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
//   android: { workManagerActive: true, chargingReceiverActive: true }
// }
```

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `jobDue` | `JobDueEvent` | A job fired (source: `'workmanager'`, `'charging'`, `'manual'`, etc.) |
| `jobSkipped` | `JobSkippedEvent` | A due job was skipped (constraint not met) |
| `overdueJobs` | `OverdueEvent` | Emitted on foreground resume if jobs are overdue |
| `statusChanged` | `CronStatus` | Scheduler state changed |
| `nativeWake` | `{ source, paused }` | WorkManager or ChargingReceiver woke the plugin |

```typescript
MobileCron.addListener('jobSkipped', ({ id, name, reason }) => {
  // reason: 'outside_active_hours' | 'paused' | 'requires_network' | 'requires_charging'
  console.warn(`Job ${name} skipped: ${reason}`)
})
```

## How native background execution works

### Android

`capacitor-mobilecron` registers a **WorkManager** periodic task (every 15 min in `balanced` mode). When it fires — even while the WebView is suspended:

1. `NativeJobEvaluator` reads job state from `CapacitorStorage` (SharedPreferences)
2. It evaluates which jobs are due, checks active-hour windows and constraints (`requiresNetwork` via `ConnectivityManager`, `requiresCharging` via `BatteryManager`)
3. Fired events are written to `pendingNativeEvents` in storage
4. `CronBridge` wakes the plugin — if the WebView is alive, `jobDue` events are dispatched immediately
5. On next app foreground (`handleOnResume`), any remaining pending events are dispatched

A **ChargingReceiver** also triggers evaluation when the device starts charging.

### iOS

`BGAppRefreshTask` and `BGProcessingTask` follow the same pattern via `NativeJobEvaluator.swift`. State is persisted to a JSON file in Application Support (with UserDefaults as fallback), ensuring it survives both `SIGKILL` and normal app termination.

### Platform differences and tradeoffs

| Behavior | Android | iOS |
|----------|---------|-----|
| **Background wake frequency** | WorkManager ~15 min (`balanced`), ~5 min chain (`aggressive`) | `BGAppRefreshTask` — iOS decides timing (typically 15–30 min, but system-managed) |
| **`requiresNetwork` constraint** | Checked by `NativeJobEvaluator` at evaluation time via `ConnectivityManager` | **Not checked** at evaluation time — enforced at the `BGProcessingTask` constraint level instead (`requiresNetworkConnectivity`) |
| **`requiresCharging` constraint** | Checked by `NativeJobEvaluator` at evaluation time via `BatteryManager` sticky intent | **Not checked** at evaluation time — enforced at the `BGProcessingTask` constraint level instead (`requiresExternalPower`) |
| **Charging event trigger** | `ChargingReceiver` fires evaluation immediately on plug-in | No equivalent — relies on next scheduled `BGTask` |
| **State persistence** | SharedPreferences (`CAPStorage`) | JSON file in Application Support + UserDefaults dual-write (survives SIGKILL) |
| **Minimum interval** | 15 min (WorkManager enforced) | 15 min (`earliestBeginDate`), actual timing system-managed |
| **`aggressive` mode** | 5-min one-shot chain worker — reliable sub-15-min execution | Maps to `BGProcessingTask` without `requiresExternalPower` — still system-scheduled |

**Key tradeoff on iOS constraints:** Android's `NativeJobEvaluator` checks `requiresNetwork` and `requiresCharging` at the moment a job is evaluated and will skip (increment `consecutiveSkips`) if constraints aren't met. On iOS, these constraints are delegated to `BGTaskScheduler` — iOS simply won't launch the background task until the constraints are satisfied. This means:

- On Android, a job can be skipped (and the skip is visible via `consecutiveSkips` / `jobSkipped` event) when constraints aren't met during a background wake.
- On iOS, the background task itself is delayed until constraints are met, so the job fires when it eventually runs — no skip event is emitted for constraint violations.
- `activeHours` and `paused` state are checked on **both** platforms by `NativeJobEvaluator` at evaluation time.

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

// Teardown
await scheduler.destroy()
```

## Testing

### Unit tests — no device needed

The scheduler core is pure TypeScript and fully testable without a phone:

```bash
npm test              # 56 unit tests (instant)
npm run test:watch    # TDD watch mode
npm run test:coverage # coverage report
```

Tests cover schedule computation, active-hour windows, persistence, pause/resume, skip logic, native event rehydration, and more.

### Android E2E tests (CDP)

Full integration suite against a running Android device via Chrome DevTools Protocol — 8 sections, 50 tests:

```bash
# 1. Build and install the example app
cd example/android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk

# 2. Launch the app
adb shell am start -n io.mobilecron.test/.MainActivity

# 3. From the project root, run the suite
npm run test:e2e
```

### iOS E2E tests (Simulator)

Full integration suite against the iOS Simulator — 8 sections, 50 tests:

```bash
# 1. Boot a simulator
xcrun simctl boot "iPhone 16e"

# 2. From the project root, run the suite (builds, installs, launches automatically)
npm run test:e2e:ios
```

The iOS suite uses a multi-phase architecture with kill+relaunch cycles to test state persistence across process termination, then runs native background evaluation tests (NativeJobEvaluator, pendingNativeEvents, skip logic, dedup) inline.

### What the E2E suites cover

Both Android and iOS suites validate the same 8 sections:

1. **Stress** — rapid register/unregister/concurrent operations (50+ jobs)
2. **State persistence** — jobs, paused state, and mode survive kill+relaunch cycles
3. **Events** — `jobDue`, `statusChanged`, listener add/remove, rapid-fire delivery
4. **Edge cases** — empty names, missing IDs, large payloads, special characters, idempotent operations
5. **Mode switching** — eco/balanced/aggressive transitions with active jobs
6. **Real-world scenarios** — hourly jobs, one-shot schedules, full lifecycle, pause+trigger interactions
7. **Diagnostics** — platform-specific status fields, `nativeWake` event, BGTask registration (iOS) / WorkManager status (Android)
8. **Native background** — `NativeJobEvaluator` fires due jobs, `pendingNativeEvents` rehydration, skip-when-paused, `consecutiveSkips` tracking, `nextDueAt` dedup

See [`tests/e2e/test-e2e.mjs`](tests/e2e/test-e2e.mjs) (Android), [`tests/e2e/test-e2e-ios.mjs`](tests/e2e/test-e2e-ios.mjs) (iOS), and [`example/`](example/) for details.

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
