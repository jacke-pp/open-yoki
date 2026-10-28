import { createHash } from 'node:crypto';

export const SIMLI_SDK_VERSION = '3.2.0';
// Base64 SHA-256 of the upstream source, rather than a credential-like hex literal.
export const SIMLI_CLIENT_SHA256 = 'mud9dUc1LyjukHXNba9heJ8GzDt6/uNOAGtoBlrxWlY=';

// Build-time compatibility patch for simli-client 3.2.0 (MIT).
// Keep the upstream LICENSE alongside the resulting browser bundle. This changes
// session lifetime only: one connection attempt, terminal stop, and cleanup of
// the SDK's AudioContext/timer. Do not apply it silently to a newer SDK release.
export function patchSimliSdk(source, { version = SIMLI_SDK_VERSION } = {}) {
  if (version !== SIMLI_SDK_VERSION || typeof source !== 'string' ||
      createHash('sha256').update(source).digest('base64') !== SIMLI_CLIENT_SHA256) {
    throw new Error(`Unsupported simli-client source; expected ${SIMLI_SDK_VERSION} dist/client.js (${SIMLI_CLIENT_SHA256})`);
  }

  const replaceOnce = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('Simli SDK patch anchor is not unique');
    source = source.replace(before, after);
  };

  replaceOnce('    shouldStop = false;', '    shouldStop = false;\n    stopPromise = null;');
  replaceOnce('        this.connection.on("start", () => {\n            this.started = true;',
    '        this.connection.on("start", () => {\n            if (this.shouldStop) return;\n            this.started = true;');
  replaceOnce('    resetConnections(videoElement, audioElement, iceServers) {\n',
    '    resetConnections(videoElement, audioElement, iceServers) {\n        if (this.shouldStop) throw new Error("Simli session stopped");\n');

  const startAt = source.indexOf('    async start() {');
  const startEnd = source.indexOf('    // Before retry n ', startAt);
  if (startAt < 0 || startEnd < 0) throw new Error('Simli SDK start method was not found');
  source = source.slice(0, startAt) + `    async start() {
        if (this.shouldStop) throw new Error("Simli session stopped");
        try {
            // Observe both promises immediately: stop must interrupt a transport
            // whose connect() is still pending, without leaving a rejection loose.
            await Promise.all([this.connection.connect(), this.connectionPromise]);
            if (this.shouldStop) throw new Error("Simli session stopped");
            this.retryAttempt = 0;
        } catch (error) {
            // No automatic paid reconnects. A deliberate new session needs a new
            // token and a new client; the caller owns any retry policy.
            await this.stop().catch(() => {});
            throw this.failReason || error;
        }
    }
` + source.slice(startEnd);

  replaceOnce(`    async stop() {
        this.shouldStop = true;
        await this.connection.disconnect();
    }
`, `    stop() {
        if (this.stopPromise) return this.stopPromise;
        this.shouldStop = true;
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = undefined;
        // Also safe when stop precedes start(): its rejected first-frame promise
        // is handled, and start() will refuse to reuse this terminal client.
        this.connectionPromise.catch(() => {});
        this.connectionReject(new Error("Simli session stopped"));
        this.stopPromise = Promise.resolve().then(async () => {
            const cleanup = [
                // Close signaling independently of LiveKit's async disconnect so
                // a pending room connection cannot keep the paid session alive.
                () => this.connection?.signalingConnection?.disconnect(),
                () => this.connection?.disconnect(),
                () => {
                    if (!this.audioWorklet) return;
                    this.audioWorklet.port.onmessage = null;
                    this.audioWorklet.port.close?.();
                    this.audioWorklet.disconnect();
                },
                () => this.sourceNode?.disconnect(),
                () => this.audioContext?.state === "closed" ? undefined : this.audioContext?.close(),
            ];
            const results = await Promise.allSettled(cleanup.map(fn => Promise.resolve().then(fn)));
            this.audioWorklet = null;
            this.sourceNode = null;
            const failed = results.filter(result => result.status === "rejected");
            if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Simli cleanup failed");
        });
        return this.stopPromise;
    }
`);
  return '// open-yoki: fixed-version Simli session lifecycle patch; upstream MIT license retained.\n' + source;
}
