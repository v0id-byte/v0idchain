// v0id 浏览器 —— 应用外壳。左侧栏在 6 个板块间切换；右侧渲染当前板块。
//
// 安全模型回顾：本 React 页面是「窗口自身的受信页面」（contextIsolation、无 Node）。
// 不可信的 .v0id 页面只在「浏览器」板块的 <webview partition="v0id"> 里加载（内存型、不落盘）
//（SOCKS 代理 + deny-all 权限 + WebRTC 加固，均在 main.js）。其余 5 个板块是本地占位/只读状态。
import React, { useState } from 'react';
import { useStatus } from './useStatus.js';
import { Browser } from './sections/Browser.jsx';
import { ClientPanel, RelayPanel, HostPanel, ChainPanel, WalletPanel } from './sections/Placeholders.jsx';

const SECTIONS = [
  { id: 'browser', label: '浏览器' },
  { id: 'client', label: '浏览客户端' },
  { id: 'relay', label: '中继' },
  { id: 'host', label: '托管站点' },
  { id: 'chain', label: '链·挖矿' },
  { id: 'wallet', label: '钱包' },
];

export function App() {
  const [active, setActive] = useState('browser');
  const status = useStatus();

  const dotClass =
    status.phase === 'socks-ready' ? 'ready' : status.phase === 'error' || status.phase === 'daemon-exited' ? 'err' : '';

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          .v0id
          <span className="brand-sub">匿名浏览器</span>
        </div>
        <nav className="nav">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={'nav-item' + (active === s.id ? ' active' : '')}
              onClick={() => setActive(s.id)}
            >
              <span className="glyph" />
              {s.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={'dot ' + dotClass} />
          <span title={status.phaseText}>
            {status.socksReady ? '已就绪' : status.phase === 'error' ? '出错' : '启动中'}
          </span>
        </div>
      </aside>

      <main className="content">
        {/* 浏览器始终挂载（保留各标签 webview 不被销毁）；切到别的板块时用 CSS 隐藏。 */}
        <div style={{ display: active === 'browser' ? 'flex' : 'none', flex: '1 1 auto', minHeight: 0 }}>
          <Browser status={status} />
        </div>
        {active === 'client' && <ClientPanel />}
        {active === 'relay' && <RelayPanel />}
        {active === 'host' && <HostPanel />}
        {active === 'chain' && <ChainPanel />}
        {active === 'wallet' && <WalletPanel />}
      </main>
    </div>
  );
}
