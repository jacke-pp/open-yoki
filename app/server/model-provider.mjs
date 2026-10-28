// Reply backends share ask(messages, { long, signal }) so the host's persona,
// memory and reply queue do not depend on how a model is called.
import { openrouter, deepseek, withBackup, MODEL } from './brain.mjs';
import { codex } from './codex.mjs';

function timeout(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms < 100 || ms > 120000) {
    throw new Error(`${name} must be an integer between 100 and 120000`);
  }
  return ms;
}

export function createReplyProvider({ env = {}, idol = {}, factories = {} } = {}) {
  const provider = env.MODEL_PROVIDER || 'openrouter';
  if (!['openrouter', 'codex'].includes(provider)) {
    throw new Error('MODEL_PROVIDER must be openrouter or codex');
  }
  const local = provider === 'codex';
  const enabled = env.MODEL_OFF !== '1' && (local || !!env.OPENROUTER_API_KEY);
  const timeoutMs = local ? timeout(env.CODEX_TIMEOUT_MS, 20000, 'CODEX_TIMEOUT_MS') : 12000;
  const longTimeoutMs = local ? timeout(env.CODEX_LONG_TIMEOUT_MS, 45000, 'CODEX_LONG_TIMEOUT_MS') : 30000;
  const direct = !local && !!env.HEART_KEY_DS && env.MOUTH_DIRECT !== '0' && !!idol.mouth?.direct;
  const model = local ? env.CODEX_MODEL || 'codex default' : direct ? env.MOUTH_DS || 'deepseek-flash' : idol.models?.main || MODEL;
  const off = async () => { throw new Error('model off'); };
  let ask = off;

  if (enabled && local) {
    ask = (factories.codex || codex)({
      bin: env.CODEX_BIN || 'codex', model: env.CODEX_MODEL || undefined,
      timeoutMs, longTimeoutMs,
    });
  } else if (enabled) {
    const makeRouter = factories.openrouter || openrouter;
    const router = name => makeRouter({ key: env.OPENROUTER_API_KEY, model: name });
    if (direct) {
      const main = (factories.deepseek || deepseek)({ key: env.HEART_KEY_DS, model });
      ask = withBackup(main, router(idol.models?.main || MODEL), { mainMs: idol.models?.mainMs || 3500 });
    } else if (idol.models) {
      ask = withBackup(router(idol.models.main), router(idol.models.backup), { mainMs: idol.models.mainMs });
    } else ask = router(MODEL);
  }

  // Codex account/API billing is outside this process. Zero returned by its
  // adapter is an accounting placeholder, never a claim of free model usage.
  return { ask, close: async () => { await ask.close?.(); }, enabled, provider, model, direct, timeoutMs, longTimeoutMs, costKnown: !local };
}
