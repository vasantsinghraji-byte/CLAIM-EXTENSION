'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const nodes = new Map(), timers = new Map(), streams = [], events = new Map();
  let nextTimer = 0;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', dataset: {}, hidden: false,
      replaceChildren() { this.textContent = ''; }, addEventListener() {} });
    return nodes.get(id);
  };
  const document = { hidden: false, getElementById: node,
    querySelectorAll: () => [node('metric')], addEventListener: (name, handler) => events.set(name, handler) };
  const context = vm.createContext({ document, AbortController,
    addEventListener() {},
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../hosting/admin-monitor.js'), 'utf8'), context);
  const monitor = context.ClaimSparkMonitor.create({ onDenied: error => { throw error; }, api: {
    watchMonitor: signal => new Promise(resolve => {
      streams.push({ signal }); signal.addEventListener('abort', resolve, { once: true });
    })
  } });
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  return { node, monitor, timers, streams, events, document, flush };
}

test('settling an aborted feed cannot remove the replacement feed watchdog', async () => {
  const f = fixture();
  f.monitor.start(); f.monitor.start(); await f.flush();
  assert.equal(f.streams[0].signal.aborted, true);
  assert.equal(f.streams[1].signal.aborted, false);
  const watchdogs = [...f.timers.values()].filter(timer => timer.delay === 45000);
  assert.equal(watchdogs.length, 1, 'the new silent stream must still time out');
  watchdogs[0].fn(); await f.flush();
  assert.equal(f.streams[1].signal.aborted, true);
  assert([...f.timers.values()].some(timer => timer.delay === 1000), 'a silent feed schedules reconnect');
  f.monitor.stop();
});

test('hiding a dashboard aborts its feed, and sign-out clears all monitoring values', async () => {
  const f = fixture();
  f.monitor.start(); f.document.hidden = true; f.events.get('visibilitychange')(); await f.flush();
  assert.equal(f.streams[0].signal.aborted, true);
  assert.equal(f.timers.size, 0);
  f.document.hidden = false; f.events.get('visibilitychange')();
  assert.equal(f.streams.length, 2);
  f.node('metric').textContent = '8'; f.node('ruleVersionValue').textContent = 'private-version';
  f.node('monitorUserRows').textContent = 'Private account'; f.node('projectLabel').textContent = 'private-project';
  f.monitor.stop(); await f.flush();
  assert.equal(f.streams[1].signal.aborted, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.node('metric').textContent, '—');
  assert.equal(f.node('ruleVersionValue').textContent, '—');
  assert.equal(f.node('monitorUserRows').textContent, '');
  assert.equal(f.node('projectLabel').textContent, 'Verifying backend');
});
