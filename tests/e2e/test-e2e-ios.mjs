#!/usr/bin/env node
/**
 * capacitor-mobilecron iOS Simulator E2E Test Suite
 *
 * Approach: HTTP server on 127.0.0.1:8099.
 *   - index.html detects the server via /__mobilecron_ping and runs all tests
 *   - Tests POST results to /__mobilecron_result
 *   - Multi-phase tests: app POSTs /__simctl_bg → runner kills+relaunches app
 *   - App uses localStorage phase coordination to resume after kill
 *
 * Prerequisites:
 *   - iOS Simulator booted (iPhone 16e or any iPhone)
 *   - Example app built and installed: cd example/ios/App && xcodebuild ...
 *
 * Usage (from repo root):
 *   node tests/e2e/test-e2e-ios.mjs
 *
 * Sections (50 tests):
 *   1  Simulator Setup              (3 tests)
 *   2  Phase 1 — API Tests         (8+5+10+5 = 28 tests, Sections 1,3,4,5)
 *   3  Phase 2 — State & bg/fg     (5+7 = 12 tests, Sections 2,6)
 *   4  Phase 3 — Native & Diag     (5+5 = 10 tests, Sections 7,8)
 *   Total embedded: 50 app-reported tests
 */

import { execSync } from 'child_process'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─── Config ───────────────────────────────────────────────────────────────────
const BUNDLE_ID   = 'io.mobilecron.test'
const RUNNER_PORT = 8099
const TOTAL_TESTS = 50
const TIMEOUT_MS  = 300_000  // 5 minutes (includes multiple kill+relaunch cycles)

// ─── Test runner state ────────────────────────────────────────────────────────
let passedTests = 0, failedTests = 0
const testResults = []

function logSection(title) { console.log(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}`) }
function pass(name, detail) {
  passedTests++
  testResults.push({ name, status: 'PASS' })
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
}
function fail(name, error) {
  failedTests++
  testResults.push({ name, status: 'FAIL', error })
  console.log(`  ❌ ${name} — ${error}`)
}

// ─── simctl helpers ───────────────────────────────────────────────────────────
function simctl(args, opts = {}) {
  return execSync(`xcrun simctl ${args}`, { encoding: 'utf8', timeout: 30000, ...opts }).trim()
}

function getBootedUDID() {
  const json = simctl('list devices booted -j')
  const data = JSON.parse(json)
  for (const devices of Object.values(data.devices)) {
    for (const d of devices) {
      if (d.state === 'Booted') return d.udid
    }
  }
  return null
}

function terminateApp(udid) {
  try { simctl(`terminate ${udid} ${BUNDLE_ID}`) } catch {}
}

function launchApp(udid) {
  try { simctl(`terminate ${udid} ${BUNDLE_ID}`) } catch {}
  execSync(`sleep 0.5`, { shell: true })
  simctl(`launch ${udid} ${BUNDLE_ID}`)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── HTTP result server ───────────────────────────────────────────────────────
function startServer(udid) {
  return new Promise((resolve, reject) => {
    const results = new Map()
    let done = false
    let doneResolve, doneReject
    const donePromise = new Promise((res, rej) => { doneResolve = res; doneReject = rej })

    const timer = setTimeout(() => {
      if (!done) doneReject(new Error(`Timeout after ${TIMEOUT_MS / 1000}s — only ${results.size}/${TOTAL_TESTS} results received`))
    }, TIMEOUT_MS)

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${RUNNER_PORT}`)

      // CORS for simulator WebView
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

      // Test mode detection ping
      if (req.method === 'GET' && url.pathname === '/__mobilecron_ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      // Kill + relaunch the app (used by in-app bg/fg tests)
      if (req.method === 'POST' && url.pathname === '/__simctl_bg') {
        const delay = parseInt(url.searchParams.get('delay') || '1500', 10)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        // Terminate and relaunch asynchronously
        setImmediate(async () => {
          terminateApp(udid)
          await sleep(delay)
          launchApp(udid)
        })
        return
      }

      // Collect a single test result
      if (req.method === 'POST' && url.pathname === '/__mobilecron_result') {
        let body = ''
        req.on('data', d => body += d)
        req.on('end', () => {
          try {
            const r = JSON.parse(body)
            results.set(r.name, r)
            const status = r.status === 'pass' ? '✅' : '❌'
            const detail = r.detail ? ` — ${r.detail}` : ''
            const err = r.error ? ` — ${r.error}` : ''
            console.log(`  ${status} ${r.name}${detail}${err}`)
          } catch {}
          res.writeHead(200); res.end()
        })
        return
      }

      // All tests done
      if (req.method === 'POST' && url.pathname === '/__mobilecron_done') {
        let body = ''
        req.on('data', d => body += d)
        req.on('end', () => {
          let summary = {}
          try { summary = JSON.parse(body) } catch {}
          clearTimeout(timer)
          done = true
          doneResolve({ results, summary })
          res.writeHead(200); res.end()
        })
        return
      }

      res.writeHead(404); res.end()
    })

    server.listen(RUNNER_PORT, '0.0.0.0', () => {
      console.log(`  → HTTP server listening on :${RUNNER_PORT}`)
      resolve({ server, donePromise })
    })
    server.on('error', reject)
  })
}

// ─── Test names (for ordering the final report) ───────────────────────────────
const ORDERED_TESTS = [
  '1.1 Rapid register 50 jobs',
  '1.2 List 50 jobs returns all',
  '1.3 getStatus shows 50 active jobs',
  '1.4 triggerNow all 50 jobs rapidly',
  '1.5 Update all 50 jobs',
  '1.6 Unregister all 50 jobs rapidly',
  '1.7 Rapid register+unregister cycle (100 iterations)',
  '1.8 Concurrent register calls (Promise.all)',
  '3.1 jobDue event fires on triggerNow',
  '3.2 statusChanged fires on register/unregister/pause/resume/setMode',
  '3.3 Multiple listeners on same event',
  '3.4 Listener removal stops delivery',
  '3.5 Event delivery under rapid-fire triggers (20 rapid triggerNow)',
  '4.1 Register with empty name rejects',
  '4.2 Register with whitespace-only name rejects',
  '4.3 Unregister non-existent job',
  '4.4 Update non-existent job rejects',
  '4.5 triggerNow on non-existent job rejects',
  '4.6 setMode with invalid mode rejects',
  '4.7 Register with large data payload',
  '4.8 Register with special chars in name',
  '4.9 Register with minimum everyMs (60000)',
  '4.10 Double pauseAll is idempotent',
  '5.1 Cycle through all modes and verify status',
  '5.2 Mode switch with active jobs',
  '5.3 BGTaskScheduler tasks registered after mode switch',
  '5.4 Aggressive mode schedules BGProcessingTask',
  '5.5 BGTask registration consistent across mode switches',
  '2.1 Register jobs, background app, foreground, verify state survives',
  '2.2 Background 5s, foreground, check status consistency',
  '2.3 Pause before bg, verify paused after fg',
  '2.4 Mode persists across bg/fg',
  '2.5 Multiple rapid bg/fg cycles (5x)',
  '6.1 Simulate hourly job + one-shot scheduled job',
  '6.2 triggerNow while paused still fires',
  '6.3 Register during pause, resume, verify job exists',
  '6.4 Background for 10s, foreground, verify no crash (integration)',
  '6.5 Full lifecycle: register → trigger → update → list → unregister',
  '6.6 Register job, open another app, come back',
  '6.7 Rapid mode switch while backgrounding (race condition test)',
  '7.1 BGTaskScheduler is registered and functional',
  '7.2 BGTask identifiers match plugin bundle',
  '7.3 nativeWake event listener can be attached',
  '7.4 Diagnostics report platform-specific fields',
  '7.5 Process not killed during tests (stability check)',
  '8.1 UserDefaults stores key "mobilecron:state" without group prefix',
  '8.2 Pending native events in storage deliver as jobDue on foreground (rehydrate path)',
  '8.3 NativeJobEvaluator fires due job via test hook and delivers via rehydrate',
  '8.4 NativeJobEvaluator skips due jobs when scheduler is paused',
  '8.5 nextDueAt advances after native evaluation — job fires exactly once',
]

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n🔵 capacitor-mobilecron iOS Simulator E2E Test Suite\n')

  // ─── Section 1: Simulator Setup ──────────────────────────────────────────
  logSection('1 — Simulator Setup')

  // 1.1 Find booted simulator
  let udid
  try {
    udid = getBootedUDID()
    if (!udid) throw new Error('No booted simulator found. Boot one with: xcrun simctl boot "iPhone 16e"')
    pass('1.1 Booted simulator found', `UDID ${udid}`)
  } catch (err) {
    fail('1.1 Booted simulator found', err.message)
    process.exit(1)
  }

  // 1.2 Start HTTP result server
  let server, donePromise
  try {
    ;({ server, donePromise } = await startServer(udid))
    pass('1.2 HTTP result server started', `port ${RUNNER_PORT}`)
  } catch (err) {
    fail('1.2 HTTP result server started', err.message)
    process.exit(1)
  }

  // 1.3 Build + install + launch app
  try {
    const exampleDir = path.join(__dirname, '../../example')
    const iosDir = path.join(exampleDir, 'ios/App')

    console.log('  → Syncing web assets (cap sync ios)...')
    try {
      execSync(
        `${process.execPath} node_modules/.bin/cap sync ios`,
        { cwd: exampleDir, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (e) {
      // Non-fatal — may just be a missing dep; continue with existing assets
      console.log(`  → cap sync skipped: ${(e.stderr || e.message || '').split('\n')[0]}`)
    }

    // Touch a marker before build so we can find the NEWLY built App.app afterward.
    execSync('touch /tmp/.mobilecron-build-marker', { shell: true })
    console.log('  → Building with xcodebuild...')
    execSync(
      `xcodebuild -workspace App.xcworkspace -scheme App -sdk iphonesimulator ` +
      `-destination "platform=iOS Simulator,id=${udid}" -configuration Debug build ` +
      `CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO`,
      { cwd: iosDir, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] }
    )

    console.log('  → Installing app...')
    // Find the App.app built AFTER our marker — avoids picking a stale build from DerivedData.
    const appPath = execSync(
      `find ~/Library/Developer/Xcode/DerivedData -name "App.app" ` +
      `-newer /tmp/.mobilecron-build-marker ` +
      `-path "*/Debug-iphonesimulator/*" -not -path "*PlugIns*" 2>/dev/null | head -1`,
      { encoding: 'utf8', shell: true }
    ).trim()
    if (!appPath) throw new Error('App.app not found in DerivedData')
    // Uninstall first to clear app container data (localStorage, state files) between runs.
    try { simctl(`uninstall ${udid} io.mobilecron.test`) } catch (_) {}
    simctl(`install ${udid} "${appPath}"`)

    console.log('  → Launching app...')
    launchApp(udid)
    pass('1.3 App built, installed, and launched')
  } catch (err) {
    const lines = (err.stderr || err.stdout || err.message || '').split('\n')
    const errLine = lines.filter(l => l.includes('error:')).slice(0, 3).join(' | ') || lines[0]
    fail('1.3 App built, installed, and launched', errLine.slice(0, 200))
    process.exit(1)
  }

  // ─── Sections 2–8: App-driven tests ──────────────────────────────────────
  logSection('2 — App-Driven Tests (Sections 1–8, 50 tests)')
  console.log('  → Waiting for app to run all tests and POST results...')
  console.log('  → (Multi-phase: app requests kill+relaunch for bg/fg tests)\n')

  let captureResult
  try {
    captureResult = await donePromise
    pass('App test suite completed', `${captureResult.results.size} results received`)
  } catch (err) {
    fail('App test suite completed', err.message)
    server.close()
    process.exit(1)
  }

  // ─── Report results in order ──────────────────────────────────────────────
  logSection('3 — Test Results')

  for (const name of ORDERED_TESTS) {
    const r = captureResult.results.get(name)
    if (!r) {
      fail(name, 'no result received (test did not run)')
    } else if (r.status === 'pass') {
      pass(name, r.detail || '')
    } else {
      fail(name, r.error || 'failed')
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  server.close()
  const total = passedTests + failedTests
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  Results: ${passedTests}/${total} passed, ${failedTests} failed`)
  if (captureResult.summary) {
    console.log(`  App reported: ${captureResult.summary.passed}/${captureResult.summary.total} passed`)
  }
  if (failedTests > 0) {
    console.log('\n  Failed tests:')
    testResults.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`    ❌ ${r.name}${r.error ? ` — ${r.error}` : ''}`)
    })
  } else {
    console.log('  ✅ ALL PASS')
  }
  console.log(`${'═'.repeat(60)}\n`)

  process.exit(failedTests > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('\n  Fatal error:', err.message)
  process.exit(1)
})
