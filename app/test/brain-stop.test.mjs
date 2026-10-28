import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrain } from '../server/brain.mjs';
import { createWorld } from '../server/world.mjs';
import idol from '../idols/example/config.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function brainFor(options) {
  return createBrain({ idol, world: createWorld({ idol }), viewers: () => 0, ...options });
}

test('stop aborts a pending reply and waits for provider cleanup without speaking a fallback', { timeout: 2000 }, async t => {
  const started = deferred(), cleanup = deferred(), errors = [], spoken = [];
  let requestSignal, settled = false;
  const brain = brainFor({
    ask: (_messages, { signal }) => new Promise((_resolve, reject) => {
      requestSignal = signal;
      signal.addEventListener('abort', () => {
        cleanup.promise.then(() => reject(Object.assign(new Error('request cancelled'), { name: 'AbortError' })));
      }, { once: true });
      started.resolve();
    }),
    speak: async line => { spoken.push(line); },
    status: (...args) => { errors.push(args); },
  });
  t.after(async () => { cleanup.resolve(); await brain.stop(); });
  brain.add({ kind: 'chat', name: 'guest', text: 'hello' });
  brain.start();
  await started.promise;
  const stopped = brain.stop().then(() => { settled = true; });
  assert.equal(requestSignal.aborted, true);
  assert.equal(requestSignal.reason, 'stopped');
  await Promise.resolve();
  assert.equal(settled, false, 'shutdown must wait until the provider has released its child process');
  cleanup.resolve();
  await stopped;
  assert.deepEqual(spoken, []);
  assert.deepEqual(errors, []);
  assert.equal(brain.spend.fails, 0);
  assert.equal(brain.queue.length, 0, 'stopped requests are not requeued as preempted requests');
});

test('a late successful reply from an abort-ignoring provider is discarded after stop', { timeout: 2000 }, async t => {
  const started = deferred(), response = deferred(), spoken = [];
  const brain = brainFor({
    ask: async () => { started.resolve(); return response.promise; },
    speak: async line => { spoken.push(line); },
  });
  t.after(async () => { response.resolve({ text: '[开心][无]hello', cost: 0 }); await brain.stop(); });
  brain.add({ kind: 'chat', name: 'guest', text: 'hello' });
  brain.start();
  await started.promise;
  const stopped = brain.stop();
  response.resolve({ text: '[开心][无]hello', cost: 0 });
  await stopped;
  assert.deepEqual(spoken, []);
  assert.equal(brain.spend.fails, 0);
  assert.equal(brain.queue.length, 0);
});

test('stop allows current speech to finish, then skips folded-comment requeue', { timeout: 2000 }, async t => {
  const speaking = deferred(), finished = deferred();
  let signal, calls = 0, settled = false;
  const brain = brainFor({
    ask: async (_messages, options) => {
      signal = options.signal;
      calls++;
      return { text: '[开心][无]hello everyone', cost: 0 };
    },
    speak: async () => { speaking.resolve(); await finished.promise; },
  });
  t.after(async () => { finished.resolve(); await brain.stop(); });
  brain.add({ kind: 'chat', name: 'guest-one', text: 'first question' });
  brain.add({ kind: 'chat', name: 'guest-two', text: 'second question' });
  brain.start();
  await speaking.promise;
  const stopped = brain.stop().then(() => { settled = true; });
  assert.equal(signal.aborted, false, 'already-started speech is allowed to finish');
  await Promise.resolve();
  assert.equal(settled, false);
  finished.resolve();
  await stopped;
  assert.equal(calls, 1);
  assert.equal(brain.queue.length, 0, 'folded comments must not be requeued during shutdown');
});

test('an immediate stop prevents queued work from starting and the brain can restart afterward', { timeout: 2000 }, async t => {
  const spoken = deferred();
  let calls = 0;
  const brain = brainFor({
    ask: async () => { calls++; return { text: '[开心][无]hello', cost: 0 }; },
    speak: async () => { spoken.resolve(); },
  });
  t.after(() => brain.stop());
  brain.add({ kind: 'chat', name: 'guest', text: 'hello' });
  const firstRun = brain.start();
  assert.equal(brain.start(), firstRun, 'starting an active loop must not create another loop');
  await brain.stop();
  assert.equal(calls, 0);
  brain.start();
  await spoken.promise;
  await brain.stop();
  assert.equal(calls, 1);
});
