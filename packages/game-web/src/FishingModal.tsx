// 钓鱼浮层：纯客户端 QTE（零延迟、不触链）+ 结算卡。
// 玩法（FISHING-DESIGN §3-4）：idle →(E)→ casting(300ms) →(随机1.5–5s)→ bite →(900ms 窗口)→ reeling(张力条 QTE) → caught / missed。
// 结算卡两按钮：留作纪念（不上链，仅本地计数）/ 铸成链上藏品（→ 交给 App 的统一揭晓仪式 onMintReveal：
//   投入虚空 → 等区块盖章 → 鱼种/稀有度由出块后 catchHash 事后确定，揭晓演出由 RevealOverlay 接管）。
// 关键红线：本浮层不直接发交易；上链铸造一律走 App 的 fishReveal（自转 + burn>0 + FISH| memo，零新发币路径）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FISH_BURN, MIN_FEE, sha256Hex, fishTraits } from '@v0idchain/core/browser';
import type { Wallet } from '@v0idchain/core/browser';
import { renderFish, RARITY_LABEL, fishName } from './fish-render';

type Phase = 'idle' | 'casting' | 'waiting' | 'bite' | 'reeling' | 'caught' | 'missed';

// QTE 参数（FISHING-DESIGN §3 推荐值）
const CAST_MS = 300;
const BITE_WINDOW_MS = 900; // 咬钩后多久内必须开始收线
const REEL_DURATION_MS = 2600; // 张力条总时长，耗尽=跑鱼
const HOLD_MS = 450; // 指针稳在绿区累计这么久=上鱼
const GREEN_LO = 0.42; // 绿区下界（0~1 张力位）
const GREEN_HI = 0.62; // 绿区上界
const REEL_RATE = 1.15; // 按住时指针右移速度（每秒张力）
const SLACK_RATE = 0.85; // 松开时指针左移速度

function FishCanvas({ catchHash, size = 132 }: { catchHash: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) renderFish(ref.current, catchHash, size);
  }, [catchHash, size]);
  return <canvas ref={ref} className="sprite" style={{ width: size, height: size }} />;
}

export default function FishingModal({
  wallet,
  balance,
  onMintReveal,
  onClose,
}: {
  wallet: Wallet;
  balance: number | null;
  onMintReveal: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [tension, setTension] = useState(0); // 0~1 张力位
  const [score, setScore] = useState(0); // 局战绩（本地）
  const [previewHash, setPreviewHash] = useState<string | null>(null); // 庆祝时的本地预览（非链上真鱼）
  const [busy, setBusy] = useState(false);
  const [kept, setKept] = useState(0); // 本会话“留作纪念”计数

  // QTE 运行态（用 ref 避免 effect 频繁重建）
  const holding = useRef(false); // 是否正按住（收线）
  const greenAccum = useRef(0); // 绿区累计时长
  const reelStart = useRef(0); // 收线开始时刻（performance.now）
  const reelElapsed = useRef(0); // 张力条已耗时（= now - reelStart）
  const raf = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canAfford = (balance ?? 0) >= FISH_BURN + MIN_FEE;

  const clearTimers = useCallback(() => {
    if (raf.current != null) cancelAnimationFrame(raf.current);
    if (timer.current != null) clearTimeout(timer.current);
    raf.current = null;
    timer.current = null;
  }, []);

  // 抛竿：idle → casting → waiting →（随机）→ bite
  const cast = useCallback(() => {
    clearTimers();
    setPreviewHash(null);
    setTension(0);
    setPhase('casting');
    timer.current = setTimeout(() => {
      setPhase('waiting');
      const wait = 1500 + Math.random() * 3500; // 1.5~5s
      timer.current = setTimeout(() => {
        setPhase('bite');
        // 咬钩窗口：BITE_WINDOW_MS 内没开始收线 → 跑鱼
        timer.current = setTimeout(() => {
          setPhase((p) => (p === 'bite' ? 'missed' : p));
        }, BITE_WINDOW_MS);
      }, wait);
    }, CAST_MS);
  }, [clearTimers]);

  // 进入 reeling：启动张力条 QTE 循环
  const startReeling = useCallback(() => {
    clearTimers();
    greenAccum.current = 0;
    reelElapsed.current = 0;
    reelStart.current = performance.now();
    holding.current = true; // 触发收线的那一下默认按住
    setTension(0.5); // 从中间起手
    setPhase('reeling');
    let last = reelStart.current;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); // 夹住 dt，标签页切回时不暴冲
      last = now;
      reelElapsed.current = now - reelStart.current;
      // 张力位移动：按住右移、松开左移；绿区累计
      setTension((prev) => {
        const next = Math.max(0, Math.min(1, prev + (holding.current ? REEL_RATE : -SLACK_RATE) * dt));
        if (next >= GREEN_LO && next <= GREEN_HI) greenAccum.current += dt * 1000;
        return next;
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [clearTimers]);

  // 张力条结算：监听 tension / 累计量。用一个独立 effect 在 reeling 期间轮询判定，避免在 raf 闭包里读旧 state。
  useEffect(() => {
    if (phase !== 'reeling') return;
    const id = setInterval(() => {
      // 线崩：指针顶到最右
      if (tension >= 0.995) {
        setPhase('missed');
        return;
      }
      // 收够：绿区累计达标
      if (greenAccum.current >= HOLD_MS) {
        setPhase('caught');
        return;
      }
      // 超时：张力条耗尽
      if (reelElapsed.current >= REEL_DURATION_MS) {
        setPhase('missed');
        return;
      }
    }, 60);
    return () => clearInterval(id);
  }, [phase, tension]);

  // 相位副作用：caught → 生成本地预览 + 计分；missed/caught → 停 raf
  useEffect(() => {
    if (phase === 'caught') {
      clearTimers();
      setScore((s) => s + 1);
      // 本地预览鱼（仅庆祝用，非链上真鱼）：用一次性随机种子，处处不同、即时反馈
      setPreviewHash(sha256Hex(`v0id-fish-preview-${wallet.address}-${Date.now()}-${Math.random()}`));
    } else if (phase === 'missed') {
      clearTimers();
    }
  }, [phase, clearTimers, wallet.address]);

  // 卸载清理
  useEffect(() => () => clearTimers(), [clearTimers]);

  // 统一动作入口：press=true 表示按下/按住，false 表示松开
  const onAction = useCallback(
    (press: boolean) => {
      if (press) {
        holding.current = true;
        if (phase === 'idle' || phase === 'caught' || phase === 'missed') {
          if (!busy) cast();
        } else if (phase === 'bite') {
          startReeling();
        }
      } else {
        holding.current = false;
      }
    },
    [phase, busy, cast, startReeling],
  );

  // 键鼠：E / 空格 / 鼠标按住 驱动 QTE
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.repeat) return;
      if (e.key === 'e' || e.key === 'E' || e.key === ' ') {
        e.preventDefault();
        onAction(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'e' || e.key === 'E' || e.key === ' ') onAction(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [onAction, onClose]);

  // 铸成链上藏品 → 交给 App 的统一揭晓仪式（投入虚空 → 区块盖章 → 稀有度揭晓由 RevealOverlay 接管）。
  // 仪式结束后本浮层回到 idle，可继续抛竿；铸造交易/真渔获完全由 App 的 fishReveal 处理。
  const mint = useCallback(async () => {
    if (busy || !canAfford) return;
    setBusy(true);
    try {
      await onMintReveal();
      setPhase('idle');
      setPreviewHash(null);
    } finally {
      setBusy(false);
    }
  }, [busy, canAfford, onMintReveal]);

  const keepAsMemory = useCallback(() => {
    setKept((k) => k + 1);
    setPhase('idle');
    setPreviewHash(null);
  }, []);

  const hint = useMemo(() => {
    switch (phase) {
      case 'idle':
        return '按 E / 空格 抛竿。';
      case 'casting':
        return '抛竿入水…';
      case 'waiting':
        return '静候鱼汛… 浮标轻晃，沉住气。';
      case 'bite':
        return '⚡ 咬钩了！立刻按住 E 收线！';
      case 'reeling':
        return '按住=收线（右移）· 松开=放线（左移）· 把指针稳在绿区！';
      case 'caught':
        return '🎣 上鱼！';
      case 'missed':
        return '🌀 跑了… 再来一竿。';
    }
  }, [phase]);

  return (
    <div className="menu-backdrop" onClick={onClose}>
      <div className="menu fishing-menu" onClick={(e) => e.stopPropagation()}>
        <div className="menu-tabs">
          <button className="on">🎣 钓鱼</button>
          <span className="fish-score">本局上鱼 {score} · 留念 {kept}</span>
          <button className="menu-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="panel fishing-panel">
          {/* 钓场可视区 */}
          <div className={`fishing-stage phase-${phase}`}>
            {phase === 'caught' && previewHash ? (
              <div className="catch-burst">
                <FishCanvas catchHash={previewHash} />
              </div>
            ) : (
              <div className="bobber-wrap">
                <div className={`bobber ${phase === 'bite' ? 'bite' : ''}`} />
                <div className="ripple" />
              </div>
            )}
          </div>

          {/* 张力条（仅 reeling 显示） */}
          {phase === 'reeling' && (
            <div className="tension-bar">
              <div className="tension-green" style={{ left: `${GREEN_LO * 100}%`, width: `${(GREEN_HI - GREEN_LO) * 100}%` }} />
              <div className="tension-pointer" style={{ left: `${tension * 100}%` }} />
            </div>
          )}

          <p className="fish-hint">{hint}</p>

          {/* 结算卡 */}
          {phase === 'caught' && (
            <div className="catch-card">
              {previewHash && <PreviewSummary catchHash={previewHash} />}
              <div className="catch-actions">
                <button className="ghost-btn" onClick={keepAsMemory} disabled={busy}>
                  留作纪念
                </button>
                <button className="primary" onClick={mint} disabled={busy || !canAfford}>
                  {busy ? '投入虚空…' : canAfford ? `铸成链上藏品（烧 ${FISH_BURN}）` : `余额不足（需 ${FISH_BURN + MIN_FEE}）`}
                </button>
              </div>
              <p className="note">
                日常瞎钓不烧币。鱼种由上链后的区块 hash 事后确定 —— 谁也伪造不出传说鱼。下方为本地预览，铸造后以链上真鱼为准。
              </p>
            </div>
          )}

          {/* 抛竿/再来按钮（非收线/咬钩时） */}
          {(phase === 'idle' || phase === 'waiting' || phase === 'casting') && (
            <div className="catch-actions">
              <button className="primary" disabled={phase !== 'idle' || busy} onClick={() => onAction(true)}>
                {phase === 'idle' ? '抛竿 (E)' : '…'}
              </button>
            </div>
          )}
          {phase === 'missed' && (
            <div className="catch-actions">
              <button className="primary" onClick={() => onAction(true)}>
                再来一竿 (E)
              </button>
            </div>
          )}
          {phase === 'bite' && (
            <div className="catch-actions">
              <button className="primary bite-btn" onMouseDown={() => startReeling()}>
                收线！(E)
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewSummary({ catchHash }: { catchHash: string }) {
  const t = fishTraits(catchHash);
  return (
    <div className={`catch-meta rarity-${t.rarity}`}>
      <span className={`tag tag-${t.rarity}`}>{RARITY_LABEL[t.rarity]}</span>
      <strong>{fishName(t)}</strong>
      <span className="fish-size">{t.sizeCm} cm{t.shiny ? ' · ✨闪光' : ''}</span>
      <span className="fish-preview-note">（本地预览）</span>
    </div>
  );
}
