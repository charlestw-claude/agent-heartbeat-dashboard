const si = require('systeminformation');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const { getDb } = require('../db/database');

// Polls VM resource metrics once per second. Buffers samples in memory and
// flushes to SQLite every BATCH_FLUSH_MS to keep write amplification low.
// systeminformation gives cumulative counters for net/disk; we convert to
// per-second rates locally by diffing against the previous sample.
//
// Process-level RSS (bun.exe / claude.exe) is sampled on a slower cadence
// because si.processes() on Windows is slow (~0.5–1s). The 1Hz sample reads
// the cached total; a separate endpoint (`/api/metrics/agents`) returns the
// per-agent breakdown for on-demand UI display.

const POLL_INTERVAL_MS = 1000;
const BATCH_FLUSH_MS = 5000;
// si.processes() is expensive on Windows (~500ms–1s), so we scan the full
// process tree at a relaxed cadence. netstat is cheap (~26ms), so the active
// socket check runs faster and patches the cached breakdown in place — the
// UI sees active-flag changes at NET_REFRESH_MS resolution.
const PROC_REFRESH_MS = 5000;
const NET_REFRESH_MS = 2000;
const AGENT_PROC_NAMES = new Set(['bun.exe', 'claude.exe']);

// Agent identity lives in the cmd.exe ancestor that launched the agent via
// its .bat file (e.g. `cmd /k ...\Claude-Agent-02.bat`). bun.exe / claude.exe
// processes themselves carry no agent identifier, so we walk the parent
// chain (up to MAX_PARENT_HOPS) and match the first ancestor whose command
// line contains one of the known agent names.
const AGENT_NAME_PATTERN = /Claude-Agent-\d+|Claude-Deloitte|Claude-Quant-2|Claude-Quant|Claude-Guest-Agent|Guest-Agent/i;
const MAX_PARENT_HOPS = 12;

let lastNet = null;
let buffer = [];
let listeners = [];
let agentsListeners = [];
let pollTimer = null;
let flushTimer = null;
let procTimer = null;
let netTimer = null;
let lastSample = null;
let lastAgentsMemMB = null;
let lastAgentsBreakdown = { ts: 0, total_mem_mb: null, agents: [], unattributed: [] };

function findAgentForProcess(p, byPid) {
  let cur = byPid.get(p.parentPid);
  for (let hops = 0; cur && hops < MAX_PARENT_HOPS; hops++) {
    const haystack = (cur.command || '') + ' ' + (cur.path || '');
    const m = haystack.match(AGENT_NAME_PATTERN);
    if (m) return m[0];
    cur = byPid.get(cur.parentPid);
  }
  return null;
}

// Returns Set<pid> of processes holding at least one ESTABLISHED outbound
// TCP connection to a remote :443 endpoint. Used to flag agents that are
// actively streaming from the Anthropic API - a far more reliable signal
// than CPU% because LLM inference happens server-side, so the VM just
// holds an idle socket while the model "thinks". Shelling out to netstat
// is ~50ms per call, acceptable at the 5s process-refresh cadence.
async function getActiveTlsPids() {
  try {
    const { stdout } = await execFileP('netstat', ['-ano', '-p', 'TCP'], {
      windowsHide: true,
      timeout: 4000,
    });
    const active = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+\s+(\S+)\s+(\S+)\s+(\d+)\s*$/);
      if (!m) continue;
      const [, foreign, state, pidStr] = m;
      if (state !== 'ESTABLISHED') continue;
      const portMatch = foreign.match(/:(\d+)$/);
      if (!portMatch || portMatch[1] !== '443') continue;
      active.add(parseInt(pidStr, 10));
    }
    return active;
  } catch {
    return new Set();
  }
}

async function refreshAgentProcesses() {
  try {
    const [res, activePids] = await Promise.all([
      si.processes(),
      getActiveTlsPids(),
    ]);
    const list = Array.isArray(res && res.list) ? res.list : [];
    const byPid = new Map(list.map((p) => [p.pid, p]));

    const byAgent = new Map();
    const unattributed = [];
    let totalKb = 0;

    for (const p of list) {
      const name = (p.name || '').toLowerCase();
      if (!AGENT_PROC_NAMES.has(name)) continue;
      const memKb = p.memRss || p.mem_rss || 0;
      totalKb += memKb;
      const proc = {
        pid: p.pid,
        name,
        rss_mb: memKb / 1024,
        cpu_pct: typeof p.cpu === 'number' ? p.cpu : null,
        active: activePids.has(p.pid),
      };
      const agentName = findAgentForProcess(p, byPid);
      if (agentName) {
        if (!byAgent.has(agentName)) {
          byAgent.set(agentName, {
            agent: agentName,
            process_count: 0,
            total_rss_mb: 0,
            total_cpu_pct: 0,
            active: false,
            processes: [],
          });
        }
        const bucket = byAgent.get(agentName);
        bucket.processes.push(proc);
        bucket.process_count += 1;
        bucket.total_rss_mb += proc.rss_mb;
        if (proc.cpu_pct != null) bucket.total_cpu_pct += proc.cpu_pct;
        // Only claude.exe owns the Anthropic API stream. bun.exe processes are
        // MCP servers (Telegram, etc) that keep long-poll :443 connections open
        // regardless of LLM activity, so they'd produce constant false positives.
        if (proc.active && name === 'claude.exe') bucket.active = true;
      } else {
        unattributed.push(proc);
      }
    }

    const agents = Array.from(byAgent.values())
      .map((a) => ({
        ...a,
        processes: a.processes.sort((x, y) => y.rss_mb - x.rss_mb),
      }))
      .sort((a, b) => b.total_rss_mb - a.total_rss_mb);

    lastAgentsMemMB = totalKb / 1024;
    lastAgentsBreakdown = {
      ts: Math.floor(Date.now() / 1000),
      total_mem_mb: lastAgentsMemMB,
      agents,
      unattributed: unattributed.sort((x, y) => y.rss_mb - x.rss_mb),
    };
    emitAgents();
  } catch (err) {
    console.error('[metrics] process probe error:', err.message);
  }
}

function emitAgents() {
  for (const fn of agentsListeners) {
    try { fn(lastAgentsBreakdown); } catch {}
  }
}

// Fast path: re-check just the active TLS sockets and patch the cached
// breakdown's active flags in place. Runs at NET_REFRESH_MS so the UI sees
// Thinking transitions quickly without paying the cost of a full si.processes
// scan every cycle.
async function refreshActiveSockets() {
  const activePids = await getActiveTlsPids();
  const snap = lastAgentsBreakdown;
  if (!snap || !Array.isArray(snap.agents)) return;

  for (const a of snap.agents) {
    let agentActive = false;
    for (const p of a.processes) {
      p.active = activePids.has(p.pid);
      if (p.active && p.name === 'claude.exe') agentActive = true;
    }
    a.active = agentActive;
  }
  for (const p of snap.unattributed || []) {
    p.active = activePids.has(p.pid);
  }
  snap.ts = Math.floor(Date.now() / 1000);
  emitAgents();
}

async function pollOnce() {
  const nowMs = Date.now();
  const ts = Math.floor(nowMs / 1000);

  try {
    const [cpu, mem, net, fs, time] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.networkStats(),
      si.fsSize(),
      si.time(),
    ]);

    const cpu_pct = cpu && typeof cpu.currentLoad === 'number' ? cpu.currentLoad : null;
    const mem_total_gb = mem ? mem.total / 1073741824 : null;
    const mem_used_gb = mem ? (mem.total - mem.available) / 1073741824 : null;

    // Pagefile / commit charge (Windows swap).
    const pagefile_total_gb = mem && typeof mem.swaptotal === 'number' ? mem.swaptotal / 1073741824 : null;
    const pagefile_used_gb = mem && typeof mem.swapused === 'number' ? mem.swapused / 1073741824 : null;

    // System disk free. Prefer the drive mounted at C:; fall back to the
    // first entry if no C: match (e.g. a future non-Windows host).
    let disk_free_gb = null;
    let disk_total_gb = null;
    if (Array.isArray(fs) && fs.length) {
      const c = fs.find((d) => /^c:/i.test(d.mount || d.fs || '')) || fs[0];
      if (c) {
        if (typeof c.available === 'number') disk_free_gb = c.available / 1073741824;
        else if (typeof c.size === 'number' && typeof c.used === 'number') disk_free_gb = (c.size - c.used) / 1073741824;
        if (typeof c.size === 'number') disk_total_gb = c.size / 1073741824;
      }
    }

    const uptime_s = time && typeof time.uptime === 'number' ? Math.floor(time.uptime) : null;

    // Sum across network interfaces; systeminformation returns an array
    const rx_bytes = Array.isArray(net) ? net.reduce((s, n) => s + (n.rx_bytes || 0), 0) : 0;
    const tx_bytes = Array.isArray(net) ? net.reduce((s, n) => s + (n.tx_bytes || 0), 0) : 0;

    let net_rx_bps = null;
    let net_tx_bps = null;
    if (lastNet && nowMs > lastNet.ts) {
      const dt_s = (nowMs - lastNet.ts) / 1000;
      net_rx_bps = Math.max(0, (rx_bytes - lastNet.rx_bytes) / dt_s);
      net_tx_bps = Math.max(0, (tx_bytes - lastNet.tx_bytes) / dt_s);
    }
    lastNet = { rx_bytes, tx_bytes, ts: nowMs };

    const sample = {
      ts,
      cpu_pct,
      mem_used_gb,
      mem_total_gb,
      net_rx_bps,
      net_tx_bps,
      // disk_read_bps / disk_write_bps intentionally null: systeminformation's
      // disksIO() returns null on Windows. Columns kept for backward-compat
      // with v1.1/v1.2 data; new dashboards use disk_free_gb instead.
      disk_read_bps: null,
      disk_write_bps: null,
      disk_free_gb,
      disk_total_gb,
      pagefile_used_gb,
      pagefile_total_gb,
      uptime_s,
      agents_mem_mb: lastAgentsMemMB,
    };

    // Skip the first sample where per-second rates are still null
    if (net_rx_bps !== null) {
      buffer.push(sample);
      lastSample = sample;
      for (const fn of listeners) {
        try { fn(sample); } catch {}
      }
    }
  } catch (err) {
    console.error('[metrics] poll error:', err.message);
  }
}

function flush() {
  if (buffer.length === 0) return;
  const rows = buffer;
  buffer = [];
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO vm_metrics_raw
        (ts, cpu_pct, mem_used_gb, mem_total_gb,
         net_rx_bps, net_tx_bps, disk_read_bps, disk_write_bps,
         disk_free_gb, disk_total_gb, pagefile_used_gb, pagefile_total_gb,
         uptime_s, agents_mem_mb)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction((items) => {
      for (const r of items) {
        stmt.run(
          r.ts, r.cpu_pct, r.mem_used_gb, r.mem_total_gb,
          r.net_rx_bps, r.net_tx_bps, r.disk_read_bps, r.disk_write_bps,
          r.disk_free_gb, r.disk_total_gb, r.pagefile_used_gb, r.pagefile_total_gb,
          r.uptime_s, r.agents_mem_mb,
        );
      }
    });
    tx(rows);
  } catch (err) {
    console.error('[metrics] flush error:', err.message);
  }
}

function start() {
  if (pollTimer) return;
  // Prime the process cache so the first 1Hz sample has something to report.
  refreshAgentProcesses();
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  flushTimer = setInterval(flush, BATCH_FLUSH_MS);
  procTimer = setInterval(refreshAgentProcesses, PROC_REFRESH_MS);
  netTimer = setInterval(refreshActiveSockets, NET_REFRESH_MS);
  console.log(`[metrics] collector started (poll=${POLL_INTERVAL_MS}ms, flush=${BATCH_FLUSH_MS}ms, proc=${PROC_REFRESH_MS}ms, net=${NET_REFRESH_MS}ms)`);
}

function stop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (procTimer) { clearInterval(procTimer); procTimer = null; }
  if (netTimer) { clearInterval(netTimer); netTimer = null; }
  flush();
}

function onSample(fn) {
  listeners.push(fn);
  return () => { listeners = listeners.filter((f) => f !== fn); };
}

function onAgents(fn) {
  agentsListeners.push(fn);
  return () => { agentsListeners = agentsListeners.filter((f) => f !== fn); };
}

function getLastSample() { return lastSample; }
function getAgentsBreakdown() { return lastAgentsBreakdown; }

module.exports = { start, stop, onSample, onAgents, getLastSample, getAgentsBreakdown };
