// Agent → current model mapping.
//
// Claude Code writes every session to ~/.claude/projects/<slug>/<uuid>.jsonl,
// where each assistant message line includes a "model" field. By locating the
// most recently mtime'd jsonl in the agent's project directory and pulling
// the last `"model":"..."` occurrence from its tail we get the model the
// agent actually sent its latest message with — which reflects /fast toggles
// and /model switches that static settings.json inspection would miss.
//
// All file I/O is cached per-agent with a 60s TTL to keep this cheap.

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
// Project slugs for agents living under C:\ClaudeProjects\ClaudeAgents\<name>
// get flattened to this prefix + agent name. See
// ~/.claude/projects/C--ClaudeProjects-ClaudeAgents-Claude-Agent-01.
const SLUG_PREFIX = 'C--ClaudeProjects-ClaudeAgents-';

const CACHE_TTL_MS = 60_000;
// Enough to catch the most recent assistant message even after a long
// tool-result response; jsonl lines rarely exceed a few KB each.
const TAIL_BYTES = 40_000;
const MODEL_RE = /"model":"([^"]+)"/g;

const cache = new Map();

function findLatestJsonl(dir) {
  let latest = null;
  let latestMtime = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const ent of entries) {
    if (!ent.endsWith('.jsonl')) continue;
    const full = path.join(dir, ent);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs > latestMtime) {
        latestMtime = st.mtimeMs;
        latest = full;
      }
    } catch {}
  }
  return latest ? { file: latest, mtime: latestMtime } : null;
}

function tailModel(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    if (len <= 0) return null;
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    let m;
    let last = null;
    MODEL_RE.lastIndex = 0;
    while ((m = MODEL_RE.exec(text)) !== null) last = m[1];
    return last;
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function getAgentModel(agentName) {
  const now = Date.now();
  const hit = cache.get(agentName);
  if (hit && now - hit.cachedAt < CACHE_TTL_MS) return hit;

  const dir = path.join(PROJECTS_ROOT, SLUG_PREFIX + agentName);
  const latest = findLatestJsonl(dir);
  let entry;
  if (!latest) {
    entry = { agent: agentName, model: null, sessionMtime: null, cachedAt: now };
  } else {
    entry = {
      agent: agentName,
      model: tailModel(latest.file),
      sessionMtime: new Date(latest.mtime).toISOString(),
      cachedAt: now,
    };
  }
  cache.set(agentName, entry);
  return entry;
}

function getAgentModels(agentNames) {
  return agentNames.map((n) => getAgentModel(n));
}

module.exports = { getAgentModel, getAgentModels };
