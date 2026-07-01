// 内置零后端静态托管：给「托管站点」提供「选个文件夹就能发布」的路径，免去用户自己起一个 HTTP 服务器再填 host:port。
// 与洋葱/rendezvous 完全解耦——就是个只读静态文件服务器；serveHiddenService（hsbridge.ts）本就后端无关，
// 只需把这里吐出的本地端口当 target 传给它，「静态文件夹」就变成了一个正常的隐藏服务后端。
import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

export interface StaticServeOptions {
  dir: string; // 要发布的本地文件夹（绝对路径）
  host?: string; // 默认 127.0.0.1：只本机监听，靠隐藏服务转发对外，从不直接暴露
}

/**
 * 起一个只读静态文件服务器：`/` 兜底 `index.html`，按扩展名给 content-type，拒绝任何逃出 dir 的路径。
 * 绑定随机端口（0），供 RoleManager.startHs 把它当 target 用。
 */
export function serveStaticDir(opts: StaticServeOptions): Promise<{ port: number; stop: () => void }> {
  const root = normalize(opts.dir);
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const rel = rawPath === '/' ? '/index.html' : rawPath;
        const resolved = normalize(join(root, rel));
        // 路径遍历防护：resolved 必须仍在 root 之下（含 root 本身），否则 ../../etc/passwd 这类请求会被拒绝。
        if (resolved !== root && !resolved.startsWith(root + sep)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden');
          return;
        }
        const st = await stat(resolved).catch(() => null);
        if (!st || !st.isFile()) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
          return;
        }
        const body = await readFile(resolved);
        const type = MIME[extname(resolved).toLowerCase()] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type });
        res.end(body);
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('internal error');
      }
    })();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, opts.host ?? '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, stop: () => server.close() });
    });
  });
}
