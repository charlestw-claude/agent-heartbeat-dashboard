const { WebSocketServer } = require('ws');
const { onSample, getLastSample } = require('./collector');

// Minimal WebSocket hub: clients connect to /ws/metrics and receive every
// 1-second sample as `{ type: 'sample', data: <sample> }`. On connect we
// send the last cached sample so the UI paints immediately.

function attach(server) {
  const wss = new WebSocketServer({ server, path: '/ws/metrics' });

  wss.on('connection', (ws) => {
    const last = getLastSample();
    if (last) {
      try { ws.send(JSON.stringify({ type: 'sample', data: last })); } catch {}
    }
  });

  onSample((sample) => {
    const payload = JSON.stringify({ type: 'sample', data: sample });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        try { client.send(payload); } catch {}
      }
    }
  });

  console.log('[ws] /ws/metrics hub attached');
  return wss;
}

module.exports = { attach };
