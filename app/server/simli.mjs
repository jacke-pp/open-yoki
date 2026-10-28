// Simli credentials stay on the server. A local operator explicitly requests one
// short trial session; room snapshots only describe whether it can be configured.
import { randomUUID } from 'node:crypto';

const TOKEN_URL = 'https://api.simli.ai/compose/token';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const integer = (value, fallback, min, max, name) => {
  const n = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return n;
};

function config(env) {
  const maxSessionLength = integer(env.SIMLI_MAX_SESSION_LENGTH, 120, 60, 3600, 'SIMLI_MAX_SESSION_LENGTH');
  const maxIdleTime = integer(env.SIMLI_MAX_IDLE_TIME, Math.min(60, maxSessionLength), 1, maxSessionLength, 'SIMLI_MAX_IDLE_TIME');
  const key = String(env.SIMLI_API_KEY || '').trim(), faceId = String(env.SIMLI_FACE_ID || '').trim();
  return { key, faceId, maxSessionLength, maxIdleTime };
}

export function simliPublicConfig(env = {}) {
  const { key, faceId, maxSessionLength } = config(env);
  return { configured: !!(key && faceId), maxSessionLength };
}

export class SimliError extends Error {
  constructor(status, message) { super(message); this.name = 'SimliError'; this.status = status; }
}

// Require the real socket and exact browser origin. Proxy headers and arbitrary
// Host values must never turn this paid-session endpoint into a public API.
export function isLocalSimliRequest(req, { requireOrigin = true } = {}) {
  const address = req.socket?.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  if (Object.keys(req.headers).some(name => name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-'))) return false;
  const host = req.headers.host, origin = req.headers.origin;
  if (typeof host !== 'string' || (requireOrigin && typeof origin !== 'string')) return false;
  try {
    const target = new URL(`http://${host}`);
    const validHost = LOOPBACK_HOSTS.has(target.hostname) && !target.username && !target.password &&
      target.host === host.toLowerCase() && target.pathname === '/' && !target.search && !target.hash &&
      Number(target.port || 80) === req.socket.localPort;
    if (!validHost || !requireOrigin) return validHost;
    const source = new URL(origin);
    return source.origin === target.origin && origin === source.origin;
  } catch { return false; }
}

export function createSimliService({ env = {}, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000 } = {}) {
  const settings = config(env);
  const missing = ['SIMLI_API_KEY', 'SIMLI_FACE_ID'].filter(name => !String(env[name] || '').trim());
  const configured = missing.length === 0;
  let lease = null, pending = null, closed = false, attempts = [];
  const expire = () => { if (lease && !pending && now() >= lease.expiresAt) lease = null; };
  const health = () => {
    expire();
    return { configured, missing: [...missing], maxSessionLength: settings.maxSessionLength, maxIdleTime: settings.maxIdleTime, active: !!lease };
  };

  async function create({ signal } = {}) {
    if (closed) throw new SimliError(503, 'Simli service is closed');
    if (!configured) throw new SimliError(503, 'Simli is not configured');
    if (signal?.aborted) throw new SimliError(499, 'Simli session request cancelled');
    expire();
    if (lease) throw new SimliError(409, 'A Simli trial session is already active');
    const at = now();
    attempts = attempts.filter(t => at - t < 60000);
    if (attempts.length >= 3 || (attempts.length && at - attempts.at(-1) < 2000)) throw new SimliError(429, 'Wait before starting another Simli trial');
    attempts.push(at);
    const ownLease = lease = { leaseId: randomUUID(), expiresAt: Infinity };
    const controller = new AbortController();
    let timer, timedOut = false;
    const cancel = () => controller.abort();
    const cancelled = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new SimliError(timedOut ? 504 : 499,
        timedOut ? 'Simli session request timed out' : 'Simli session request cancelled')), { once: true });
    });
    signal?.addEventListener('abort', cancel, { once: true });
    pending = controller;
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const request = (async () => {
        const response = await fetchImpl(TOKEN_URL, {
          method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json', 'x-simli-api-key': settings.key },
          body: JSON.stringify({ faceId: settings.faceId, apiVersion: 'v2', handleSilence: true,
            maxSessionLength: settings.maxSessionLength, maxIdleTime: settings.maxIdleTime, audioInputFormat: 'pcm16' }),
          signal: controller.signal,
        });
        if (!response.ok) throw new SimliError(502, `Simli rejected the session request (HTTP ${response.status})`);
        const result = await response.json();
        if (typeof result?.session_token !== 'string' || !result.session_token.trim() || result.session_token.length > 65536) throw new SimliError(502, 'Simli returned an invalid session');
        return result.session_token;
      })();
      const sessionToken = await Promise.race([request, cancelled]);
      if (controller.signal.aborted) throw new SimliError(499, 'Simli session request cancelled');
      ownLease.expiresAt = now() + settings.maxSessionLength * 1000;
      return { leaseId: ownLease.leaseId, sessionToken, maxSessionLength: settings.maxSessionLength, expiresAt: ownLease.expiresAt };
    } catch (error) {
      if (lease === ownLease) lease = null;
      if (error instanceof SimliError) throw error;
      // Never reflect upstream response bodies, tokens, URLs, or exception text.
      throw new SimliError(502, 'Simli session request failed');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (pending === controller) pending = null;
    }
  }

  function release(leaseId) {
    if (typeof leaseId !== 'string' || !/^[a-f0-9-]{36}$/i.test(leaseId)) throw new SimliError(400, 'A valid Simli leaseId is required');
    expire();
    if (lease && lease.leaseId !== leaseId) throw new SimliError(409, 'Simli lease does not match');
    // The browser stops its SDK connection before releasing this local lease.
    if (lease) { pending?.abort(); lease = null; }
    return { ok: true };
  }

  function close() { closed = true; pending?.abort(); lease = null; }
  return { create, release, health, close };
}
