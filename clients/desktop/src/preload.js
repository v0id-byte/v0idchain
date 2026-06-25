// v0id 浏览器 —— preload（隔离世界）。
// 只经 contextBridge 暴露一个最小 API 给 renderer；contextIsolation: true + nodeIntegration: false，
// renderer 拿不到 Node/Electron 内部，只能用下面这几个方法。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('v0id', {
  // 请求导航到一个 .v0id 或 http(s) 地址；主进程校验并回 { ok, url } 或 { ok:false, error }。
  navigate: (addr) => ipcRenderer.invoke('v0id:navigate', addr),
  // 订阅状态推送（守护阶段 / SOCKS 就绪 / 链高 / 日志行）。返回取消订阅函数。
  onStatus: (cb) => {
    const handler = (_e, patch) => cb(patch);
    ipcRenderer.on('v0id:status', handler);
    return () => ipcRenderer.removeListener('v0id:status', handler);
  },
});
