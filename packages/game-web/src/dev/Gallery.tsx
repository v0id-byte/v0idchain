// ?gallery → 美术建模验收台（开发用，验收完即可移除）。
// 用真实引擎函数离屏渲染：建筑墙面纹理 / 地面场景变体 / 场景专属道具，放大显示便于逐像素核对。
import { useEffect, useRef } from 'react';
import { loadAtlas } from '../engine/atlas';
import { buildingCanvas } from '../engine/buildings';
import { buildFurniture } from '../engine/sprites';
import { drawGroundTile } from '../engine/ground';

const BUILDINGS: [string, number, number][] = [
  ['house', 4, 4], ['cottage', 4, 4], ['tudor', 5, 5],
  ['house3', 4, 4], ['bank', 4, 5], ['chapel', 4, 5],
  ['farmhouse', 5, 5], ['grocer', 4, 5], ['smithy', 4, 5],
  // R3 木板墙：barn/mossy=竖板 board-and-batten，cottage/saltbox=横板 clapboard
  ['barn', 5, 5], ['mossy', 4, 4], ['saltbox', 4, 5],
];
const GROUND = ['grass', 'grassForest', 'dirt', 'sand', 'sandWet', 'plank', 'cobble', 'stone', 'stoneRuins', 'water'];
const NEW_GROUND = new Set(['grassForest', 'sandWet', 'plank', 'stoneRuins']);
const PROPS = ['piling', 'shell', 'driftwood', 'brokenColumn', 'rubble', 'standingStone', 'stall',
  'flowerBucket', 'breadRack', 'coalPile', 'kegStack', 'cropSack', 'bookStack', 'potionShelf', 'signboard',
  'table', 'fence', 'mailbox'];
const NEW_PROP = new Set(['piling', 'shell', 'driftwood', 'brokenColumn', 'rubble', 'standingStone', 'stall',
  'flowerBucket', 'breadRack', 'coalPile', 'kegStack', 'cropSack', 'bookStack', 'potionShelf', 'signboard']);

export default function Gallery() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      await loadAtlas();
      if (!alive || !ref.current) return;
      const cv = ref.current;
      const ctx = cv.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#15131c';
      ctx.fillRect(0, 0, cv.width, cv.height);
      const W = cv.width;
      const pad = 24;
      const sub = (t: string, y: number) => { ctx.fillStyle = '#f3ece0'; ctx.font = 'bold 18px monospace'; ctx.fillText(t, pad, y); ctx.font = '13px monospace'; };
      const tag = (t: string, x: number, y: number, hot = false) => { ctx.fillStyle = hot ? '#ffcf6b' : '#cdbfa6'; ctx.font = '13px monospace'; ctx.fillText(t, x, y); };

      // ── Buildings：墙面纹理（逐块石砌 / 灰泥颗粒 + 木骨架） ──
      let y = pad + 18;
      sub('① Buildings — 墙面纹理 (timber 灰泥颗粒 + 木纹 / stone 逐块石砌 + 缝隙青苔)', y);
      y += 18;
      let x = pad, rowH = 0;
      const sB = 3;
      for (const [style, bw, bh] of BUILDINGS) {
        const img = buildingCanvas(style, bw, bh, 1);
        const dw = img.width * sB, dh = img.height * sB;
        if (x + dw > W - pad) { x = pad; y += rowH + 30; rowH = 0; }
        ctx.drawImage(img, x, y, dw, dh);
        tag(`${style} ${bw}×${bh}`, x, y + dh + 17);
        x += dw + 26; rowH = Math.max(rowH, dh);
      }
      y += rowH + 46;

      // ── Ground：场景专属变体 ── (5×5 tile 拼块)
      sub('② Ground — 场景变体 (★ = 新增)', y);
      y += 18; x = pad;
      const tp = 15, gN = 5, patch = tp * gN;
      for (const name of GROUND) {
        if (x + patch > W - pad) { x = pad; y += patch + 32; }
        for (let ty = 0; ty < gN; ty++) for (let tx = 0; tx < gN; tx++) drawGroundTile(ctx, name, x + tx * tp, y + ty * tp, tp, tx, ty);
        ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, patch, patch);
        const hot = NEW_GROUND.has(name);
        tag((hot ? '★ ' : '') + name, x, y + patch + 17, hot);
        x += patch + 24;
      }
      y += patch + 50;

      // ── Props：场景专属道具（草地背景上展示） ──
      sub('③ Props — 场景专属道具 (★ = 新增，替代占位件)', y);
      y += 18; x = pad;
      const furn = buildFurniture() as Record<string, HTMLCanvasElement | undefined>;
      const sP = 5, pp = 16 * sP;
      for (const kind of PROPS) {
        const img = furn[kind];
        if (!img) continue;
        if (x + pp > W - pad) { x = pad; y += pp + 32; }
        drawGroundTile(ctx, 'grass', x, y, pp, 0, 0);
        ctx.drawImage(img, x, y, pp, pp);
        ctx.strokeStyle = '#000'; ctx.strokeRect(x + 0.5, y + 0.5, pp, pp);
        const hot = NEW_PROP.has(kind);
        tag((hot ? '★ ' : '') + kind, x, y + pp + 17, hot);
        x += pp + 24;
      }
    })();
    return () => { alive = false; };
  }, []);
  return (
    <div style={{ width: '100vw', height: '100vh', overflow: 'auto', background: '#15131c' }}>
      <canvas ref={ref} width={1180} height={1700} style={{ display: 'block', margin: '0 auto', imageRendering: 'pixelated' }} />
    </div>
  );
}
