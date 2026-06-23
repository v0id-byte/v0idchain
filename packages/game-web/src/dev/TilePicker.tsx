// 临时开发工具（?pick）：把 Kenney 图集铺成带坐标网格，一张截图即可读出每个瓦片的 (列,行)。
// 映射完成后此文件可删。
import { useEffect, useRef } from 'react';
import { loadAtlas, atlasImage, ATLAS_T } from '../engine/atlas';

const COLS = 57;
const ROWS = 31;

// 默认：全表概览（小格，标号每5）。#c0,r0,cols,rows：放大某区域、每格标 "c,r"，便于精确读坐标。
function parseRegion(): { c0: number; r0: number; cw: number; ch: number; zoom: boolean } {
  const m = location.hash.slice(1).split(',').map(Number);
  if (m.length === 4 && m.every((n) => Number.isFinite(n))) {
    return { c0: m[0], r0: m[1], cw: m[2], ch: m[3], zoom: true };
  }
  return { c0: 0, r0: 0, cw: COLS, ch: ROWS, zoom: false };
}

export default function TilePicker() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    (async () => {
      await loadAtlas();
      const img = atlasImage();
      const { c0, r0, cw, ch, zoom } = parseRegion();
      const CELL = zoom ? 60 : 22;
      const MX = zoom ? 4 : 30;
      const MY = zoom ? 4 : 22;
      const cv = ref.current!;
      const dpr = 2;
      cv.width = (MX + cw * CELL) * dpr;
      cv.height = (MY + ch * CELL) * dpr;
      cv.style.width = MX + cw * CELL + 'px';
      const ctx = cv.getContext('2d')!;
      ctx.scale(dpr, dpr);
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#15131d';
      ctx.fillRect(0, 0, cv.width, cv.height);
      if (img) {
        for (let r = 0; r < ch; r++)
          for (let c = 0; c < cw; c++)
            ctx.drawImage(img, (c0 + c) * 17, (r0 + r) * 17, ATLAS_T, ATLAS_T, MX + c * CELL, MY + r * CELL, CELL - 1, CELL - 1);
      }
      ctx.fillStyle = '#ffe08a';
      ctx.font = zoom ? 'bold 11px ui-monospace, Menlo, monospace' : '9px ui-monospace, Menlo, monospace';
      if (zoom) {
        for (let r = 0; r < ch; r++)
          for (let c = 0; c < cw; c++) {
            ctx.fillStyle = 'rgba(0,0,0,.6)';
            ctx.fillRect(MX + c * CELL, MY + r * CELL + CELL - 13, 30, 12);
            ctx.fillStyle = '#ffe08a';
            ctx.fillText(`${c0 + c},${r0 + r}`, MX + c * CELL + 1, MY + r * CELL + CELL - 3);
          }
      } else {
        for (let c = 0; c < cw; c += 5) ctx.fillText(String(c), MX + c * CELL + 2, MY - 6);
        for (let r = 0; r < ch; r += 5) ctx.fillText(String(r), 4, MY + r * CELL + CELL / 2);
      }
    })();
  }, []);
  return <canvas ref={ref} style={{ imageRendering: 'pixelated', display: 'block' }} />;
}
