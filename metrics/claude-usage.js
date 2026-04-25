// Claude subscription usage — pull poller.
//
// ClaudeMonitor (a separate .NET WPF tray app on the same VM) exposes a
// loopback-only HTTP API at http://127.0.0.1:6736/v1/usage that returns
// the latest claude.ai usage snapshot. This module polls that endpoint
// every POLL_INTERVAL_MS, caches the latest payload in memory, and serves
// it to the dashboard frontend via GET /api/claude/usage.
//
// Why pull (not push):
// - ClaudeMonitor v2.4.2 standardised on a local read-only API so multiple
//   consumers (dashboard, Home Assistant, scripts) can share one snapshot
//   instead of each running its own scraper.
// - No auth needed: API is loopback-bound and the dashboard is on the same
//   host, so the only thing that can hit it is local code.
//
// Deliberately read-only wrt Claude Code: ClaudeMonitor uses a separate
// claude.ai web-session cookie jar — it never touches
// ~/.claude/.credentials.json so there's zero risk of invalidating the
// refresh_token that running agents rely on.

const http = require('http');

const SCHEMA_VERSION = 1;
const SOURCE_HOST = '127.0.0.1';
const SOURCE_PORT = 6736;
const SOURCE_PATH = '/v1/usage';
// Poll cadence. ClaudeMonitor refreshes its own scrape every ~5 min, so
// polling more often than that just re-reads a cached snapshot — but a 60s
// cadence keeps `receivedAt` fresh enough that the UI's "Updated 1m ago"
// is always meaningful and a missed poll is obvious within a minute.
const POLL_INTERVAL_MS = 60 * 1000;
// Mark snapshot stale if our most recent successful poll is older than this.
// 3× POLL_INTERVAL_MS = three consecutive failures before we flag it.
const STALE_THRESHOLD_MS = 3 * POLL_INTERVAL_MS;
// Beyond this, we drop the cached payload entirely so the UI hides the
// panel rather than showing fossilised data.
const MAX_PAYLOAD_AGE_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3000;

const state = {
  payload: null,
  receivedAt: null,
  lastError: null,
  timer: null,
};

function fetchSnapshot() {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: SOURCE_HOST, port: SOURCE_PORT, path: SOURCE_PATH, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode === 503) {
            // ClaudeMonitor running but no snapshot yet (cold start).
            return reject(new Error('no_snapshot'));
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`http_${res.statusCode}`));
          }
          try {
            const parsed = JSON.parse(body);
            if (parsed.schemaVersion !== SCHEMA_VERSION) {
              return reject(new Error(`schema_version_mismatch:expected=${SCHEMA_VERSION},got=${parsed.schemaVersion}`));
            }
            resolve(parsed);
          } catch (err) {
            reject(new Error(`parse_error:${err.message}`));
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (err) => reject(err));
  });
}

async function pollOnce() {
  try {
    const payload = await fetchSnapshot();
    state.payload = payload;
    state.receivedAt = Date.now();
    state.lastError = null;
  } catch (err) {
    state.lastError = err.message || String(err);
  }
}

function start() {
  if (state.timer) return;
  // Fire immediately so the first /api/claude/usage call doesn't have to
  // wait POLL_INTERVAL_MS for any data at all.
  pollOnce();
  state.timer = setInterval(pollOnce, POLL_INTERVAL_MS);
  if (state.timer.unref) state.timer.unref();
}

function stop() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
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
    lastError: state.lastError,
    staleThresholdMs: STALE_THRESHOLD_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
    schemaVersion: SCHEMA_VERSION,
    source: `http://${SOURCE_HOST}:${SOURCE_PORT}${SOURCE_PATH}`,
  };
}

module.exports = { start, stop, getSnapshot, SCHEMA_VERSION };
