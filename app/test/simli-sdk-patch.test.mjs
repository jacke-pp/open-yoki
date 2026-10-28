import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { patchSimliSdk, SIMLI_SDK_VERSION } from '../tools/simli-sdk-patch.mjs';

const source = await readFile(new URL('../node_modules/simli-client/dist/client.js', import.meta.url), 'utf8');
const patched = patchSimliSdk(source);
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ connecting = Promise.resolve(), disconnecting = Promise.resolve(), disconnectError = null } = {}) {
  const transports = [], contexts = [], timers = new Map();
  let timerId = 0;
  class AudioContext {
    state = 'running';
    closes = 0;
    constructor() { contexts.push(this); }
    async close() { this.closes++; this.state = 'closed'; }
  }
  class Transport {
    events = new Map();
    disconnects = 0;
    socketCloses = 0;
    signalingConnection = { disconnect: () => { this.socketCloses++; } };
    constructor() { transports.push(this); }
    on(event, fn) {
      if (!this.events.has(event)) this.events.set(event, new Set());
      this.events.get(event).add(fn);
    }
    off(event, fn) { this.events.get(event)?.delete(fn); }
    emit(event, ...args) { for (const fn of this.events.get(event) || []) fn(...args); }
    connect() { return connecting; }
    async disconnect() {
      this.disconnects++;
      if (disconnectError) throw disconnectError;
      await disconnecting;
    }
  }
  class Logger { debug() {} info() {} warn() {} error() {} }
  const exports = {};
  runInNewContext(patched, {
    exports,
    window: { AudioContext },
    require(id) {
      if (id === './transports/LivekitTransport') return { LivekitTransport: Transport };
      if (id === './transports/P2PTransport') return { P2PTransport: Transport };
      if (id === './Logger') return { Logger, LogLevel: { DEBUG: 3, INFO: 2 } };
      throw new Error(`Unexpected SDK import ${id}`);
    },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const client = new exports.SimliClient('test-short-lived-token', {}, {}, null);
  return {
    client, transports, contexts, timers,
    expireFirstFrame() {
      for (const [id, { fn }] of [...timers]) { timers.delete(id); fn(); }
    },
  };
}

test('Simli lifecycle patch fails closed for changed sources or versions', () => {
  assert.equal(SIMLI_SDK_VERSION, '3.2.0');
  assert.throws(() => patchSimliSdk(source + '\n'), /Unsupported simli-client source/);
  assert.throws(() => patchSimliSdk(source, { version: '3.2.1' }), /Unsupported simli-client source/);
  assert.throws(() => patchSimliSdk(null), /Unsupported simli-client source/);
  assert.throws(() => patchSimliSdk(patched), /Unsupported simli-client source/);
});

test('patched real SDK waits for its first frame and retains the successful session until stop', async () => {
  const f = fixture();
  let ready = false;
  const starting = f.client.start().then(() => { ready = true; });
  await turn();
  assert.equal(ready, false);
  assert.equal(f.contexts[0].closes, 0);
  f.transports[0].emit('start');
  await starting;
  assert.equal(ready, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.transports.length, 1);
  await f.client.stop();
  assert.equal(f.transports[0].socketCloses, 1);
  assert.equal(f.transports[0].disconnects, 1);
  assert.equal(f.contexts[0].closes, 1);
});

test('stop during pending connect closes audio and signaling before slow transport cleanup, without late reconnect', async () => {
  const connect = deferred(), disconnect = deferred();
  const f = fixture({ connecting: connect.promise, disconnecting: disconnect.promise });
  const starting = f.client.start();
  const rejected = assert.rejects(starting, /Simli session stopped/);
  const stopping = f.client.stop();
  assert.equal(f.client.stop(), stopping);
  await turn();
  assert.equal(f.timers.size, 0);
  assert.equal(f.transports[0].socketCloses, 1);
  assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.contexts[0].state, 'closed');

  // A late connection/frame must not revive this terminal client or create a
  // second transport while the first transport's disconnect is still pending.
  connect.resolve();
  f.transports[0].emit('start');
  f.expireFirstFrame();
  await turn();
  assert.equal(f.client.started, false);
  assert.equal(f.transports.length, 1);
  assert.throws(() => f.client.resetConnections({}, {}, null), /Simli session stopped/);
  disconnect.resolve();
  await stopping;
  await rejected;
  await assert.rejects(f.client.start(), /Simli session stopped/);
  assert.equal(f.transports.length, 1);
  assert.equal(f.contexts[0].closes, 1);
});

test('startup network failures make one attempt and clean up without retry timers', async () => {
  const connect = deferred();
  const f = fixture({ connecting: connect.promise });
  const starting = assert.rejects(f.client.start(), /network unavailable/);
  f.transports[0].emit('startup_error', 'network unavailable');
  connect.reject(new Error('network unavailable'));
  await starting;
  f.expireFirstFrame();
  await turn();
  assert.equal(f.transports.length, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.transports[0].socketCloses, 1);
  assert.equal(f.contexts[0].closes, 1);
});

test('first-frame timeout closes the session before an outer 25-second timeout could reconnect it', async () => {
  const f = fixture();
  const starting = assert.rejects(f.client.start(), /Connection Timed Out/);
  assert.deepEqual([...f.timers.values()].map(t => t.delay), [15000]);
  f.expireFirstFrame();
  await starting;
  await f.client.stop(); // Same cleanup an outer timeout/finally performs.
  assert.equal(f.timers.size, 0);
  assert.equal(f.transports.length, 1);
  assert.equal(f.transports[0].socketCloses, 1);
  assert.equal(f.contexts[0].closes, 1);
});

test('transport cleanup failure still closes audio, worklet and source', async () => {
  const f = fixture({ disconnectError: new Error('room disconnect failed') });
  let workletClosed = false, workletDisconnected = false, sourceDisconnected = false;
  f.client.audioWorklet = {
    port: { onmessage: () => {}, close() { workletClosed = true; } },
    disconnect() { workletDisconnected = true; },
  };
  f.client.sourceNode = { disconnect() { sourceDisconnected = true; } };
  await assert.rejects(f.client.stop(), /Simli cleanup failed/);
  assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.transports[0].socketCloses, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(workletClosed && workletDisconnected && sourceDisconnected, true);
  assert.equal(f.client.audioWorklet, null);
  assert.equal(f.client.sourceNode, null);
});

test('stop before start consumes the pending rejection and makes the client unusable', async () => {
  const f = fixture();
  await f.client.stop();
  await assert.rejects(f.client.start(), /Simli session stopped/);
  await turn();
  assert.equal(f.timers.size, 0);
  assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.transports.length, 1);
});
