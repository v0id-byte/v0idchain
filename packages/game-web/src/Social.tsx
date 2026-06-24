// 镇中心公告牌 + 玩家主页：世界动态流（链上事件派生）+ 名册串门 + 个人炫耀页。
// 动态流来自 /api/feed（纯链上事件派生）；名字解析用 addressToName；主页来自 /api/profile。
import { useEffect, useState } from 'react';
import type { FeedEvent } from '@v0idchain/core/browser';
import { api, type Profile } from './api';
import { shortAddr } from './wallet';
import { RARITY_LABEL } from './pet-render';

function ago(ts: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}

const ICON: Record<FeedEvent['type'], string> = {
  name: '🪪',
  pet: '🥚',
  fish: '🎣',
  land: '🪧',
  harvest: '🌾',
  mine: '⛏️',
  redCreate: '🧧',
  redClaim: '🧧',
  message: '🔥',
};

function nameOf(addr: string, names: Record<string, string>): string {
  const n = names[addr];
  return n ? '@' + n : shortAddr(addr);
}

function sentence(ev: FeedEvent, names: Record<string, string>): string {
  const w = nameOf(ev.actor, names);
  switch (ev.type) {
    case 'name':
      return `${w} 抢注了昵称 @${ev.text}`;
    case 'pet':
      return `${w} 孵化了一只崽`;
    case 'fish':
      return `${w} 钓到一条鱼`;
    case 'land':
      return `${w} 买下了第 ${ev.n} 块地`;
    case 'harvest':
      return `${w} 收获了作物`;
    case 'mine':
      return ev.depth ? `${w} 在第 ${ev.depth} 层发现了 ${ev.mineKind}` : `${w} 铸造了 ${ev.count ?? 1} 份矿洞材料`;
    case 'redCreate':
      return `${w} 发了 ${ev.amount} $V0ID 红包（${ev.n} 份）`;
    case 'redClaim':
      return `${w} 抢到一个红包`;
    case 'message':
      return `${w}：${ev.text}`;
  }
}

export function FeedList({
  events,
  names,
  onProfile,
}: {
  events: FeedEvent[];
  names: Record<string, string>;
  onProfile: (addr: string) => void;
}) {
  if (events.length === 0)
    return <p className="empty">世界还很安静。去孵崽 / 钓鱼 / 买地 / 发红包，事件就会出现在这块公告牌上，全网都看得到。</p>;
  return (
    <div className="feed-list">
      {events.map((ev) => (
        <button key={ev.txid} className="feed-item" onClick={() => onProfile(ev.actor)}>
          <span className="feed-ico">{ICON[ev.type]}</span>
          <span className="feed-txt">{sentence(ev, names)}</span>
          {ev.rarity ? <span className={`tag tag-${ev.rarity}`}>{RARITY_LABEL[ev.rarity]}</span> : null}
          <span className="feed-ago">{ago(ev.timestamp)}</span>
        </button>
      ))}
    </div>
  );
}

/** 镇中心公告牌：世界动态 + 名册·串门 两个标签页。 */
export function TownBoard({
  events,
  names,
  list,
  self,
  onVisit,
  onProfile,
  onClose,
}: {
  events: FeedEvent[];
  names: Record<string, string>;
  list: { address: string; name?: string }[];
  self: string;
  onVisit: (address: string, who?: string) => void;
  onProfile: (addr: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'feed' | 'dir'>('feed');
  return (
    <div className="menu-backdrop" onClick={onClose}>
      <div className="menu" onClick={(e) => e.stopPropagation()}>
        <div className="menu-tabs">
          <button className={tab === 'feed' ? 'on' : ''} onClick={() => setTab('feed')}>📰 世界动态</button>
          <button className={tab === 'dir' ? 'on' : ''} onClick={() => setTab('dir')}>🏠 名册·串门</button>
          <button className="menu-close" onClick={onClose}>✕</button>
        </div>
        <div className="panel">
          {tab === 'feed' ? (
            <FeedList events={events} names={names} onProfile={onProfile} />
          ) : list.length === 0 ? (
            <p className="empty">还没有人发布房间。回房间按「🔨装修」布置并发布，就会出现在名册里。</p>
          ) : (
            <div className="dir-list">
              {list.map((r) => (
                <div key={r.address} className="dir-item">
                  <button className="dir-name-btn" onClick={() => onProfile(r.address)}>
                    {r.name ? '@' + r.name : shortAddr(r.address)}
                    {r.address === self ? '（我）' : ''}
                  </button>
                  <button className="dir-go" onClick={() => onVisit(r.address, r.name)}>进去看看 →</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="pf-stat">
      <span className="pf-k">{k}</span>
      <span className="pf-v">{v}</span>
    </div>
  );
}

/** 玩家炫耀卡：把地址变成“世界里的角色”。 */
export function ProfileCard({ p, self, onVisit }: { p: Profile; self: boolean; onVisit?: (a: string) => void }) {
  const title = p.joinHeight > 0 && p.joinHeight < 2000 ? '创世 · 早期玩家' : '玩家';
  return (
    <div className="profile-card">
      <div className="pf-head">
        <span className="pf-name">{p.nickname ? '@' + p.nickname : shortAddr(p.address)}</span>
        <span className="pf-badge">{title}</span>
      </div>
      <div className="pf-bal">
        {p.balance} <em>$V0ID</em>
      </div>
      <div className="pf-grid">
        <Stat k="崽" v={`${p.petCount}${p.rarePets ? `（稀有 ${p.rarePets}）` : ''}`} />
        <Stat k="鱼" v={`${p.fishCount}${p.bestRarity ? `（${RARITY_LABEL[p.bestRarity]}）` : ''}`} />
        <Stat k="农场" v={p.farm ? `${p.farm.plots} 地 / ${p.farm.zones} 区 / ${p.farm.harvests} 收` : '未开垦'} />
        <Stat k="房间" v={p.hasRoom ? `已发布 · 访问 ${p.visitCount} 次` : '未发布'} />
        <Stat k="加入" v={p.joinHeight > 0 ? `高度 ${p.joinHeight}` : '—'} />
        <Stat k="累计烧毁" v={`${p.totalBurned} $V0ID`} />
      </div>
      {!self && p.hasRoom && onVisit ? (
        <button className="primary pf-visit" onClick={() => onVisit(p.address)}>进 TA 的房间 →</button>
      ) : null}
    </div>
  );
}

/** 点别人名字弹出的主页浮层（按地址拉取）。 */
export function ProfileOverlay({
  address,
  self,
  onVisit,
  onClose,
}: {
  address: string;
  self: string;
  onVisit: (address: string, who?: string) => void;
  onClose: () => void;
}) {
  const [p, setP] = useState<Profile | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    setP(null);
    setErr('');
    api
      .profile(address)
      .then((r) => alive && setP(r))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [address]);
  return (
    <div className="menu-backdrop" onClick={onClose}>
      <div className="menu" onClick={(e) => e.stopPropagation()}>
        <div className="menu-tabs">
          <button className="on">👤 玩家主页</button>
          <button className="menu-close" onClick={onClose}>✕</button>
        </div>
        <div className="panel">
          {err ? (
            <p className="empty">读取失败：{err}</p>
          ) : !p ? (
            <p className="empty">加载中…</p>
          ) : (
            <ProfileCard
              p={p}
              self={address === self}
              onVisit={(a) => {
                onClose();
                onVisit(a);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** 菜单里的「主页」标签页：自己的炫耀卡。 */
export function MyProfilePanel({ address, onProfile }: { address: string; onProfile: (a: string) => void }) {
  const [p, setP] = useState<Profile | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .profile(address)
      .then((r) => alive && setP(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [address]);
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>我的主页</h2>
      </div>
      {!p ? <p className="empty">加载中…</p> : <ProfileCard p={p} self onVisit={onProfile} />}
      <p className="note">这是你的链上形象——别人在名册 / 动态里点你的名字，看到的就是这张卡片。</p>
    </div>
  );
}
