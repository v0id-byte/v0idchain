// 内置零后端静态托管：给「托管站点」提供「选个文件夹就能发布」的路径，免去用户自己起一个 HTTP 服务器再填 host:port。
// 与洋葱/rendezvous 完全解耦——就是个只读静态文件服务器；serveHiddenService（hsbridge.ts）本就后端无关，
// 只需把这里吐出的本地端口当 target 传给它，「静态文件夹」就变成了一个正常的隐藏服务后端。
import { createServer, type Server } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
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
  // root 自己也可能是个符号链接；只解析一次（server 生命周期内文件夹身份不变），后续每次请求都拿它当基准。
  let rootReal: string | null = null;
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        rootReal ??= await realpath(root);
        const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const rel = rawPath === '/' ? '/index.html' : rawPath;
        const resolved = normalize(join(root, rel));
        // 第一道防线（字面路径）：挡住 ../../etc/passwd 这类明文遍历，不碰文件系统、开销最小。
        if (resolved !== root && !resolved.startsWith(root + sep)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden');
          return;
        }
        // 第二道防线（符号链接逃逸）：第一道只看得到链接本身的路径，看不到它指向哪——文件夹里若有一个
        // 指向 /etc/passwd 之类外部文件的符号链接，resolved 本身在 root 之下、但 stat/readFile 会跟着
        // 链接读到外面去。realpath 把链接一路解到真实文件，再核对真实路径是否仍落在 root 的真实路径下。
        const resolvedReal = await realpath(resolved).catch(() => null);
        if (!resolvedReal || (resolvedReal !== rootReal && !resolvedReal.startsWith(rootReal + sep))) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
          return;
        }
        const st = await stat(resolvedReal).catch(() => null);
        if (!st || !st.isFile()) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
          return;
        }
        const body = await readFile(resolvedReal);
        const type = MIME[extname(resolvedReal).toLowerCase()] ?? 'application/octet-stream';
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
