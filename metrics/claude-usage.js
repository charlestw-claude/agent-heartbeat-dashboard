// Claude subscription usage — ingest store.
//
// ClaudeMonitor (a separate .NET WPF app on the same host) scrapes claude.ai's
// usage page via an embedded WebView2, parses the "X / Y" utilization lines,
// and POSTs a JSON snapshot to /api/claude/usage/ingest every ~5 minutes.
// This module caches the latest payload in memory and exposes it to the
// dashboard frontend via GET /api/claude/usage.
//
// Deliberately read-only wrt Claude Code: we never touch ~/.claude/.credentials.json
// so there's zero risk of invalidating the refresh_token that running agents
// rely on. ClaudeMonitor uses a separate claude.ai web-session cookie jar,
// which is its own auth lane.

const SCHEMA_VERSION = 1;
// Mark payload stale if we haven't received a POST in this long. ClaudeMonitor
// probes every 5 min, so 15 min = 3 missed probes.
const STALE_THRESHOLD_MS = 15 * 60 * 1000;
// Cap how old a payload we'll return at all. Beyond this, the snapshot
// payload is cleared so the UI hides the panel rather than showing fossilized
// data after ClaudeMonitor has been offline for hours.
const MAX_PAYLOAD_AGE_MS = 6 * 60 * 60 * 1000;

const state = {
  payload: null,
  receivedAt: null,
};

function ingest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('payload_not_object');
  }
  if (payload.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`schema_version_mismatch:expected=${SCHEMA_VERSION}`);
  }
  state.payload = payload;
  state.receivedAt = Date.now();
}

function getSnapshot() {
  const now = Date.now();
  if (state.receivedAt && now - state.receivedAt > MAX_PAYLOAD_AGE_MS) {
    state.payload = null;
    state.receivedAt = null;
  }
  const stale = state.receivedAt ? now - state.receivedAt > STALE_THRESHOLD_MS : true;
  return {
    payload: state.payload,
    receivedAt: state.receivedAt ? new Date(state.receivedAt).toISOString() : null,
    stale,
    staleThresholdMs: STALE_THRESHOLD_MS,
    schemaVersion: SCHEMA_VERSION,
  };
}

module.exports = { ingest, getSnapshot, SCHEMA_VERSION };
