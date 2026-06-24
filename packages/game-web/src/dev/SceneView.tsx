// ?scene=<id>&s=<scale> → 静态场景验收（开发用）。用真实 build* + 引擎绘制基元渲染一整张静帧，
// 无需链后端，供核对路径/道具/建筑在场景中的实际效果。id=town/beach/forest/nightmarket/ruins。
import { useEffect, useRef } from 'react';
import { loadAtlas, drawAtlasTile } from '../engine/atlas';
import { buildTown, buildBeach, buildForest, buildNightMarket, buildRuins, type Scene } from '../engine/scene';
import { GROUND_KINDS, drawGroundTile } from '../engine/ground';
import { tileCoord, furnitureCoord } from '../engine/tileset';
import { buildFurniture, TILE } from '../engine/sprites';
import { treeCanvas, treeVariant, TREE_W, TREE_H } from '../engine/foliage';
import { buildingCanvas } from '../engine/buildings';
import { EFFECTS, phaseOf } from '../engine/effects';

const FLAT = new Set(['rug', 'bed', 'fence', 'shell']);

function buildScene(id: string): Scene {
  if (id === 'beach') return buildBeach();
  if (id === 'forest') return buildForest();
  if (id === 'nightmarket') return buildNightMarket();
  if (id === 'ruins') return buildRuins();
  return buildTown();
}

export default function SceneView() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      await loadAtlas();
      if (!alive || !ref.current) return;
      const params = new URLSearchParams(location.search);
      const id = params.get('scene') || 'town';
      const scale = Math.max(1, Math.min(3, Number(params.get('s')) || 2));
      const S = scale * TILE;
      const sc = buildScene(id);
      // 可选区域裁剪 ?rx&ry&rw&rh（瓦片坐标）：只渲染一块、画布恰好那么大 ⇒ 免滚动直接截图。
      const num = (k: string, def: number) => { const v = Number(params.get(k)); return params.get(k) !== null && Number.isFinite(v) ? v : def; };
      const rx = num('rx', 0), ry = num('ry', 0), rw = num('rw', sc.w), rh = num('rh', sc.h);
      const cv = ref.current;
      cv.width = rw * S;
      cv.height = rh * S;
      cv.style.width = rw * S + 'px';
      cv.style.height = rh * S + 'px';
      cv.style.maxWidth = 'none';
      const ctx = cv.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.translate(-rx * S, -ry * S);
      const furn = buildFurniture() as Record<string, HTMLCanvasElement | undefined>;
      const t = 0.6; // 静帧时间（火苗/水波定格在一个好看相位）

      // 地面层
      for (let y = 0; y < sc.h; y++)
        for (let x = 0; x < sc.w; x++) {
          const name = sc.tiles[y][x];
          const dx = x * S, dy = y * S;
          if (GROUND_KINDS.has(name)) drawGroundTile(ctx, name, dx, dy, S, x, y);
          else { const c = tileCoord(name, x, y); if (c) drawAtlasTile(ctx, c[0], c[1], dx, dy, S); }
        }

      const shadow = (cx: number, by: number, wpx: number) => {
        ctx.save(); ctx.globalAlpha = 0.18; ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.ellipse(cx, by, wpx * 0.5, wpx * 0.22, 0, 0, 7); ctx.fill(); ctx.restore();
      };

      // y-排序的物件层（家具/树/建筑/特效）
      const ds: { y: number; draw: () => void }[] = [];
      for (const f of sc.furniture) {
        const dx = f.x * S, dy = f.y * S;
        if (f.kind === 'tree') {
          const img = treeCanvas(treeVariant(f.x, f.y));
          const bx = (f.x + 0.5) * S, by = (f.y + 1) * S, tw = TREE_W * S, th = TREE_H * S;
          ds.push({ y: f.y, draw: () => { shadow(bx, by, S * 0.95); ctx.drawImage(img, bx - tw / 2, by - th, tw, th); } });
          continue;
        }
        const coord = furnitureCoord(f.kind, f.x, f.y);
        const flat = FLAT.has(f.kind);
        if (coord) ds.push({ y: f.y, draw: () => { if (!flat) shadow(dx + S / 2, dy + S - S * 0.12, S * 0.62); drawAtlasTile(ctx, coord[0], coord[1], dx, dy, S); } });
        else { const img = furn[f.kind]; if (img) ds.push({ y: f.y, draw: () => { if (!flat) shadow(dx + S / 2, dy + S - S * 0.12, S * 0.62); ctx.drawImage(img, dx, dy, S, S); } }); }
      }
      for (const b of sc.buildings) {
        const img = buildingCanvas(b.style, b.w, b.h, b.variant ?? 0);
        const dx = b.x * S, dy = b.y * S, bw = b.w * S, bh = b.h * S;
        ds.push({ y: b.y + b.h - 1, draw: () => { shadow(dx + bw / 2, dy + bh - 2, bw * 0.92); ctx.drawImage(img, dx, dy, bw, bh); } });
      }
      for (const e of sc.effects) {
        const drawer = EFFECTS[e.kind]; if (!drawer) continue;
        const dx = e.x * S, dy = e.y * S, depth = e.kind === 'chimneySmoke' ? 1e6 : e.y;
        ds.push({ y: depth, draw: () => drawer(ctx, dx, dy, S, t, phaseOf(e.x, e.y)) });
      }
      ds.sort((a, b) => a.y - b.y);
      for (const d of ds) d.draw();
    })();
    return () => { alive = false; };
  }, []);
  return <div style={{ width: '100vw', height: '100vh', overflow: 'auto', background: '#0c0b12' }}><canvas ref={ref} style={{ display: 'block', imageRendering: 'pixelated' }} /></div>;
}
