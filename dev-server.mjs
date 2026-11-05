import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from './api/relatorios.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(root, '.env.local');

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const item = line.trim();
    if (!item || item.startsWith('#') || !item.includes('=')) continue;
    const position = item.indexOf('=');
    const key = item.slice(0, position).trim();
    if (!process.env[key]) process.env[key] = item.slice(position + 1).trim();
  }
}

const contentTypes = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/relatorios') {
    const reqLike = { method: req.method, query: Object.fromEntries(url.searchParams) };
    const resLike = {
      code: 200, headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      status(code) { this.code = code; return this; },
      json(body) { res.writeHead(this.code, { 'Content-Type': 'application/json; charset=utf-8', ...this.headers }); res.end(JSON.stringify(body)); }
    };
    return handler(reqLike, resLike);
  }

  const target = path.normalize(path.join(root, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!target.startsWith(root) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
  res.writeHead(200, { 'Content-Type': contentTypes[path.extname(target).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
});

const port = Number(process.env.PORT || 4173);
server.listen(port, '127.0.0.1', () => console.log(`Farol local: http://127.0.0.1:${port}`));
