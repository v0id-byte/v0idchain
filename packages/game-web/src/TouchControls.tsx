// 触屏控件（仅 pointer:coarse / 窄屏显示）：左下虚拟方向键 + 右下交互键 + 顶部触屏 HUD 按钮。
// 方向键：每个箭头独立按住（多点触控 → 可斜向），合成 (dx,dy) 经 onDir 推给引擎；松手归零。
// 交互键 = E/确认 → onInteract（进门/钓鱼/种地/收获/名册）。物品栏暂为占位，点了弹提示。
// 不破坏桌面键盘：本组件只在触屏显示，且只“注入”输入，引擎移动/交互逻辑与键盘共用。
import { useCallback, useRef, useState } from 'react';

type Dir = 'up' | 'down' | 'left' | 'right';
const VEC: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

export interface TouchControlsProps {
  onDir: (dx: number, dy: number) => void;
  onInteract: () => void;
  onMenu: () => void;
  onEdit?: () => void; // 仅自己房间场景传入 → 显示🔨装修
  onInventory: () => void; // 🎒物品栏（占位）
}

export default function TouchControls({ onDir, onInteract, onMenu, onEdit, onInventory }: TouchControlsProps) {
  // 当前按住的方向集合（多点触控可同时多个）→ 合成移动向量。用 ref 持有最新集合，避免闭包陈旧。
  const activeRef = useRef<Set<Dir>>(new Set());
  const [active, setActive] = useState<Set<Dir>>(new Set()); // 仅驱动 :active 视觉高亮

  const pushVec = useCallback(() => {
    let dx = 0;
    let dy = 0;
    for (const d of activeRef.current) {
      dx += VEC[d][0];
      dy += VEC[d][1];
    }
    onDir(Math.sign(dx), Math.sign(dy));
  }, [onDir]);

  const press = useCallback(
    (d: Dir, e: React.PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      activeRef.current.add(d);
      setActive(new Set(activeRef.current));
      pushVec();
    },
    [pushVec],
  );
  const release = useCallback(
    (d: Dir) => {
      if (!activeRef.current.delete(d)) return;
      setActive(new Set(activeRef.current));
      pushVec();
    },
    [pushVec],
  );

  const dpadBtn = (d: Dir, glyph: string, cls: string) => (
    <button
      className={`tc-dir ${cls} ${active.has(d) ? 'on' : ''}`}
      aria-label={d}
      onPointerDown={(e) => press(d, e)}
      onPointerUp={() => release(d)}
      onPointerCancel={() => release(d)}
      onPointerLeave={(e) => { if (e.buttons) release(d); }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {glyph}
    </button>
  );

  return (
    <>
      <div className="tc-hud">
        <button className="tc-hud-btn" aria-label="菜单" onClick={onMenu}>☰</button>
        {onEdit && <button className="tc-hud-btn" aria-label="装修" onClick={onEdit}>🔨</button>}
        <button className="tc-hud-btn" aria-label="物品栏" onClick={onInventory}>🎒</button>
      </div>

      <div className="tc-dpad" onContextMenu={(e) => e.preventDefault()}>
        {dpadBtn('up', '▲', 'tc-up')}
        {dpadBtn('left', '◀', 'tc-left')}
        {dpadBtn('right', '▶', 'tc-right')}
        {dpadBtn('down', '▼', 'tc-down')}
      </div>

      <button
        className="tc-action"
        aria-label="交互"
        onPointerDown={(e) => { e.preventDefault(); onInteract(); }}
        onContextMenu={(e) => e.preventDefault()}
      >
        E
      </button>
    </>
  );
}
