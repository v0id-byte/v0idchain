// Kenney Roguelike/RPG 图集（CC0）加载与绘制。16×16 瓦片，1px 间距 ⇒ stride 17。
// 源图 public/assets/roguelike.png（57×31 格）。署名见 THIRD-PARTY-NOTICES.md。
export const ATLAS_T = 16;
const STRIDE = 17;
const SRC = 'assets/roguelike.png';

let img: HTMLImageElement | null = null;
let loading: Promise<void> | null = null;

export function loadAtlas(): Promise<void> {
  if (loading) return loading;
  loading = new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      img = im;
      resolve();
    };
    im.onerror = () => resolve(); // 加载失败也不卡死（引擎有程序化兜底）
    im.src = SRC;
  });
  return loading;
}

export function atlasReady(): boolean {
  return img !== null;
}
export function atlasImage(): HTMLImageElement | null {
  return img;
}

/** 把图集第 (col,row) 格画到目标 (dx,dy) 处、边长 size。imageSmoothing 应由调用方关掉。 */
export function drawAtlasTile(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  dx: number,
  dy: number,
  size: number,
): void {
  if (!img) return;
  ctx.drawImage(img, col * STRIDE, row * STRIDE, ATLAS_T, ATLAS_T, dx, dy, size, size);
}
