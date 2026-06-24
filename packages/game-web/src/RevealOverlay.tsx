// 铸造揭晓仪式：把"静默 setStatus"换成三幕演出 —— 投入虚空 → 区块盖章 → 稀有度揭晓。
// 关键：这套悬念是真的 —— 鱼/作物/矿的稀有度由**出块后**的区块 hash 事后确定（见 fishing/farm 的 catchHash/cropHash），
// 此前不可预测。我们只是把这个一直隐形的"抽卡瞬间"演出来。崽的基因虽在签名时已定，但玩家同样事前不知 → 也是揭晓。
// 接入点：孵崽 / 钓鱼铸造 / 作物收获 / 矿物发现（稀有 gacha 走完整三幕；批量果子/材料走轻量"已铭刻"确认）。
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Rarity, Crop } from '@v0idchain/core/browser';
import { renderPet, RARITY_LABEL } from './pet-render';
import { renderFish } from './fish-render';
import { renderCrop } from './crop-render';

/** 揭晓结果（按子系统区分；rarity 统一用前导 0 比特那套 common/rare/epic/legendary）。 */
export type RevealResult =
  | { kind: 'pet'; gene: string; rarity: Rarity; name: string; sub: string }
  | { kind: 'fish'; catchHash: string; rarity: Rarity; name: string; sub: string }
  | { kind: 'crop'; crop: Crop; hash: string; rarity: Rarity; name: string; sub: string }
  | { kind: 'mine'; icon: string; rarity: Rarity; name: string; sub: string };

/** 仪式状态机：sealing（投入虚空 + 等区块确认）→ reveal（盖章 + 揭晓 / 轻量确认 / 失败兜底）。 */
export interface RevealState {
  stage: 'sealing' | 'reveal';
  label: string; // 动作名："孵化崽" / "铸造渔获" / "收获作物" / "矿物发现"
  burn: number;
  blockHeight?: number; // 盖章区块高度
  failed?: boolean; // 广播了但未在超时内确认
  bulk?: { icon: string; label: string; count: number }; // 轻量确认（批量果子/材料），无稀有 gacha
  result?: RevealResult; // 稀有 gacha 揭晓
}

const RARITY_GLOW: Record<Rarity, string> = {
  common: '#9b94ad',
  rare: '#54a8ff',
  epic: '#b66bff',
  legendary: '#ffce3d',
};

/** 揭晓主角的像素 sprite（崽/鱼/作物走各自渲染器；矿用大 emoji 图标）。 */
function RevealSprite({ result, size = 128 }: { result: RevealResult; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    if (result.kind === 'pet') renderPet(c, result.gene, size);
    else if (result.kind === 'fish') renderFish(c, result.catchHash, size);
    else if (result.kind === 'crop') renderCrop(c, result.crop, result.hash, size, 3);
  }, [result, size]);
  if (result.kind === 'mine') return <div className="reveal-mine-icon">{result.icon}</div>;
  return <canvas ref={ref} className="sprite reveal-sprite" style={{ width: size, height: size }} />;
}

export default function RevealOverlay({ reveal, onClose }: { reveal: RevealState | null; onClose: () => void }) {
  // 仪式分步入场（盖章 → 主角 → 文案），用一个 step 计时器驱动 CSS 阶段，避免一次性炸出来。
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (reveal?.stage !== 'reveal' || reveal.failed) return;
    setStep(0);
    const t1 = setTimeout(() => setStep(1), 340); // 主角弹出
    const t2 = setTimeout(() => setStep(2), 720); // 稀有度/文案
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [reveal?.stage, reveal?.failed, reveal?.result]);

  // Esc / 点背景关闭（仅在 reveal 阶段允许；sealing 时不让关，等链确认）。
  useEffect(() => {
    if (reveal?.stage !== 'reveal') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reveal?.stage, onClose]);

  if (!reveal) return null;

  const result = reveal.result;
  const legendary = result?.rarity === 'legendary';
  const glow = result ? RARITY_GLOW[result.rarity] : '#9b94ad';

  return (
    <div className="reveal-backdrop" onClick={reveal.stage === 'reveal' ? onClose : undefined}>
      <div
        className={`reveal-card${legendary ? ' reveal-legendary' : ''}`}
        style={result ? ({ '--glow': glow } as CSSProperties) : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {reveal.stage === 'sealing' ? (
          // 幕一 · 投入虚空：烧币沉入、等出块盖章（此刻区块 hash 还没定，稀有度真未知）
          <div className="reveal-sealing">
            <div className="reveal-vortex">
              <span className="reveal-vortex-core" />
            </div>
            <div className="reveal-burn">
              −{reveal.burn} <em>$V0ID</em> 投入虚空
            </div>
            <div className="reveal-wait">
              <i className="spin" />
              等待区块盖章…
            </div>
            <p className="reveal-note">稀有度由出块后的区块 hash 事后确定——此刻还没人知道。</p>
          </div>
        ) : reveal.failed ? (
          // 兜底：广播了但未在超时内确认
          <div className="reveal-done">
            <div className="reveal-stamp reveal-stamp-pending">⛓</div>
            <h3 className="reveal-title">已广播 · 等待上链</h3>
            <p className="reveal-note">{reveal.label}交易已进入网络，区块稍后确认。可在「图鉴」中查看结果。</p>
            <button className="primary reveal-ok" onClick={onClose}>
              知道了
            </button>
          </div>
        ) : reveal.bulk ? (
          // 轻量确认：批量果子/材料铸造（非稀有 gacha）
          <div className="reveal-done">
            <div className="reveal-stamp">✦</div>
            <div className="reveal-bulk-icon">{reveal.bulk.icon}</div>
            <h3 className="reveal-title">已铭刻上链</h3>
            <p className="reveal-bulk-meta">
              {reveal.bulk.label} × {reveal.bulk.count}
            </p>
            <p className="reveal-note">永久记于虚空，链上可验证。</p>
            <button className="primary reveal-ok" onClick={onClose}>
              收下
            </button>
          </div>
        ) : result ? (
          // 幕二/三 · 区块盖章 + 稀有度揭晓
          <div className={`reveal-done reveal-step-${step}`}>
            <div className="reveal-stamp">{legendary ? '★' : '✓'}</div>
            <div className="reveal-sprite-wrap" style={{ '--glow': glow } as CSSProperties}>
              <span className="reveal-halo" />
              <RevealSprite result={result} size={132} />
            </div>
            <span className={`tag tag-${result.rarity} reveal-rarity`}>{RARITY_LABEL[result.rarity]}</span>
            <h3 className="reveal-name">{result.name}</h3>
            <p className="reveal-sub">{result.sub}</p>
            <p className="reveal-note reveal-forge">虚空已为你永久盖章 · 不可伪造</p>
            <button className="primary reveal-ok" onClick={onClose}>
              收入图鉴
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
