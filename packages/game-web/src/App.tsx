import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createMessage,
  makePetMint,
  PET_HATCH_COST,
  MIN_FEE,
  sha256Hex,
  petTraits,
  fishTraits,
  NULL_ADDRESS,
} from '@v0idchain/core/browser';
import type { Pet, Catch, FarmView, Wallet, FeedEvent } from '@v0idchain/core/browser';
import { api, waitConfirmed } from './api';
import { loadOrCreateWallet, exportPrivateKey, importPrivateKey, shortAddr } from './wallet';
import { TownBoard, ProfileOverlay, MyProfilePanel } from './Social';
import { renderPet, RARITY_LABEL } from './pet-render';
import { renderFish, fishName } from './fish-render';
import FishingModal from './FishingModal';
import { FarmPanel, FarmActionModal } from './FarmPanel';
import GameView, { type GameHandle } from './game/GameView';
import TouchControls from './TouchControls';
import Hotbar, { DEFAULT_INVENTORY, type InventorySlot } from './Hotbar';
import type { Interactable, FurnitureItem, FarmRef, FruitKind } from './engine/scene';
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

type Tab = 'wallet' | 'pets' | 'fish' | 'farm' | 'profile';

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
  // 单机版公共菜地（gardenId → plot 状态）
  type GardenCrop = 'carrot' | 'wheat' | 'cabbage';
  type GardenPlot = { phase: 'empty' | 'tilled' | 'planted' | 'watered' | 'ready'; crop?: GardenCrop; plantedAt?: number; watered?: boolean };
  const [gardenPlots, setGardenPlots] = useState<Map<string, GardenPlot>>(new Map());
  const gardenTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // 附近的可交互物件（引擎回调）
  const [nearby, setNearby] = useState<Interactable | null>(null);
  // 公共菜地浮层 + 当前聚焦格
  const [gardenOpen, setGardenOpen] = useState(false);
  const [gardenFocusId, setGardenFocusId] = useState<string | null>(null);
  // 房间租售浮层
  const [rentOpen, setRentOpen] = useState(false);
  // 果子铸造浮层（选中的果子 slot）
  const [mintTarget, setMintTarget] = useState<InventorySlot | null>(null);

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
    setNamesMap(names);
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

  const GROW_MS: Record<string, number> = { carrot: 60_000, wheat: 90_000, cabbage: 120_000 };

  const tillGarden = useCallback((gardenId: string) => {
    setGardenPlots((prev) => {
      const m = new Map(prev);
      const cur = m.get(gardenId);
      if (!cur || cur.phase === 'empty') m.set(gardenId, { phase: 'tilled' });
      return m;
    });
  }, []);

  const plantGarden = useCallback((gardenId: string, crop: 'carrot' | 'wheat' | 'cabbage') => {
    const now = Date.now();
    setGardenPlots((prev) => {
      const m = new Map(prev);
      const cur = m.get(gardenId);
      if (!cur || (cur.phase !== 'tilled' && cur.phase !== 'empty')) return prev;
      m.set(gardenId, { phase: 'planted', crop, plantedAt: now });
      return m;
    });
    // 定时成熟
    const growMs = GROW_MS[crop] ?? 60_000;
    if (gardenTimers.current.has(gardenId)) clearTimeout(gardenTimers.current.get(gardenId)!);
    const t = setTimeout(() => {
      setGardenPlots((prev) => {
        const m = new Map(prev);
        const cur = m.get(gardenId);
        if (cur && (cur.phase === 'planted' || cur.phase === 'watered')) m.set(gardenId, { ...cur, phase: 'ready' });
        return m;
      });
      gardenTimers.current.delete(gardenId);
    }, growMs);
    gardenTimers.current.set(gardenId, t);
  }, []);

  const waterGarden = useCallback((gardenId: string) => {
    setGardenPlots((prev) => {
      const m = new Map(prev);
      const cur = m.get(gardenId);
      if (!cur || cur.phase !== 'planted') return prev;
      // 浇水后加速 2x：重置计时器，剩余时间减半
      const elapsed = Date.now() - (cur.plantedAt ?? Date.now());
      const growMs = (GROW_MS[cur.crop!] ?? 60_000);
      const remaining = Math.max(1000, (growMs - elapsed) / 2);
      m.set(gardenId, { ...cur, phase: 'watered', watered: true });
      if (gardenTimers.current.has(gardenId)) clearTimeout(gardenTimers.current.get(gardenId)!);
      const t = setTimeout(() => {
        setGardenPlots((p2) => {
          const m2 = new Map(p2);
          const c2 = m2.get(gardenId);
          if (c2 && (c2.phase === 'planted' || c2.phase === 'watered')) m2.set(gardenId, { ...c2, phase: 'ready' });
          return m2;
        });
        gardenTimers.current.delete(gardenId);
      }, remaining);
      gardenTimers.current.set(gardenId, t);
      return m;
    });
  }, []);

  const harvestGarden = useCallback((gardenId: string) => {
    setGardenPlots((prev) => {
      const m = new Map(prev);
      const cur = m.get(gardenId);
      if (!cur || cur.phase !== 'ready') return prev;
      // 收获后加入背包
      const crop = cur.crop!;
      const CROP_ICON: Record<string, string> = { carrot: '🥕', wheat: '🌾', cabbage: '🥬' };
      const CROP_LABEL: Record<string, string> = { carrot: '胡萝卜', wheat: '小麦', cabbage: '白菜' };
      const count = cur.watered ? 2 : 1;
      setInventory((inv) => {
        const next = [...inv];
        const existing = next.findIndex((s) => s?.kind === `crop_${crop}`);
        if (existing >= 0) {
          next[existing] = { ...next[existing], count: next[existing].count + count };
        } else {
          const emptyIdx = next.findIndex((s, i) => i >= 4 && s === undefined);
          const slot: InventorySlot = { kind: `crop_${crop}`, label: CROP_LABEL[crop], icon: CROP_ICON[crop], count };
          if (emptyIdx >= 0) next[emptyIdx] = slot;
          else next.push(slot);
        }
        return next;
      });
      m.set(gardenId, { phase: 'empty' });
      return m;
    });
  }, []);

  const onInteract = useCallback((it: Interactable) => {
    const toolIdx = hotbarSelRef.current;
    const tool = inventoryRef.current[toolIdx];
    const toolKind = tool?.kind;

    if (it.type === 'pedestal') {
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
      if (toolKind === 'tool_hoe') {
        tillGarden(it.gardenId);
        useTool(toolIdx);
      } else if (toolKind === 'tool_can') {
        waterGarden(it.gardenId);
        useTool(toolIdx);
      } else {
        setGardenFocusId(it.gardenId);
        setGardenOpen(true);
      }
    }
  }, [pickFruit, useTool, chopTree, tillGarden, waterGarden]);

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

  const mintFruit = useCallback(async () => {
    if (!mintTarget || busy) return;
    setBusy(true);
    try {
      setStatus('铸造果子：签名 + 烧币…');
      const { nonce } = await api.nonce(wallet.address);
      const kind = mintTarget.kind.replace('fruit_', '');
      const cost = (FRUIT_MINT_COST[mintTarget.kind] ?? 10) * mintTarget.count;
      const memo = `FRUIT:MINT:${kind}:${mintTarget.count}`;
      const tx = createMessage(wallet, NULL_ADDRESS, memo, nonce, cost, MIN_FEE);
      const r = await api.submitTx(tx);
      setStatus('已广播，等矿工打包…');
      const ok = await waitConfirmed(r.txid);
      await refresh();
      if (ok) {
        // 从背包移除已铸造的果子
        setInventory((prev) => prev.filter((s) => s?.kind !== mintTarget.kind));
        setStatus(`✅ ${mintTarget.icon} 已铸造上链！`);
      } else setStatus('已广播，稍后生效');
      setMintTarget(null);
    } catch (e) {
      setStatus(`铸造失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }, [busy, mintTarget, refresh, wallet]);

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

  // depletedFruits / choppedTreesSet（稳定引用）
  const depletedFruits = useMemo(() => new Set(fruitDepletion.keys()), [fruitDepletion]);
  const choppedTreesSet = useMemo(() => new Set(choppedTrees.keys()), [choppedTrees]);

  // 任一浮层打开时引擎已暂停（paused）→ 同时隐藏触屏方向/交互键，避免遮挡弹窗。
  const anyOverlay = menuOpen || fishingOpen || !!farmAction || dirOpen || !!profileAddr || gardenOpen || rentOpen || !!mintTarget;
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
        paused={menuOpen || fishingOpen || !!farmAction || gardenOpen || rentOpen || !!mintTarget}
        visit={visit ? { furniture: visit.furniture, theme: visit.theme } : null}
        farm={farm}
        depletedFruits={depletedFruits}
        choppedTrees={choppedTreesSet}
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
              if (s?.kind?.startsWith('fruit_') || s?.kind?.startsWith('crop_')) setMintTarget(s);
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
              <button className={tab === 'profile' ? 'on' : ''} onClick={() => setTab('profile')}>主页</button>
              <button className={tab === 'wallet' ? 'on' : ''} onClick={() => setTab('wallet')}>钱包</button>
              <button className="menu-close" onClick={() => setMenuOpen(false)}>✕</button>
            </div>
            {tab === 'pets' ? (
              <PetsPanel pets={pets} balance={balance} busy={busy} onHatch={hatch} status={status} />
            ) : tab === 'fish' ? (
              <FishPanel fish={fish} canFish={nearby?.type === 'fishing'} onFish={() => { setMenuOpen(false); setFishingOpen(true); }} />
            ) : tab === 'farm' ? (
              <FarmPanel farm={farm} status={status} />
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
      {gardenOpen && (
        <div className="menu-backdrop" onClick={() => { setGardenOpen(false); setGardenFocusId(null); }}>
          <div className="menu garden-modal" onClick={(e) => e.stopPropagation()}>
            <div className="menu-tabs">
              <button className="on">🌱 公共菜地</button>
              <button className="menu-close" onClick={() => { setGardenOpen(false); setGardenFocusId(null); }}>✕</button>
            </div>
            <div className="panel">
              <p className="note" style={{ marginBottom: 12 }}>锄头翻土 · 选种播种 · 水桶浇水 · 成熟收获</p>
              {gardenFocusId ? (() => {
                const plot = gardenPlots.get(gardenFocusId) ?? { phase: 'empty' as const };
                const CROP_OPTS: { crop: 'carrot'|'wheat'|'cabbage'; icon: string; label: string }[] = [
                  { crop: 'carrot', icon: '🥕', label: '胡萝卜 (60s)' },
                  { crop: 'wheat',  icon: '🌾', label: '小麦 (90s)' },
                  { crop: 'cabbage',icon: '🥬', label: '白菜 (120s)' },
                ];
                return (
                  <div className="garden-plot-detail">
                    <div className="garden-phase-badge">{
                      plot.phase === 'empty' ? '空地' :
                      plot.phase === 'tilled' ? '已翻土 ✔' :
                      plot.phase === 'planted' ? `已种 ${plot.crop}` :
                      plot.phase === 'watered' ? `已浇水 💧 ${plot.crop}` :
                      `✅ 可收获！${plot.crop}`
                    }</div>
                    {plot.phase === 'tilled' && (
                      <div className="garden-crops">
                        <p>选择种子：</p>
                        {CROP_OPTS.map(({ crop, icon, label }) => (
                          <button key={crop} className="primary" style={{ margin: 4 }}
                            onClick={() => { plantGarden(gardenFocusId, crop); setGardenOpen(false); }}>
                            {icon} {label}
                          </button>
                        ))}
                      </div>
                    )}
                    {(plot.phase === 'planted' || plot.phase === 'watered') && (
                      <p className="note">等待成熟…{plot.watered ? '（已浇水，加速中）' : '（用水桶浇水可加速）'}</p>
                    )}
                    {plot.phase === 'ready' && (
                      <button className="primary" onClick={() => { harvestGarden(gardenFocusId); setGardenOpen(false); }}>
                        🎉 收获！
                      </button>
                    )}
                    {plot.phase === 'empty' && (
                      <p className="note">先装备锄头（⛏️），走到这里按 E 翻土。</p>
                    )}
                  </div>
                );
              })() : (
                <p className="note">走到菜地格子按 E 交互，或装备工具直接操作。</p>
              )}
            </div>
          </div>
        </div>
      )}

      {rentOpen && (
        <div className="menu-backdrop" onClick={() => setRentOpen(false)}>
          <div className="menu" onClick={(e) => e.stopPropagation()}>
            <div className="menu-tabs">
              <button className="on">🏠 房间租售</button>
              <button className="menu-close" onClick={() => setRentOpen(false)}>✕</button>
            </div>
            <div className="panel">
              <p>此房为<strong>住宅单元</strong>，可租可买。拥有后可装修、发布、和其他玩家交易。</p>
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
              <p className="note">将此物品铸造成链上资产（烧 {(FRUIT_MINT_COST[mintTarget.kind] ?? 10) * mintTarget.count} $V0ID），永久上链可交易。</p>
              {mintTarget.kind === 'fruit_golden_apple' && (
                <p className="note" style={{ color: '#f4c430' }}>★ 稀有物品，铸造后链上唯一标记！</p>
              )}
              <div className="catch-actions">
                <button className="primary" disabled={busy || (balance ?? 0) < (FRUIT_MINT_COST[mintTarget.kind] ?? 10) * mintTarget.count + MIN_FEE}
                  onClick={mintFruit}>
                  {busy ? '铸造中…' : '确认铸造'}
                </button>
                <button onClick={() => setMintTarget(null)}>取消</button>
              </div>
              {status && status !== '就绪' && <p className="note" style={{ marginTop: 8 }}>{status}</p>}
            </div>
          </div>
        </div>
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
