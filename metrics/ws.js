const { WebSocketServer } = require('ws');
const { onSample, onAgents, getLastSample, getAgentsBreakdown } = require('./collector');

// Minimal WebSocket hub: clients connect to /ws/metrics and receive:
//   - `{ type: 'sample', data: <vm-sample> }` at 1Hz
//   - `{ type: 'agents', data: <agents-breakdown> }` whenever the active-socket
//     scan or full process scan updates (2s and 5s respectively)
//   - `{ type: 'heartbeats', data: <heartbeats-batch> }` on each POST /api/heartbeat
// On connect we send the last cached value of each so the UI paints immediately.

let sendMessage = () => {};

function attach(server) {
  const wss = new WebSocketServer({ server, path: '/ws/metrics' });

  wss.on('connection', (ws) => {
    const last = getLastSample();
    if (last) {
      try { ws.send(JSON.stringify({ type: 'sample', data: last })); } catch {}
    }
    const agents = getAgentsBreakdown();
    if (agents && Array.isArray(agents.agents)) {
      try { ws.send(JSON.stringify({ type: 'agents', data: agents })); } catch {}
    }
  });

  const broadcast = (payload) => {
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        try { client.send(payload); } catch {}
      }
    }
  };

  sendMessage = (msg) => broadcast(JSON.stringify(msg));

  onSample((sample) => {
    broadcast(JSON.stringify({ type: 'sample', data: sample }));
  });

  onAgents((agents) => {
    broadcast(JSON.stringify({ type: 'agents', data: agents }));
  });

  console.log('[ws] /ws/metrics hub attached');
  return wss;
}

function send(msg) { sendMessage(msg); }

module.exports = { attach, send };
