import http from 'node:http';
import { readFile, mkdir, writeFile, rename, realpath, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const stateDirectory = path.join(root, '.local');
const stateFile = path.join(stateDirectory, 'server.json');
const publicFiles = new Map([
  ['/index.html', 'text/html; charset=utf-8'],
  ['/style.css', 'text/css; charset=utf-8'],
  ['/app.js', 'text/javascript; charset=utf-8'],
  ['/storage.js', 'text/javascript; charset=utf-8'],
  ['/pricing.js', 'text/javascript; charset=utf-8'],
  ['/icon.svg', 'image/svg+xml'],
  ['/manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
]);
const portIndex = process.argv.indexOf('--port');
const preferredPort = portIndex === -1 ? 23168 : Number(process.argv[portIndex + 1]);
if (!Number.isInteger(preferredPort) || preferredPort < 1024 || preferredPort > 65515) {
  console.error('启动端口无效，请使用 1024 到 65515 之间的整数。');
  process.exit(1);
}

function respond(request, response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

const server = http.createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD');
    respond(request, response, 405, '仅支持 GET 和 HEAD 请求。');
    return;
  }

  let pathname;
  try {
    // Inspect the unnormalised request target so dot segments cannot hide traversal.
    pathname = decodeURIComponent((request.url || '').split('?')[0]);
  } catch {
    respond(request, response, 400, '网址格式不正确。');
    return;
  }
  if (!pathname.startsWith('/') || pathname.includes('\\') || /[\u0000-\u001f\u007f]/u.test(pathname) || pathname.split('/').some(segment => segment === '.' || segment === '..')) {
    respond(request, response, 400, '网址格式不正确。');
    return;
  }
  if (pathname === '/health') {
    respond(request, response, 200, JSON.stringify({ app: 'erjie-wholesale', version: '1.0.0' }), 'application/json; charset=utf-8');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const contentType = publicFiles.get(pathname);
  if (!contentType) {
    respond(request, response, 404, '没有找到这个页面。');
    return;
  }
  try {
    const filePath = path.join(root, pathname.slice(1));
    // Do not follow a public filename if it was replaced with an external symlink.
    const resolvedPath = await realpath(filePath);
    if (path.dirname(resolvedPath).toLowerCase() !== path.resolve(root).toLowerCase()) {
      respond(request, response, 404, '没有找到这个页面。');
      return;
    }
    const content = await readFile(resolvedPath);
    respond(request, response, 200, content, contentType);
  } catch (error) {
    respond(request, response, error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? '没有找到这个页面。' : '读取页面失败，请重新启动小算盘。');
  }
});

function listen(port) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

let activePort;
for (let offset = 0; offset <= 20; offset += 1) {
  try {
    await listen(preferredPort + offset);
    activePort = preferredPort + offset;
    break;
  } catch (error) {
    if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
  }
}
if (!activePort) {
  console.error(`无法启动：${preferredPort} 到 ${preferredPort + 20} 端口均不可用。请关闭重复运行的软件后重试。`);
  process.exit(1);
}

const url = `http://127.0.0.1:${activePort}/`;
try {
  await mkdir(stateDirectory, { recursive: true });
  const temporaryState = path.join(stateDirectory, `server-${process.pid}.tmp`);
  await writeFile(temporaryState, JSON.stringify({ pid: process.pid, port: activePort, url }, null, 2), 'utf8');
  await rename(temporaryState, stateFile);
} catch (error) {
  console.error(`无法保存启动状态：${error.message}`);
  server.close();
  process.exit(1);
}
console.log(url);

async function shutDown() {
  try {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (state.pid === process.pid) await unlink(stateFile);
  } catch { /* The launcher can recover from an absent or stale state file. */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.once('SIGINT', shutDown);
process.once('SIGTERM', shutDown);
