'use strict';
/*
 * Tiny local HTTP receiver. Binds to 127.0.0.1 only.
 *   POST /event   body: one slimmed hook event (JSON). Requires header X-Agent-Cody: 1
 *   POST /control body: {"preview_theme":"light"|"dark"|null}  (used by the simulator's showcase)
 *   GET  /health  -> {"ok":true,"app":"agent-cody"}
 *
 * The custom header blocks drive-by requests from web pages: browsers can't send
 * it cross-origin without a CORS preflight, which this server never approves.
 */
const http = require('http');

const MAX_BODY = 256 * 1024;

function startServer({ port, onEvent, onControl = () => {}, host = '127.0.0.1' }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reply = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true, app: 'agent-cody' });
      const route = req.url === '/event' ? onEvent : req.url === '/control' ? onControl : null;
      if (req.method !== 'POST' || !route) return reply(404, { ok: false });
      if (req.headers['x-agent-cody'] !== '1') return reply(403, { ok: false });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return reply(415, { ok: false });

      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reply(413, { ok: false }); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (size > MAX_BODY) return;
        let evt;
        try { evt = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return reply(400, { ok: false }); }
        reply(200, { ok: true }); // answer first, so the hook can exit immediately
        try { route(evt); } catch (err) { console.error('[agent-cody] request handling failed:', err); }
      });
      req.on('error', () => {});
    });
    server.keepAliveTimeout = 1000;
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      server.on('error', (err) => console.error('[agent-cody] server error:', err));
      resolve(server);
    });
  });
}

module.exports = { startServer };
