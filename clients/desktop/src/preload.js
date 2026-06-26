// v0id 浏览器 —— preload（隔离世界）。
// 只经 contextBridge 暴露一个最小 API 给 renderer；contextIsolation: true + nodeIntegration: false，
// renderer 拿不到 Node/Electron 内部，只能用下面这几个方法。
//
// 安全模型：React 渲染层是「窗口自身的受信页面」，所有特权操作（书签文件 I/O、地址校验、
// 取链状态）都经这里的 IPC 转给主进程做；渲染层与 <webview> 都没有 Node。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('v0id', {
  // 请求导航到一个 .v0id 或 http(s) 地址；主进程校验 + 看 SOCKS 是否就绪，回 { ok, url } 或 { ok:false, error }。
  navigate: (addr) => ipcRenderer.invoke('v0id:navigate', addr),
  // 纯校验地址（不看 SOCKS 就绪）：多标签 UI 设 webview.src 前先规整。回 { ok, url } 或 { ok:false, error }。
  validate: (addr) => ipcRenderer.invoke('v0id:validate', addr),
  // 只读链/节点状态（占位板块用）。外部 SOCKS 模式无链 → 返回 null。
  info: () => ipcRenderer.invoke('v0id:info'),
  // 书签：持久化在主进程的 userData/bookmarks.json，渲染层只经这三个方法读写。
  bookmarks: {
    list: () => ipcRenderer.invoke('v0id:bookmarks:list'),
    add: (entry) => ipcRenderer.invoke('v0id:bookmarks:add', entry), // entry = { url, title }
    remove: (url) => ipcRenderer.invoke('v0id:bookmarks:remove', url),
  },
  // 订阅状态推送（守护阶段 / SOCKS 就绪 / 链高 / 日志行）。返回取消订阅函数。
  onStatus: (cb) => {
    const handler = (_e, patch) => cb(patch);
    ipcRenderer.on('v0id:status', handler);
    return () => ipcRenderer.removeListener('v0id:status', handler);
  },

  // 节点控制 API（角色板块 / 钱包板块用）。
  // 安全：渲染层**永不**接触 API 令牌——所有调用 renderer→preload→**主进程**，由主进程从
  // userData/v0id/api.token 读令牌、对 127.0.0.1:7001 发请求（写接口带 Authorization: Bearer）。
  // 这里每个方法只是把入参经 IPC 转给主进程，主进程统一回 { ok, data } 或 { ok:false, error }。
  api: {
    // ---- 只读（GET，无需令牌）----
    roles: () => ipcRenderer.invoke('v0id:api:roles'),
    stakeStatus: () => ipcRenderer.invoke('v0id:api:stakeStatus'),
    walletInfo: () => ipcRenderer.invoke('v0id:api:walletInfo'),
    txStatus: (txid) => ipcRenderer.invoke('v0id:api:txStatus', txid),
    // ---- 写（POST，主进程带 Bearer）----
    relayStart: () => ipcRenderer.invoke('v0id:api:relayStart'),
    relayStop: () => ipcRenderer.invoke('v0id:api:relayStop'),
    hsStart: (host, port, name) => ipcRenderer.invoke('v0id:api:hsStart', { host, port, name }),
    hsStop: (id) => ipcRenderer.invoke('v0id:api:hsStop', id),
    importWallet: (privateKey) => ipcRenderer.invoke('v0id:api:importWallet', privateKey),
    mineStart: (intervalMs) => ipcRenderer.invoke('v0id:api:mineStart', intervalMs),
    mineStop: () => ipcRenderer.invoke('v0id:api:mineStop'),
    stake: (role) => ipcRenderer.invoke('v0id:api:stake', role),
    unstake: (stakeId) => ipcRenderer.invoke('v0id:api:unstake', stakeId),
    send: (to, amount, memo) => ipcRenderer.invoke('v0id:api:send', { to, amount, memo }),
  },
});
