// 农场面板 + 动作浮层。仿 PetsPanel/FishPanel（菜单 Tab 总览）+ FishingModal（上链动作）。
// 关键红线：买地/建区块/种植/收获都只发一笔“自转 + 烧币 + memo”交易（系统零增发），照搬 App.hatch 的签名上链路径，
// 不碰 faucet/央行私钥。动作由世界地图的交互点（FarmRef）触发 → App 设 action → 本浮层弹对应表单。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createMessage,
  makeLandBuy,
  makeZone,
  makePlant,
  makeHarvest,
  ZONE_COST,
  HARVEST_BURN,
  SEED_COST,
  GROW_BLOCKS,
  CROPS,
  cropGrowth,
  MIN_FEE,
  sha256Hex,
} from '@v0idchain/core/browser';
import type { FarmView, Crop, Wallet, HarvestedCrop } from '@v0idchain/core/browser';
import type { FarmRef } from './engine/scene';
import { api, waitConfirmed } from './api';
import { renderCrop, CROP_NAME, QUALITY_LABEL, cropFullName, cropTraits } from './crop-render';

function CropSprite({ crop, hash, size = 84, stage = 3 }: { crop: Crop; hash: string; size?: number; stage?: 0 | 1 | 2 | 3 }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) renderCrop(ref.current, crop, hash, size, stage);
  }, [crop, hash, size, stage]);
  return <canvas ref={ref} className="sprite" style={{ width: size, height: size }} />;
}

function HarvestedCard({ c, size = 84 }: { c: HarvestedCrop; size?: number }) {
  const t = c.traits;
  return (
    <div className={`pet-card rarity-${t.quality}`}>
      <CropSprite crop={c.crop} hash={c.hash} size={size} />
      <div className="pet-meta">
        <span className={`tag tag-${t.quality}`}>{QUALITY_LABEL[t.quality]}</span>
        <strong style={{ fontSize: 12 }}>{cropFullName(t)}</strong>
        <code title={c.id}>{t.weightG} g{t.giant ? ' · 巨' : ''}</code>
      </div>
    </div>
  );
}

/** 菜单 Tab：农场总览（地块/区块数 + 动态地价）+ 仓库（已收获作物）+ 图鉴预览。 */
export function FarmPanel({ farm, status }: { farm: FarmView | null; status: string }) {
  const dex = useMemo(
    () => CROPS.map((crop) => ({ crop, hash: sha256Hex(`v0id-crop-sample-${crop}`) })),
    [],
  );
  const plots = farm?.plots ?? [];
  const zones = farm?.zones ?? [];
  const crops = farm?.crops ?? [];
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>我的农场</h2>
        <span className="big-bal">
          地价 {farm ? farm.landPrice : '—'} <em>$V0ID</em>
        </span>
      </div>
      <div className="kv"><span className="k">已解锁地块</span><span className="v">{plots.length} 块</span></div>
      <div className="kv"><span className="k">田地区块</span><span className="v">{zones.length} 个</span></div>
      <div className="kv"><span className="k">仓库收成</span><span className="v">{crops.length} 件</span></div>
      <p className="note">
        从房间「去我的农场」的门进入农场。空地块按 E 建田地，田地空格按 E 选作物种植，作物成熟后按 E 收获为链上收藏作物。
        买地、建区块、种子、收获都只烧币（系统零增发），收成只能 P2P 卖给别人（后续开放）。
      </p>
      {status && status !== '就绪' && <p className="panel-status">{status}</p>}

      <h3>仓库 · 链上收藏作物</h3>
      {crops.length === 0 ? (
        <p className="empty">还没有收成。去农场种点东西，成熟后收获——品质由收获后的区块 hash 事后确定，谁也伪造不出黄金作物。</p>
      ) : (
        <div className="pet-grid">
          {crops.map((c) => <HarvestedCard key={c.id} c={c} />)}
        </div>
      )}

      <h3>图鉴 · 作物种类</h3>
      <div className="pet-grid">
        {dex.map(({ crop, hash }) => (
          <div key={crop} className="pet-card">
            <CropSprite crop={crop} hash={hash} size={72} />
            <div className="pet-meta">
              <strong style={{ fontSize: 12 }}>{CROP_NAME[crop]}</strong>
              <code>种 {SEED_COST[crop]} · {GROW_BLOCKS[crop]}块</code>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 农场动作浮层：由世界交互点（FarmRef）触发，按 kind 弹买地/建田地/种植/收获表单，
 * 确认后照搬 hatch() 本地签名上链（自转 + 烧币 + memo），完成后回调刷新农场状态。
 */
export function FarmActionModal({
  action,
  farm,
  wallet,
  balance,
  onCropReveal,
  onDone,
  onClose,
}: {
  action: FarmRef;
  farm: FarmView | null;
  wallet: Wallet;
  balance: number | null;
  onCropReveal: (plantId: string) => Promise<boolean>;
  onDone: () => void;
  onClose: () => void;
}) {
  const [crop, setCrop] = useState<Crop>('turnip');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  // H1 修复：买地烧的不是“快照价”，而是“当前价 × 1.05 向上取整”的 buffer。
  // 地价是 parseFarm 入块时按截至该笔前的全网状态**重算**的（随行情上涨），快照价可能在确认前被别人买地推高；
  // parseFarm 只要求 burn ≥ price，故在 5% 内涨价仍通过，多烧的部分照样全进虚空（合法、不破零增发）→ 避免“烧了币、没拿到地、币不退”。
  const buyBurn = farm ? Math.ceil(farm.landPrice * 1.05) : 0;

  // 本动作的烧币额（用于余额校验与文案）
  const burnFor = (): number => {
    if (action.kind === 'buy') return buyBurn;
    if (action.kind === 'plot') return ZONE_COST;
    if (action.kind === 'slot') return SEED_COST[crop];
    if (action.kind === 'crop') return HARVEST_BURN;
    return 0;
  };
  const burn = burnFor();
  const canAfford = (balance ?? 0) >= burn + MIN_FEE;

  // 构造 memo（按 kind）。返回 null = 入参非法（理论上不会，世界交互点已确保合法）。
  const buildMemo = (): { memo: string; burn: number } | null => {
    if (action.kind === 'buy') {
      const r = makeLandBuy(action.plotN ?? 0);
      return r.ok && r.memo ? { memo: r.memo, burn: buyBurn } : null; // 多烧 5% buffer（见 buyBurn 注释）
    }
    if (action.kind === 'plot') {
      const r = makeZone(action.plotN ?? 0, 'farmland');
      return r.ok && r.memo ? { memo: r.memo, burn: ZONE_COST } : null;
    }
    if (action.kind === 'slot') {
      const r = makePlant(action.zoneId ?? '', crop, action.slot ?? 0);
      return r.ok && r.memo ? { memo: r.memo, burn: SEED_COST[crop] } : null;
    }
    if (action.kind === 'crop') {
      const r = makeHarvest(action.plantId ?? '');
      return r.ok && r.memo ? { memo: r.memo, burn: HARVEST_BURN } : null;
    }
    return null;
  };

  const submit = useCallback(async () => {
    if (busy || !canAfford) return;
    // 收获 → 走 App 的统一揭晓仪式（铸造 + 揭晓 + 刷新由 App 接管）；本浮层即时关闭，避免与揭晓层叠加。
    if (action.kind === 'crop') {
      onCropReveal(action.plantId ?? '');
      onClose();
      return;
    }
    // H2 前置校验：同格并发种植/收获是「链序首胜、败者烧费不退」（见 GAME-PROTOCOL §7.8）。
    // 提交前用最新 farm 快照再判一次该格是否已被占用，挡掉「两标签页 / 快照未刷新就重复点」的自撞——
    // 不能根治（快照可能滞后链状态），但能显著降低白烧概率。
    if (action.kind === 'slot') {
      const taken = (farm?.plants ?? []).some((p) => p.zoneId === action.zoneId && p.slot === action.slot && !p.harvested);
      if (taken) { setMsg('该格已被占用（可能刚有一笔种植已确认）——换个空格，避免重复烧种子费'); return; }
    }
    const built = buildMemo();
    if (!built) { setMsg('参数无效'); return; }
    setBusy(true);
    try {
      setMsg('本地签名 + 烧币…');
      const { nonce } = await api.nonce(wallet.address);
      const tx = createMessage(wallet, wallet.address, built.memo, nonce, built.burn, MIN_FEE);
      const r = await api.submitTx(tx);
      setMsg('已广播，等待矿工打包…');
      const ok = await waitConfirmed(r.txid);
      setMsg(ok ? '✅ 已上链' : '已广播，稍后生效');
      onDone();
      if (ok) setTimeout(onClose, 700);
    } catch (e) {
      setMsg(`失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }, [busy, canAfford, wallet, crop, action, onCropReveal, onDone, onClose]);

  const title =
    action.kind === 'buy' ? '开垦新地块'
      : action.kind === 'plot' ? `地块 #${action.plotN} · 建田地`
        : action.kind === 'slot' ? '种植作物'
          : '收获';

  // 收获浮层：展示该作物的成长状态
  const plant = action.kind === 'crop' ? (farm?.plants ?? []).find((p) => p.id === action.plantId) : undefined;
  const growth = plant && farm ? cropGrowth(plant.plantHeight, farm.height, plant.crop) : 0;

  return (
    <div className="menu-backdrop" onClick={onClose}>
      <div className="menu" onClick={(e) => e.stopPropagation()}>
        <div className="menu-tabs">
          <button className="on">🌾 {title}</button>
          <button className="menu-close" onClick={onClose}>✕</button>
        </div>
        <div className="panel">
          {action.kind === 'buy' && (
            <>
              <p>向系统开垦你的第 <strong>#{action.plotN}</strong> 块专属农场地块。</p>
              <p className="note">地价随全网行情浮动（卖得越多、最近抢得越凶越贵），全网同价、链上可复算。开垦的币烧进虚空，系统不增发。</p>
              <div className="kv"><span className="k">当前地价</span><span className="v">{farm?.landPrice ?? '—'} $V0ID</span></div>
              <div className="kv"><span className="k">实际烧币</span><span className="v">{burn} $V0ID（烧）</span></div>
              <p className="note">实际烧币 = 当前地价 ×1.05（<strong>含市场波动缓冲</strong>）：地价可能在确认前被别人买地推高，多烧 5% 缓冲可避免“涨价后开垦失效、烧币不退”。在缓冲内涨价仍成功，多烧部分照样进虚空。</p>
            </>
          )}
          {action.kind === 'plot' && (
            <>
              <p>在地块 <strong>#{action.plotN}</strong> 上建一个<strong>田地</strong>区块，可种 6 格作物。</p>
              <div className="kv"><span className="k">建造费</span><span className="v">{ZONE_COST} $V0ID（烧）</span></div>
            </>
          )}
          {action.kind === 'slot' && (
            <>
              <p>选择要种的作物：</p>
              <div className="crop-pick">
                {CROPS.map((c) => (
                  <button
                    key={c}
                    className={`palette-item ${crop === c ? 'on' : ''}`}
                    onClick={() => setCrop(c)}
                    title={CROP_NAME[c]}
                  >
                    <CropSprite crop={c} hash={sha256Hex(`v0id-crop-sample-${c}`)} size={48} />
                    <span>{CROP_NAME[c]}</span>
                  </button>
                ))}
              </div>
              <div className="kv"><span className="k">种子费</span><span className="v">{SEED_COST[crop]} $V0ID（烧）</span></div>
              <div className="kv"><span className="k">成熟</span><span className="v">约 {GROW_BLOCKS[crop]} 个区块后</span></div>
              <p className="note">成长按区块高度推进，全网/跨端一致。种子烧进虚空，系统不增发。</p>
            </>
          )}
          {action.kind === 'crop' && plant && (
            <>
              <div style={{ display: 'flex', justifyContent: 'center', margin: '8px 0' }}>
                <CropSprite crop={plant.crop} hash={plant.id} stage={growth >= 1 ? 3 : growth >= 0.66 ? 2 : growth >= 0.25 ? 1 : 0} size={120} />
              </div>
              <div className="kv"><span className="k">作物</span><span className="v">{CROP_NAME[plant.crop]}</span></div>
              <div className="kv"><span className="k">成长</span><span className="v">{Math.floor(growth * 100)}%{growth >= 1 ? ' · 可收' : ''}</span></div>
              {growth < 1 ? (
                <p className="note">还没成熟。成长按区块高度推进，再等 {Math.max(0, GROW_BLOCKS[plant.crop] - (farm!.height - plant.plantHeight))} 个区块。</p>
              ) : (
                <p className="note">收获 → 产出一件链上收藏作物，品质由收获后的区块 hash 事后确定（前导 0 比特越多越稀有，同崽/鱼）。烧 {HARVEST_BURN} 收获费。</p>
              )}
            </>
          )}

          {msg && <p className="panel-status">{busy ? <i className="spin" /> : null}{msg}</p>}

          <div className="catch-actions">
            <button className="ghost-btn" onClick={onClose} disabled={busy}>取消</button>
            {action.kind === 'crop' && growth < 1 ? null : (
              <button className="primary" onClick={submit} disabled={busy || !canAfford}>
                {canAfford
                  ? action.kind === 'buy' ? `开垦（烧 ${burn}）`
                    : action.kind === 'plot' ? `建田地（烧 ${ZONE_COST}）`
                      : action.kind === 'slot' ? `种植（烧 ${SEED_COST[crop]}）`
                        : `收获（烧 ${HARVEST_BURN}）`
                  : `余额不足（需 ${burn + MIN_FEE}）`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export { cropTraits };
