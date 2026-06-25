// v0id 浏览器 —— renderer（页面逻辑）。只通过 preload 暴露的 window.v0id 与主进程对话。
const addr = document.getElementById('addr');
const go = document.getElementById('go');
const view = document.getElementById('view');
const dot = document.getElementById('dot');
const phaseEl = document.getElementById('phase');
const chainEl = document.getElementById('chain');
const overlay = document.getElementById('overlay');
const logEl = document.getElementById('log');
const logToggle = document.getElementById('logToggle');

let socksReady = false;
const logLines = [];

// ---- 状态行 / 阶段文案 ----
const PHASE_TEXT = {
  starting: '守护进程启动中…',
  'socks-ready': 'SOCKS 已就绪 · 可访问 .v0id',
  'daemon-exited': '守护进程已退出',
  error: '出错',
};

window.v0id.onStatus((patch) => {
  if (patch.phase) {
    // 优先用主进程给的明确文案（如外部 SOCKS 模式的「外部 SOCKS :9050（demo 网络）」）。
    phaseEl.textContent =
      patch.phase === 'error' && patch.error ? patch.error : patch.statusText || PHASE_TEXT[patch.phase] || patch.phase;
    socksReady = patch.phase === 'socks-ready';
    dot.className = patch.phase === 'socks-ready' ? 'ready' : patch.phase === 'error' || patch.phase === 'daemon-exited' ? 'err' : '';
    go.disabled = !socksReady;
  }
  if (patch.error && !patch.phase) {
    phaseEl.textContent = patch.error;
    dot.className = 'err';
  }
  if (patch.chain) {
    const { height, peers, syncing } = patch.chain;
    chainEl.textContent = syncing ? `同步中 · 链高 ${height} · 对等 ${peers}` : `链高 ${height} · 对等 ${peers}`;
  }
  if (patch.logLine) {
    logLines.push(patch.logLine);
    if (logLines.length > 300) logLines.shift();
    logEl.textContent = logLines.join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  }
});

// ---- 导航 ----
async function navigate() {
  const raw = addr.value;
  const r = await window.v0id.navigate(raw);
  if (!r.ok) {
    showOverlay(true, '无法导航', r.error);
    return;
  }
  hideOverlay();
  view.src = r.url; // 设 webview src → Chromium 经具名 partition 的 SOCKS5 代理发起请求
}

go.addEventListener('click', navigate);
addr.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') navigate();
});

// ---- webview 事件：加载中 / 失败 → 友好提示 ----
view.addEventListener('did-start-loading', () => {
  phaseEl.dataset.busy = '1';
});
view.addEventListener('did-stop-loading', () => {
  delete phaseEl.dataset.busy;
});
view.addEventListener('did-fail-load', (e) => {
  // errorCode === -3 是 ABORTED（常见于正常的重定向/取消），不当错误显示。
  if (e.errorCode === -3) return;
  showOverlay(
    true,
    '连不上该 .v0id 服务',
    `未发布 / 取不到描述符 / 守护未就绪 / 链上中继不足。\n(${e.errorCode} ${e.errorDescription || ''})`,
  );
});
// 成功加载到内容就隐藏覆盖层。
view.addEventListener('did-finish-load', () => {
  if (view.src && view.src !== 'about:blank') hideOverlay();
});

// ---- 覆盖层（空态 / 错误）----
function showOverlay(isError, title, body) {
  overlay.classList.remove('hidden');
  overlay.classList.toggle('error', !!isError);
  overlay.querySelector('h1').textContent = isError ? title : '.v0id';
  const ps = overlay.querySelectorAll('p');
  if (isError && ps[0]) {
    ps[0].textContent = body || '';
    if (ps[1]) ps[1].style.display = 'none';
    if (ps[2]) ps[2].style.display = 'none';
  }
}
function hideOverlay() {
  overlay.classList.add('hidden');
}

// ---- 日志折叠 ----
logToggle.addEventListener('click', () => {
  logEl.classList.toggle('show');
});

addr.focus();
