import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createMessage,
  makePetMint,
  PET_HATCH_COST,
  MIN_FEE,
  sha256Hex,
  petTraits,
  fishTraits,
} from '@v0idchain/core/browser';
import type { Pet, Catch, FarmView, Wallet } from '@v0idchain/core/browser';
import { api, waitConfirmed } from './api';
import { loadOrCreateWallet, exportPrivateKey, shortAddr } from './wallet';
import { renderPet, RARITY_LABEL } from './pet-render';
import { renderFish, fishName } from './fish-render';
import FishingModal from './FishingModal';
import { FarmPanel, FarmActionModal } from './FarmPanel';
import GameView from './game/GameView';
import type { Interactable, FurnitureItem, FarmRef } from './engine/scene';
import { DEFAULT_ROOM_FURNITURE } from './engine/scene';
import { FURNITURE_CATALOG, FURNITURE_TILES, ROOM_THEMES, type RoomThemeId } from './engine/tileset';
import { loadAtlas, drawAtlasTile } from './engine/atlas';
import { publishRoom, loadRoom } from './room';

function PetSprite({ gene, size = 88 }: { gene: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) renderPet(ref.current, gene, size);
  }, [gene, size]);
  return <canvas ref={ref} className="sprite" style={{ width: size, height: size }} />;
}

function PetCard({ pet, size = 88 }: { pet: Pet; size?: number }) {
  const t = petTraits(pet.gene);
  return (
    <div className={`pet-card rarity-${t.rarity}`}>
      <PetSprite gene={pet.gene} size={size} />
      <div className="pet-meta">
        <span className={`tag tag-${t.rarity}`}>{RARITY_LABEL[t.rarity]}</span>
        <code title={pet.id}>#{pet.id.slice(0, 8)}</code>
      </div>
    </div>
  );
}

function FishSprite({ catchHash, size = 88 }: { catchHash: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) renderFish(ref.current, catchHash, size);
  }, [catchHash, size]);
  return <canvas ref={ref} className="sprite" style={{ width: size, height: size }} />;
}

function FishCard({ fish, size = 88 }: { fish: Catch; size?: number }) {
  const t = fish.traits;
  return (
    <div className={`pet-card rarity-${t.rarity}`}>
      <FishSprite catchHash={fish.catchHash} size={size} />
      <div className="pet-meta">
        <span className={`tag tag-${t.rarity}`}>{RARITY_LABEL[t.rarity]}</span>
        <strong style={{ fontSize: 12 }}>{fishName(t)}</strong>
        <code title={fish.id}>{t.sizeCm}cm</code>
      </div>
    </div>
  );
}

function FurnitureIcon({ kind, size = 30 }: { kind: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    loadAtlas().then(() => {
      const c = ref.current;
      if (!alive || !c) return;
      c.width = c.height = size;
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      const coord = FURNITURE_TILES[kind];
      if (coord) drawAtlasTile(ctx, coord[0], coord[1], 0, 0, size);
    });
    return () => {
      alive = false;
    };
  }, [kind, size]);
  return <canvas ref={ref} style={{ width: size, height: size, imageRendering: 'pixelated' }} />;
}

type Tab = 'wallet' | 'pets' | 'fish' | 'farm';

export default function App() {
  const wallet = useMemo<Wallet>(() => loadOrCreateWallet(), []);
  const [balance, setBalance] = useState<number | null>(null);
  const [pets, setPets] = useState<Pet[]>([]);
  const [fish, setFish] = useState<Catch[]>([]);
  const [farm, setFarm] = useState<FarmView | null>(null);
  const [fishingOpen, setFishingOpen] = useState(false);
  const [farmAction, setFarmAction] = useState<FarmRef | null>(null);
  const [name, setName] = useState('');
  const [status, setStatus] = useState('连接中…');
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('pets');
  const [scene, setScene] = useState<'room' | 'town' | 'farm'>('room');
  // 房间编辑
  const [furniture, setFurniture] = useState<FurnitureItem[]>(DEFAULT_ROOM_FURNITURE);
  const [theme, setTheme] = useState<RoomThemeId>('wood');
  const [editMode, setEditMode] = useState(false);
  const [sel, setSel] = useState<string | 'erase' | null>(null);
  const [pubStatus, setPubStatus] = useState('');
  // 串门
  const [visit, setVisit] = useState<{
    address: string;
    name?: string;
    furniture: FurnitureItem[];
    theme: RoomThemeId;
    verified: boolean;
    petGene: string | null;
  } | null>(null);
  const [dirOpen, setDirOpen] = useState(false);
  const [dirList, setDirList] = useState<{ address: string; name?: string }[]>([]);

  const refresh = useCallback(async () => {
    const [b, ps, fs, fm, names] = await Promise.all([
      api.balance(wallet.address).then((r) => r.balance).catch(() => null),
      api.pets(wallet.address).catch(() => [] as Pet[]),
      api.fish(wallet.address).catch(() => [] as Catch[]),
      api.farm(wallet.address).catch(() => null),
      api.names().then((r) => r.addressToName).catch(() => ({}) as Record<string, string>),
    ]);
    setBalance(b);
    setPets(ps);
    setFish(fs);
    setFarm(fm);
    setName(names[wallet.address] ?? '');
    return b;
  }, [wallet.address]);

  // 入场:faucet + 余额轮询 + 载入已发布房间
  useEffect(() => {
    let alive = true;
    const ensureFaucet = async () => {
      try {
        const b = await refresh();
        const claimedKey = 'v0idchain.game.faucet.claimed';
        if ((b ?? 0) === 0 && !localStorage.getItem(claimedKey)) {
          setStatus('为你领取启动 $V0ID…');
          const r = await api.faucet(wallet.address);
          if (r.ok && r.txid) {
            localStorage.setItem(claimedKey, '1');
            setStatus('启动币上链中…');
            await waitConfirmed(r.txid);
            await refresh();
            setStatus('就绪');
          } else setStatus(r.error ? `faucet：${r.error}` : '就绪');
        } else setStatus('就绪');
      } catch (e) {
        setStatus(`连不上游戏服务器（${e instanceof Error ? e.message : e}）`);
      }
    };
    ensureFaucet();
    loadRoom(wallet.address)
      .then(({ layout }) => {
        if (alive && layout) {
          setFurniture(layout.furniture);
          setTheme(layout.theme);
        }
      })
      .catch(() => {});
    const id = setInterval(() => {
      if (alive) refresh().catch(() => {});
    }, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [refresh, wallet.address]);

  const hatch = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      setStatus('孵化中：本地签名 + 烧币铸造…');
      const { nonce } = await api.nonce(wallet.address);
      const tx = createMessage(wallet, wallet.address, makePetMint().memo, nonce, PET_HATCH_COST, MIN_FEE);
      const r = await api.submitTx(tx);
      setStatus('已广播，等待矿工打包…');
      const ok = await waitConfirmed(r.txid);
      await refresh();
      setStatus(ok ? '🐣 新崽诞生！' : '已广播，稍后可见');
    } catch (e) {
      setStatus(`孵化失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }, [busy, refresh, wallet]);

  const onInteract = useCallback((it: Interactable) => {
    if (it.type === 'pedestal') {
      setTab('pets');
      setMenuOpen(true);
    } else if (it.type === 'board') {
      api.rooms().then(setDirList).catch(() => setDirList([]));
      setDirOpen(true);
    } else if (it.type === 'fishing') {
      setFishingOpen(true);
    } else if ((it.type === 'plot' || it.type === 'crop') && it.farm) {
      setFarmAction(it.farm); // 打开农场动作浮层（买地/建田地/种植/收获）
    }
  }, []);

  const onSceneChange = useCallback((id: string) => {
    setScene(id as 'room' | 'town' | 'farm');
    if (id !== 'room') {
      setEditMode(false);
      setVisit(null); // 走出他人房间的门 → 退出串门
    }
  }, []);

  // 串门:载入某人房间(只读) + 他的崽,切到其房间
  const visitRoom = useCallback(async (address: string, who?: string) => {
    setDirOpen(false);
    try {
      const [{ layout, verified }, ownerPets] = await Promise.all([
        loadRoom(address),
        api.pets(address).catch(() => [] as Pet[]),
      ]);
      setVisit({
        address,
        name: who,
        furniture: layout?.furniture ?? [],
        theme: layout?.theme ?? 'wood',
        verified,
        petGene: ownerPets[0]?.gene ?? null,
      });
      setScene('room');
    } catch {
      /* ignore */
    }
  }, []);

  // 编辑:点格子放/删家具（仅房间内部、非基座格）
  const onTileClick = useCallback(
    (tx: number, ty: number, sid: string) => {
      if (!editMode || sid !== 'room') return;
      if (tx < 1 || tx > 10 || ty < 1 || ty > 7) return;
      if (tx === 2 && ty === 2) return; // 崽基座固定
      setFurniture((prev) => {
        const without = prev.filter((f) => !(f.x === tx && f.y === ty));
        if (sel === 'erase') return without;
        if (sel) return [...without, { kind: sel, x: tx, y: ty }];
        return prev;
      });
    },
    [editMode, sel],
  );

  const publish = useCallback(async () => {
    setPubStatus('发布中：本地签名 + 上链…');
    try {
      const { txid } = await publishRoom(wallet, { theme, furniture });
      setPubStatus('已广播，等确认…');
      const ok = await waitConfirmed(txid);
      setPubStatus(ok ? '✅ 房间已上链发布' : '已广播，稍后生效');
    } catch (e) {
      setPubStatus(`发布失败：${e instanceof Error ? e.message : e}`);
    }
  }, [wallet, theme, furniture]);

  // 调试钩子(预览里 rAF 节流难以走到名册牌):直接开名册 / 串门。部署前删。
  useEffect(() => {
    const w = window as unknown as { __dir?: () => void; __visit?: (a: string, n?: string) => void };
    w.__dir = () => {
      api.rooms().then(setDirList).catch(() => {});
      setDirOpen(true);
    };
    w.__visit = (a: string, n?: string) => visitRoom(a, n);
  }, [visitRoom]);

  const petGene = pets[0]?.gene ?? null;

  return (
    <div className="game-root">
      <GameView
        address={wallet.address}
        petGene={visit ? visit.petGene : petGene}
        furniture={furniture}
        theme={theme}
        editMode={editMode}
        paused={menuOpen || fishingOpen || !!farmAction}
        visit={visit ? { furniture: visit.furniture, theme: visit.theme } : null}
        farm={farm}
        onToggleMenu={() => setMenuOpen((o) => !o)}
        onInteract={onInteract}
        onSceneChange={onSceneChange}
        onTileClick={onTileClick}
      />

      <div className="hud">
        <div className="hud-left">
          <span className="hud-place">
            {visit
              ? `🏠 ${visit.name ? '@' + visit.name : shortAddr(visit.address)} 的房间 ${visit.verified ? '✓已验证' : '⚠未验证'}`
              : scene === 'room'
                ? '🏠 我的房间'
                : scene === 'farm'
                  ? '🌾 我的农场'
                  : '🏙 镇中心'}
          </span>
          <span className="hud-bal">{balance === null ? '—' : balance} $V0ID</span>
          {name ? <span className="hud-name">@{name}</span> : <code className="hud-addr">{shortAddr(wallet.address)}</code>}
        </div>
        <div className="hud-right">
          {scene === 'room' && !editMode && !visit && (
            <button className="hud-menu" onClick={() => { setEditMode(true); setSel(null); }}>🔨 装修</button>
          )}
          <button className="hud-menu" onClick={() => setMenuOpen(true)}>菜单 (Esc)</button>
        </div>
      </div>

      {editMode ? (
        <EditorBar
          theme={theme}
          onTheme={setTheme}
          sel={sel}
          onSel={setSel}
          onPublish={publish}
          onDone={() => setEditMode(false)}
          pubStatus={pubStatus}
        />
      ) : (
        <div className="hud-hint">
          <span>WASD/方向键 移动</span>
          <span>E 交互</span>
          <span>Esc 菜单</span>
          {status && status !== '就绪' ? <span className="hud-status">{busy ? <i className="spin" /> : null}{status}</span> : null}
        </div>
      )}

      {menuOpen && (
        <div className="menu-backdrop" onClick={() => setMenuOpen(false)}>
          <div className="menu" onClick={(e) => e.stopPropagation()}>
            <div className="menu-tabs">
              <button className={tab === 'pets' ? 'on' : ''} onClick={() => setTab('pets')}>崽</button>
              <button className={tab === 'fish' ? 'on' : ''} onClick={() => setTab('fish')}>鱼篓</button>
              <button className={tab === 'farm' ? 'on' : ''} onClick={() => setTab('farm')}>农场</button>
              <button className={tab === 'wallet' ? 'on' : ''} onClick={() => setTab('wallet')}>钱包</button>
              <button className="menu-close" onClick={() => setMenuOpen(false)}>✕</button>
            </div>
            {tab === 'pets' ? (
              <PetsPanel pets={pets} balance={balance} busy={busy} onHatch={hatch} status={status} />
            ) : tab === 'fish' ? (
              <FishPanel fish={fish} onFish={() => { setMenuOpen(false); setFishingOpen(true); }} />
            ) : tab === 'farm' ? (
              <FarmPanel farm={farm} status={status} />
            ) : (
              <WalletPanel address={wallet.address} name={name} balance={balance} />
            )}
          </div>
        </div>
      )}
      {dirOpen && (
        <DirectoryOverlay list={dirList} self={wallet.address} onVisit={visitRoom} onClose={() => setDirOpen(false)} />
      )}
      {fishingOpen && (
        <FishingModal
          wallet={wallet}
          balance={balance}
          onMinted={() => refresh().catch(() => {})}
          onClose={() => setFishingOpen(false)}
        />
      )}
      {farmAction && (
        <FarmActionModal
          action={farmAction}
          farm={farm}
          wallet={wallet}
          balance={balance}
          onDone={() => refresh().catch(() => {})}
          onClose={() => setFarmAction(null)}
        />
      )}
    </div>
  );
}

function DirectoryOverlay({
  list,
  self,
  onVisit,
  onClose,
}: {
  list: { address: string; name?: string }[];
  self: string;
  onVisit: (address: string, who?: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="menu-backdrop" onClick={onClose}>
      <div className="menu" onClick={(e) => e.stopPropagation()}>
        <div className="menu-tabs">
          <button className="on">名册 · 串门</button>
          <button className="menu-close" onClick={onClose}>✕</button>
        </div>
        <div className="panel">
          {list.length === 0 ? (
            <p className="empty">还没有人发布房间。回房间按「🔨装修」布置并发布，就会出现在名册里。</p>
          ) : (
            <div className="dir-list">
              {list.map((r) => (
                <button key={r.address} className="dir-item" onClick={() => onVisit(r.address, r.name)}>
                  <span className="dir-name">
                    {r.name ? '@' + r.name : shortAddr(r.address)}
                    {r.address === self ? '（我）' : ''}
                  </span>
                  <span className="dir-go">进去看看 →</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EditorBar({
  theme,
  onTheme,
  sel,
  onSel,
  onPublish,
  onDone,
  pubStatus,
}: {
  theme: RoomThemeId;
  onTheme: (t: RoomThemeId) => void;
  sel: string | 'erase' | null;
  onSel: (s: string | 'erase' | null) => void;
  onPublish: () => void;
  onDone: () => void;
  pubStatus: string;
}) {
  return (
    <div className="editor-bar">
      <div className="editor-row">
        <span className="editor-label">房型</span>
        {(Object.keys(ROOM_THEMES) as RoomThemeId[]).map((id) => (
          <button key={id} className={`theme-btn ${theme === id ? 'on' : ''}`} onClick={() => onTheme(id)}>
            {ROOM_THEMES[id].label}
          </button>
        ))}
        <span className="editor-tip">点格子放置 · 选「擦除」后点格子移除</span>
        <div className="editor-actions">
          <button className={`erase-btn ${sel === 'erase' ? 'on' : ''}`} onClick={() => onSel('erase')}>擦除</button>
          <button className="primary" onClick={onPublish}>发布上链</button>
          <button className="done-btn" onClick={onDone}>完成</button>
        </div>
      </div>
      <div className="palette">
        {FURNITURE_CATALOG.map((c, i) => (
          <button
            key={c.kind + i}
            className={`palette-item ${sel === c.kind ? 'on' : ''}`}
            title={c.label}
            onClick={() => onSel(c.kind)}
          >
            <FurnitureIcon kind={c.kind} />
            <span>{c.label}</span>
          </button>
        ))}
      </div>
      {pubStatus && <div className="editor-pub">{pubStatus}</div>}
    </div>
  );
}

function PetsPanel({
  pets,
  balance,
  busy,
  onHatch,
  status,
}: {
  pets: Pet[];
  balance: number | null;
  busy: boolean;
  onHatch: () => void;
  status: string;
}) {
  const canAfford = (balance ?? 0) >= PET_HATCH_COST + MIN_FEE;
  const samples = useMemo(() => Array.from({ length: 6 }, (_, i) => sha256Hex(`v0id-sample-${i}`)), []);
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>我的崽</h2>
        <button className="primary" disabled={busy || !canAfford} onClick={onHatch}>
          {canAfford ? `孵化（烧 ${PET_HATCH_COST}）` : `余额不足（需 ${PET_HATCH_COST}）`}
        </button>
      </div>
      {pets.length === 0 ? (
        <p className="empty">还没有崽。孵化一只由链上基因生成、独一无二的像素宠物吧。</p>
      ) : (
        <div className="pet-grid">
          {pets.map((p) => (
            <PetCard key={p.id} pet={p} />
          ))}
        </div>
      )}
      {status && status !== '就绪' && <p className="panel-status">{busy ? <i className="spin" /> : null}{status}</p>}
      <h3>图鉴 · 基因决定长相</h3>
      <div className="pet-grid">
        {samples.map((g) => (
          <PetCard key={g} pet={{ id: g, gene: g, owner: '', minter: '', birthHeight: 0, birthTs: 0 }} size={72} />
        ))}
      </div>
    </div>
  );
}

function FishPanel({ fish, onFish }: { fish: Catch[]; onFish: () => void }) {
  // 图鉴预览：几个本地随机 hash，展示稀有度与鱼种长相（与崽图鉴同套路）。
  const samples = useMemo(() => Array.from({ length: 6 }, (_, i) => sha256Hex(`v0id-fish-sample-${i}`)), []);
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>我的鱼篓</h2>
        <button className="primary" onClick={onFish}>去钓鱼 🎣</button>
      </div>
      {fish.length === 0 ? (
        <p className="empty">还没钓到链上藏品。去镇中心西端的鱼摊抛竿，钓中后可铸成链上渔获——鱼种由出块后的区块 hash 事后确定，谁也伪造不出传说鱼。</p>
      ) : (
        <div className="pet-grid">
          {fish.map((f) => (
            <FishCard key={f.id} fish={f} />
          ))}
        </div>
      )}
      <h3>图鉴 · 区块 hash 决定鱼种</h3>
      <div className="pet-grid">
        {samples.map((h) => (
          <div key={h} className={`pet-card rarity-${fishTraits(h).rarity}`}>
            <FishSprite catchHash={h} size={72} />
            <div className="pet-meta">
              <span className={`tag tag-${fishTraits(h).rarity}`}>{RARITY_LABEL[fishTraits(h).rarity]}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function WalletPanel({ address, name, balance }: { address: string; name: string; balance: number | null }) {
  const [copied, setCopied] = useState('');
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>钱包</h2>
        <span className="big-bal">{balance === null ? '—' : balance} <em>$V0ID</em></span>
      </div>
      <div className="kv">
        <span className="k">昵称</span>
        <span className="v">{name ? `@${name}` : '（未抢注）'}</span>
      </div>
      <div className="kv">
        <span className="k">地址</span>
        <code className="v addr">{address}</code>
      </div>
      <div className="wallet-actions">
        <button onClick={() => { navigator.clipboard?.writeText(address); setCopied('地址已复制'); }}>复制地址</button>
        <button onClick={() => { navigator.clipboard?.writeText(exportPrivateKey()); setCopied('私钥已复制——妥善备份，可导入软件钱包 App'); }}>导出私钥</button>
      </div>
      {copied && <p className="panel-status">{copied}</p>}
      <p className="note">私钥只存在你的浏览器本地，永不上送服务器。这是自托管钱包。</p>
    </div>
  );
}
