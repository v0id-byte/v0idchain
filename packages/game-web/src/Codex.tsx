// 虚空图鉴（Void Codex）—— 脊椎：把四类链上藏品（崽/鱼/作物/矿）聚合成一面可炫耀、链上可验证、不可伪造的收藏墙。
// v1 纯客户端聚合 refresh() 已加载的数据，零服务端改动。留存用"收集欲"实现（宝可梦式完成度），非打卡式。
// 只收录**链上**资产（可验证、不可伪造 = 图鉴的全部意义）；单机菜地 / 背包果子不计入。
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { N_SPECIES, CROPS, MINE_KINDS } from '@v0idchain/core/browser';
import type { Pet, Catch, HarvestedCrop, MineAsset, Rarity, Crop } from '@v0idchain/core/browser';
import { renderPet, RARITY_LABEL, petTraits } from './pet-render';
import { renderFish, fishName } from './fish-render';
import { renderCrop, cropFullName, QUALITY_LABEL } from './crop-render';
import { shortAddr } from './wallet';
import { downloadBragCard, type ShowcaseItem } from './brag-card';

const RANK: Record<Rarity, number> = { common: 0, rare: 1, epic: 2, legendary: 3 };
const RARITY_ORDER: Rarity[] = ['common', 'rare', 'epic', 'legendary'];

/** 矿洞稀有度（含 uncommon）映射到标准四档，用于统一展示/排序。 */
function mineRarity(r: MineAsset['traits']['rarity']): Rarity {
  return r === 'legendary' ? 'legendary' : r === 'epic' ? 'epic' : r === 'rare' || r === 'uncommon' ? 'rare' : 'common';
}

function PetSp({ gene, size = 64, evo = 0 }: { gene: string; size?: number; evo?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) renderPet(ref.current, gene, size, evo);
  }, [gene, size, evo]);
  return <canvas ref={ref} className="sprite" style={{ width: size, height: size }} />;
}
function FishSp({ catchHash, size = 64 }: { catchHash: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) renderFish(ref.current, catchHash, size);
  }, [catchHash, size]);
  return <canvas ref={ref} className="sprite" style={{ width: size, height: size }} />;
}
function CropSp({ crop, hash, size = 64 }: { crop: Crop; hash: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) renderCrop(ref.current, crop, hash, size, 3);
  }, [crop, hash, size]);
  return <canvas ref={ref} className="sprite" style={{ width: size, height: size }} />;
}

export default function Codex({
  pets,
  fish,
  crops,
  mines,
  address,
  name,
}: {
  pets: Pet[];
  fish: Catch[];
  crops: HarvestedCrop[];
  mines: MineAsset[];
  address: string;
  name: string;
}) {
  const agg = useMemo(() => {
    // 稀有度战绩墙：崽 + 鱼 + 作物（同一套前导 0 比特稀有度）。矿用纯度档，单列计数不混入。
    const tally: Record<Rarity, number> = { common: 0, rare: 0, epic: 0, legendary: 0 };
    for (const p of pets) tally[petTraits(p.gene).rarity]++;
    for (const f of fish) tally[f.traits.rarity]++;
    for (const c of crops) tally[c.traits.quality]++;

    // 镇馆之宝：所有藏品按稀有度降序取前 5。
    const flat: (ShowcaseItem & { rank: number })[] = [
      ...pets.map((p) => {
        const t = petTraits(p.gene);
        return { kind: 'pet' as const, gene: p.gene, rarity: t.rarity, label: `${RARITY_LABEL[t.rarity]}崽`, rank: RANK[t.rarity] };
      }),
      ...fish.map((f) => ({ kind: 'fish' as const, catchHash: f.catchHash, rarity: f.traits.rarity, label: fishName(f.traits), rank: RANK[f.traits.rarity] })),
      ...crops.map((c) => ({ kind: 'crop' as const, crop: c.crop, hash: c.hash, rarity: c.traits.quality, label: cropFullName(c.traits), rank: RANK[c.traits.quality] })),
      ...mines.map((m) => {
        const r = mineRarity(m.traits.rarity);
        return { kind: 'mine' as const, icon: m.icon, rarity: r, label: m.label, rank: RANK[r] };
      }),
    ];
    const showcase = [...flat].sort((a, b) => b.rank - a.rank).slice(0, 5);

    // 收集完成度（宝可梦式）：鱼种 / 作物 / 矿物。
    const fishTotal = N_SPECIES.common + N_SPECIES.rare + N_SPECIES.epic + N_SPECIES.legendary;
    const completion = [
      { label: '鱼种', have: new Set(fish.map((f) => `${f.traits.rarity}:${f.traits.species}`)).size, of: fishTotal },
      { label: '作物', have: new Set(crops.map((c) => c.crop)).size, of: CROPS.length },
      { label: '矿物', have: new Set(mines.map((m) => m.kind)).size, of: MINE_KINDS.length },
    ];

    const total = pets.length + fish.length + crops.length + mines.length;
    return { tally, showcase, completion, total };
  }, [pets, fish, crops, mines]);

  const onShare = () =>
    downloadBragCard({
      owner: name ? `@${name}` : shortAddr(address),
      total: agg.total,
      rarity: agg.tally,
      completion: agg.completion,
      showcase: agg.showcase,
    });

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>虚空图鉴 · {agg.total} 件藏品</h2>
        <button className="primary" onClick={onShare} disabled={agg.total === 0} title={agg.total === 0 ? '先铸一件藏品' : '生成像素战绩卡 PNG'}>
          分享战绩卡
        </button>
      </div>

      {/* 稀有度战绩墙 */}
      <div className="codex-wall">
        {RARITY_ORDER.map((r) => (
          <div key={r} className={`codex-tile rarity-${r}${agg.tally[r] > 0 ? ' has' : ''}`}>
            <span className="codex-tile-n">{agg.tally[r]}</span>
            <span className={`tag tag-${r}`}>{RARITY_LABEL[r]}</span>
          </div>
        ))}
      </div>
      <p className="note" style={{ marginTop: 8 }}>稀有度 = 链上区块 hash 的前导 0 比特数（越多越稀有，谁也伪造不了）——崽 / 鱼 / 作物同此一套。</p>

      {/* 收集完成度 */}
      <h3>收集完成度</h3>
      <div className="codex-bars">
        {agg.completion.map((c) => (
          <div key={c.label} className="codex-bar">
            <span className="codex-bar-label">{c.label}</span>
            <span className="codex-bar-track">
              <span className="codex-bar-fill" style={{ width: `${c.of > 0 ? (c.have / c.of) * 100 : 0}%` }} />
            </span>
            <span className="codex-bar-num">{c.have} / {c.of}</span>
          </div>
        ))}
      </div>

      {/* 藏品墙：四类 */}
      <CodexSection title={`崽 · ${pets.length}`} empty={pets.length === 0} hint="去基座孵化一只链上基因崽。">
        {pets.map((p) => {
          const t = petTraits(p.gene);
          return (
            <div key={p.id} className={`pet-card rarity-${t.rarity}`}>
              <PetSp gene={p.gene} evo={p.evo ?? 0} />
              <div className="pet-meta">
                <span className={`tag tag-${t.rarity}`}>{RARITY_LABEL[t.rarity]}</span>
                {p.parents && <span className="tag pet-bred" title="繁育而生">子</span>}
              </div>
            </div>
          );
        })}
      </CodexSection>

      <CodexSection title={`鱼 · ${fish.length}`} empty={fish.length === 0} hint="到水边按 E 开钓，铸成链上渔获。">
        {fish.map((f) => (
          <div key={f.id} className={`pet-card rarity-${f.traits.rarity}`}>
            <FishSp catchHash={f.catchHash} />
            <div className="pet-meta">
              <span className={`tag tag-${f.traits.rarity}`}>{RARITY_LABEL[f.traits.rarity]}</span>
              <strong style={{ fontSize: 11 }}>{fishName(f.traits)}</strong>
            </div>
          </div>
        ))}
      </CodexSection>

      <CodexSection title={`作物 · ${crops.length}`} empty={crops.length === 0} hint="去农场种菜，成熟后收获为链上收藏作物。">
        {crops.map((c) => (
          <div key={c.id} className={`pet-card rarity-${c.traits.quality}`}>
            <CropSp crop={c.crop} hash={c.hash} />
            <div className="pet-meta">
              <span className={`tag tag-${c.traits.quality}`}>{QUALITY_LABEL[c.traits.quality]}</span>
              <strong style={{ fontSize: 11 }}>{cropFullName(c.traits)}</strong>
            </div>
          </div>
        ))}
      </CodexSection>

      <CodexSection title={`矿洞 · ${mines.length}`} empty={mines.length === 0} hint="进东侧矿洞采矿，把发现证明/材料铸成链上资产。">
        {mines.map((m) => (
          <div key={m.id} className={`pet-card rarity-${mineRarity(m.traits.rarity)}`}>
            <div className="mine-icon">{m.icon}</div>
            <div className="pet-meta">
              <strong style={{ fontSize: 11 }}>{m.label}</strong>
              <code>{m.type === 'discovery' ? `纯度 ${m.traits.purity}` : `×${m.count ?? 1}`}</code>
            </div>
          </div>
        ))}
      </CodexSection>
    </div>
  );
}

function CodexSection({ title, empty, hint, children }: { title: string; empty: boolean; hint: string; children: ReactNode }) {
  return (
    <>
      <h3>{title}</h3>
      {empty ? <p className="empty">{hint}</p> : <div className="pet-grid">{children}</div>}
    </>
  );
}
