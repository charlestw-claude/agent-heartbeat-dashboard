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
const USAGE_PATH = '/v1/usage';
const ANALYSIS_PATH = '/v1/analysis';
// Usage snapshot poll cadence. ClaudeMonitor refreshes its own scrape every
// ~5 min, so polling more often than that just re-reads a cached snapshot —
// but a 60s cadence keeps `receivedAt` fresh enough that the UI's "Updated
// 1m ago" is always meaningful and a missed poll is obvious within a minute.
const USAGE_POLL_MS = 60 * 1000;
// Analysis is a rolling 14-day aggregate — it only changes meaningfully when
// a new hour's worth of activity rolls in. 5 min is more than enough.
const ANALYSIS_POLL_MS = 5 * 60 * 1000;
const STALE_THRESHOLD_MS = 3 * USAGE_POLL_MS; // 3 missed usage polls
const ANALYSIS_STALE_MS = 3 * ANALYSIS_POLL_MS;
const MAX_PAYLOAD_AGE_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3000;

const usageState = { payload: null, receivedAt: null, lastError: null, timer: null };
const analysisState = { payload: null, receivedAt: null, lastError: null, timer: null };

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: SOURCE_HOST, port: SOURCE_PORT, path, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode === 503) return reject(new Error('no_snapshot'));
          if (res.statusCode !== 200) return reject(new Error(`http_${res.statusCode}`));
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

function makePoller(state, path, intervalMs) {
  return async function pollOnce() {
    try {
      state.payload = await fetchJson(path);
      state.receivedAt = Date.now();
      state.lastError = null;
    } catch (err) {
      state.lastError = err.message || String(err);
    }
  };
}

const pollUsage = makePoller(usageState, USAGE_PATH, USAGE_POLL_MS);
const pollAnalysis = makePoller(analysisState, ANALYSIS_PATH, ANALYSIS_POLL_MS);

function start() {
  if (!usageState.timer) {
    pollUsage();
    usageState.timer = setInterval(pollUsage, USAGE_POLL_MS);
    if (usageState.timer.unref) usageState.timer.unref();
  }
  if (!analysisState.timer) {
    pollAnalysis();
    analysisState.timer = setInterval(pollAnalysis, ANALYSIS_POLL_MS);
    if (analysisState.timer.unref) analysisState.timer.unref();
  }
}

function stop() {
  for (const s of [usageState, analysisState]) {
    if (s.timer) { clearInterval(s.timer); s.timer = null; }
  }
}

function getSnapshot() {
  const now = Date.now();
  if (usageState.receivedAt && now - usageState.receivedAt > MAX_PAYLOAD_AGE_MS) {
    usageState.payload = null;
    usageState.receivedAt = null;
  }
  const stale = usageState.receivedAt ? now - usageState.receivedAt > STALE_THRESHOLD_MS : true;
  return {
    payload: usageState.payload,
    receivedAt: usageState.receivedAt ? new Date(usageState.receivedAt).toISOString() : null,
    stale,
    lastError: usageState.lastError,
    staleThresholdMs: STALE_THRESHOLD_MS,
    pollIntervalMs: USAGE_POLL_MS,
    schemaVersion: SCHEMA_VERSION,
    source: `http://${SOURCE_HOST}:${SOURCE_PORT}${USAGE_PATH}`,
  };
}

function getAnalysis() {
  const now = Date.now();
  if (analysisState.receivedAt && now - analysisState.receivedAt > MAX_PAYLOAD_AGE_MS) {
    analysisState.payload = null;
    analysisState.receivedAt = null;
  }
  const stale = analysisState.receivedAt ? now - analysisState.receivedAt > ANALYSIS_STALE_MS : true;
  return {
    payload: analysisState.payload,
    receivedAt: analysisState.receivedAt ? new Date(analysisState.receivedAt).toISOString() : null,
    stale,
    lastError: analysisState.lastError,
    staleThresholdMs: ANALYSIS_STALE_MS,
    pollIntervalMs: ANALYSIS_POLL_MS,
    schemaVersion: SCHEMA_VERSION,
    source: `http://${SOURCE_HOST}:${SOURCE_PORT}${ANALYSIS_PATH}`,
  };
}

module.exports = { start, stop, getSnapshot, getAnalysis, SCHEMA_VERSION };
