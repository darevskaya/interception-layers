import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const PORT = 3000;
export const LOCAL_ORIGIN = `http://localhost:${PORT}`;
export const FAKE_ORIGIN = 'http://app.invalid';

const PAGE_HTML = `<!doctype html>
<html>
  <head><title>Local app</title></head>
  <body>
    <h1>Hello from the local app</h1>
    <p id="origin"></p>
    <button id="checkout">Checkout</button>
    <script>
      document.getElementById('origin').textContent = location.origin;
      document.getElementById('checkout').addEventListener('click', () => {
        fetch('/api/checkout', { method: 'POST' }).catch(() => {});
      });
    </script>
  </body>
</html>`;

function handler(req, res) {
  const url = new URL(req.url, LOCAL_ORIGIN);

  if (url.pathname === '/api/checkout') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'payment provider unavailable' }));
    return;
  }

  if (url.pathname === '/api/products') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ id: 1, name: 'Notebook' }]));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE_HTML);
}

export function startServer(port = PORT) {
  const server = http.createServer(handler);

  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

export function stopServer(server) {
  return new Promise(resolve => server.close(resolve));
}

// Allow running the server on its own: `node server/app.js`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
  console.log(`app server listening on ${LOCAL_ORIGIN}`);
}
