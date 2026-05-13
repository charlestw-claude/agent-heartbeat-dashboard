// agents-conf.js — parser for the canonical agents.conf
//
// Mirrors AgentsConf.ps1 (see profiles/vm-agent/config/agents/AgentsConf.ps1).
// Tab-separated rows: name | channel_dir | token_env | color.
// Whole-line comments (# at column 0 optionally preceded by spaces) are
// stripped; inline # is NOT a comment (hex colours must survive).

const fs = require('fs');
const path = require('path');

const DEFAULT_CONF = path.resolve(
  __dirname,
  '..',
  '..',
  'profiles',
  'vm-agent',
  'config',
  'agents',
  'agents.conf'
);

function parseAgentsConf(text) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*#/.test(raw)) continue;
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('\t').map((s) => s.trim());
    rows.push({
      name: parts[0],
      channel_dir: parts[1] || null,
      token_env: parts[2] || null,
      color: parts[3] || null,
    });
  }
  return rows;
}

function readAgentsConf(confPath) {
  const p = confPath || DEFAULT_CONF;
  const text = fs.readFileSync(p, 'utf8');
  return parseAgentsConf(text);
}

module.exports = { readAgentsConf, parseAgentsConf, DEFAULT_CONF };
