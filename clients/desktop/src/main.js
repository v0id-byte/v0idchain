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
const path = require('node:path');

// ---- 配置 ----
// repoRoot：本文件在 <repo>/clients/desktop/src/main.js → 上溯三级到仓库根。
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const cliEntry = path.join(repoRoot, 'packages', 'cli', 'src', 'index.ts');
// 外部 SOCKS 模式：设了 V0ID_SOCKS_EXTERNAL=<port> 就不拉守护进程，
// 而是把 127.0.0.1:<port> 当成「已经在跑的 SOCKS5 代理」直接用（例如 demo-network.mjs 起的 :9050）。
// 用途：手动验证浏览器时把它指到本地 demo 网络的 SOCKS，无需起真链。不设则保持原来「自起守护」的行为。
const SOCKS_EXTERNAL = process.env.V0ID_SOCKS_EXTERNAL ? Number(process.env.V0ID_SOCKS_EXTERNAL) : null;
// SOCKS 端口：外部模式用 V0ID_SOCKS_EXTERNAL；否则用 V0ID_SOCKS_PORT（默认 9050），即守护进程要监听的端口。
const SOCKS_PORT = SOCKS_EXTERNAL ?? Number(process.env.V0ID_SOCKS_PORT || 9050);
const PEERS = process.env.V0ID_PEERS || ''; // 逗号分隔的种子 ws 地址；为空则纯本地（无网络，.v0id 无法解析）
// webview 用一个具名 partition，这样它的 session 是我们能单独设代理的那一个。
const PARTITION = 'persist:v0id';
const PROXY_RULES = `socks5://127.0.0.1:${SOCKS_PORT}`;

// Force Chromium WebRTC traffic through the configured proxy. Without this policy,
// arbitrary hidden-service pages could use ICE/STUN over non-proxied UDP and leak
// local/public IP addresses outside the v0id SOCKS path. This must be set before
// any BrowserWindow/webContents is created.
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');

let daemon = null; // 守护子进程句柄
let win = null;
let socksReady = false;

// ---- 把一行状态推给 renderer（地址栏下方的状态行）----
function pushStatus(patch) {
  if (win && !win.isDestroyed()) win.webContents.send('v0id:status', patch);
}

// ---- 拉起守护进程：corepack pnpm exec tsx <cliEntry> start --socks … ----
// 用 corepack 跑 tsx（仓库工具链），数据目录放在 Electron 的 userData 下，避免污染仓库。
function spawnDaemon() {
  const dataDir = path.join(app.getPath('userData'), 'v0id');
  const args = [
    'pnpm', 'exec', 'tsx', cliEntry,
    'start',
    '--name', 'browser',
    '--data-dir', dataDir,
    '--socks',
    '--socks-port', String(SOCKS_PORT),
  ];
  if (PEERS.trim()) {
    args.push('--peers', PEERS.trim());
  }

  pushStatus({ phase: 'starting', socksPort: SOCKS_PORT, dataDir });
  log(`spawn: corepack ${args.join(' ')}  (cwd=${repoRoot})`);

  // cwd 设为 repoRoot，让 corepack/tsx 用仓库的 pnpm 与依赖解析。
  daemon = spawn('corepack', args, {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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

  win.loadFile(path.join(__dirname, 'index.html'));
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
      const res = await fetch('http://127.0.0.1:7001/info');
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

// ---- IPC：renderer 请求导航 ----
// 校验：以 .v0id 结尾的主机名（可带路径），或 http/https URL。返回规整后的 URL，由 renderer 设 webview.src。
ipcMain.handle('v0id:navigate', (_e, raw) => {
  const url = normalizeTarget(raw);
  if (!url) return { ok: false, error: '地址无效：请输入 xxxxx.v0id 或 http(s):// 链接' };
  if (!socksReady) return { ok: false, error: '守护进程/SOCKS 还没就绪，请稍候…' };
  return { ok: true, url };
});

// 把用户输入规整成可加载的 URL：
//   - 已带 http://｜https:// → 原样（但 host 必须是 .v0id 或普通域名/IP）
//   - 裸 host（含 .v0id 或普通域名）→ 补 http://
//   - 仅允许 host 看起来像 .v0id 结尾，或含点的普通域名/IP（避免把乱输入当地址）
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
  const isClearnet = host.includes('.') || host === 'localhost'; // 普通域名/IP/localhost
  if (!isV0id && !isClearnet) return null;
  return u.toString();
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

// ---- 极简文件日志（写到 userData/browser.log，便于无 GUI 时排查）----
const fs = require('node:fs');
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
