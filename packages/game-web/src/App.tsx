import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createMessage,
  makePetMint,
  PET_HATCH_COST,
  MIN_FEE,
  sha256Hex,
  petTraits,
  fishTraits,
  makeFishCatch,
  FISH_BURN,
  makeHarvest,
  HARVEST_BURN,
  NULL_ADDRESS,
  MINE_KIND_META,
  MINE_KINDS,
  makeMineDiscovery,
  makeMineMaterial,
  mineDiscoveryBurn,
  mineMaterialBurn,
} from '@v0idchain/core/browser';
import type { Pet, Catch, FarmView, Wallet, FeedEvent, Crop, MineAsset, MineAssetKind, Rarity } from '@v0idchain/core/browser';
import { api, waitConfirmed } from './api';
import { loadOrCreateWallet, exportPrivateKey, importPrivateKey, shortAddr } from './wallet';
import { TownBoard, ProfileOverlay, MyProfilePanel } from './Social';
import { renderPet, RARITY_LABEL } from './pet-render';
import { renderFish, fishName } from './fish-render';
import FishingModal from './FishingModal';
import { FarmPanel, FarmActionModal } from './FarmPanel';
import RevealOverlay, { type RevealState, type RevealResult } from './RevealOverlay';
import Codex from './Codex';
import { cropFullName } from './crop-render';
import GameView, { type GameHandle } from './game/GameView';
import TouchControls from './TouchControls';
import Hotbar, { DEFAULT_INVENTORY, type InventorySlot } from './Hotbar';
import type { Interactable, FurnitureItem, FarmRef, FruitKind, GardenStateEntry } from './engine/scene';
import { DEFAULT_ROOM_FURNITURE } from './engine/scene';
import { mineTileKey } from './engine/mine';
import { FURNITURE_CATALOG, FURNITURE_TILES, ROOM_THEMES, type RoomThemeId } from './engine/tileset';
import { loadAtlas, drawAtlasTile } from './engine/atlas';
import { publishRoom, loadRoom } from './room';

// —— 公共田地常量 ——
const GROW_MS: Record<Crop, number> = { turnip: 45_000, wheat: 75_000, pumpkin: 120_000, starfruit: 180_000 };
const CROP_ICON: Record<Crop, string> = { turnip: '🌰', wheat: '🌾', pumpkin: '🎃', starfruit: '⭐' };
const CROP_LABEL: Record<Crop, string> = { turnip: '芜菁', wheat: '小麦', pumpkin: '南瓜', starfruit: '星果' };
type GardenPlot = { phase: 'empty' | 'planted' | 'watered'; crop?: Crop; plantedAt?: number; wateredAt?: number; hash?: string };

function plotHash(id: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0').repeat(8);
}

function isMineAssetKind(kind: string): kind is MineAssetKind {
  return MINE_KINDS.includes(kind as MineAssetKind);
}

/** 矿洞稀有度（含 uncommon）→ 标准四档，供揭晓仪式统一外发光/标签。 */
function mineRevealRarity(r: MineAsset['traits']['rarity']): Rarity {
  return r === 'legendary' ? 'legendary' : r === 'epic' ? 'epic' : r === 'rare' || r === 'uncommon' ? 'rare' : 'common';
}

function addSlot(prev: InventorySlot[], slot: InventorySlot, unique = false): InventorySlot[] {
  const next = [...prev];
  if (!unique) {
    const existing = next.findIndex((s) => s?.kind === slot.kind && !s.chain);
    if (existing >= 0) {
      next[existing] = { ...next[existing], count: next[existing].count + slot.count };
      return next;
    }
  }
  const emptyIdx = next.findIndex((s, i) => i >= 4 && s === undefined);
  if (emptyIdx >= 0) next[emptyIdx] = slot;
  else next.push(slot);
  return next;
}
function computeGardenStage(plot: GardenPlot): 0 | 1 | 2 | 3 {
  if (!plot.crop || !plot.plantedAt || plot.phase === 'empty') return 0;
  const now = Date.now();
  const growMs = GROW_MS[plot.crop] ?? 60_000;
  let elapsed = now - plot.plantedAt;
  if (plot.wateredAt) {
    elapsed = (plot.wateredAt - plot.plantedAt) + (now - plot.wateredAt) * 2;
  }
  const p = Math.min(1, elapsed / growMs);
  if (p >= 1) return 3;
  if (p >= 0.6) return 2;
  if (p >= 0.25) return 1;
  return 0;
}

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

type Tab = 'codex' | 'wallet' | 'pets' | 'fish' | 'farm' | 'mine' | 'profile';

export default function App() {
  const wallet = useMemo<Wallet>(() => loadOrCreateWallet(), []);
  const [balance, setBalance] = useState<number | null>(null);
  const [pets, setPets] = useState<Pet[]>([]);
  const [fish, setFish] = useState<Catch[]>([]);
  const [farm, setFarm] = useState<FarmView | null>(null);
  const [mines, setMines] = useState<MineAsset[]>([]);
  const [fishingOpen, setFishingOpen] = useState(false);
  const [farmAction, setFarmAction] = useState<FarmRef | null>(null);
  const [name, setName] = useState('');
  const [status, setStatus] = useState('连接中…');
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('pets');
  const [scene, setScene] = useState<string>('room');
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
  const [namesMap, setNamesMap] = useState<Record<string, string>>({});
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([]);
  const [profileAddr, setProfileAddr] = useState<string | null>(null);
  // 触屏
  const gameRef = useRef<GameHandle>(null);
  const [invToast, setInvToast] = useState(false);
  const invTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 物品栏 + 工具
  const [inventory, setInventory] = useState<InventorySlot[]>(DEFAULT_INVENTORY);
  const [hotbarSel, setHotbarSel] = useState(0);
  // 工具 ref（onInteract 闭包同步读，避免 stale）
  const hotbarSelRef = useRef(hotbarSel);
  const inventoryRef = useRef(inventory);
  useEffect(() => { hotbarSelRef.current = hotbarSel; }, [hotbarSel]);
  useEffect(() => { inventoryRef.current = inventory; }, [inventory]);
  // 果树摘取状态（fruitId → 摘取时间戳 ms）
  const [fruitDepletion, setFruitDepletion] = useState<Map<string, number>>(new Map());
  const fruitTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // 砍树状态（fruitId → 砍倒时间戳 ms；砍倒后 3 分钟恢复）
  const [choppedTrees, setChoppedTrees] = useState<Map<string, number>>(new Map());
  const chopTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // 单机版公共田地（gardenId → plot 状态）
  const [gardenPlots, setGardenPlots] = useState<Map<string, GardenPlot>>(new Map());
  const [gardenTick, setGardenTick] = useState(0); // 定期触发成长阶段重算
  // 附近的可交互物件（引擎回调）
  const [nearby, setNearby] = useState<Interactable | null>(null);
  // 公共菜地浮层 + 当前聚焦格
  const [gardenHud, setGardenHud] = useState<{ gardenId: string } | null>(null);
  // 房间租售浮层
  const [rentOpen, setRentOpen] = useState(false);
  // 果子铸造浮层（选中的果子 slot）
  const [mintTarget, setMintTarget] = useState<InventorySlot | null>(null);
  // 链上资产：已铸造的果子记录（从 feed 解析），房间所有权
  const [mintedAssets, setMintedAssets] = useState<{ kind: string; count: number; ts: number }[]>([]);
  const [roomOwnership, setRoomOwnership] = useState<{ type: 'rent' | 'buy'; expiryTs?: number } | null>(null);
  const [mineHp, setMineHp] = useState(100);
  const [mineMined, setMineMined] = useState<Set<string>>(new Set());
  const [mineChests, setMineChests] = useState<Set<string>>(new Set());
  const [mineMonsters, setMineMonsters] = useState<Set<string>>(new Set());
  // 铸造揭晓仪式状态（投入虚空 → 区块盖章 → 稀有度揭晓）。
  const [reveal, setReveal] = useState<RevealState | null>(null);

  const refresh = useCallback(async () => {
    const [b, ps, fs, fm, ms, names, ownFeed] = await Promise.all([
      api.balance(wallet.address).then((r) => r.balance).catch(() => null),
      api.pets(wallet.address).catch(() => [] as Pet[]),
      api.fish(wallet.address).catch(() => [] as Catch[]),
      api.farm(wallet.address).catch(() => null),
      api.mines(wallet.address).catch(() => [] as MineAsset[]),
      api.names().then((r) => r.addressToName).catch(() => ({}) as Record<string, string>),
      api.feed(wallet.address, 200).catch(() => ({ events: [] as import('@v0idchain/core/browser').FeedEvent[] })),
    ]);
    setBalance(b);
    setPets(ps);
    setFish(fs);
    setFarm(fm);
    setMines(ms);
    setName(names[wallet.address] ?? '');
    setNamesMap(names);

    // 解析自己的 ROOM + FRUIT 链上记录
    const msgs = ownFeed.events.filter((e) => e.type === 'message' && e.actor === wallet.address);
    // 房间所有权（取最新一条 ROOM: 记录）
    const roomTx = msgs.find((e) => e.text?.startsWith('ROOM:'));
    if (roomTx?.text) {
      const [, op, param] = roomTx.text.split(':'); // ROOM:RENT:7d or ROOM:BUY
      if (op === 'BUY') {
        setRoomOwnership({ type: 'buy' });
      } else if (op === 'RENT' && param) {
        const days = parseInt(param.replace('d', ''), 10) || 7;
        setRoomOwnership({ type: 'rent', expiryTs: roomTx.timestamp + days * 86_400_000 });
      }
    } else {
      setRoomOwnership(null);
    }
    // 已铸造果子（聚合 FRUIT:MINT 记录）
    const fruitMap = new Map<string, { count: number; ts: number }>();
    for (const e of msgs) {
      if (!e.text?.startsWith('FRUIT:MINT:')) continue;
      const [, , kind, countStr] = e.text.split(':');
      if (!kind) continue;
      const prev = fruitMap.get(kind) ?? { count: 0, ts: 0 };
      fruitMap.set(kind, { count: prev.count + (parseInt(countStr, 10) || 1), ts: Math.max(prev.ts, e.timestamp) });
    }
    setMintedAssets(Array.from(fruitMap.entries()).map(([kind, v]) => ({ kind, ...v })));

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

  // 田地成长阶段每 10s 重算一次（触发 gardenStateMap 更新 → 重建镇地图作物精灵）
  useEffect(() => {
    const id = setInterval(() => setGardenTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  // 统一铸造揭晓：投入虚空（sealing）→ 等区块确认 → 盖章揭晓（result）/ 轻量确认（bulk）/ 兜底（failed）。
  // 复用各处 mint 链路（nonce→createMessage→submitTx→waitConfirmed→refresh），把静默 setStatus 换成仪式演出。
  const runReveal = useCallback(
    async (opts: {
      label: string;
      memo: string;
      burn: number;
      to: string;
      resolve?: (txid: string) => Promise<RevealResult | null>;
      bulk?: { icon: string; label: string; count: number };
    }): Promise<boolean> => {
      setReveal({ stage: 'sealing', label: opts.label, burn: opts.burn, bulk: opts.bulk });
      try {
        const { nonce } = await api.nonce(wallet.address);
        const tx = createMessage(wallet, opts.to, opts.memo, nonce, opts.burn, MIN_FEE);
        const r = await api.submitTx(tx);
        const ok = await waitConfirmed(r.txid);
        await refresh();
        if (!ok) {
          setReveal({ stage: 'reveal', label: opts.label, burn: opts.burn, failed: true });
          return false;
        }
        if (opts.bulk) {
          setReveal({ stage: 'reveal', label: opts.label, burn: opts.burn, bulk: opts.bulk });
          return true;
        }
        const result = opts.resolve ? await opts.resolve(r.txid) : null;
        setReveal({ stage: 'reveal', label: opts.label, burn: opts.burn, result: result ?? undefined, failed: !result });
        return true;
      } catch {
        setReveal({ stage: 'reveal', label: opts.label, burn: opts.burn, failed: true });
        return false;
      }
    },
    [wallet, refresh],
  );

  const hatch = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setMenuOpen(false);
    try {
      await runReveal({
        label: '孵化崽',
        memo: makePetMint().memo,
        burn: PET_HATCH_COST,
        to: wallet.address,
        resolve: async (txid) => {
          const ps = await api.pets(wallet.address).catch(() => [] as Pet[]);
          const p = ps.find((x) => x.id === txid);
          if (!p) return null;
          const t = petTraits(p.gene);
          return { kind: 'pet', gene: p.gene, rarity: t.rarity, name: `${RARITY_LABEL[t.rarity]}崽`, sub: `基因 #${p.gene.slice(0, 8)}` };
        },
      });
    } finally {
      setBusy(false);
    }
  }, [busy, runReveal, wallet.address]);

  // 钓鱼铸造渔获 → 揭晓（鱼种/稀有度由出块后 catchHash 事后确定）。供 FishingModal 调用。
  const fishReveal = useCallback(
    () =>
      runReveal({
        label: '铸造渔获',
        memo: makeFishCatch().memo,
        burn: FISH_BURN,
        to: wallet.address,
        resolve: async (txid) => {
          const fs = await api.fish(wallet.address).catch(() => [] as Catch[]);
          const f = fs.find((x) => x.id === txid);
          if (!f) return null;
          return { kind: 'fish', catchHash: f.catchHash, rarity: f.traits.rarity, name: fishName(f.traits), sub: `${f.traits.sizeCm} cm${f.traits.shiny ? ' · ✨闪光' : ''}` };
        },
      }),
    [runReveal, wallet.address],
  );

  // 作物收获 → 揭晓（品质由收获后 cropHash 事后确定）。供 FarmActionModal 收获动作调用。
  const cropReveal = useCallback(
    (plantId: string) =>
      runReveal({
        label: '收获作物',
        memo: makeHarvest(plantId).memo ?? '',
        burn: HARVEST_BURN,
        to: wallet.address,
        resolve: async (txid) => {
          const fm = await api.farm(wallet.address).catch(() => null);
          const c = fm?.crops.find((x) => x.id === txid);
          if (!c) return null;
          return { kind: 'crop', crop: c.crop, hash: c.hash, rarity: c.traits.quality, name: cropFullName(c.traits), sub: `${c.traits.weightG} g${c.traits.giant ? ' · 巨型' : ''}` };
        },
      }),
    [runReveal, wallet.address],
  );

  const FRUIT_ICON: Record<FruitKind, string> = { apple: '🍎', orange: '🍊', berry: '🫐', golden_apple: '✨🍎' };
  const FRUIT_REGEN_MS = 90_000; // 果子再生时间（90 秒游戏内时间）

  const pickFruit = useCallback((fruitId: string, kind: FruitKind) => {
    // 加入物品栏：找到同类格合并计数，否则放第一个空格（工具槽 0-3 不覆盖）
    setInventory((prev) => {
      const next = [...prev];
      const existing = next.findIndex((s) => s.kind === `fruit_${kind}`);
      if (existing >= 0) {
        next[existing] = { ...next[existing], count: next[existing].count + 1 };
      } else {
        const emptyIdx = next.findIndex((s, i) => i >= 4 && s === undefined);
        const slot: InventorySlot = { kind: `fruit_${kind}`, label: FRUIT_ICON[kind].replace(/✨/, '') + (kind === 'golden_apple' ? '黄金苹果' : kind === 'apple' ? '苹果' : kind === 'orange' ? '橙子' : '浆果'), icon: FRUIT_ICON[kind], count: 1 };
        if (emptyIdx >= 0) next[emptyIdx] = slot;
        else next.push(slot);
      }
      return next;
    });
    // 标记为已摘，开始再生倒计时
    setFruitDepletion((prev) => new Map(prev).set(fruitId, Date.now()));
    const t = setTimeout(() => {
      setFruitDepletion((prev) => { const m = new Map(prev); m.delete(fruitId); return m; });
      fruitTimers.current.delete(fruitId);
    }, FRUIT_REGEN_MS);
    fruitTimers.current.set(fruitId, t);
  }, []);

  // 消耗工具耐久 1 点（耐久耗尽则移除该格）
  const useTool = useCallback((slotIdx: number) => {
    setInventory((prev) => {
      const next = [...prev];
      const s = next[slotIdx];
      if (!s || s.durability === undefined || s.maxDurability === undefined) return prev;
      const newDur = s.durability - 1;
      if (newDur <= 0) {
        next.splice(slotIdx, 1, undefined as unknown as InventorySlot);
      } else {
        next[slotIdx] = { ...s, durability: newDur };
      }
      return next;
    });
  }, []);

  const CHOP_REGEN_MS = 3 * 60 * 1000; // 3 分钟恢复

  const chopTree = useCallback((fruitId: string) => {
    setChoppedTrees((prev) => new Map(prev).set(fruitId, Date.now()));
    // 同时清除采摘状态（砍倒后果子消失）
    setFruitDepletion((prev) => { const m = new Map(prev); m.delete(fruitId); return m; });
    const t = setTimeout(() => {
      setChoppedTrees((prev) => { const m = new Map(prev); m.delete(fruitId); return m; });
      chopTimers.current.delete(fruitId);
    }, CHOP_REGEN_MS);
    chopTimers.current.set(fruitId, t);
  }, []);

  const plantGarden = useCallback((gardenId: string, crop: Crop) => {
    setGardenPlots((prev) => {
      const m = new Map(prev);
      const cur = m.get(gardenId);
      if (cur && cur.phase !== 'empty') return prev;
      m.set(gardenId, { phase: 'planted', crop, plantedAt: Date.now(), hash: plotHash(gardenId) });
      return m;
    });
  }, []);

  const waterGarden = useCallback((gardenId: string) => {
    setGardenPlots((prev) => {
      const m = new Map(prev);
      const cur = m.get(gardenId);
      if (!cur || cur.phase !== 'planted') return prev;
      m.set(gardenId, { ...cur, phase: 'watered', wateredAt: Date.now() });
      return m;
    });
  }, []);

  const harvestGarden = useCallback((gardenId: string) => {
    const cur = gardenPlots.get(gardenId);
    if (!cur || !cur.crop || cur.phase === 'empty') return;
    if (computeGardenStage(cur) < 3) return;
    const count = cur.wateredAt ? 2 : 1;
    setInventory((inv) => {
      const next = [...inv];
      const kind = `crop_${cur.crop!}`;
      const existing = next.findIndex((s) => s?.kind === kind);
      if (existing >= 0) {
        next[existing] = { ...next[existing], count: next[existing].count + count };
      } else {
        const emptyIdx = next.findIndex((s, i) => i >= 4 && s === undefined);
        const slot: InventorySlot = { kind, label: CROP_LABEL[cur.crop!], icon: CROP_ICON[cur.crop!], count };
        if (emptyIdx >= 0) next[emptyIdx] = slot;
        else next.push(slot);
      }
      return next;
    });
    setGardenPlots((prev) => { const m = new Map(prev); m.set(gardenId, { phase: 'empty' }); return m; });
  }, [gardenPlots]);

  const removeCrop = useCallback((gardenId: string) => {
    setGardenPlots((prev) => { const m = new Map(prev); m.set(gardenId, { phase: 'empty' }); return m; });
  }, []);

  useEffect(() => {
    if (!gardenHud) return;
    const handler = (e: KeyboardEvent) => {
      if (['1', '2', '3', '4', 'Escape'].indexOf(e.key) === -1) return;
      e.stopPropagation();
      const id = gardenHud.gardenId;
      const plot = gardenPlots.get(id) ?? { phase: 'empty' as const };
      if (e.key === 'Escape') { setGardenHud(null); return; }
      if (plot.phase === 'empty') {
        const OPTS: Crop[] = ['turnip', 'wheat', 'pumpkin', 'starfruit'];
        const idx = parseInt(e.key) - 1;
        if (idx >= 0 && idx < OPTS.length) { plantGarden(id, OPTS[idx]); setGardenHud(null); }
      } else {
        const stage = computeGardenStage(plot);
        if (e.key === '1') { stage >= 3 ? harvestGarden(id) : waterGarden(id); setGardenHud(null); }
        if (e.key === '2') { removeCrop(id); setGardenHud(null); }
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [gardenHud, gardenPlots, plantGarden, harvestGarden, waterGarden, removeCrop]);

  const addMineMaterial = useCallback((kind: MineAssetKind, count: number) => {
    const meta = MINE_KIND_META[kind];
    setInventory((prev) => addSlot(prev, {
      kind: `mine_mat_${kind}`,
      label: `${meta.label}材料`,
      icon: meta.icon,
      count,
    }));
  }, []);

  const addMineDiscovery = useCallback((depth: number, x: number, y: number, kind: MineAssetKind) => {
    const meta = MINE_KIND_META[kind];
    setInventory((prev) => addSlot(prev, {
      kind: `mine_disc_${depth}_${x}_${y}_${kind}`,
      label: `${meta.label}发现证明`,
      icon: meta.icon,
      count: 1,
      chain: { type: 'mine_discovery', depth, x, y, kind },
    }, true));
  }, []);

  const onInteract = useCallback((it: Interactable) => {
    const toolIdx = hotbarSelRef.current;
    const tool = inventoryRef.current[toolIdx];
    const toolKind = tool?.kind;

    if ((it.type === 'mine_rock' || it.type === 'mine_ore') && it.mine) {
      if (toolKind !== 'tool_pickaxe' && toolKind !== 'tool_hoe') {
        setStatus('需要装备矿镐才能凿开矿壁');
        return;
      }
      const key = mineTileKey(it.mine.depth, it.mine.x, it.mine.y);
      setMineMined((prev) => new Set(prev).add(key));
      useTool(toolIdx);
      if (it.mine.oreKind && isMineAssetKind(it.mine.oreKind)) {
        const kind = it.mine.oreKind;
        const meta = MINE_KIND_META[kind];
        const count = 1 + Math.floor(it.mine.depth / 3) + (meta.tier >= 4 ? 1 : 0);
        addMineMaterial(kind, count);
        if (meta.tier >= 3) addMineDiscovery(it.mine.depth, it.mine.x, it.mine.y, kind);
        setStatus(`⛏️ 获得 ${meta.label}材料 ×${count}${meta.tier >= 3 ? '，发现证明已入背包' : ''}`);
      } else {
        setStatus('⛏️ 凿开了一块岩壁');
      }
    } else if (it.type === 'mine_chest' && it.mine) {
      const key = mineTileKey(it.mine.depth, it.mine.x, it.mine.y);
      setMineChests((prev) => new Set(prev).add(key));
      const available = MINE_KINDS.filter((k) => MINE_KIND_META[k].minDepth <= it.mine!.depth);
      const kind = available[(it.mine.x * 31 + it.mine.y * 17 + it.mine.depth) % available.length] ?? 'copper';
      const count = 2 + Math.floor(it.mine.depth / 2);
      addMineMaterial(kind, count);
      setStatus(`🎁 宝箱里找到 ${MINE_KIND_META[kind].label}材料 ×${count}`);
    } else if (it.type === 'mine_monster' && it.mine) {
      const key = mineTileKey(it.mine.depth, it.mine.x, it.mine.y);
      setMineMonsters((prev) => new Set(prev).add(key));
      if (toolKind === 'tool_sword') {
        useTool(toolIdx);
        setStatus('🗡️ 击退了洞穴怪物');
      } else {
        setMineHp((hp) => Math.max(15, hp - 18));
        setStatus('受伤后勉强赶跑了怪物，带把剑会轻松很多');
      }
      if (it.mine.depth >= 3) addMineMaterial('void_crystal', 1);
    } else if (it.type === 'pedestal') {
      setTab('pets');
      setMenuOpen(true);
    } else if (it.type === 'board') {
      api.rooms().then(setDirList).catch(() => setDirList([]));
      api.feed('all', 80).then((r) => setFeedEvents(r.events)).catch(() => setFeedEvents([]));
      setDirOpen(true);
    } else if (it.type === 'rent') {
      setRentOpen(true);
    } else if (it.type === 'fishing') {
      setFishingOpen(true);
      if (toolKind === 'tool_rod') useTool(toolIdx);
    } else if ((it.type === 'plot' || it.type === 'crop') && it.farm) {
      setFarmAction(it.farm);
    } else if (it.type === 'fruit' && it.fruitId && it.fruitKind) {
      if (toolKind === 'tool_axe') {
        chopTree(it.fruitId);
        useTool(toolIdx);
      } else {
        pickFruit(it.fruitId, it.fruitKind);
      }
    } else if (it.type === 'garden' && it.gardenId) {
      const plot = gardenPlots.get(it.gardenId) ?? { phase: 'empty' as const };
      if (toolKind === 'tool_can' && (plot.phase === 'planted' || plot.phase === 'watered')) {
        waterGarden(it.gardenId);
        useTool(toolIdx);
      } else {
        setGardenHud({ gardenId: it.gardenId });
      }
    }
  }, [pickFruit, useTool, chopTree, waterGarden, gardenPlots, addMineMaterial, addMineDiscovery]);

  const onSceneChange = useCallback((id: string) => {
    setScene(id);
    if (!id.startsWith('mine:')) setMineHp(100);
    if (id !== 'room') {
      setEditMode(false);
      setVisit(null); // 走出他人房间的门 → 退出串门
    }
  }, []);

  // 串门:载入某人房间(只读) + 他的崽,切到其房间
  const visitRoom = useCallback(async (address: string, who?: string) => {
    setDirOpen(false);
    if (address !== wallet.address) api.visit(wallet.address, address).catch(() => {}); // 串门=访问记录(链下)
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
  }, [wallet.address]);

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

  const RENT_WEEK_COST = 70;  // 7 天租金 = 70 VOID（10/天）
  const BUY_ROOM_COST = 500; // 买断价格

  const rentRoom = useCallback(async (weeks: number) => {
    if (busy) return;
    setBusy(true);
    try {
      setStatus('租房上链：签名 + 烧币…');
      const { nonce } = await api.nonce(wallet.address);
      const cost = weeks * RENT_WEEK_COST;
      const memo = `ROOM:RENT:${weeks * 7}d`;
      const tx = createMessage(wallet, NULL_ADDRESS, memo, nonce, cost, MIN_FEE);
      const r = await api.submitTx(tx);
      setStatus('已广播，等矿工打包…');
      const ok = await waitConfirmed(r.txid);
      await refresh();
      setStatus(ok ? `✅ 成功租下 ${weeks} 周！` : '已广播，稍后生效');
      setRentOpen(false);
    } catch (e) {
      setStatus(`租房失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }, [busy, refresh, wallet]);

  const buyRoom = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      setStatus('买房上链：签名 + 烧币…');
      const { nonce } = await api.nonce(wallet.address);
      const tx = createMessage(wallet, NULL_ADDRESS, 'ROOM:BUY', nonce, BUY_ROOM_COST, MIN_FEE);
      const r = await api.submitTx(tx);
      setStatus('已广播，等矿工打包…');
      const ok = await waitConfirmed(r.txid);
      await refresh();
      setStatus(ok ? '✅ 房产已登记上链！' : '已广播，稍后生效');
      setRentOpen(false);
    } catch (e) {
      setStatus(`买房失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }, [busy, refresh, wallet]);

  const FRUIT_MINT_COST: Record<string, number> = { fruit_apple: 5, fruit_orange: 5, fruit_berry: 5, fruit_golden_apple: 50 };

  const mintItem = useCallback(async () => {
    if (!mintTarget || busy) return;
    setBusy(true);
    try {
      // 注：makeMineDiscovery/makeMineMaterial 返回的是 memo 字符串本身（非 {ok,memo}）——
      // 旧代码误判 made.ok/made.memo 导致矿物铸造恒抛错，此处一并修正为直接取字符串。
      let memo = '';
      let cost = 0;
      let discovery = false;
      if (mintTarget.chain?.type === 'mine_discovery' && isMineAssetKind(mintTarget.chain.kind)) {
        const { depth, x, y, kind } = mintTarget.chain;
        memo = makeMineDiscovery(depth, x, y, kind);
        cost = mineDiscoveryBurn(depth, kind);
        discovery = true;
      } else if (mintTarget.kind.startsWith('mine_mat_')) {
        const kind = mintTarget.kind.slice('mine_mat_'.length);
        if (!isMineAssetKind(kind)) throw new Error('未知矿洞材料');
        memo = makeMineMaterial(kind, mintTarget.count);
        cost = mineMaterialBurn(kind, mintTarget.count);
      } else {
        const kind = mintTarget.kind.replace('fruit_', '');
        cost = (FRUIT_MINT_COST[mintTarget.kind] ?? 10) * mintTarget.count;
        memo = `FRUIT:MINT:${kind}:${mintTarget.count}`;
      }
      // 矿物发现 = 稀有藏品 → 完整揭晓；批量果子/材料 → 轻量"已铭刻"确认（Q2）。
      const target = mintTarget;
      setMintTarget(null);
      const ok = await runReveal({
        label: discovery ? '矿物发现' : '铸造资产',
        memo,
        burn: cost,
        to: NULL_ADDRESS,
        bulk: discovery ? undefined : { icon: target.icon, label: target.label, count: target.count },
        resolve: discovery
          ? async (txid) => {
              const ms = await api.mines(wallet.address).catch(() => [] as MineAsset[]);
              const m = ms.find((x) => x.id === txid);
              if (!m) return null;
              return { kind: 'mine', icon: m.icon, rarity: mineRevealRarity(m.traits.rarity), name: m.label, sub: `第 ${m.depth ?? '?'} 层 · 纯度 ${m.traits.purity}` };
            }
          : undefined,
      });
      if (ok) setInventory((prev) => prev.filter((s) => s?.kind !== target.kind));
    } catch (e) {
      setStatus(`铸造失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }, [busy, mintTarget, runReveal, wallet.address]);

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

  // 🎒物品栏占位：背包系统后接，这里先弹个短提示，入口/位置已留。
  const showInvPlaceholder = useCallback(() => {
    setInvToast(true);
    if (invTimer.current) clearTimeout(invTimer.current);
    invTimer.current = setTimeout(() => setInvToast(false), 1800);
  }, []);

  // depletedFruits / choppedTreesSet / gardenStateMap（稳定引用）
  const depletedFruits = useMemo(() => new Set(fruitDepletion.keys()), [fruitDepletion]);
  const choppedTreesSet = useMemo(() => new Set(choppedTrees.keys()), [choppedTrees]);
  const gardenStateMap = useMemo<ReadonlyMap<string, GardenStateEntry>>(() => {
    const m = new Map<string, GardenStateEntry>();
    for (const [k, v] of gardenPlots) {
      const stage = computeGardenStage(v);
      const phase = v.phase !== 'empty' && stage === 3 ? 'ready' : v.phase;
      m.set(k, { phase, crop: v.crop, stage, hash: v.hash });
    }
    return m;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gardenPlots, gardenTick]);
  const mineState = useMemo(() => ({
    mined: mineMined,
    openedChests: mineChests,
    defeatedMonsters: mineMonsters,
  }), [mineMined, mineChests, mineMonsters]);

  // 工具提示：根据 nearby 类型 + 当前选中工具推导上下文提示
  const toolHint = useMemo(() => {
    if (!nearby) return null;
    const tk = inventory[hotbarSel]?.kind;
    if (nearby.type === 'fishing') return tk === 'tool_rod' ? '🎣 E: 垂钓（消耗鱼竿）' : 'E: 垂钓';
    if (nearby.type === 'fruit') return tk === 'tool_axe' ? `🪓 E: 砍树（消耗斧子）` : `E: ${nearby.label}`;
    if (nearby.type === 'garden') {
      if (tk === 'tool_can') return '🪣 E: 浇水（消耗水桶）';
      return 'E: 查看田地';
    }
    if (nearby.type === 'rent') return 'E: 查看租售详情';
    if (nearby.type === 'mine_rock') return tk === 'tool_pickaxe' || tk === 'tool_hoe' ? '⛏️ E: 凿开岩壁' : '需要矿镐';
    if (nearby.type === 'mine_ore') return tk === 'tool_pickaxe' || tk === 'tool_hoe' ? `⛏️ E: ${nearby.label}` : '需要矿镐';
    if (nearby.type === 'mine_chest') return '🎁 E: 打开宝箱';
    if (nearby.type === 'mine_monster') return tk === 'tool_sword' ? '🗡️ E: 击退怪物' : 'E: 赶跑怪物（会受伤）';
    if (nearby.type === 'door') return `E: ${nearby.label}`;
    return `E: ${nearby.label}`;
  }, [nearby, inventory, hotbarSel]);
  const mintTargetCost = useMemo(() => {
    if (!mintTarget) return 0;
    if (mintTarget.chain?.type === 'mine_discovery' && isMineAssetKind(mintTarget.chain.kind)) {
      return mineDiscoveryBurn(mintTarget.chain.depth, mintTarget.chain.kind);
    }
    if (mintTarget.kind.startsWith('mine_mat_')) {
      const kind = mintTarget.kind.slice('mine_mat_'.length);
      return isMineAssetKind(kind) ? mineMaterialBurn(kind, mintTarget.count) : 0;
    }
    return (FRUIT_MINT_COST[mintTarget.kind] ?? 10) * mintTarget.count;
  }, [mintTarget]);

  // 任一浮层打开时引擎已暂停（paused）→ 同时隐藏触屏方向/交互键，避免遮挡弹窗。
  const anyOverlay = menuOpen || fishingOpen || !!farmAction || dirOpen || !!profileAddr || !!gardenHud || rentOpen || !!mintTarget || !!reveal;
  const showTouch = !anyOverlay && !editMode;
  // D-pad 卸载（开浮层/进装修）时若有手指还按着，补发一次归零，避免角色卡着走。
  useEffect(() => {
    if (!showTouch) gameRef.current?.setTouchDir(0, 0);
  }, [showTouch]);

  return (
    <div className="game-root">
      <GameView
        ref={gameRef}
        address={wallet.address}
        petGene={visit ? visit.petGene : petGene}
        petFollow={!visit}
        furniture={furniture}
        theme={theme}
        editMode={editMode}
        paused={menuOpen || fishingOpen || !!farmAction || !!gardenHud || rentOpen || !!mintTarget || !!reveal}
        visit={visit ? { furniture: visit.furniture, theme: visit.theme } : null}
        farm={farm}
        depletedFruits={depletedFruits}
        choppedTrees={choppedTreesSet}
        gardenState={gardenStateMap}
        mineState={mineState}
        onToggleMenu={() => setMenuOpen((o) => !o)}
        onNearby={setNearby}
        onInteract={onInteract}
        onSceneChange={onSceneChange}
        onTileClick={onTileClick}
      />

      {showTouch && !editMode && (
        <Hotbar
          slots={inventory}
          selected={hotbarSel}
          onSelect={(i) => {
            setHotbarSel(i);
            // 双击已选中的果子格 → 开铸造面板
            if (i === hotbarSel) {
              const s = inventory[i];
              if (s?.kind?.startsWith('fruit_') || s?.kind?.startsWith('crop_') || s?.kind?.startsWith('mine_mat_') || s?.chain) setMintTarget(s);
            }
          }}
        />
      )}

      {showTouch && (
        <TouchControls
          onDir={(dx, dy) => gameRef.current?.setTouchDir(dx, dy)}
          onInteract={() => gameRef.current?.touchInteract()}
          onMenu={() => setMenuOpen(true)}
          onEdit={scene === 'room' && !visit ? () => { setEditMode(true); setSel(null); } : undefined}
          onInventory={showInvPlaceholder}
        />
      )}
      {invToast && <div className="inv-toast">🎒 背包开发中</div>}

      <div className="hud">
        <div className="hud-left">
          <span className="hud-place">
            {visit
              ? `🏠 ${visit.name ? '@' + visit.name : shortAddr(visit.address)} 的房间 ${visit.verified ? '✓已验证' : '⚠未验证'}`
              : scene === 'room'
                ? '🏠 我的房间'
                : scene === 'farm'
                  ? '🌾 我的农场'
                  : scene.startsWith('mine:')
                    ? `⛏️ 巨型矿洞 · 第 ${Number(scene.slice(5)) || 1} 层 · HP ${mineHp}/100`
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
          {toolHint
            ? <span className="hud-tool-hint">{toolHint}</span>
            : <>
                <span>WASD/方向键 移动</span>
                <span>E 交互</span>
                <span>Esc 菜单</span>
              </>}
          {status && status !== '就绪' ? <span className="hud-status">{busy ? <i className="spin" /> : null}{status}</span> : null}
        </div>
      )}

      {menuOpen && (
        <div className="menu-backdrop" onClick={() => setMenuOpen(false)}>
          <div className="menu" onClick={(e) => e.stopPropagation()}>
            <div className="menu-tabs">
              <button className={tab === 'codex' ? 'on' : ''} onClick={() => setTab('codex')}>图鉴</button>
              <button className={tab === 'pets' ? 'on' : ''} onClick={() => setTab('pets')}>崽</button>
              <button className={tab === 'fish' ? 'on' : ''} onClick={() => setTab('fish')}>鱼篓</button>
              <button className={tab === 'farm' ? 'on' : ''} onClick={() => setTab('farm')}>农场</button>
              <button className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>矿洞</button>
              <button className={tab === 'profile' ? 'on' : ''} onClick={() => setTab('profile')}>主页</button>
              <button className={tab === 'wallet' ? 'on' : ''} onClick={() => setTab('wallet')}>钱包</button>
              <button className="menu-close" onClick={() => setMenuOpen(false)}>✕</button>
            </div>
            {tab === 'codex' ? (
              <Codex pets={pets} fish={fish} crops={farm?.crops ?? []} mines={mines} address={wallet.address} name={name} />
            ) : tab === 'pets' ? (
              <PetsPanel pets={pets} balance={balance} busy={busy} onHatch={hatch} status={status} />
            ) : tab === 'fish' ? (
              <FishPanel fish={fish} canFish={nearby?.type === 'fishing'} onFish={() => { setMenuOpen(false); setFishingOpen(true); }} />
            ) : tab === 'farm' ? (
              <FarmPanel farm={farm} status={status} />
            ) : tab === 'mine' ? (
              <MinePanel mines={mines} />
            ) : tab === 'profile' ? (
              <MyProfilePanel address={wallet.address} onProfile={(a) => { setMenuOpen(false); setProfileAddr(a); }} />
            ) : (
              <WalletPanel address={wallet.address} name={name} balance={balance} />
            )}
          </div>
        </div>
      )}
      {dirOpen && (
        <TownBoard
          events={feedEvents}
          names={namesMap}
          list={dirList}
          self={wallet.address}
          onVisit={visitRoom}
          onProfile={(a) => setProfileAddr(a)}
          onClose={() => setDirOpen(false)}
        />
      )}
      {profileAddr && (
        <ProfileOverlay
          address={profileAddr}
          self={wallet.address}
          onVisit={visitRoom}
          onClose={() => setProfileAddr(null)}
        />
      )}
      {gardenHud && (() => {
        const plot = gardenPlots.get(gardenHud.gardenId) ?? { phase: 'empty' as const };
        const stage = computeGardenStage(plot);
        const isReady = plot.phase !== 'empty' && stage === 3;
        const CROP_OPTS: { crop: Crop; time: string }[] = [
          { crop: 'turnip', time: '45s' }, { crop: 'wheat', time: '75s' },
          { crop: 'pumpkin', time: '2分' }, { crop: 'starfruit', time: '3分' },
        ];
        return (
          <div className="garden-hud">
            {plot.phase === 'empty' ? (
              <>
                <span className="garden-hud-title">播种</span>
                {CROP_OPTS.map(({ crop, time }, i) => (
                  <button key={crop} className="garden-hud-btn"
                    onClick={() => { plantGarden(gardenHud.gardenId, crop); setGardenHud(null); }}>
                    <kbd className="garden-hud-key">{i + 1}</kbd>
                    {CROP_ICON[crop]} {CROP_LABEL[crop]}
                    <span className="garden-hud-time">{time}</span>
                  </button>
                ))}
              </>
            ) : (
              <>
                <span className="garden-hud-title">
                  {CROP_ICON[plot.crop!]} {CROP_LABEL[plot.crop!]}
                  {isReady ? ' · 可收获' : plot.phase === 'watered' ? ' · 💧加速' : ` · ${'🌱🌿🌿🌾'[stage]}`}
                </span>
                <button className={`garden-hud-btn${isReady ? ' garden-hud-harvest' : ''}`}
                  onClick={() => { isReady ? harvestGarden(gardenHud.gardenId) : waterGarden(gardenHud.gardenId); setGardenHud(null); }}>
                  <kbd className="garden-hud-key">1</kbd>
                  {isReady ? `🎉 收获 +${plot.wateredAt ? 2 : 1}` : (plot.phase === 'watered' ? '💧 已浇水' : '🪣 浇水')}
                </button>
                <button className="garden-hud-btn garden-hud-remove"
                  onClick={() => { removeCrop(gardenHud.gardenId); setGardenHud(null); }}>
                  <kbd className="garden-hud-key">2</kbd>🗑 拔除
                </button>
              </>
            )}
            <button className="garden-hud-close" onClick={() => setGardenHud(null)}>✕</button>
          </div>
        );
      })()}

      {rentOpen && (
        <div className="menu-backdrop" onClick={() => setRentOpen(false)}>
          <div className="menu" onClick={(e) => e.stopPropagation()}>
            <div className="menu-tabs">
              <button className="on">🏠 房间租售</button>
              <button className="menu-close" onClick={() => setRentOpen(false)}>✕</button>
            </div>
            <div className="panel">
              <p>此房为<strong>住宅单元</strong>，可租可买。拥有后可装修、发布、和其他玩家交易。</p>
              {roomOwnership && (
                <div className="rent-status">
                  {roomOwnership.type === 'buy'
                    ? '🏠 你已永久拥有此类房产'
                    : `📅 租约到期：${new Date(roomOwnership.expiryTs ?? 0).toLocaleDateString('zh-CN')}`}
                </div>
              )}
              <div className="rent-grid">
                <div className="rent-option">
                  <div className="rent-title">短租 · 1 周</div>
                  <div className="rent-price">70 $V0ID</div>
                  <button className="primary" disabled={busy || (balance ?? 0) < 70 + MIN_FEE}
                    onClick={() => rentRoom(1)}>
                    {busy ? '处理中…' : '租 1 周'}
                  </button>
                </div>
                <div className="rent-option">
                  <div className="rent-title">月租 · 4 周</div>
                  <div className="rent-price">280 $V0ID</div>
                  <button className="primary" disabled={busy || (balance ?? 0) < 280 + MIN_FEE}
                    onClick={() => rentRoom(4)}>
                    {busy ? '处理中…' : '租 4 周'}
                  </button>
                </div>
                <div className="rent-option rent-buy">
                  <div className="rent-title">买断永久</div>
                  <div className="rent-price">500 $V0ID</div>
                  <button className="primary" disabled={busy || (balance ?? 0) < 500 + MIN_FEE}
                    onClick={() => buyRoom()}>
                    {busy ? '处理中…' : '买断'}
                  </button>
                </div>
              </div>
              {status && status !== '就绪' && <p className="note" style={{ marginTop: 10 }}>{status}</p>}
            </div>
          </div>
        </div>
      )}

      {mintTarget && (
        <div className="menu-backdrop" onClick={() => setMintTarget(null)}>
          <div className="menu" onClick={(e) => e.stopPropagation()}>
            <div className="menu-tabs">
              <button className="on">⛏️ 铸造上链</button>
              <button className="menu-close" onClick={() => setMintTarget(null)}>✕</button>
            </div>
            <div className="panel">
              <div style={{ textAlign: 'center', fontSize: 48, margin: '12px 0' }}>{mintTarget.icon}</div>
              <p><strong>{mintTarget.label}</strong> × {mintTarget.count}</p>
              <p className="note">将此物品铸造成链上资产（烧 {mintTargetCost} $V0ID），永久上链可交易。</p>
              {(mintTarget.kind === 'fruit_golden_apple' || mintTarget.chain) && (
                <p className="note" style={{ color: '#f4c430' }}>★ 稀有物品，铸造后链上唯一标记！</p>
              )}
              <div className="catch-actions">
                <button className="primary" disabled={busy || mintTargetCost <= 0 || (balance ?? 0) < mintTargetCost + MIN_FEE}
                  onClick={mintItem}>
                  {busy ? '铸造中…' : '确认铸造'}
                </button>
                <button onClick={() => setMintTarget(null)}>取消</button>
              </div>
              {mintedAssets.length > 0 && (
                <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                  <p className="note">已铸链上资产：</p>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                    {mintedAssets.map((a) => (
                      <span key={a.kind} className="garden-phase-badge">
                        {a.kind} × {a.count}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {status && status !== '就绪' && <p className="note" style={{ marginTop: 8 }}>{status}</p>}
            </div>
          </div>
        </div>
      )}

      {fishingOpen && (
        <FishingModal
          wallet={wallet}
          balance={balance}
          onMintReveal={fishReveal}
          onClose={() => setFishingOpen(false)}
        />
      )}
      {farmAction && (
        <FarmActionModal
          action={farmAction}
          farm={farm}
          wallet={wallet}
          balance={balance}
          onCropReveal={cropReveal}
          onDone={() => refresh().catch(() => {})}
          onClose={() => setFarmAction(null)}
        />
      )}

      <RevealOverlay reveal={reveal} onClose={() => setReveal(null)} />
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

function FishPanel({ fish, canFish, onFish }: { fish: Catch[]; canFish?: boolean; onFish: () => void }) {
  // 图鉴预览：几个本地随机 hash，展示稀有度与鱼种长相（与崽图鉴同套路）。
  const samples = useMemo(() => Array.from({ length: 6 }, (_, i) => sha256Hex(`v0id-fish-sample-${i}`)), []);
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>我的鱼篓</h2>
        <button className="primary" onClick={onFish} disabled={!canFish} title={canFish ? '' : '请先走到鱼摊或水塘边按 E'}>
          {canFish ? '开钓 🎣' : '需在水边 🎣'}
        </button>
      </div>
      {fish.length === 0 ? (
        <p className="empty">还没钓到链上藏品。走到镇中心西端鱼摊或西北水塘边，按 E 开钓。钓中后可铸成链上渔获——鱼种由区块 hash 事后确定，谁也伪造不出传说鱼。</p>
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

function MinePanel({ mines }: { mines: MineAsset[] }) {
  const discoveries = mines.filter((m) => m.type === 'discovery');
  const materials = mines.filter((m) => m.type === 'material');
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>矿洞藏品</h2>
        <span className="tag">{discoveries.length} 发现 / {materials.length} 材料</span>
      </div>
      {mines.length === 0 ? (
        <p className="empty">还没有链上矿洞资产。去镇中心东侧进入巨型矿洞，采到稀有矿物后在快捷栏双击发现证明或材料铸造上链。</p>
      ) : (
        <div className="pet-grid">
          {mines.map((m) => (
            <div key={m.id} className={`pet-card rarity-${m.traits.rarity}`}>
              <div className="mine-icon">{m.icon}</div>
              <div className="pet-meta">
                <span className={`tag tag-${m.traits.rarity}`}>{RARITY_LABEL[m.traits.rarity]}</span>
                <strong style={{ fontSize: 12 }}>{m.label}</strong>
              </div>
              <code title={m.id}>{m.type === 'discovery' ? `第 ${m.depth} 层 · 纯度 ${m.traits.purity}` : `材料 ×${m.count}`}</code>
            </div>
          ))}
        </div>
      )}
      <h3>玩法</h3>
      <p className="note">矿镐凿墙和采矿，短剑轻战斗。三阶以上矿物会掉落发现证明；材料和证明都可以烧 $V0ID 铸成链上资产，后续可接交易、合成和升级。</p>
    </div>
  );
}

function WalletPanel({ address, name, balance }: { address: string; name: string; balance: number | null }) {
  const [copied, setCopied] = useState('');
  const [importing, setImporting] = useState(false);
  const [pk, setPk] = useState('');
  const [err, setErr] = useState('');
  const doImport = () => {
    const r = importPrivateKey(pk);
    if (r.ok) window.location.reload(); // 全应用以新钱包重载
    else setErr(r.error ?? '导入失败');
  };
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
        <button onClick={() => { navigator.clipboard?.writeText(exportPrivateKey()); setCopied('私钥已复制——妥善备份'); }}>导出私钥</button>
        <button onClick={() => { setImporting((v) => !v); setErr(''); setCopied(''); }}>{importing ? '收起导入' : '导入钱包'}</button>
      </div>
      {importing && (
        <div className="wallet-import">
          <p className="note" style={{ marginTop: 0 }}>
            粘贴你已有钱包的<strong>私钥</strong>（64 位十六进制，可带 0x）→ 切换到那个钱包。
            <br />⚠️ 会覆盖当前浏览器里的钱包；需要保留请先「导出私钥」备份。
          </p>
          <textarea
            className="pk-input"
            value={pk}
            onChange={(e) => { setPk(e.target.value); setErr(''); }}
            placeholder="私钥 hex…"
            rows={2}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          {err && <p className="panel-status err">{err}</p>}
          <div className="wallet-actions">
            <button className="primary" disabled={!pk.trim()} onClick={doImport}>导入并切换</button>
            <button onClick={() => { setImporting(false); setPk(''); setErr(''); }}>取消</button>
          </div>
        </div>
      )}
      {copied && <p className="panel-status">{copied}</p>}
      <p className="note">私钥只存在你的浏览器本地，永不上送服务器。这是自托管钱包。</p>
    </div>
  );
}
