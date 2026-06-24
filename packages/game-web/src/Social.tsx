// 社交面板：城镇公告栏 / 玩家档案 / 我的档案
import type { FeedEvent } from '@v0idchain/core/browser';
import { shortAddr } from './wallet';

interface TownBoardProps {
  events: FeedEvent[];
  names: Record<string, string>;
  list: { address: string; name?: string }[];
  self: string;
  onVisit: (address: string, name?: string) => void;
  onProfile: (address: string) => void;
  onClose: () => void;
}

export function TownBoard({ events, names, list, self, onVisit, onProfile, onClose }: TownBoardProps) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}
      onClick={onClose}>
      <div style={{ background: '#1e1a2e', border: '2px solid #4a3f6a', borderRadius: 0, padding: '20px 24px', minWidth: 320, maxWidth: 420, color: '#e8e0cc', fontFamily: 'monospace', imageRendering: 'pixelated' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <b style={{ color: '#d4aa60' }}>★ 城镇公告栏</b>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#a09080', cursor: 'pointer', fontSize: 18 }}>×</button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ color: '#a09080', fontSize: 12, marginBottom: 6 }}>在线居民 ({list.length})</div>
          <div style={{ maxHeight: 140, overflowY: 'auto' }}>
            {list.map(p => (
              <div key={p.address} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0', borderBottom: '1px solid #2a2540' }}>
                <span
                  style={{ cursor: 'pointer', color: p.address === self ? '#d4aa60' : '#c8b8a0' }}
                  onClick={() => onProfile(p.address)}
                >
                  {p.name ?? names[p.address] ?? shortAddr(p.address)}
                  {p.address === self ? ' (我)' : ''}
                </span>
                {p.address !== self && (
                  <button
                    onClick={() => onVisit(p.address, p.name ?? names[p.address])}
                    style={{ fontSize: 11, padding: '1px 8px', background: '#3a2f5a', border: '1px solid #5a4a8a', color: '#c8b8d0', cursor: 'pointer' }}
                  >
                    串门
                  </button>
                )}
              </div>
            ))}
            {list.length === 0 && <div style={{ color: '#6a5a7a', fontSize: 12 }}>暂无其他居民在线</div>}
          </div>
        </div>

        {events.length > 0 && (
          <div>
            <div style={{ color: '#a09080', fontSize: 12, marginBottom: 6 }}>最近动态</div>
            <div style={{ maxHeight: 120, overflowY: 'auto' }}>
              {events.slice(0, 20).map((e, i) => (
                <div key={i} style={{ fontSize: 11, color: '#9a8a7a', padding: '2px 0', borderBottom: '1px solid #2a2540' }}>
                  <span
                    style={{ color: '#b8a890', cursor: 'pointer' }}
                    onClick={() => onProfile(e.from)}
                  >
                    {names[e.from] ?? shortAddr(e.from)}
                  </span>
                  {' · '}{e.memo ?? e.type}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface ProfileOverlayProps {
  address: string;
  self: string;
  onVisit: (address: string) => void;
  onClose: () => void;
}

export function ProfileOverlay({ address, self, onVisit, onClose }: ProfileOverlayProps) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 210 }}
      onClick={onClose}>
      <div style={{ background: '#1e1a2e', border: '2px solid #4a3f6a', padding: '20px 24px', minWidth: 280, color: '#e8e0cc', fontFamily: 'monospace' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <b style={{ color: '#d4aa60' }}>档案</b>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#a09080', cursor: 'pointer', fontSize: 18 }}>×</button>
        </div>
        <div style={{ color: '#c8b8a0', marginBottom: 12, fontSize: 13, wordBreak: 'break-all' }}>{address}</div>
        {address !== self && (
          <button
            onClick={() => { onVisit(address); onClose(); }}
            style={{ width: '100%', padding: '6px', background: '#3a2f5a', border: '1px solid #5a4a8a', color: '#c8b8d0', cursor: 'pointer', fontFamily: 'monospace' }}
          >
            ▶ 前往串门
          </button>
        )}
      </div>
    </div>
  );
}

interface MyProfilePanelProps {
  address: string;
  onProfile: (address: string) => void;
}

export function MyProfilePanel({ address, onProfile }: MyProfilePanelProps) {
  return (
    <div style={{ padding: '12px 0', color: '#e8e0cc', fontFamily: 'monospace' }}>
      <div style={{ color: '#a09080', fontSize: 12, marginBottom: 8 }}>我的档案</div>
      <div style={{ fontSize: 12, color: '#c8b8a0', wordBreak: 'break-all', marginBottom: 12 }}>{address}</div>
      <button
        onClick={() => onProfile(address)}
        style={{ padding: '4px 12px', background: '#3a2f5a', border: '1px solid #5a4a8a', color: '#c8b8d0', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12 }}
      >
        查看档案
      </button>
    </div>
  );
}
