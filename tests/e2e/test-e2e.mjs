#!/usr/bin/env node
/**
 * capacitor-mobilecron E2E test suite
 * Runs against a live Android device via Chrome DevTools Protocol.
 *
 * Usage:
 *   adb forward tcp:9222 localabstract:webview_devtools_remote_<PID>
 *   node test-e2e.mjs
 */

import WebSocket from 'ws';
import http from 'http';
import { execSync } from 'child_process';

const ADB = '/home/rruiz/Android/Sdk/platform-tools/adb';
const CDP_PORT = 9222;

// ── Helper: HTTP GET as promise ──────────────────────────────────────────

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// ── Setup CDP forward ────────────────────────────────────────────────────

const APP_PACKAGE = 'io.mobilecron.test';
const pid = execSync(`${ADB} shell pidof ${APP_PACKAGE}`, { encoding: 'utf-8' }).trim();
if (!pid) { console.error(`App ${APP_PACKAGE} not running`); process.exit(1); }
execSync(`${ADB} forward tcp:${CDP_PORT} localabstract:webview_devtools_remote_${pid}`);

// ── Discover target ──────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 1000)); // wait for CDP to be ready
const targets = await httpGetJSON(`http://localhost:${CDP_PORT}/json`);
const target = targets[0]; // dedicated test app — use the first (and only) WebView page
if (!target) { console.error('No WebView target found in', APP_PACKAGE); process.exit(1); }

// ── CDP connection ───────────────────────────────────────────────────────

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = msgId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const res = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.result?.result?.subtype === 'error') {
    const desc = res.result.result.description || res.result.result.className || 'Unknown error';
    throw new Error(desc);
  }
  if (res.result?.exceptionDetails) {
    const ex = res.result.exceptionDetails;
    throw new Error(ex.exception?.description || ex.text || JSON.stringify(ex));
  }
  return res.result?.result?.value;
}

async function evalJSON(expr) {
  const raw = await evaluate(`(async () => { return JSON.stringify(await (${expr})); })()`);
  return JSON.parse(raw);
}

function adb(...args) {
  return execSync(`${ADB} ${args.join(' ')}`, { encoding: 'utf-8', timeout: 15000, maxBuffer: 10 * 1024 * 1024 }).trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function bgAndFg(bgMs = 3000) {
  adb('shell', 'input', 'keyevent', '3');
  await sleep(bgMs);
  adb('shell', 'am', 'start', '-n', 'io.mobilecron.test/.MainActivity');
  await sleep(3000);
  // Re-forward CDP in case it dropped
  try {
    const p = adb('shell', 'pidof', 'io.mobilecron.test');
    adb('forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${p}`);
  } catch { /* best effort */ }
}

// ── Test harness ─────────────────────────────────────────────────────────

let passed = 0, failed = 0, total = 0;
const failures = [];

async function test(name, fn, timeoutMs = 30000) {
  total++;
  const t0 = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Test timed out after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    passed++;
    const ms = Date.now() - t0;
    console.log(`  ✓ ${name} (${ms}ms)`);
  } catch (e) {
    failed++;
    const ms = Date.now() - t0;
    console.log(`  ✗ ${name} (${ms}ms)`);
    console.log(`    → ${e.message.split('\n')[0]}`);
    failures.push({ name, error: e.message });
  }
}

function assert(cond, msg) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Helper: clean all jobs AND listeners
async function cleanAll() {
  await evaluate(`(async () => {
    const mc = window.Capacitor.Plugins.MobileCron;
    await mc.removeAllListeners();
    const { jobs } = await mc.list();
    for (const j of jobs) await mc.unregister({ id: j.id });
    await mc.resumeAll();
    await mc.setMode({ mode: 'balanced' });
  })()`);
}

// ══════════════════════════════════════════════════════════════════════════
// SECTION 1: Stress Tests
// ══════════════════════════════════════════════════════════════════════════

async function stressTests() {
  console.log('\n══ SECTION 1: Stress Tests ══');

  await test('1.1 Rapid register 50 jobs', async () => {
    await cleanAll();
    const count = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      const ids = [];
      for (let i = 0; i < 50; i++) {
        const r = await mc.register({
          name: 'stress-' + i,
          schedule: { kind: 'every', everyMs: 60000 },
          data: { index: i }
        });
        ids.push(r.id);
      }
      return ids.length;
    })()`);
    assertEqual(count, 50, 'Should register 50 jobs');
  });

  await test('1.2 List 50 jobs returns all', async () => {
    const result = await evalJSON(`window.Capacitor.Plugins.MobileCron.list()`);
    assertEqual(result.jobs.length, 50, 'Should list 50 jobs');
    const uniqueIds = new Set(result.jobs.map(j => j.id));
    assertEqual(uniqueIds.size, 50, 'All IDs should be unique');
  });

  await test('1.3 getStatus shows 50 active jobs', async () => {
    const s = await evalJSON(`window.Capacitor.Plugins.MobileCron.getStatus()`);
    assertEqual(s.activeJobCount, 50, 'activeJobCount should be 50');
  });

  await test('1.4 triggerNow all 50 jobs rapidly', async () => {
    const count = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      const { jobs } = await mc.list();
      let triggered = 0;
      for (const j of jobs) {
        await mc.triggerNow({ id: j.id });
        triggered++;
      }
      return triggered;
    })()`);
    assertEqual(count, 50, 'Should trigger all 50');
  });

  await test('1.5 Update all 50 jobs', async () => {
    const count = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      const { jobs } = await mc.list();
      for (const j of jobs) {
        await mc.update({ id: j.id, name: 'updated-' + j.name, priority: 'high' });
      }
      const after = await mc.list();
      return after.jobs.filter(j => j.name.startsWith('updated-') && j.priority === 'high').length;
    })()`);
    assertEqual(count, 50, 'All 50 should be updated');
  });

  await test('1.6 Unregister all 50 jobs rapidly', async () => {
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      const before = await mc.list();
      for (const j of before.jobs) await mc.unregister({ id: j.id });
      const after = await mc.list();
      return JSON.stringify({ before: before.jobs.length, after: after.jobs.length });
    })()`);
    const parsed = JSON.parse(result);
    assertEqual(parsed.before, 50, 'Had 50 before');
    assertEqual(parsed.after, 0, 'Should have 0 after');
  });

  await test('1.7 Rapid register+unregister cycle (100 iterations)', async () => {
    await cleanAll();
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      let errors = 0;
      for (let i = 0; i < 100; i++) {
        try {
          const { id } = await mc.register({ name: 'churn-' + i, schedule: { kind: 'every', everyMs: 60000 } });
          await mc.unregister({ id });
        } catch { errors++; }
      }
      const { jobs } = await mc.list();
      return jobs.length === 0 && errors === 0 ? 'ok' : 'fail:' + jobs.length + ':' + errors;
    })()`);
    assertEqual(result, 'ok', 'Should handle rapid churn without leaks');
  });

  await test('1.8 Concurrent register calls (Promise.all)', async () => {
    await cleanAll();
    const count = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      const promises = [];
      for (let i = 0; i < 20; i++) {
        promises.push(mc.register({ name: 'concurrent-' + i, schedule: { kind: 'every', everyMs: 60000 } }));
      }
      const results = await Promise.all(promises);
      const { jobs } = await mc.list();
      return jobs.length;
    })()`);
    assertEqual(count, 20, 'All 20 concurrent registers should succeed');
    await cleanAll();
  });
}

// ══════════════════════════════════════════════════════════════════════════
// SECTION 2: Background / Foreground Cycles
// ══════════════════════════════════════════════════════════════════════════

async function bgFgTests() {
  console.log('\n══ SECTION 2: Background / Foreground Cycles ══');

  await test('2.1 Register jobs, background app, foreground, verify state survives', async () => {
    await cleanAll();
    await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      await mc.register({ name: 'bg-test-1', schedule: { kind: 'every', everyMs: 60000 } });
      await mc.register({ name: 'bg-test-2', schedule: { kind: 'every', everyMs: 120000 } });
      await mc.register({ name: 'bg-test-3', schedule: { kind: 'every', everyMs: 300000 } });
    })()`);

    const beforeBg = await evalJSON(`window.Capacitor.Plugins.MobileCron.list()`);
    assertEqual(beforeBg.jobs.length, 3, 'Should have 3 jobs before bg');

    await bgAndFg(3000);

    const afterFg = await evalJSON(`window.Capacitor.Plugins.MobileCron.list()`);
    assertEqual(afterFg.jobs.length, 3, 'Should still have 3 jobs after fg');
  });

  await test('2.2 Background 5s, foreground, check status consistency', async () => {
    await bgAndFg(5000);

    const status = await evalJSON(`window.Capacitor.Plugins.MobileCron.getStatus()`);
    assertEqual(status.platform, 'android', 'Platform should be android');
    assert(status.activeJobCount >= 0, 'activeJobCount should be non-negative');
    assertEqual(status.paused, false, 'Should not be paused');
    assert(status.android.workManagerActive === true, 'WorkManager should be active');
    assert(status.android.chargingReceiverActive === true, 'ChargingReceiver should be active');
  });

  await test('2.3 Pause before bg, verify paused after fg', async () => {
    await evaluate(`window.Capacitor.Plugins.MobileCron.pauseAll()`);

    await bgAndFg(3000);

    const status = await evalJSON(`window.Capacitor.Plugins.MobileCron.getStatus()`);
    assertEqual(status.paused, true, 'Should still be paused after bg/fg cycle');
    await evaluate(`window.Capacitor.Plugins.MobileCron.resumeAll()`);
  });

  await test('2.4 Mode persists across bg/fg', async () => {
    await evaluate(`window.Capacitor.Plugins.MobileCron.setMode({ mode: 'aggressive' })`);

    await bgAndFg(3000);

    const status = await evalJSON(`window.Capacitor.Plugins.MobileCron.getStatus()`);
    assertEqual(status.mode, 'aggressive', 'Mode should persist as aggressive');
    await evaluate(`window.Capacitor.Plugins.MobileCron.setMode({ mode: 'balanced' })`);
  });

  await test('2.5 Multiple rapid bg/fg cycles (5x)', async () => {
    for (let i = 0; i < 5; i++) {
      await bgAndFg(1500);
    }

    const status = await evalJSON(`window.Capacitor.Plugins.MobileCron.getStatus()`);
    assertEqual(status.platform, 'android', 'Platform should still be android after rapid cycles');
    assert(status.activeJobCount >= 0, 'activeJobCount should be valid');
  });

  await cleanAll();
}

// ══════════════════════════════════════════════════════════════════════════
// SECTION 3: Event Listener Reliability
// ══════════════════════════════════════════════════════════════════════════

async function eventTests() {
  console.log('\n══ SECTION 3: Event Listener Reliability ══');

  await test('3.1 jobDue event fires on triggerNow', async () => {
    await cleanAll();
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      let received = null;
      const handle = await mc.addListener('jobDue', (e) => { received = e; });
      const { id } = await mc.register({ name: 'event-test', schedule: { kind: 'every', everyMs: 60000 }, data: { payload: 42 } });
      await mc.triggerNow({ id });
      // Wait for event delivery
      await new Promise(r => setTimeout(r, 500));
      await handle.remove();
      if (!received) return 'no-event';
      if (received.source !== 'manual') return 'wrong-source:' + received.source;
      if (received.name !== 'event-test') return 'wrong-name:' + received.name;
      if (!received.data || received.data.payload !== 42) return 'wrong-data';
      if (typeof received.firedAt !== 'number') return 'no-firedAt';
      return 'ok';
    })()`);
    assertEqual(result, 'ok', 'jobDue event should have correct fields');
  });

  await test('3.2 statusChanged fires on register/unregister/pause/resume/setMode', async () => {
    await cleanAll();
    const count = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      let events = 0;
      const handle = await mc.addListener('statusChanged', () => { events++; });

      const { id } = await mc.register({ name: 'sc-test', schedule: { kind: 'every', everyMs: 60000 } });
      await new Promise(r => setTimeout(r, 200));

      await mc.pauseAll();
      await new Promise(r => setTimeout(r, 200));

      await mc.resumeAll();
      await new Promise(r => setTimeout(r, 200));

      await mc.setMode({ mode: 'eco' });
      await new Promise(r => setTimeout(r, 200));

      await mc.unregister({ id });
      await new Promise(r => setTimeout(r, 200));

      await handle.remove();
      await mc.setMode({ mode: 'balanced' });
      return events;
    })()`);
    assert(count >= 5, `Should have at least 5 statusChanged events, got ${count}`);
  });

  await test('3.3 Multiple listeners on same event', async () => {
    await cleanAll();
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      let count1 = 0, count2 = 0, count3 = 0;
      await mc.addListener('jobDue', () => count1++);
      await mc.addListener('jobDue', () => count2++);
      await mc.addListener('jobDue', () => count3++);

      const { id } = await mc.register({ name: 'multi-listen', schedule: { kind: 'every', everyMs: 60000 } });
      await mc.triggerNow({ id });
      await new Promise(r => setTimeout(r, 500));

      return count1 + ':' + count2 + ':' + count3;
    })()`);
    // cleanAll() will removeAllListeners
    const parts = result.split(':').map(Number);
    assert(parts.every(n => n >= 1), `All 3 listeners should fire: ${result}`);
  });

  await test('3.4 Listener removal stops delivery', async () => {
    await cleanAll();
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      let count = 0;
      const handle = await mc.addListener('jobDue', () => count++);

      const { id } = await mc.register({ name: 'remove-test', schedule: { kind: 'every', everyMs: 60000 } });
      await mc.triggerNow({ id });
      await new Promise(r => setTimeout(r, 300));
      const before = count;

      // Use removeAllListeners instead of single handle.remove() to avoid bridge deadlock
      await mc.removeAllListeners();
      await mc.triggerNow({ id });
      await new Promise(r => setTimeout(r, 300));

      return before + ':' + count;
    })()`);
    const [before, after] = result.split(':').map(Number);
    assertEqual(before, after, 'Count should not increase after listeners removed');
  });

  await test('3.5 Event delivery under rapid-fire triggers (20 rapid triggerNow)', async () => {
    await cleanAll();
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      let count = 0;
      await mc.addListener('jobDue', () => count++);

      const { id } = await mc.register({ name: 'rapid-fire', schedule: { kind: 'every', everyMs: 60000 } });

      const promises = [];
      for (let i = 0; i < 20; i++) {
        promises.push(mc.triggerNow({ id }));
      }
      await Promise.all(promises);
      await new Promise(r => setTimeout(r, 1000));

      return count;
    })()`);
    // cleanAll() will removeAllListeners
    assertEqual(result, 20, 'Should receive all 20 events');
  });

  await cleanAll();
}

// ══════════════════════════════════════════════════════════════════════════
// SECTION 4: Edge Cases & Validation
// ══════════════════════════════════════════════════════════════════════════

async function edgeCaseTests() {
  console.log('\n══ SECTION 4: Edge Cases & Validation ══');

  await test('4.1 Register with empty name rejects', async () => {
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      try {
        await mc.register({ name: '', schedule: { kind: 'every', everyMs: 60000 } });
        return 'should-have-rejected';
      } catch (e) {
        return 'rejected:' + e.message;
      }
    })()`);
    assert(result.startsWith('rejected:'), 'Empty name should reject');
  });

  await test('4.2 Register with whitespace-only name rejects', async () => {
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      try {
        await mc.register({ name: '   ', schedule: { kind: 'every', everyMs: 60000 } });
        return 'should-have-rejected';
      } catch (e) {
        return 'rejected';
      }
    })()`);
    assertEqual(result, 'rejected', 'Whitespace-only name should reject');
  });

  await test('4.3 Unregister non-existent job', async () => {
    await cleanAll();
    // Should not throw — just a no-op
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      try {
        await mc.unregister({ id: 'does-not-exist-12345' });
        return 'ok';
      } catch (e) {
        return 'error:' + e.message;
      }
    })()`);
    // Native Android doesn't throw for missing unregister
    assertEqual(result, 'ok', 'Should handle missing ID gracefully');
  });

  await test('4.4 Update non-existent job rejects', async () => {
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      try {
        await mc.update({ id: 'fake-id-999', name: 'nope' });
        return 'should-have-rejected';
      } catch (e) {
        return 'rejected';
      }
    })()`);
    assertEqual(result, 'rejected', 'Update missing job should reject');
  });

  await test('4.5 triggerNow on non-existent job rejects', async () => {
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      try {
        await mc.triggerNow({ id: 'no-such-job' });
        return 'should-have-rejected';
      } catch (e) {
        return 'rejected';
      }
    })()`);
    assertEqual(result, 'rejected', 'triggerNow on missing job should reject');
  });

  await test('4.6 setMode with invalid mode rejects', async () => {
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      try {
        await mc.setMode({ mode: 'turbo' });
        return 'should-have-rejected';
      } catch (e) {
        return 'rejected';
      }
    })()`);
    assertEqual(result, 'rejected', 'Invalid mode should reject');
  });

  await test('4.7 Register with large data payload', async () => {
    await cleanAll();
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      const bigData = {};
      for (let i = 0; i < 100; i++) bigData['key_' + i] = 'value_'.repeat(100) + i;
      const { id } = await mc.register({ name: 'big-data', schedule: { kind: 'every', everyMs: 60000 }, data: bigData });
      const { jobs } = await mc.list();
      const found = jobs.find(j => j.id === id);
      return found && Object.keys(found.data || {}).length === 100 ? 'ok' : 'fail';
    })()`);
    assertEqual(result, 'ok', 'Should handle large data payloads');
    await cleanAll();
  });

  await test('4.8 Register with special chars in name', async () => {
    await cleanAll();
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      const { id } = await mc.register({
        name: 'test 日本語 <script>alert(1)</script> "quoted" & done!',
        schedule: { kind: 'every', everyMs: 60000 }
      });
      const { jobs } = await mc.list();
      const found = jobs.find(j => j.id === id);
      return found ? 'ok:' + found.name : 'fail';
    })()`);
    assert(result.startsWith('ok:'), 'Should handle special characters in name');
    await cleanAll();
  });

  await test('4.9 Register with minimum everyMs (60000)', async () => {
    await cleanAll();
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      const { id } = await mc.register({ name: 'min-interval', schedule: { kind: 'every', everyMs: 60000 } });
      return id ? 'ok' : 'fail';
    })()`);
    assertEqual(result.length > 0 && result !== 'fail', true, 'Should accept 60000ms interval');
    await cleanAll();
  });

  await test('4.10 Double pauseAll is idempotent', async () => {
    await cleanAll();
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      await mc.pauseAll();
      await mc.pauseAll();
      const s1 = await mc.getStatus();
      await mc.resumeAll();
      await mc.resumeAll();
      const s2 = await mc.getStatus();
      return s1.paused + ':' + s2.paused;
    })()`);
    assertEqual(result, 'true:false', 'Double pause/resume should be idempotent');
  });
}

// ══════════════════════════════════════════════════════════════════════════
// SECTION 5: Mode Switching & WorkManager
// ══════════════════════════════════════════════════════════════════════════

async function modeTests() {
  console.log('\n══ SECTION 5: Mode Switching & WorkManager ══');

  await test('5.1 Cycle through all modes and verify status', async () => {
    for (const mode of ['eco', 'balanced', 'aggressive']) {
      await evaluate(`window.Capacitor.Plugins.MobileCron.setMode({ mode: '${mode}' })`);
      const s = await evalJSON(`window.Capacitor.Plugins.MobileCron.getStatus()`);
      assertEqual(s.mode, mode, `Mode should be ${mode}`);
    }
    await evaluate(`window.Capacitor.Plugins.MobileCron.setMode({ mode: 'balanced' })`);
  });

  await test('5.2 Mode switch with active jobs', async () => {
    await cleanAll();
    await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      for (let i = 0; i < 5; i++) {
        await mc.register({ name: 'mode-test-' + i, schedule: { kind: 'every', everyMs: 60000 } });
      }
    })()`);

    for (const mode of ['aggressive', 'eco', 'balanced']) {
      await evaluate(`window.Capacitor.Plugins.MobileCron.setMode({ mode: '${mode}' })`);
      const s = await evalJSON(`window.Capacitor.Plugins.MobileCron.getStatus()`);
      assertEqual(s.mode, mode, `Mode should be ${mode}`);
      assertEqual(s.activeJobCount, 5, `Should still have 5 active jobs in ${mode} mode`);
    }
    await cleanAll();
  });

  await test('5.3 WorkManager registered after mode switch (verify via dumpsys)', async () => {
    await evaluate(`window.Capacitor.Plugins.MobileCron.setMode({ mode: 'balanced' })`);
    await sleep(500);
    const dump = adb('shell', 'dumpsys', 'jobscheduler');
    const mobileclawJobs = dump.split('\n').filter(l => l.includes('io.mobileclaw'));
    assert(mobileclawJobs.length > 0, 'WorkManager jobs should be registered in system scheduler');
  });

  await test('5.4 Aggressive mode creates OneTimeWork chain', async () => {
    await evaluate(`window.Capacitor.Plugins.MobileCron.setMode({ mode: 'aggressive' })`);
    await sleep(500);
    const dump = adb('shell', 'dumpsys', 'jobscheduler');
    const lines = dump.split('\n').filter(l => l.includes('io.mobileclaw') && l.includes('SystemJobService'));
    assert(lines.length >= 1, 'Should have at least 1 WorkManager job in aggressive mode');
    await evaluate(`window.Capacitor.Plugins.MobileCron.setMode({ mode: 'balanced' })`);
  });

  await test('5.5 ChargingReceiver remains active across mode switches', async () => {
    for (const mode of ['eco', 'aggressive', 'balanced']) {
      await evaluate(`window.Capacitor.Plugins.MobileCron.setMode({ mode: '${mode}' })`);
      const s = await evalJSON(`window.Capacitor.Plugins.MobileCron.getStatus()`);
      assertEqual(s.android.chargingReceiverActive, true, `ChargingReceiver should be active in ${mode} mode`);
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// SECTION 6: Real-World Scenarios
// ══════════════════════════════════════════════════════════════════════════

async function realWorldTests() {
  console.log('\n══ SECTION 6: Real-World Scenarios ══');

  await test('6.1 Simulate hourly job + one-shot scheduled job', async () => {
    await cleanAll();
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      // Recurring hourly job
      const { id: hourlyId } = await mc.register({
        name: 'hourly-sync',
        schedule: { kind: 'every', everyMs: 3600000 },
        requiresNetwork: true,
        priority: 'normal',
        data: { type: 'sync' }
      });
      // One-shot job in 10 minutes
      const { id: oneshotId } = await mc.register({
        name: 'delayed-task',
        schedule: { kind: 'at', atMs: Date.now() + 600000 },
        priority: 'high',
        data: { type: 'oneshot' }
      });

      const { jobs } = await mc.list();
      const hourly = jobs.find(j => j.id === hourlyId);
      const oneshot = jobs.find(j => j.id === oneshotId);

      return hourly && oneshot && hourly.schedule.kind === 'every' && oneshot.schedule.kind === 'at' ? 'ok' : 'fail';
    })()`);
    assertEqual(result, 'ok', 'Should handle mixed recurring and one-shot jobs');
  });

  await test('6.2 triggerNow while paused still fires', async () => {
    await evaluate(`window.Capacitor.Plugins.MobileCron.pauseAll()`);
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      let received = false;
      const handle = await mc.addListener('jobDue', () => { received = true; });
      const { jobs } = await mc.list();
      if (jobs.length === 0) return 'no-jobs';
      await mc.triggerNow({ id: jobs[0].id });
      await new Promise(r => setTimeout(r, 500));
      await mc.removeAllListeners();
      return received ? 'ok' : 'not-received';
    })()`);
    assertEqual(result, 'ok', 'Manual trigger should fire even when paused');
    await evaluate(`window.Capacitor.Plugins.MobileCron.resumeAll()`);
  });

  await test('6.3 Register during pause, resume, verify job exists', async () => {
    await cleanAll();
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      await mc.pauseAll();
      const { id } = await mc.register({ name: 'paused-register', schedule: { kind: 'every', everyMs: 60000 } });
      const s1 = await mc.getStatus();
      await mc.resumeAll();
      const { jobs } = await mc.list();
      return s1.paused && jobs.find(j => j.id === id) ? 'ok' : 'fail';
    })()`);
    assertEqual(result, 'ok', 'Should be able to register jobs while paused');
  });

  await test('6.4 Background for 10s, foreground, verify no crash (integration)', async () => {
    await cleanAll();
    // Register jobs in different modes
    await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      await mc.register({ name: 'bg-surv-1', schedule: { kind: 'every', everyMs: 60000 }, requiresNetwork: true });
      await mc.register({ name: 'bg-surv-2', schedule: { kind: 'every', everyMs: 120000 }, requiresCharging: true });
      await mc.register({ name: 'bg-surv-3', schedule: { kind: 'at', atMs: Date.now() + 300000 } });
      await mc.setMode({ mode: 'aggressive' });
    })()`);

    // Background for 10 seconds
    console.log('    (backgrounded for 10s...)');
    await bgAndFg(10000);

    const status = await evalJSON(`window.Capacitor.Plugins.MobileCron.getStatus()`);
    assertEqual(status.platform, 'android', 'Should not crash');
    assertEqual(status.activeJobCount, 3, 'All 3 jobs should survive 10s bg');
    assertEqual(status.mode, 'aggressive', 'Mode should persist');
    assert(status.android.workManagerActive === true, 'WorkManager should be active after bg');

    await evaluate(`window.Capacitor.Plugins.MobileCron.setMode({ mode: 'balanced' })`);
  });

  await test('6.5 Full lifecycle: register → trigger → update → list → unregister', async () => {
    await cleanAll();
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;

      // Register
      const { id } = await mc.register({
        name: 'lifecycle-test',
        schedule: { kind: 'every', everyMs: 60000 },
        priority: 'low',
        data: { step: 'registered' }
      });

      // Trigger
      let triggered = false;
      await mc.addListener('jobDue', (e) => { if (e.id === id) triggered = true; });
      await mc.triggerNow({ id });
      await new Promise(r => setTimeout(r, 500));
      await mc.removeAllListeners();
      if (!triggered) return 'trigger-failed';

      // Update
      await mc.update({ id, name: 'lifecycle-updated', priority: 'high', data: { step: 'updated' } });

      // List & verify update
      const { jobs } = await mc.list();
      const found = jobs.find(j => j.id === id);
      if (!found) return 'not-found-after-update';
      if (found.name !== 'lifecycle-updated') return 'name-not-updated:' + found.name;
      if (found.priority !== 'high') return 'priority-not-updated';

      // Unregister
      await mc.unregister({ id });
      const after = await mc.list();
      if (after.jobs.find(j => j.id === id)) return 'still-exists-after-unregister';

      return 'ok';
    })()`);
    assertEqual(result, 'ok', 'Full lifecycle should work end-to-end');
  });

  await test('6.6 Register job, open another app, come back', async () => {
    await cleanAll();
    await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      await mc.register({ name: 'app-switch-test', schedule: { kind: 'every', everyMs: 60000 }, data: { sentinel: 'abc' } });
    })()`);

    // Open Settings app (different app), then come back
    adb('shell', 'am', 'start', '-a', 'android.settings.SETTINGS');
    await sleep(3000);
    adb('shell', 'am', 'start', '-n', 'io.mobilecron.test/.MainActivity');
    await sleep(3000);
    try { const p = adb('shell', 'pidof', 'io.mobilecron.test'); adb('forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${p}`); } catch {}

    const { jobs } = await evalJSON(`window.Capacitor.Plugins.MobileCron.list()`);
    assertEqual(jobs.length, 1, 'Job should survive app switch');
    assertEqual(jobs[0].name, 'app-switch-test', 'Job name should be preserved');
    await cleanAll();
  });

  await test('6.7 Rapid mode switch while backgrounding (race condition test)', async () => {
    await cleanAll();
    await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      await mc.register({ name: 'race-test', schedule: { kind: 'every', everyMs: 60000 } });
    })()`);

    // Rapidly switch modes
    for (const mode of ['aggressive', 'eco', 'balanced', 'aggressive', 'eco']) {
      await evaluate(`window.Capacitor.Plugins.MobileCron.setMode({ mode: '${mode}' })`);
    }

    // Immediately background
    await bgAndFg(2000);

    const s = await evalJSON(`window.Capacitor.Plugins.MobileCron.getStatus()`);
    // Should be last mode set
    assertEqual(s.mode, 'eco', 'Should reflect last mode set');
    assert(s.activeJobCount >= 1, 'Job should survive');
    await cleanAll();
  });
}

// ══════════════════════════════════════════════════════════════════════════
// SECTION 7: Native Wake Verification
// ══════════════════════════════════════════════════════════════════════════

async function nativeWakeTests() {
  console.log('\n══ SECTION 7: Native Wake & Diagnostics ══');

  await test('7.1 WorkManager is registered in Android JobScheduler', async () => {
    const dump = adb('shell', 'dumpsys', 'jobscheduler');
    const wmJobs = dump.split('\n').filter(l =>
      l.includes('io.mobilecron.test') && l.includes('SystemJobService')
    );
    assert(wmJobs.length >= 1, `Should have WorkManager jobs registered, found ${wmJobs.length}`);
  });

  await test('7.2 ChargingReceiver is registered in broadcast system', async () => {
    const dump = adb('shell', 'dumpsys', 'activity', 'broadcasts');
    const receivers = dump.split('\n').filter(l => l.includes('ChargingReceiver'));
    assert(receivers.length >= 1, 'ChargingReceiver should be registered');
  });

  await test('7.3 nativeWake event listener can be attached', async () => {
    const result = await evaluate(`(async () => {
      const mc = window.Capacitor.Plugins.MobileCron;
      let received = false;
      try {
        await mc.addListener('nativeWake', (data) => { received = data; });
        // Can't simulate a real native wake easily, but verify the listener attaches
        await mc.removeAllListeners();
        return 'attached';
      } catch (e) {
        return 'error:' + e.message;
      }
    })()`);
    assertEqual(result, 'attached', 'Should be able to attach nativeWake listener');
  });

  await test('7.4 Diagnostics report platform-specific fields', async () => {
    const s = await evalJSON(`window.Capacitor.Plugins.MobileCron.getStatus()`);
    assert(s.android !== undefined, 'Should have android diagnostics');
    assert(typeof s.android.workManagerActive === 'boolean', 'workManagerActive should be boolean');
    assert(typeof s.android.chargingReceiverActive === 'boolean', 'chargingReceiverActive should be boolean');
    assert(s.ios === undefined, 'Should not have ios diagnostics on android');
  });

  await test('7.5 Process not killed during tests (stability check)', async () => {
    const pid = getPid();
    assert(pid > 0, `App process should still be alive, PID=${pid}`);
  });
}

// ══════════════════════════════════════════════════════════════════════════
// SECTION 8: Native Background Execution
// ══════════════════════════════════════════════════════════════════════════

// Read mobilecron:state directly from the Capacitor Preferences bridge (native SharedPreferences)
async function readStoredState() {
  const raw = await evaluate(`(async () => {
    const r = await window.Capacitor.Plugins.Preferences.get({ key: 'mobilecron:state' });
    return r.value;
  })()`);
  return raw ? JSON.parse(raw) : null;
}

// Write mobilecron:state directly through the Capacitor Preferences bridge
async function writeStoredState(state) {
  const escaped = JSON.stringify(JSON.stringify(state));
  await evaluate(`(async () => {
    await window.Capacitor.Plugins.Preferences.set({ key: 'mobilecron:state', value: ${escaped} });
  })()`);
}

// Force-run all WorkManager SystemJobService entries for the app via ADB.
// Returns the number of job IDs successfully force-triggered.
function forceWorkManager() {
  try {
    const dump = adb('shell', 'dumpsys', 'jobscheduler');
    const ids = new Set();
    const lines = dump.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('io.mobilecron.test')) continue;
      if (!line.includes('SystemJobService') && !line.includes('WorkManager')) continue;
      const ctx = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
      for (const m of ctx.matchAll(/(?:JOB\s+#[^\/]+\/|id=)(\d+)/g)) ids.add(m[1]);
    }
    let forced = 0;
    for (const id of ids) {
      try { adb('shell', 'cmd', 'jobscheduler', 'run', '-f', 'io.mobilecron.test', id); forced++; }
      catch { /* skip individual failures */ }
    }
    return forced;
  } catch { return 0; }
}

// Re-establish CDP forward after a bg/fg cycle that may have reset the PID
function reforwardCdp() {
  try {
    const p = adb('shell', 'pidof', 'io.mobilecron.test');
    adb('forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${p.trim()}`);
  } catch { /* best effort */ }
}

async function nativeBackgroundTests() {
  console.log('\n══ SECTION 8: Native Background Execution ══');

  // ── 8.1: SharedPreferences key check ─────────────────────────────────────
  await test('8.1 CAPStorage.xml stores key "mobilecron:state" without group prefix', async () => {
    await cleanAll();
    await evaluate(`window.Capacitor.Plugins.MobileCron.register({
      name: 'key-check', schedule: { kind: 'every', everyMs: 60000 }
    })`);
    await sleep(300);

    const xml = adb('shell', 'run-as', 'io.mobilecron.test', 'cat',
      '/data/data/io.mobilecron.test/shared_prefs/CapacitorStorage.xml');
    assert(xml.includes('mobilecron:state'),
      `CapacitorStorage.xml must contain mobilecron:state. Snippet: ${xml.substring(0, 300)}`);
    assert(!xml.includes('CapacitorStorage.mobilecron'),
      'Key must be plain "mobilecron:state", not prefixed with "CapacitorStorage."');
    await cleanAll();
  });

  // ── 8.2: Pending events injected into storage fire on foreground ──────────
  await test('8.2 Pending native events in storage deliver as jobDue on foreground (rehydrate path)', async () => {
    await cleanAll();
    const { id: jobId } = await evalJSON(`window.Capacitor.Plugins.MobileCron.register({
      name: 'pending-inject',
      schedule: { kind: 'every', everyMs: 60000 },
      data: { sentinel: 'native-e2e' }
    })`);

    // Inject pendingNativeEvents – simulates exactly what NativeJobEvaluator writes
    const state = await readStoredState();
    assert(state?.jobs?.length > 0, 'Need jobs in stored state');
    state.pendingNativeEvents = [{
      id: jobId,
      name: 'pending-inject',
      firedAt: Date.now() - 2000,
      source: 'workmanager',
      data: { sentinel: 'native-e2e' }
    }];
    // Advance nextDueAt so TS watchdog doesn't re-fire on foreground
    const j = state.jobs.find(j => j.id === jobId);
    if (j) { j.lastFiredAt = Date.now() - 2000; j.nextDueAt = Date.now() + 58000; }
    await writeStoredState(state);

    // Register JS listener before going to background
    await evaluate(`
      window.__pendingFired = [];
      window.Capacitor.Plugins.MobileCron.addListener('jobDue', (e) => {
        window.__pendingFired.push({ id: e.id, source: e.source });
      });
    `);

    // background → foreground triggers appStateChange → rehydrate()
    await bgAndFg(3000);
    await sleep(500);

    const fired = await evalJSON(`Promise.resolve(window.__pendingFired || [])`);
    const match = fired.find(e => e.id === jobId && e.source === 'workmanager');
    assert(match, `pendingNativeEvents must deliver jobDue on foreground (fired: ${JSON.stringify(fired)})`);

    // Storage must be cleared after rehydrate
    const afterState = await readStoredState();
    assertEqual((afterState?.pendingNativeEvents ?? []).length, 0,
      'pendingNativeEvents must be cleared after rehydrate');

    await cleanAll();
  }, 35000);

  // ── 8.3: NativeJobEvaluator fires due job via forced WorkManager ──────────
  await test('8.3 NativeJobEvaluator fires due job in background and delivers via rehydrate', async () => {
    await cleanAll();
    const { id: jobId } = await evalJSON(`window.Capacitor.Plugins.MobileCron.register({
      name: 'native-eval-bg',
      schedule: { kind: 'every', everyMs: 60000 }
    })`);

    // Write a past nextDueAt so NativeJobEvaluator considers it due
    const state = await readStoredState();
    const j = state?.jobs?.find(j => j.id === jobId);
    assert(j, 'Job must be in stored state');
    j.nextDueAt = Date.now() - 10000; // 10 s overdue
    await writeStoredState(state);

    await evaluate(`
      window.__nativeBgFired = [];
      window.Capacitor.Plugins.MobileCron.addListener('jobDue', (e) => {
        window.__nativeBgFired.push({ id: e.id, source: e.source });
      });
    `);

    // Background app
    adb('shell', 'input', 'keyevent', '3');
    await sleep(1500);

    // Force WorkManager job(s) – this runs NativeJobEvaluator
    const forced = forceWorkManager();
    assert(forced > 0, `Must force ≥1 WorkManager job (found ${forced}). Check dumpsys jobscheduler.`);
    console.log(`    (forced ${forced} WorkManager job(s))`);
    await sleep(4000); // Wait for native evaluation + storage write

    // Foreground
    adb('shell', 'am', 'start', '-n', 'io.mobilecron.test/.MainActivity');
    await sleep(3000);
    reforwardCdp();
    await sleep(500);

    const fired = await evalJSON(`Promise.resolve(window.__nativeBgFired || [])`);
    const nativeFires = fired.filter(e =>
      e.id === jobId && ['workmanager', 'workmanager_chain'].includes(e.source));
    assert(nativeFires.length >= 1,
      `NativeJobEvaluator should fire due job (got: ${JSON.stringify(fired)})`);

    await cleanAll();
  }, 60000);

  // ── 8.4: NativeJobEvaluator skips when paused ────────────────────────────
  await test('8.4 NativeJobEvaluator skips due jobs when scheduler is paused', async () => {
    await cleanAll();
    await evaluate(`window.Capacitor.Plugins.MobileCron.pauseAll()`);

    const { id: jobId } = await evalJSON(`window.Capacitor.Plugins.MobileCron.register({
      name: 'paused-native',
      schedule: { kind: 'every', everyMs: 60000 }
    })`);

    const state = await readStoredState();
    assert(state?.paused === true, 'State must be paused');
    const j = state.jobs.find(j => j.id === jobId);
    j.nextDueAt = Date.now() - 10000;
    await writeStoredState(state);

    await evaluate(`
      window.__pausedFired = [];
      window.Capacitor.Plugins.MobileCron.addListener('jobDue', (e) => { window.__pausedFired.push(e.id); });
    `);

    adb('shell', 'input', 'keyevent', '3');
    await sleep(1500);
    const forced = forceWorkManager();
    console.log(`    (forced ${forced} WorkManager job(s) while paused)`);
    await sleep(4000);

    adb('shell', 'am', 'start', '-n', 'io.mobilecron.test/.MainActivity');
    await sleep(3000);
    reforwardCdp();
    await sleep(500);

    const fired = await evalJSON(`Promise.resolve(window.__pausedFired || [])`);
    assert(!fired.includes(jobId),
      `Paused job must NOT fire (fired: ${JSON.stringify(fired)})`);

    // consecutiveSkips must be incremented by the skip
    const afterState = await readStoredState();
    const afterJob = afterState?.jobs?.find(j => j.id === jobId);
    assert((afterJob?.consecutiveSkips ?? 0) > 0,
      `consecutiveSkips should be >0 after skip (got ${afterJob?.consecutiveSkips})`);

    await evaluate(`window.Capacitor.Plugins.MobileCron.resumeAll()`);
    await cleanAll();
  }, 60000);

  // ── 8.5: No double-fire – nextDueAt advances after native evaluation ──────
  await test('8.5 nextDueAt advances after native evaluation — job fires exactly once', async () => {
    await cleanAll();
    const { id: jobId } = await evalJSON(`window.Capacitor.Plugins.MobileCron.register({
      name: 'dedup-test',
      schedule: { kind: 'every', everyMs: 60000 }
    })`);

    const state = await readStoredState();
    const j = state?.jobs?.find(j => j.id === jobId);
    j.nextDueAt = Date.now() - 5000;
    await writeStoredState(state);

    await evaluate(`
      window.__dedupFired = [];
      window.Capacitor.Plugins.MobileCron.addListener('jobDue', (e) => { window.__dedupFired.push(e.id); });
    `);

    adb('shell', 'input', 'keyevent', '3');
    await sleep(1500);
    const forced = forceWorkManager();
    assert(forced > 0, `Must force ≥1 WorkManager job (found ${forced})`);
    await sleep(4000);

    adb('shell', 'am', 'start', '-n', 'io.mobilecron.test/.MainActivity');
    await sleep(3000);
    reforwardCdp();
    await sleep(500);

    const fired = await evalJSON(`Promise.resolve(window.__dedupFired || [])`);
    const count = fired.filter(id => id === jobId).length;
    assertEqual(count, 1, `Job should fire exactly once, not be duplicated (fired ${count}×)`);

    // nextDueAt must be in the future (advanced by NativeJobEvaluator)
    const { jobs } = await evalJSON(`window.Capacitor.Plugins.MobileCron.list()`);
    const afterJob = jobs.find(j => j.id === jobId);
    assert((afterJob?.nextDueAt ?? 0) > Date.now(),
      `nextDueAt must be future after native fire (got ${afterJob?.nextDueAt})`);

    await cleanAll();
  }, 60000);
}

// ══════════════════════════════════════════════════════════════════════════

function getPid() {
  try {
    const ps = adb('shell', 'pidof', 'io.mobilecron.test');
    return parseInt(ps.trim(), 10) || 0;
  } catch { return 0; }
}

// ── Main ─────────────────────────────────────────────────────────────────

ws.on('open', async () => {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  capacitor-mobilecron E2E Test Suite         ║');
  console.log('║  Target: Android device via CDP              ║');
  console.log('╚══════════════════════════════════════════════╝');

  const pid = getPid();
  console.log(`PID: ${pid}`);

  try {
    await stressTests();
    await bgFgTests();
    // Health check: verify CDP still works after bg/fg cycles
    console.log('\n  [health check after bg/fg cycles...]');
    const hc = await evaluate(`'cdp-alive'`);
    if (hc !== 'cdp-alive') throw new Error('CDP connection lost after bg/fg');
    console.log('  [CDP OK]');
    await eventTests();
    await edgeCaseTests();
    await modeTests();
    await realWorldTests();
    await nativeWakeTests();
    await nativeBackgroundTests();
  } catch (e) {
    console.error('\nFATAL:', e.message);
  }

  console.log('\n══════════════════════════════════════════════');
  console.log(`  RESULTS: ${passed}/${total} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('  FAILURES:');
    for (const f of failures) {
      console.log(`    ✗ ${f.name}: ${f.error.split('\n')[0]}`);
    }
  }
  console.log('══════════════════════════════════════════════');

  ws.close();
  process.exit(failed > 0 ? 1 : 0);
});

ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
setTimeout(() => { console.error('\nTIMEOUT: Tests exceeded 10 minutes'); process.exit(1); }, 600000);
