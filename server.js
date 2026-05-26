/**
 * NestFlow — Nesting Server v4.1
 * HTTP server only — spawns worker.js as a child process per job.
 * The worker does all the geometry and exits when done, freeing all memory.
 * This prevents any memory accumulation in the main process.
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, engine: 'BL-fit worker v4.1', version: '4.1.0' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/nest') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const nParts = (() => { try { return JSON.parse(body).parts?.length || 0; } catch(e) { return 0; } })();
      console.log(`  Nesting ${nParts} parts — spawning worker`);

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
        'X-Accel-Buffering': 'no',
      });

      // Spawn worker as a child process
      const worker = spawn(process.execPath, [path.join(__dirname, 'worker.js')], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Stream worker stdout directly to response
      worker.stdout.on('data', chunk => {
        try { res.write(chunk); } catch(e) {}
      });

      // Log worker stderr
      worker.stderr.on('data', chunk => {
        console.error('  Worker:', chunk.toString().trim());
      });

      // End response when worker exits
      worker.on('close', (code) => {
        console.log(`  Worker exited (code ${code})`);
        try { res.end(); } catch(e) {}
      });

      worker.on('error', (err) => {
        console.error('  Worker spawn error:', err.message);
        try {
          res.write(JSON.stringify({ type: 'error', error: err.message }) + '\n');
          res.end();
        } catch(e) {}
      });

      // Send payload to worker via stdin
      worker.stdin.write(body);
      worker.stdin.end();
    });
    return;
  }

  if (req.method === 'GET' && ['/', '/index.html', '/nestflow.html'].includes(req.url)) {
    const htmlPath = path.join(__dirname, 'nestflow.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath, 'utf8'));
    } else {
      res.writeHead(404); res.end('nestflow.html not found');
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  +==========================================+');
  console.log('  |  NestFlow Nesting Server  v4.1          |');
  console.log(`  |  Listening on http://localhost:${PORT}      |`);
  console.log('  |  Engine: child process worker            |');
  console.log('  +==========================================+');
  console.log('');
});
