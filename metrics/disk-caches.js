// Disk cache size scanner.
// Scans well-known developer cache directories (npm, pip, puppeteer) and
// reports sizes + protection status. Directory traversal can take a few
// seconds on multi-GB trees, so results are cached for 10 minutes.
//
// Protected entries (e.g., puppeteer's Chromium binary) must NEVER be
// auto-deleted — consumers of this API should respect the `protected` flag.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE_TTL_MS = 10 * 60 * 1000;

const HOME = os.homedir();

const ENTRIES = [
  {
    key: 'npm-cache',
    label: 'npm cache',
    paths: [
      path.join(HOME, 'AppData', 'Local', 'npm-cache'),
      path.join(HOME, 'AppData', 'Roaming', 'npm-cache'),
    ],
    protected: false,
    note: 'Safe to delete. Only affects future `npm install` speed.',
  },
  {
    key: 'pip-cache',
    label: 'pip cache',
    paths: [path.join(HOME, 'AppData', 'Local', 'pip', 'Cache')],
    protected: false,
    note: 'Safe to delete. Only affects future `pip install` speed.',
  },
  {
    key: 'puppeteer',
    label: '.cache/puppeteer',
    paths: [path.join(HOME, '.cache', 'puppeteer')],
    protected: true,
    note: 'Chromium runtime binary — DO NOT delete. Active projects depend on it.',
  },
];

function dirSize(root) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try { total += fs.statSync(full).size; } catch {}
      }
    }
  }
  return total;
}

let cached = null;

function computeInfo() {
  const started = Date.now();
  const entries = ENTRIES.map((entry) => {
    let totalBytes = 0;
    const foundPaths = [];
    for (const p of entry.paths) {
      if (fs.existsSync(p)) {
        foundPaths.push(p);
        totalBytes += dirSize(p);
      }
    }
    return {
      key: entry.key,
      label: entry.label,
      paths: foundPaths.length ? foundPaths : entry.paths,
      exists: foundPaths.length > 0,
      size_bytes: totalBytes,
      protected: entry.protected,
      note: entry.note,
    };
  });
  const total_bytes = entries.reduce((a, e) => a + e.size_bytes, 0);
  return {
    ts: Math.floor(started / 1000),
    scan_ms: Date.now() - started,
    total_bytes,
    entries,
  };
}

function getInfo({ force = false } = {}) {
  const now = Date.now();
  if (!force && cached && (now - cached.at) < CACHE_TTL_MS) {
    return { ...cached.info, cached: true, cache_age_s: Math.floor((now - cached.at) / 1000) };
  }
  const info = computeInfo();
  cached = { at: now, info };
  return { ...info, cached: false, cache_age_s: 0 };
}

module.exports = { getInfo };
