// v0id 浏览器 —— Electron 主进程。
//
// 职责（GUI 不重新实现洋葱/rendezvous，那些守护进程已经做好且测过）：
//   1) 拉起 v0idchain 守护进程子进程：`v0id start --socks …`，它同时跑节点 + 本地 SOCKS5 代理。
//      该 SOCKS5 既能出 clearnet（host:port），也能把 .v0id 地址经 rendezvous 连到隐藏服务。
//   2) 把内嵌的 <webview> 的 session 代理指到守护的 SOCKS5（socks5://127.0.0.1:<port>），
//      让浏览器的每一次请求都走洋葱网络。
//   3) 提供地址栏（renderer），输入 xxxxx.v0id → 经 IPC → webview 加载 http://xxxxx.v0id/。
//
// 关键细节（.v0id 远程 DNS）：.v0id 不是真实 TLD，本机 DNS 解析不了它。必须让 Chromium
//   把主机名原样交给 SOCKS 代理去解析（远程 DNS），而不是自己先解析。Chromium 对
//   proxyRules 里写成 'socks5://…' 的代理就是做远程 DNS 的（等价于 curl 的 --socks5-hostname），
//   所以这里统一用 'socks5://'。守护进程的 SOCKS5 收到 ATYP=domain 的 .v0id 主机名后走 rendezvous。
//   （详见 README 的“远程 DNS”一节。）

const { app, BrowserWindow, ipcMain, session } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { isIP } = net;
const path = require('node:path');
const fs = require('node:fs');
const { DEFAULT_PEERS } = require('./seeds');

// ---- 配置 ----
// repoRoot：本文件在 <repo>/clients/desktop/src/main.js → 上溯三级到仓库根。
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const cliEntry = path.join(repoRoot, 'packages', 'cli', 'src', 'index.ts');
// 外部 SOCKS 模式：设了 V0ID_SOCKS_EXTERNAL=<port> 就不拉守护进程，
// 而是把 127.0.0.1:<port> 当成「已经在跑的 SOCKS5 代理」直接用（例如 demo-network.mjs 起的 :9050）。
// 用途：手动验证浏览器时把它指到本地 demo 网络的 SOCKS，无需起真链。不设则保持原来「自起守护」的行为。
const SOCKS_EXTERNAL = process.env.V0ID_SOCKS_EXTERNAL ? parsePortEnv('V0ID_SOCKS_EXTERNAL', process.env.V0ID_SOCKS_EXTERNAL) : null;
// SOCKS 端口：外部模式用 V0ID_SOCKS_EXTERNAL；否则用 V0ID_SOCKS_PORT（默认 9050），即守护进程要监听的端口。
const SOCKS_PORT = SOCKS_EXTERNAL ?? parsePortEnv('V0ID_SOCKS_PORT', process.env.V0ID_SOCKS_PORT || '9050');
// 守护进程要连的种子：显式 V0ID_PEERS 优先；否则用出厂默认（seeds.js），让应用开箱即用而非本地孤岛。
// 注意：外部 SOCKS 模式不起守护，PEERS 不参与（demo 网络自带中继）。
const PEERS = (process.env.V0ID_PEERS || '').trim() || DEFAULT_PEERS.join(',');
// 本地 HTTP API 端口（守护进程 CLI start 的 --api-port 默认 7001）。/info 等只读状态从这里取。
const API_PORT = parsePortEnv('V0ID_API_PORT', process.env.V0ID_API_PORT || '7001');
// 开发时若设了 V0ID_RENDERER_DEV_URL（Vite dev server，如 http://localhost:5173），主窗口加载它（热更新）；
// 否则加载 Vite 构建产物 src/renderer/dist/index.html（生产/打包路径）。
const RENDERER_DEV_URL = process.env.V0ID_RENDERER_DEV_URL || '';
// webview 用一个具名 partition，这样它的 session 是我们能单独设代理的那一个。
// 关键（隐私）：不加 'persist:' 前缀 → 内存型 session。匿名浏览器**默认不把** cookie / 缓存 /
// localStorage / IndexedDB / 已访问链接 DB 写盘——它们随进程退出蒸发，不在磁盘留下浏览痕迹。
// （唯一持久化到磁盘的是用户主动收藏的书签，见 bookmarks.json。）renderer 的 <webview> partition
// 必须与此完全一致（'v0id'，无 persist 前缀），否则代理/权限加固落不到它那个 session 上。
const PARTITION = 'v0id';
const PROXY_RULES = `socks5://127.0.0.1:${SOCKS_PORT}`;

function parsePortEnv(name, value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} 必须是 1–65535 的整数端口（当前：${value}）`);
  }
  return port;
}

// Force Chromium WebRTC traffic through the configured proxy. Without this policy,
// arbitrary hidden-service pages could use ICE/STUN over non-proxied UDP and leak
// local/public IP addresses outside the v0id SOCKS path. This must be set before
// any BrowserWindow/webContents is created.
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');

// 不可信的 .v0id 页面（在 <webview> 里）若调用 window.open / target=_blank，会试图开一个新顶层窗口，
// 那个新窗口不在我们加固的 partition/权限/WebRTC 策略下 → 可能逃逸代理直连、泄露 IP。一律拒绝弹窗。
// 同时对 webview 的 webContents 兜底设一次代理 + deny-all 权限（partition session 已设过，这里是防御纵深）。
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // 阻止 webview 把自己导航到我们窗口之外，或被诱导加载非预期协议（file: 等）。
    // 同时复用地址栏/书签的 host 校验，避免不可信 .v0id 页面通过链接/表单/重定向
    // 导航主 frame 到 127.0.0.1、私网 IP 等本机/内网资源，绕过 normalizeTarget 的 SSRF 防护。
    contents.on('will-navigate', (ev, navUrl) => {
      if (!isAllowedWebviewNavigation(navUrl)) ev.preventDefault();
    });
  }
});

let daemon = null; // 守护子进程句柄
let win = null;
let socksReady = false;

// ---- 把一行状态推给 renderer（地址栏下方的状态行）----
function pushStatus(patch) {
  if (win && !win.isDestroyed()) win.webContents.send('v0id:status', patch);
}

// ---- 拉起守护进程 ----
// 守护进程跑的是同一条 `v0id start --socks …`（节点 + 本地 SOCKS5），只是「怎么拉起」分两种模式：
//
//   • 开发（未打包，app.isPackaged=false）：`corepack pnpm exec tsx <repo>/packages/cli/src/index.ts …`，
//     用仓库工具链直接跑 TS 源（需仓库 + pnpm + tsx 在场）。cwd=repoRoot 让依赖按仓库解析。
//
//   • 打包后（app.isPackaged=true）：.app 里没有仓库/pnpm/tsx。改用 esbuild 预打好的单文件 CJS
//     （resources/daemon/v0id-daemon.cjs，随 extraResources 进 Contents/Resources/daemon/），
//     并用 Electron 自带的二进制当 Node 跑它：spawn(process.execPath, [cjs, …], { ELECTRON_RUN_AS_NODE:'1' })。
//     ELECTRON_RUN_AS_NODE 让 Electron 退化成纯 Node（不开窗、不加载 Chromium），即「内嵌 Node」。
//     —— 这样打包应用零外部依赖即可自起守护进程。node-datachannel（--webrtc 才用的原生模块）
//        已被 externalize 出 bundle，--socks 路径根本不 require 它，故无需随包附带任何 .node。
function spawnDaemon() {
  const dataDir = path.join(app.getPath('userData'), 'v0id');
  // `start …` 之后的参数两种模式完全一致；区别只在前面用什么把它跑起来。
  const startArgs = [
    'start',
    '--name', 'browser',
    '--data-dir', dataDir,
    '--socks',
    '--socks-port', String(SOCKS_PORT),
    '--api-port', String(API_PORT),
  ];
  if (PEERS.trim()) {
    // PEERS 现在默认就是 seeds.js 的出厂种子（除非 V0ID_PEERS 覆盖），所以这里几乎总会带上 --peers。
    startArgs.push('--peers', PEERS.trim());
  }

  pushStatus({ phase: 'starting', socksPort: SOCKS_PORT, dataDir });

  let cmd, args, opts;
  if (app.isPackaged) {
    // 打包：用 Electron-as-Node 跑 bundle 出来的守护进程 CJS。
    const daemonCjs = path.join(process.resourcesPath, 'daemon', 'v0id-daemon.cjs');
    cmd = process.execPath;
    args = [daemonCjs, ...startArgs];
    opts = {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    log(`spawn(packaged): ELECTRON_RUN_AS_NODE=1 ${cmd} ${args.join(' ')}`);
  } else {
    // 开发：corepack pnpm exec tsx <cliEntry> start …（cwd=repoRoot 让 corepack/tsx 按仓库解析依赖）。
    cmd = 'corepack';
    args = ['pnpm', 'exec', 'tsx', cliEntry, ...startArgs];
    opts = {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    log(`spawn(dev): corepack ${args.join(' ')}  (cwd=${repoRoot})`);
  }

  daemon = spawn(cmd, args, opts);

  daemon.stdout.on('data', (b) => onDaemonLine(b.toString()));
  daemon.stderr.on('data', (b) => onDaemonLine(b.toString(), true));
  daemon.on('exit', (code, sig) => {
    log(`daemon exited code=${code} sig=${sig}`);
    daemon = null;
    if (!app.isQuiting) pushStatus({ phase: 'daemon-exited', code, signal: sig });
  });
  daemon.on('error', (err) => {
    log(`daemon spawn error: ${err.message}`);
    pushStatus({ phase: 'error', error: `守护进程启动失败：${err.message}` });
  });
}

// 守护进程每一行日志：转发到 app 日志 + renderer（折叠在状态区，方便排错）。
function onDaemonLine(chunk, isErr = false) {
  for (const line of chunk.split('\n')) {
    const t = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd(); // 去掉 ANSI 颜色
    if (!t.trim()) continue;
    log((isErr ? '[daemon!] ' : '[daemon] ') + t);
    pushStatus({ logLine: t });
  }
}

// ---- 轮询 TCP 连通性等 SOCKS 就绪（比解析 stdout 的 "SOCKS …" 行更稳）----
// 每 250ms 尝试 connect 127.0.0.1:<port>，连上即认为 SOCKS server 在监听；上限约 30s。
function waitSocksReady(port, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        sock.destroy();
        resolve();
      });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`SOCKS 端口 ${port} 在 ${timeoutMs}ms 内未就绪`));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

// ---- 默认拒绝浏览会话的权限请求/检查 ----
function denyAllPermissions(wvSession) {
  // Hidden-service pages are arbitrary remote content. Electron defaults can grant
  // requested capabilities unless handlers are installed, so deny every runtime
  // permission and permission check by default. Add explicit allow-list entries
  // here only if the browser intentionally supports a capability later.
  wvSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  wvSession.setPermissionCheckHandler(() => false);
}

// ---- 创建浏览器窗口 + 把 webview 的 session 代理指到守护 SOCKS5 ----
async function createWindow() {
  // 给 webview 的具名 partition 的 session 设代理（这是真正承载浏览页面的 session）。
  // 用 socks5:// → Chromium 远程 DNS，把 .v0id 主机名交给代理解析。
  const wvSession = session.fromPartition(PARTITION);
  denyAllPermissions(wvSession);
  await wvSession.setProxy({ proxyRules: PROXY_RULES });

  win = new BrowserWindow({
    width: 1100,
    height: 760,
    backgroundColor: '#0a0a0f',
    title: 'v0id 浏览器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // 启用 <webview>
    },
  });

  // 主窗口自身也走同一个代理并拒绝权限（保险：万一未来主窗口直接发请求/嵌入内容）。
  denyAllPermissions(win.webContents.session);
  await win.webContents.session.setProxy({ proxyRules: PROXY_RULES });

  // 渲染层 = React + Vite。dev：加载 Vite dev server（V0ID_RENDERER_DEV_URL，热更新）；
  // prod：加载 Vite 构建产物 src/renderer/dist/index.html。两者都是「窗口自身的受信页面」
  //（contextIsolation + 无 Node），不可信的 .v0id 页面只在其中的 <webview partition="v0id"> 里。
  const builtIndex = path.join(__dirname, 'renderer', 'dist', 'index.html');
  if (RENDERER_DEV_URL) {
    log(`loading renderer from dev server: ${RENDERER_DEV_URL}`);
    win.loadURL(RENDERER_DEV_URL);
  } else if (fs.existsSync(builtIndex)) {
    win.loadFile(builtIndex);
  } else {
    // 没构建过 dist：给出明确指引而不是白屏（无 GUI 环境/忘了 build 时最常见）。
    log(`renderer dist 未找到：${builtIndex} —— 请先在 clients/desktop 跑 \`pnpm build\``);
    win.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<body style="background:#0a0a0f;color:#d7d7e0;font-family:monospace;padding:40px;line-height:1.7">' +
            '<h2 style="color:#7c5cff">v0id 浏览器 · 渲染层未构建</h2>' +
            '<p>请先构建 React 渲染层：</p>' +
            '<pre style="background:#12121a;padding:12px;border:1px solid #23232f">cd clients/desktop\npnpm install --ignore-workspace\npnpm build</pre>' +
            '<p>或开发模式（热更新）：另开终端 <code>pnpm dev</code>，再 <code>V0ID_RENDERER_DEV_URL=http://localhost:5173 pnpm start</code>。</p>' +
            '</body>',
        ),
    );
  }
  win.webContents.on('did-finish-load', () => {
    // 渲染就绪后补一次当前状态（防止 renderer 错过早期事件）。
    pushStatus({ phase: socksReady ? 'socks-ready' : 'starting', socksPort: SOCKS_PORT, partition: PARTITION });
  });
}

// ---- 定时取链状态（链高 / 对等 / 同步中），推给 renderer 状态行 ----
// 守护的本地 HTTP API 默认 127.0.0.1:7001（CLI start 的默认 --api-port）。便宜地拉 /info。
function startChainPoll() {
  const tick = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/info`);
      if (res.ok) {
        const i = await res.json();
        pushStatus({ chain: { height: i.height, peers: i.peers, syncing: i.syncing } });
      }
    } catch {
      // 节点 API 还没起/抖动，忽略，下一轮再试。
    }
  };
  tick();
  const timer = setInterval(tick, 5000);
  app.on('before-quit', () => clearInterval(timer));
}

// ---- 节点控制 API（renderer 经 preload→这里；令牌只在主进程，绝不下发渲染层）----
// 令牌路径：守护进程的数据目录 = userData/v0id（见 spawnDaemon），CLI 在那里生成 api.token（0600）。
// 每次现读（守护进程刚起时文件可能还没落盘 → 读不到时 POST 返回明确错误，由 UI 提示稍候重试）。
function apiTokenPath() {
  return path.join(app.getPath('userData'), 'v0id', 'api.token');
}
function readApiToken() {
  try {
    return fs.readFileSync(apiTokenPath(), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// 统一的本机节点 API 调用：GET 不带令牌；POST 带 Authorization: Bearer。
// 返回 { ok:true, data } 或 { ok:false, error }——渲染层据此渲染，永不接触令牌或裸 Response。
// 外部 SOCKS 模式（无守护/无链 API）：直接回 { ok:false, error } 而非抛错，让角色/钱包板块优雅降级。
async function nodeApi(method, pathname, body) {
  if (SOCKS_EXTERNAL != null) {
    return { ok: false, error: '当前为外部 SOCKS 验证模式，无本机节点 API（角色/钱包控制不可用）' };
  }
  const headers = { 'content-type': 'application/json' };
  if (method === 'POST') {
    const token = readApiToken();
    if (!token) return { ok: false, error: '节点令牌尚未就绪（守护进程刚启动？请稍候重试）' };
    headers['authorization'] = `Bearer ${token}`;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${API_PORT}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `${method} ${pathname} → ${res.status}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `连接本机节点失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---- 只读（GET，无需令牌）----
ipcMain.handle('v0id:api:roles', () => nodeApi('GET', '/roles'));
ipcMain.handle('v0id:api:stakeStatus', () => nodeApi('GET', '/stake'));
ipcMain.handle('v0id:api:txStatus', (_e, txid) => nodeApi('GET', `/tx?txid=${encodeURIComponent(String(txid ?? ''))}`));
// 钱包信息：合并 /info 的 address+symbol 与 /balance 的余额（/info 已含 balance，但分开取更直观且 /balance 更轻）。
ipcMain.handle('v0id:api:walletInfo', async () => {
  const info = await nodeApi('GET', '/info');
  if (!info.ok) return info;
  const d = info.data || {};
  return { ok: true, data: { address: d.address, balance: d.balance, symbol: d.symbol, minFee: d.minFee } };
});

// ---- 写（POST，主进程带 Bearer）----
ipcMain.handle('v0id:api:relayStart', () => nodeApi('POST', '/relay/start'));
ipcMain.handle('v0id:api:relayStop', () => nodeApi('POST', '/relay/stop'));
ipcMain.handle('v0id:api:hsStart', (_e, { host, port } = {}) => nodeApi('POST', '/hs/start', { host, port: Number(port) }));
ipcMain.handle('v0id:api:hsStop', () => nodeApi('POST', '/hs/stop'));
ipcMain.handle('v0id:api:mineStart', (_e, intervalMs) => nodeApi('POST', '/mine/start', { intervalMs: Number(intervalMs) || 0 }));
ipcMain.handle('v0id:api:mineStop', () => nodeApi('POST', '/mine/stop'));
ipcMain.handle('v0id:api:stake', (_e, role) => nodeApi('POST', '/stake', { role: String(role ?? '') }));
ipcMain.handle('v0id:api:unstake', (_e, stakeId) => nodeApi('POST', '/unstake', { stakeId: String(stakeId ?? '') }));
ipcMain.handle('v0id:api:send', (_e, { to, amount, memo } = {}) =>
  nodeApi('POST', '/send', { to: String(to ?? ''), amount: Number(amount), memo: String(memo ?? '') }),
);

// ---- IPC：renderer 请求导航 ----
// 校验：以 .v0id 结尾的主机名（可带路径），或 http/https URL。返回规整后的 URL，由 renderer 设 webview.src。
ipcMain.handle('v0id:navigate', (_e, raw) => {
  const url = normalizeTarget(raw);
  if (!url) return { ok: false, error: '地址无效：请输入 xxxxx.v0id 或 http(s):// 链接' };
  if (!socksReady) return { ok: false, error: '守护进程/SOCKS 还没就绪，请稍候…' };
  return { ok: true, url };
});

// 纯校验（不看 socksReady）：React 多标签 UI 在设 webview.src 前先规整/校验地址用。
// 与 v0id:navigate 共用同一套 normalizeTarget，行为一致。
ipcMain.handle('v0id:validate', (_e, raw) => {
  const url = normalizeTarget(raw);
  if (!url) return { ok: false, error: '地址无效：请输入 xxxxx.v0id 或 http(s):// 链接' };
  return { ok: true, url };
});

// 只读取链/节点状态（占位板块的链高·对等等）。外部 SOCKS 模式无链 API → 返回 null（UI 显示「不可用」）。
ipcMain.handle('v0id:info', async () => {
  if (SOCKS_EXTERNAL != null) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/info`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
});

// ---- 书签：持久化为 userData/bookmarks.json（文件 I/O 在主进程，经 preload 暴露给 renderer）----
ipcMain.handle('v0id:bookmarks:list', () => readBookmarks());
ipcMain.handle('v0id:bookmarks:add', (_e, entry) => {
  const url = normalizeTarget(entry && entry.url);
  if (!url) return { ok: false, error: '地址无效，未加入书签' };
  const list = readBookmarks();
  if (list.some((b) => b.url === url)) return { ok: true, list }; // 已存在则幂等返回
  const title = typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim().slice(0, 200) : url;
  list.push({ url, title, addedAt: Date.now() });
  writeBookmarks(list);
  return { ok: true, list };
});
ipcMain.handle('v0id:bookmarks:remove', (_e, url) => {
  const list = readBookmarks().filter((b) => b.url !== url);
  writeBookmarks(list);
  return { ok: true, list };
});

// 把用户输入规整成可加载的 URL：
//   - 已带 http://｜https:// → 原样（但 host 必须是 .v0id 或普通域名/IP）
//   - 裸 host（含 .v0id 或普通域名）→ 补 http://
//   - 仅允许 host 看起来像 .v0id 结尾，或含点的普通域名/IP（避免把乱输入当地址）
function isAllowedWebviewNavigation(navUrl) {
  if (navUrl === 'about:blank') return true;
  return Boolean(normalizeTarget(navUrl));
}

function normalizeTarget(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const isV0id = host.endsWith('.v0id');
  // 安全：不可信的 .v0id 页面可能链到 http://127.0.0.1:7001/ 之类去打本机守护 API（SSRF/去匿名）。
  // 故对**非 .v0id** 的目标拒绝环回 / 私网 / 链路本地字面量。.v0id 地址永不命中（它们以 .v0id 结尾）。
  if (!isV0id && isLoopbackOrPrivateHost(host)) return null;
  const isClearnet = host.includes('.'); // 普通域名 / 公网 IP（localhost 已被上面拦掉）
  if (!isV0id && !isClearnet) return null;
  return u.toString();
}

// 判断主机是否为环回 / 私网 / 链路本地（仅 IP 字面量与 localhost；普通域名的 DNS rebinding 超出此处范围）。
function isLoopbackOrPrivateHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host; // 去掉 IPv6 方括号
  const ipv4 = normalizedIPv4(h);
  if (ipv4) return isPrivateIPv4(ipv4);
  if (isIP(h) !== 6) return false;
  const lower = h.toLowerCase();
  if (lower === '::' || lower === '::1') return true; // unspecified / loopback
  if (lower.startsWith('fe80:')) return true; // link-local
  const first = Number.parseInt(lower.split(':', 1)[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  const mapped = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return mapped ? isPrivateIPv4(mapped[1]) : false;
}

function normalizedIPv4(host) {
  if (isIP(host) !== 4) return null;
  const parts = host.split('.').map(Number);
  return parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts.join('.') : null;
}

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 127 || a === 0) return true; // loopback / this-network
  if (a === 10) return true; // 10/8
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

// ---- 干净杀掉守护子进程：先 SIGTERM，2s 内没退再 SIGKILL ----
function killDaemon() {
  if (!daemon) return;
  const child = daemon;
  daemon = null;
  try {
    child.kill('SIGTERM');
  } catch {
    /* 已经没了 */
  }
  const t = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已经没了 */
    }
  }, 2000);
  child.on('exit', () => clearTimeout(t));
}

// ---- 书签持久化（userData/bookmarks.json）----
// 结构：[{ url, title, addedAt }]。读失败/损坏一律当空列表（不让坏文件阻断 UI）。
function bookmarksPath() {
  return path.join(app.getPath('userData'), 'bookmarks.json');
}
function readBookmarks() {
  try {
    const raw = fs.readFileSync(bookmarksPath(), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function writeBookmarks(list) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(bookmarksPath(), JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    log(`书签写入失败：${e.message}`);
  }
}

// ---- 极简文件日志（写到 userData/browser.log，便于无 GUI 时排查）----
let logStream = null;
function log(line) {
  const msg = `${new Date().toISOString()}  ${line}\n`;
  process.stdout.write(msg);
  try {
    if (!logStream) {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      logStream = fs.createWriteStream(path.join(app.getPath('userData'), 'browser.log'), { flags: 'a' });
    }
    logStream.write(msg);
  } catch {
    /* 日志失败不致命 */
  }
}

// ---- 生命周期 ----
app.whenReady().then(async () => {
  if (SOCKS_EXTERNAL != null) {
    // 外部 SOCKS 模式：不起守护、不轮询链；只把窗口代理指到已有的 SOCKS，并轮询其就绪。
    log(`external SOCKS mode: using 127.0.0.1:${SOCKS_EXTERNAL} (no daemon spawned)`);
    pushStatus({ phase: 'starting', socksPort: SOCKS_EXTERNAL, external: true });
  } else {
    spawnDaemon();
  }
  await createWindow();
  if (SOCKS_EXTERNAL == null) startChainPoll(); // 外部 SOCKS（demo 网络）没有链 API，跳过链状态轮询

  // 等 SOCKS 就绪 → 通知 renderer 可以导航了。（外部模式等的是别人已经起好的代理。）
  waitSocksReady(SOCKS_PORT)
    .then(() => {
      socksReady = true;
      log(`SOCKS ready on 127.0.0.1:${SOCKS_PORT}`);
      pushStatus({
        phase: 'socks-ready',
        socksPort: SOCKS_PORT,
        ...(SOCKS_EXTERNAL != null ? { external: true, statusText: `外部 SOCKS :${SOCKS_PORT}（demo 网络）` } : {}),
      });
    })
    .catch((err) => {
      log(`SOCKS not ready: ${err.message}`);
      pushStatus({ phase: 'error', error: `SOCKS 未就绪：${err.message}` });
    });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// macOS 习惯上关窗不退应用；但本 MVP 是单窗浏览器，关窗即退出并杀守护。
app.on('window-all-closed', () => {
  killDaemon();
  app.quit();
});

app.on('before-quit', () => {
  app.isQuiting = true;
  killDaemon();
});
