import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplyProvider } from '../server/model-provider.mjs';

test('the existing OpenRouter backend stays the default and needs its key', async () => {
  const off = createReplyProvider();
  assert.equal(off.provider, 'openrouter');
  assert.equal(off.enabled, false);
  await assert.rejects(off.ask([]), /model off/);
  const calls = [];
  const reply = createReplyProvider({
    env: { OPENROUTER_API_KEY: 'test-key' },
    factories: { openrouter: options => { calls.push(options); return async () => ({ text: 'hello', cost: 0.01 }); } },
  });
  assert.equal(reply.enabled, true);
  assert.equal(reply.costKnown, true);
  assert.equal((await reply.ask([])).text, 'hello');
  assert.equal(calls[0].key, 'test-key');
});

test('Codex works without an OpenRouter key and never silently calls a paid API backup', async () => {
  const calls = [];
  const reply = createReplyProvider({
    env: { MODEL_PROVIDER: 'codex', CODEX_MODEL: 'chosen-model', CODEX_TIMEOUT_MS: '18000' },
    idol: { models: { main: 'other-model', backup: 'backup-model' }, mouth: { direct: 'persona' } },
    factories: {
      codex: options => { calls.push(options); return async () => ({ text: 'local reply', cost: 0 }); },
      openrouter: () => { throw new Error('unexpected API call'); },
      deepseek: () => { throw new Error('unexpected API call'); },
    },
  });
  assert.equal(reply.enabled, true);
  assert.equal(reply.direct, false);
  assert.equal(reply.costKnown, false);
  assert.equal(reply.model, 'chosen-model');
  assert.equal(reply.timeoutMs, 18000);
  assert.equal((await reply.ask([])).text, 'local reply');
  assert.equal(calls[0].model, 'chosen-model');
  assert.equal(calls[0].timeoutMs, 18000);
});

test('MODEL_OFF disables even the Codex backend before its factory is invoked', async () => {
  const reply = createReplyProvider({
    env: { MODEL_PROVIDER: 'codex', MODEL_OFF: '1' },
    factories: { codex: () => { throw new Error('must not initialize'); } },
  });
  assert.equal(reply.enabled, false);
  await assert.rejects(reply.ask([]), /model off/);
});

test('the existing direct DeepSeek route retains its OpenRouter fallback', async () => {
  const seen = [];
  const reply = createReplyProvider({
    env: { OPENROUTER_API_KEY: 'router-key', HEART_KEY_DS: 'direct-key' },
    idol: { mouth: { direct: 'persona' }, models: { main: 'router-model', mainMs: 1000 } },
    factories: {
      deepseek: options => { seen.push(['deepseek', options]); return async () => ({ text: 'direct', cost: 0 }); },
      openrouter: options => { seen.push(['openrouter', options]); return async () => ({ text: 'backup', cost: 0 }); },
    },
  });
  assert.equal(reply.direct, true);
  assert.equal((await reply.ask([])).text, 'direct');
  assert.deepEqual(seen.map(([name]) => name), ['deepseek', 'openrouter']);
});

test('invalid backend and timeouts are rejected rather than silently selecting another backend', () => {
  assert.throws(() => createReplyProvider({ env: { MODEL_PROVIDER: 'typo' } }), /MODEL_PROVIDER/);
  for (const value of ['NaN', '-1', '0', '1.5', '120001']) {
    assert.throws(() => createReplyProvider({ env: { MODEL_PROVIDER: 'codex', CODEX_TIMEOUT_MS: value } }), /CODEX_TIMEOUT_MS/);
  }
});
