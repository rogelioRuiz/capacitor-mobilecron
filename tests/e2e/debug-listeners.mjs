#!/usr/bin/env node
import WebSocket from 'ws';
import http from 'http';
import { execSync } from 'child_process';

const ADB = '/home/rruiz/Android/Sdk/platform-tools/adb';
const pid = execSync(`${ADB} shell pidof io.mobileclaw.reference`, { encoding: 'utf-8' }).trim();
execSync(`${ADB} forward tcp:9222 localabstract:webview_devtools_remote_${pid}`);

await new Promise(r => setTimeout(r, 1000));

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

const targets = await httpGetJSON('http://localhost:9222/json');
const target = targets.find(t => t.url.includes('cron-test'));
if (!target) { console.error('Not on /cron-test:', targets.map(t=>t.url)); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();

ws.on('message', raw => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function send(method, params = {}) {
  return new Promise(resolve => {
    const id = msgId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalWithTimeout(expr, label, timeoutMs = 10000) {
  const t0 = Date.now();
  const result = await Promise.race([
    send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    new Promise(resolve => setTimeout(() => resolve({ __timeout: true }), timeoutMs))
  ]);
  const elapsed = Date.now() - t0;
  if (result.__timeout) {
    console.log(`  TIMEOUT (${elapsed}ms): ${label}`);
    return null;
  }
  const val = result.result?.result?.value;
  const err = result.result?.exceptionDetails?.exception?.description;
  if (err) {
    console.log(`  ERROR (${elapsed}ms): ${label} → ${err.split('\n')[0]}`);
    return null;
  }
  console.log(`  OK (${elapsed}ms): ${label} → ${val}`);
  return val;
}

ws.on('open', async () => {
  console.log('\n=== Debug: Multiple Listener Issue ===\n');

  // Clean
  await evalWithTimeout(`(async()=>{
    const mc=window.Capacitor.Plugins.MobileCron;
    await mc.removeAllListeners();
    const{jobs}=await mc.list();
    for(const j of jobs) await mc.unregister({id:j.id});
    return 'clean';
  })()`, 'Clean up');

  // Step 1: Register ONE listener
  await evalWithTimeout(`(async()=>{
    const mc=window.Capacitor.Plugins.MobileCron;
    window.__h1 = await mc.addListener('jobDue', () => { window.__c1 = (window.__c1||0)+1; });
    return 'listener-1-registered';
  })()`, 'Register 1st listener');

  // Step 2: Register SECOND listener
  await evalWithTimeout(`(async()=>{
    const mc=window.Capacitor.Plugins.MobileCron;
    window.__h2 = await mc.addListener('jobDue', () => { window.__c2 = (window.__c2||0)+1; });
    return 'listener-2-registered';
  })()`, 'Register 2nd listener');

  // Step 3: Register THIRD listener
  await evalWithTimeout(`(async()=>{
    const mc=window.Capacitor.Plugins.MobileCron;
    window.__h3 = await mc.addListener('jobDue', () => { window.__c3 = (window.__c3||0)+1; });
    return 'listener-3-registered';
  })()`, 'Register 3rd listener');

  // Step 4: Register a job
  await evalWithTimeout(`(async()=>{
    const mc=window.Capacitor.Plugins.MobileCron;
    const{id}=await mc.register({name:'dbg-multi',schedule:{kind:'every',everyMs:60000}});
    window.__dbgJobId = id;
    return 'job:'+id;
  })()`, 'Register job');

  // Step 5: triggerNow with 3 listeners active
  await evalWithTimeout(`(async()=>{
    const mc=window.Capacitor.Plugins.MobileCron;
    await mc.triggerNow({id:window.__dbgJobId});
    return 'triggered';
  })()`, 'triggerNow (3 listeners)', 10000);

  // Step 6: Check counts
  await evalWithTimeout(`(async()=>{
    return window.__c1+':'+window.__c2+':'+window.__c3;
  })()`, 'Read counts');

  // Step 7: Wait a bit and re-check
  await new Promise(r => setTimeout(r, 1000));
  await evalWithTimeout(`(async()=>{
    return window.__c1+':'+window.__c2+':'+window.__c3;
  })()`, 'Read counts after 1s');

  // Step 8: removeAllListeners
  await evalWithTimeout(`(async()=>{
    await window.Capacitor.Plugins.MobileCron.removeAllListeners();
    return 'removed';
  })()`, 'removeAllListeners');

  // Step 9: Unregister job
  await evalWithTimeout(`(async()=>{
    await window.Capacitor.Plugins.MobileCron.unregister({id:window.__dbgJobId});
    return 'unregistered';
  })()`, 'Unregister job');

  console.log('\n=== Now test: all in one evaluate ===\n');

  // Replicate exact test 3.3 logic but in a single evaluate
  const result = await evalWithTimeout(`(async()=>{
    const mc=window.Capacitor.Plugins.MobileCron;
    await mc.removeAllListeners();
    let c1=0, c2=0, c3=0;
    await mc.addListener('jobDue', ()=>c1++);
    await mc.addListener('jobDue', ()=>c2++);
    await mc.addListener('jobDue', ()=>c3++);
    const{id}=await mc.register({name:'inline-test',schedule:{kind:'every',everyMs:60000}});
    await mc.triggerNow({id});
    await new Promise(r=>setTimeout(r,500));
    const result = c1+':'+c2+':'+c3;
    await mc.unregister({id});
    return result;
  })()`, 'All-in-one test 3.3', 15000);

  console.log('\nDone.');
  ws.close();
  process.exit(0);
});

setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(1); }, 120000);
