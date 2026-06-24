// 2D 游戏引擎（最小、星露谷式）：相机跟随、瓦片渲染、按 y 深度排序、四向行走、碰撞、交互。
// 刻意保持精简（PRD 反模式：别先把整引擎建完）。React 只管菜单浮层与数据，世界由本引擎跑。
import { Input } from './input.js';
import {
  TILE,
  buildTiles,
  buildFurniture,
  buildCharacter,
  hueFromAddress,
  type Dir,
  type CharFrames,
  type TileSet,
  type FurnitureKind,
} from './sprites.js';
import type { Scene, Interactable, CropSprite, MineObject } from './scene.js';
import { renderPet } from '../pet-render.js';
import { renderCrop } from '../crop-render.js';
import { loadAtlas, atlasReady, drawAtlasTile } from './atlas.js';
import { tileCoord, furnitureCoord } from './tileset.js';
import { EFFECTS, drawWaterShimmer, swayAngle, phaseOf } from './effects.js';
import { buildingCanvas } from './buildings.js';
import { GROUND_KINDS, drawGroundTile, setGroundSprite } from './ground.js';
import { treeCanvas, treeVariant, TREE_W, TREE_H } from './foliage.js';
import { loadMineSprites, mineSprite, type MineSpriteKey } from './mine-sprites.js';

const SWAY_KINDS = new Set(['flower']); // 随风轻摆的装饰（绕底部中心微旋）
const FLAT_KINDS = new Set(['rug', 'bed', 'fence']); // 贴地/铺地类家具：不画落地接触阴影（§7-B）
const AIRBORNE_FX = new Set(['chimneySmoke', 'fishHang']); // 悬空动态物件：不落地，无接触阴影

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const DELTA: Record<Dir, [number, number]> = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] };

export interface OtherPlayer {
  address: string;
  name?: string;
  x: number;
  y: number;
  dir: Dir;
}
export interface GameCallbacks {
  onInteract: (it: Interactable) => void;
  onToggleMenu: () => void;
  onMove?: (x: number, y: number, dir: Dir, sceneId: string) => void;
  onNearby?: (it: Interactable | null) => void;
  onTileClick?: (tx: number, ty: number, sceneId: string) => void; // 编辑模式：点格子放/删家具
}

export class GameEngine {
  private ctx: CanvasRenderingContext2D;
  private input = new Input();
  private raf = 0;
  private last = 0;
  private paused = false;
  private scene!: Scene;
  private tiles: TileSet;
  private furniture: Partial<Record<FurnitureKind, HTMLCanvasElement>>;
  private char: CharFrames;
  private px = 0;
  private py = 0;
  private dir: Dir = 'down';
  private moving = false;
  private animT = 0;
  private frame = 0;
  private time = 0; // 全局动画时钟（秒）；菜单暂停时仍推进，让世界保持呼吸
  private scale = 3;
  private petCanvas: HTMLCanvasElement | null = null;
  private petFollowX = 0; // 宠物跟随位置（瓦片坐标）
  private petFollowY = 0;
  private petFollowInit = false; // 首帧/换场景时吸附到玩家身边，避免从老位置滑过来
  private petFollowEnabled = true; // 自家场景跟随；串门(false)时主人的崽静态摆基座
  private cropCache = new Map<string, HTMLCanvasElement>(); // key = `${crop}|${hash}|${stage}` → 缓存的作物画布
  private others: OtherPlayer[] = [];
  private otherChar: CharFrames;
  private nearby: Interactable | null = null;
  private editMode = false;
  private camX = 0;
  private camY = 0;
  private cellPx = 0;
  private onClickBound = (e: PointerEvent) => this.onPointerDown(e);

  constructor(private canvas: HTMLCanvasElement, address: string, private cb: GameCallbacks) {
    this.ctx = canvas.getContext('2d')!;
    this.tiles = buildTiles();
    this.furniture = buildFurniture();
    this.char = buildCharacter(hueFromAddress(address));
    this.otherChar = buildCharacter((hueFromAddress(address) + 140) % 360);
  }

  start() {
    void loadAtlas(); // 异步加载 Kenney 图集；加载完成前用程序化兜底
    void loadMineSprites().then(() => {
      // 用像素画 PNG 替换程序化地面纹理（加载完才切，失败则保留程序化兜底）
      const floorImg = mineSprite('caveFloor');
      const wallImg = mineSprite('caveWall');
      if (floorImg) setGroundSprite('caveFloor', floorImg);
      if (wallImg) setGroundSprite('caveWall', wallImg);
    });
    this.input.attach();
    this.canvas.addEventListener('pointerdown', this.onClickBound);
    this.last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - this.last) / 1000);
      this.last = t;
      this.update(dt);
      this.render();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() {
    cancelAnimationFrame(this.raf);
    this.input.detach();
    this.canvas.removeEventListener('pointerdown', this.onClickBound);
  }

  setScene(scene: Scene, atSpawn = true) {
    this.scene = scene;
    if (atSpawn) {
      this.px = scene.spawn.x + 0.5;
      this.py = scene.spawn.y + 0.5;
      this.petFollowInit = false; // 真正切场景才重置（就地重建 atSpawn=false 不重置，免得农场刷新时宠物乱跳）
    }
    this.nearby = null;
  }
  setPaused(p: boolean) {
    this.paused = p;
    this.input.setPaused(p);
  }
  setPetGene(gene: string | null) {
    if (!gene) {
      this.petCanvas = null;
      return;
    }
    const c = document.createElement('canvas');
    renderPet(c, gene, this.scale * TILE);
    this.petCanvas = c;
    this.petFollowInit = false; // 新崽 → 重新吸附到玩家身边
  }
  /** 自家场景跟随玩家；串门时传 false → 主人的崽静态摆在基座上。 */
  setPetFollow(on: boolean) {
    this.petFollowEnabled = on;
  }
  setOthers(list: OtherPlayer[]) {
    this.others = list;
  }
  /** 取（或生成并缓存）某作物状态的画布。key 含 crop/hash/stage → 内容变才重画。 */
  private cropImg(c: CropSprite): HTMLCanvasElement {
    const key = `${c.crop}|${c.hash}|${c.stage}`;
    let img = this.cropCache.get(key);
    if (!img) {
      img = document.createElement('canvas');
      renderCrop(img, c.crop, c.hash, this.scale * TILE, c.stage);
      this.cropCache.set(key, img);
    }
    return img;
  }
  setEditMode(b: boolean) {
    this.editMode = b;
  }
  /** 虚拟方向键 → 持续移动向量（触屏 D-pad 用；桌面键盘不经此路径）。 */
  setTouchDir(dx: number, dy: number) {
    this.input.setTouchDir(dx, dy);
  }
  /** 触屏交互键 → 等效一次 E（与键盘交互走同一条 update() 逻辑）。 */
  touchInteract() {
    this.input.pressTouch('e');
  }

  private onPointerDown(e: PointerEvent) {
    if (!this.editMode || !this.cellPx || !this.scene) return;
    const rect = this.canvas.getBoundingClientRect();
    const tx = Math.floor((e.clientX - rect.left + this.camX) / this.cellPx);
    const ty = Math.floor((e.clientY - rect.top + this.camY) / this.cellPx);
    if (tx >= 0 && ty >= 0 && tx < this.scene.w && ty < this.scene.h) {
      this.cb.onTileClick?.(tx, ty, this.scene.id);
    }
  }

  private solidAt(x: number, y: number): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.scene.w || ty >= this.scene.h) return true;
    return this.scene.solid[ty][tx];
  }

  private interactableInFront(): Interactable | null {
    const fx = Math.floor(this.px);
    const fy = Math.floor(this.py);
    const [dx, dy] = DELTA[this.dir];
    for (const [cx, cy] of [[fx + dx, fy + dy], [fx, fy]]) {
      const it = this.scene.interactables.find((i) => i.x === cx && i.y === cy);
      if (it) return it;
    }
    // 水边感知：站在水岸格（任意 4 向邻格为 water）就可以垂钓
    for (const [ox, oy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const nx = fx + ox;
      const ny = fy + oy;
      if (nx >= 0 && ny >= 0 && nx < this.scene.w && ny < this.scene.h
          && this.scene.tiles[ny]?.[nx] === 'water') {
        return { x: fx, y: fy, type: 'fishing', label: '垂钓' };
      }
    }
    return null;
  }

  private update(dt: number) {
    if (!this.scene) return;
    this.time += dt; // 动态物件/水波/花草摆动用，独立于暂停
    if (this.paused) {
      if (this.input.wasPressed('escape', 'tab', 'e')) this.cb.onToggleMenu();
      this.input.endFrame();
      return;
    }
    if (this.input.wasPressed('escape', 'tab')) {
      this.cb.onToggleMenu();
      this.input.endFrame();
      return;
    }

    let vx = 0;
    let vy = 0;
    if (this.input.isDown('arrowleft', 'a')) vx -= 1;
    if (this.input.isDown('arrowright', 'd')) vx += 1;
    if (this.input.isDown('arrowup', 'w')) vy -= 1;
    if (this.input.isDown('arrowdown', 's')) vy += 1;
    this.moving = vx !== 0 || vy !== 0;
    if (this.moving) {
      if (vx < 0) this.dir = 'left';
      else if (vx > 0) this.dir = 'right';
      else if (vy < 0) this.dir = 'up';
      else this.dir = 'down';
      const speed = 4.4;
      const len = Math.hypot(vx, vy) || 1;
      const dx = (vx / len) * speed * dt;
      const dy = (vy / len) * speed * dt;
      if (!this.solidAt(this.px + dx, this.py)) this.px = clamp(this.px + dx, 0.3, this.scene.w - 0.3);
      if (!this.solidAt(this.px, this.py + dy)) this.py = clamp(this.py + dy, 0.4, this.scene.h - 0.1);
      this.animT += dt;
      if (this.animT > 0.16) {
        this.animT = 0;
        this.frame ^= 1;
      }
      this.cb.onMove?.(this.px, this.py, this.dir, this.scene.id);
    } else {
      this.frame = 0;
    }

    // 宠物跟随：第一只崽吊在玩家身后——离太远就追、够近就停（自然拖尾，略慢于玩家）。串门时不跟随。
    if (this.petCanvas && this.petFollowEnabled) {
      if (!this.petFollowInit) { this.petFollowX = this.px; this.petFollowY = this.py + 0.9; this.petFollowInit = true; }
      const dx = this.px - this.petFollowX;
      const dy = this.py - this.petFollowY;
      const dist = Math.hypot(dx, dy);
      const GAP = 0.85; // 保持的身后间距
      if (dist > GAP) {
        const sp = 4.0 * Math.min(1, (dist - GAP) / 0.6); // 越远追越快，避免瞬移
        this.petFollowX += (dx / dist) * sp * dt;
        this.petFollowY += (dy / dist) * sp * dt;
      }
    }

    const prev = this.nearby;
    this.nearby = this.interactableInFront();
    if (this.nearby !== prev) this.cb.onNearby?.(this.nearby);
    if (this.nearby && this.input.wasPressed('e', ' ', 'enter')) this.cb.onInteract(this.nearby);
    this.input.endFrame();
    // 调试用：把玩家状态挂到 canvas 上，便于在预览里核验位置/移动（无副作用，可保留）
    (this.canvas as unknown as { __state?: unknown }).__state = { px: this.px, py: this.py, dir: this.dir, scene: this.scene.id, camX: this.camX, camY: this.camY, cellPx: this.cellPx };
  }

  private drawCharSprite(img: HTMLCanvasElement, x: number, y: number, camX: number, camY: number, S: number) {
    const w = S;
    const hh = 18 * this.scale;
    this.ctx.drawImage(img, Math.round(x * S - w / 2 - camX), Math.round(y * S - hh - camY), w, hh);
  }

  /** 落地接触阴影（RENDER-3D-FEEL §7-B）：物体脚下一枚半透明椭圆，中心沿光向反方向（右下）微偏，
   *  把直立物件"焊"在地上、并暗示其落地而非浮空。cx/baseY=屏幕空间接地中心，footW=物体接地宽。 */
  private drawContactShadow(cx: number, baseY: number, footW: number) {
    const ctx = this.ctx;
    const rx = Math.max(3, footW * 0.47);
    const ry = Math.max(1.6, rx * 0.42);
    const off = Math.min(2, rx * 0.12); // 沿光反向（右下）偏移
    const gx = cx + off;
    const gy = baseY + off;
    ctx.save();
    // 径向落差 blob：接触核心更实(α0.36)、向椭圆边缘渐隐到透明 ⇒ "站在地上"更读得出，
    // 且渐隐天然避免均匀黑团（§7-B：接触越实越有 3D 感，但别糊成黑团）。
    // 把坐标系按 ry/rx 竖向压扁后画圆形径向渐变 ⇒ 渐变沿椭圆形状均匀收到全透明。
    ctx.translate(gx, gy);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, 'rgba(0,0,0,0.36)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.24)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawMineObject(o: MineObject, dx: number, dy: number, S: number) {
    const ctx = this.ctx;
    const u = S / 16;

    if (o.kind === 'mineEntrance') {
      this.drawContactShadow(dx + S / 2, dy + S * 0.95, S * 2.35);
      const im = mineSprite('mineEntrance');
      if (im) {
        // 48×48 PNG → 3S×3S display, centre on tile, bottom at dy+S
        ctx.drawImage(im, dx - S, dy - S * 2, S * 3, S * 3);
      } else {
        // programmatic fallback
        const bx = dx - 18 * u;
        const by = dy - 16 * u;
        ctx.save();
        ctx.translate(bx, by);
        ctx.fillStyle = '#39323d';
        ctx.fillRect(5 * u, 13 * u, 26 * u, 14 * u);
        ctx.fillStyle = '#5c5362';
        ctx.fillRect(3 * u, 16 * u, 4 * u, 10 * u);
        ctx.fillRect(29 * u, 16 * u, 4 * u, 10 * u);
        ctx.fillRect(7 * u, 10 * u, 22 * u, 6 * u);
        ctx.fillStyle = '#7a6e7f';
        ctx.fillRect(8 * u, 8 * u, 5 * u, 5 * u);
        ctx.fillRect(15 * u, 6 * u, 7 * u, 5 * u);
        ctx.fillRect(24 * u, 9 * u, 5 * u, 5 * u);
        ctx.fillStyle = '#17121d';
        ctx.beginPath();
        ctx.ellipse(18 * u, 19 * u, 11 * u, 12 * u, 0, Math.PI, 0);
        ctx.rect(7 * u, 18 * u, 22 * u, 9 * u);
        ctx.fill();
        const glow = 0.65 + Math.sin(this.time * 5) * 0.16;
        ctx.fillStyle = `rgba(255, 199, 91, ${glow})`;
        ctx.fillRect(4 * u, 18 * u, 2 * u, 5 * u);
        ctx.fillRect(30 * u, 18 * u, 2 * u, 5 * u);
        ctx.fillStyle = '#2d2015';
        ctx.fillRect(10 * u, 28 * u, 16 * u, 5 * u);
        ctx.fillStyle = '#f3d486';
        ctx.font = `${Math.max(8, Math.round(4 * u))}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('MINE', 18 * u, 30.5 * u);
        ctx.restore();
      }
      return;
    }

    if (o.kind === 'ore') {
      const oreKey = `ore_${o.oreKind ?? 'copper'}` as MineSpriteKey;
      const im = mineSprite(oreKey);
      if (im) {
        ctx.drawImage(im, dx, dy, S, S);
      } else {
        const oreColor: Record<string, string> = {
          copper: '#b87333', iron: '#9aa0a6', silver: '#d8e2ee', gold: '#f4c430',
          amethyst: '#a35cff', void_crystal: '#3fd7ff', starcore: '#ffe78a', ancient_relic: '#d8a15d',
        };
        const col = oreColor[o.oreKind ?? 'copper'] ?? '#b87333';
        ctx.fillStyle = 'rgba(8,7,12,.22)';
        ctx.fillRect(dx + 3 * u, dy + 3 * u, 10 * u, 10 * u);
        ctx.fillStyle = col;
        for (let i = 0; i < 5; i++) {
          const px = dx + (4 + ((o.x * 5 + o.y * 3 + i * 7) % 8)) * u;
          const py = dy + (4 + ((o.x * 2 + o.y * 7 + i * 5) % 8)) * u;
          ctx.fillRect(px, py, Math.max(1, 2 * u), Math.max(1, 2 * u));
        }
        ctx.fillStyle = 'rgba(255,255,255,.45)';
        ctx.fillRect(dx + 7 * u, dy + 4 * u, Math.max(1, u), Math.max(1, u));
      }
      return;
    }

    if (o.kind === 'chest') {
      this.drawContactShadow(dx + S / 2, dy + S * 0.82, S * 0.72);
      const im = mineSprite('mineChest');
      if (im) {
        ctx.drawImage(im, dx, dy, S, S);
      } else {
        ctx.fillStyle = '#5b351c';
        ctx.fillRect(dx + 3 * u, dy + 6 * u, 10 * u, 7 * u);
        ctx.fillStyle = '#8a5a2a';
        ctx.fillRect(dx + 3 * u, dy + 4 * u, 10 * u, 4 * u);
        ctx.fillStyle = '#d7b46a';
        ctx.fillRect(dx + 7 * u, dy + 7 * u, 2 * u, 3 * u);
      }
      return;
    }

    if (o.kind === 'monster') {
      this.drawContactShadow(dx + S / 2, dy + S * 0.85, S * 0.58);
      const im = mineSprite('mineMonster_basic');
      if (im) {
        ctx.drawImage(im, dx, dy, S, S);
      } else {
        const bob = Math.sin(this.time * 4 + (o.variant ?? 0)) * u;
        ctx.fillStyle = '#4b315f';
        ctx.beginPath();
        ctx.ellipse(dx + S / 2, dy + 9 * u + bob, 5 * u, 4 * u, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#9dff8f';
        ctx.fillRect(dx + 6 * u, dy + 8 * u + bob, 1.5 * u, 1.5 * u);
        ctx.fillRect(dx + 9 * u, dy + 8 * u + bob, 1.5 * u, 1.5 * u);
        ctx.fillStyle = '#211529';
        ctx.fillRect(dx + 5 * u, dy + 12 * u + bob, 6 * u, u);
      }
      return;
    }

    // stairsDown / stairsUp / exit
    this.drawContactShadow(dx + S / 2, dy + S * 0.84, S * 0.65);
    const stairKey = o.kind === 'stairsDown' ? 'stairsDown' : o.kind === 'stairsUp' ? 'stairsUp' : 'mineExit';
    const stairIm = mineSprite(stairKey as MineSpriteKey);
    if (stairIm) {
      ctx.drawImage(stairIm, dx, dy, S, S);
    } else if (o.kind === 'stairsDown') {
      ctx.fillStyle = '#15131d';
      ctx.fillRect(dx + 3 * u, dy + 4 * u, 10 * u, 9 * u);
      ctx.fillStyle = '#635a72';
      for (let i = 0; i < 4; i++) ctx.fillRect(dx + (3 + i) * u, dy + (5 + i * 2) * u, (10 - i * 2) * u, u);
    } else if (o.kind === 'stairsUp') {
      ctx.fillStyle = '#5f566c';
      for (let i = 0; i < 5; i++) ctx.fillRect(dx + (3 + i) * u, dy + (11 - i * 2) * u, (10 - i * 2) * u, u);
      ctx.fillStyle = '#d5c98b';
      ctx.fillRect(dx + 7 * u, dy + 2 * u, 2 * u, 5 * u);
    } else {
      ctx.fillStyle = '#241d2c';
      ctx.fillRect(dx + 3 * u, dy + 4 * u, 10 * u, 10 * u);
      ctx.fillStyle = '#8f7d57';
      ctx.fillRect(dx + 7 * u, dy + 3 * u, 2 * u, 11 * u);
      ctx.fillRect(dx + 4 * u, dy + 7 * u, 8 * u, 2 * u);
    }
  }

  /** 昼夜光照 1=正午 0=午夜（~180s 一天，余弦平滑；起始为白天）。__daylight 可覆盖用于调试。 */
  private daylight(): number {
    const o = (window as unknown as { __daylight?: number }).__daylight;
    if (typeof o === 'number') return o;
    const cycle = 180;
    const ph = ((this.time % cycle) / cycle) + 0.5;
    return 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);
  }

  private render() {
    if (!this.scene) return;
    const ctx = this.ctx;
    const cv = this.canvas;
    const cssW = cv.clientWidth;
    const cssH = cv.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(cssW * dpr);
    const H = Math.round(cssH * dpr);
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    const S = this.scale * TILE;
    const mapW = this.scene.w * S;
    const mapH = this.scene.h * S;
    let camX = this.px * S - cssW / 2;
    let camY = this.py * S - cssH / 2;
    camX = mapW <= cssW ? (mapW - cssW) / 2 : clamp(camX, 0, mapW - cssW);
    camY = mapH <= cssH ? (mapH - cssH) / 2 : clamp(camY, 0, mapH - cssH);
    this.camX = camX;
    this.camY = camY;
    this.cellPx = S; // 供点击→格子换算

    ctx.fillStyle = '#0c0b12';
    ctx.fillRect(0, 0, cssW, cssH);

    const x0 = Math.max(0, Math.floor(camX / S));
    const x1 = Math.min(this.scene.w - 1, Math.floor((camX + cssW) / S));
    const y0 = Math.max(0, Math.floor(camY / S));
    const y1 = Math.min(this.scene.h - 1, Math.floor((camY + cssH) / S));
    const useAtlas = atlasReady();
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const name = this.scene.tiles[ty][tx];
        const dx = Math.round(tx * S - camX);
        const dy = Math.round(ty * S - camY);
        if (GROUND_KINDS.has(name)) {
          // 室外地形:程序化高细节无缝地面（草/泥/石/鹅卵石/沙/水），消网格、提分辨率
          drawGroundTile(ctx, name, dx, dy, S, tx, ty);
          if (name === 'water') drawWaterShimmer(ctx, dx, dy, S, this.time, tx, ty);
        } else {
          const coord = useAtlas ? tileCoord(name, tx, ty) : undefined;
          if (coord) {
            drawAtlasTile(ctx, coord[0], coord[1], dx, dy, S);
          } else {
            const img = this.tiles[name as keyof TileSet];
            if (img) ctx.drawImage(img, dx, dy, S, S);
          }
        }
      }
    }

    const ds: { y: number; draw: () => void }[] = [];
    for (const f of this.scene.furniture) {
      if (f.kind === 'tree') {
        // 圆冠像素树:art-res 画布按屏幕尺寸放大(最近邻),底中心锚定本格底,随风轻摆
        const img = treeCanvas(treeVariant(f.x, f.y));
        const bx = (f.x + 0.5) * S - camX;
        const by = (f.y + 1) * S - camY;
        const tw = TREE_W * S;
        const th = TREE_H * S;
        ds.push({
          y: f.y,
          draw: () => {
            this.drawContactShadow(bx, by, S * 0.95);
            ctx.save();
            ctx.translate(bx, by);
            ctx.rotate(swayAngle(this.time, f.x, f.y) * 0.5);
            ctx.drawImage(img, -tw / 2, -th, tw, th);
            ctx.restore();
          },
        });
        continue;
      }
      const coord = useAtlas ? furnitureCoord(f.kind, f.x, f.y) : undefined;
      const dx = Math.round(f.x * S - camX);
      const dy = Math.round(f.y * S - camY);
      const flat = FLAT_KINDS.has(f.kind);
      if (coord) {
        const sway = SWAY_KINDS.has(f.kind);
        ds.push({
          y: f.y,
          draw: () => {
            if (!flat) this.drawContactShadow(dx + S / 2, dy + S - S * 0.12, S * 0.62);
            if (sway) {
              // 绕格子底部中心微旋 ⇒ 随风轻摆，不破坏像素底对齐
              ctx.save();
              ctx.translate(dx + S / 2, dy + S);
              ctx.rotate(swayAngle(this.time, f.x, f.y));
              drawAtlasTile(ctx, coord[0], coord[1], -S / 2, -S, S);
              ctx.restore();
            } else {
              drawAtlasTile(ctx, coord[0], coord[1], dx, dy, S);
            }
          },
        });
      } else {
        const img = this.furniture[f.kind];
        if (img) ds.push({ y: f.y, draw: () => { if (!flat) this.drawContactShadow(dx + S / 2, dy + S - S * 0.12, S * 0.62); ctx.drawImage(img, dx, dy, S, S); } });
      }
    }
    // 多瓦片建筑：整张拼装图按底边 y 站位（玩家可走到屋前/屋后）
    for (const b of this.scene.buildings) {
      const img = buildingCanvas(b.style, b.w, b.h, b.variant ?? 0);
      const dx = Math.round(b.x * S - camX);
      const dy = Math.round(b.y * S - camY);
      const bw = b.w * S;
      const bh = b.h * S;
      ds.push({ y: b.y + b.h - 1, draw: () => { this.drawContactShadow(dx + bw / 2, dy + bh - 2, bw * 0.92); ctx.drawImage(img, dx, dy, bw, bh); } });
    }
    // 动态物件（篝火/喷泉/灯…）：按 y 站位混入深度排序，玩家可走到其前后
    for (const e of this.scene.effects) {
      const drawer = EFFECTS[e.kind];
      if (!drawer) continue;
      const dx = Math.round(e.x * S - camX);
      const dy = Math.round(e.y * S - camY);
      const ph = phaseOf(e.x, e.y);
      // 炊烟在高空，永远画在最上层（不被屋顶/玩家盖住）
      const depth = e.kind === 'chimneySmoke' ? 1e6 : e.y;
      const grounded = !AIRBORNE_FX.has(e.kind);
      ds.push({ y: depth, draw: () => { if (grounded) this.drawContactShadow(dx + S / 2, dy + S * 0.84, S * 0.72); drawer(ctx, dx, dy, S, this.time, ph); } });
    }
    // 农场作物：按成长阶段画（crop-render），底中心锚定本格底，按 y 深度排序混入。
    if (this.scene.crops) {
      for (const c of this.scene.crops) {
        const img = this.cropImg(c);
        const dx = Math.round(c.x * S - camX);
        const dy = Math.round((c.y + 1) * S - camY - S); // 底对齐本格
        ds.push({ y: c.y, draw: () => { this.drawContactShadow(dx + S / 2, dy + S - 2, S * 0.42); ctx.drawImage(img, dx, dy, S, S); } });
      }
    }
    if (this.scene.mineObjects) {
      for (const o of this.scene.mineObjects) {
        const dx = Math.round(o.x * S - camX);
        const dy = Math.round(o.y * S - camY);
        ds.push({ y: o.y, draw: () => this.drawMineObject(o, dx, dy, S) });
      }
    }
    if (this.petCanvas && this.petFollowEnabled) {
      // 跟随：画在 petFollowX/Y（任意场景）。移动时轻微上下浮动，给点活物感。
      const fx = this.petFollowX;
      const fy = this.petFollowY;
      const bob = Math.abs(this.px - fx) + Math.abs(this.py - fy) > 0.06 ? Math.sin(this.time * 9) * 0.06 : 0;
      ds.push({
        y: fy,
        draw: () => {
          this.drawContactShadow(fx * S - camX + S / 2, (fy + 0.4) * S - camY, S * 0.5);
          ctx.drawImage(this.petCanvas!, Math.round(fx * S - camX), Math.round((fy - 0.55 + bob) * S - camY), S, S);
        },
      });
    } else if (this.petCanvas && this.scene.petAnchor) {
      // 串门（不跟随）：主人的崽静态摆在基座上。
      const a = this.scene.petAnchor;
      ds.push({
        y: a.y,
        draw: () => {
          this.drawContactShadow(a.x * S - camX + S / 2, (a.y + 0.4) * S - camY, S * 0.5);
          ctx.drawImage(this.petCanvas!, Math.round(a.x * S - camX), Math.round((a.y - 0.55) * S - camY), S, S);
        },
      });
    }
    for (const o of this.others) {
      ds.push({
        y: o.y,
        draw: () => {
          this.drawContactShadow(o.x * S - camX, o.y * S - camY, S * 0.5);
          this.drawCharSprite(this.otherChar[o.dir][0], o.x, o.y, camX, camY, S);
          if (o.name) this.drawNameTag('@' + o.name, o.x, o.y, camX, camY, S);
        },
      });
    }
    ds.push({
      y: this.py,
      draw: () => {
        this.drawContactShadow(this.px * S - camX, this.py * S - camY, S * 0.5);
        this.drawCharSprite(this.char[this.dir][this.moving ? this.frame : 0], this.px, this.py, camX, camY, S);
      },
    });
    ds.sort((a, b) => a.y - b.y);
    for (const d of ds) d.draw();

    // —— 昼夜微循环：夜色罩 + 屋内暖灯 + 篝火/灯笼发光（仅室外场景有意义，室内无 buildings/光源照样安全）——
    const dl = this.daylight();
    if (dl < 0.985) {
      const night = 1 - dl;
      ctx.fillStyle = `rgba(22, 28, 66, ${0.52 * night})`;
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const b of this.scene.buildings) {
        const gx = (b.x + b.w / 2) * S - camX;
        const gy = (b.y + b.h * 0.45) * S - camY;
        const r = b.w * S * 0.55;
        const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
        g.addColorStop(0, `rgba(255, 206, 120, ${0.3 * night})`);
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.fillRect(gx - r, gy - r, r * 2, r * 2);
      }
      for (const e of this.scene.effects) {
        if (e.kind !== 'campfire' && e.kind !== 'lantern' && e.kind !== 'torch') continue;
        const gx = (e.x + 0.5) * S - camX;
        const gy = (e.y + 0.4) * S - camY;
        const r = (e.kind === 'campfire' ? 2.6 : 1.7) * S;
        const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
        g.addColorStop(0, `rgba(255, 176, 88, ${0.55 * night})`);
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.fillRect(gx - r, gy - r, r * 2, r * 2);
      }
      ctx.restore();
    }

    if (this.scene.id.startsWith('mine:')) {
      ctx.save();
      ctx.fillStyle = 'rgba(3, 2, 8, 0.34)';
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.globalCompositeOperation = 'destination-out';
      const gx = this.px * S - camX;
      const gy = (this.py - 0.2) * S - camY;
      const r = 4.8 * S;
      const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
      g.addColorStop(0, 'rgba(0,0,0,0.95)');
      g.addColorStop(0.5, 'rgba(0,0,0,0.55)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(gx - r, gy - r, r * 2, r * 2);
      ctx.restore();
    }

    if (this.editMode) {
      ctx.strokeStyle = 'rgba(139,109,255,.5)';
      ctx.lineWidth = 1;
      const gx0 = Math.max(0, Math.floor(camX / S));
      const gx1 = Math.min(this.scene.w, Math.ceil((camX + cssW) / S));
      const gy0 = Math.max(0, Math.floor(camY / S));
      const gy1 = Math.min(this.scene.h, Math.ceil((camY + cssH) / S));
      ctx.beginPath();
      for (let gx = gx0; gx <= gx1; gx++) {
        ctx.moveTo(Math.round(gx * S - camX) + 0.5, gy0 * S - camY);
        ctx.lineTo(Math.round(gx * S - camX) + 0.5, gy1 * S - camY);
      }
      for (let gy = gy0; gy <= gy1; gy++) {
        ctx.moveTo(gx0 * S - camX, Math.round(gy * S - camY) + 0.5);
        ctx.lineTo(gx1 * S - camX, Math.round(gy * S - camY) + 0.5);
      }
      ctx.stroke();
    }

    if (this.nearby) {
      ctx.font = '600 13px ui-monospace, Menlo, monospace';
      const text = `[E] ${this.nearby.label}`;
      const tw = ctx.measureText(text).width;
      const hx = this.px * S - camX - tw / 2 - 6;
      const hy = this.py * S - 26 * this.scale - camY;
      ctx.fillStyle = 'rgba(16,14,24,.85)';
      ctx.fillRect(hx, hy, tw + 12, 20);
      ctx.fillStyle = '#ece9f3';
      ctx.fillText(text, hx + 6, hy + 14);
    }
  }

  private drawNameTag(text: string, x: number, y: number, camX: number, camY: number, S: number) {
    const ctx = this.ctx;
    ctx.font = '600 11px ui-monospace, Menlo, monospace';
    const tw = ctx.measureText(text).width;
    const nx = x * S - camX - tw / 2 - 4;
    const ny = y * S - 22 * this.scale - camY;
    ctx.fillStyle = 'rgba(16,14,24,.8)';
    ctx.fillRect(nx, ny, tw + 8, 15);
    ctx.fillStyle = '#cfc8e0';
    ctx.fillText(text, nx + 4, ny + 11);
  }
}
