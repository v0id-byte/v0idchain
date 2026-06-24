#!/usr/bin/env node
// Generates pixel-art PNGs for the mine scene.
// No external deps — uses only Node built-ins (zlib, fs).
// Output: packages/game-web/public/assets/mine/
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { deflateSync } from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '../public/assets/mine');
mkdirSync(OUT, { recursive: true });

// ─── minimal PNG encoder (pure JS, no deps) ───────────────────────────────
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function u32be(n) {
  return Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = u32be(data.length);
  const crc = u32be(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  // rgba: Uint8Array, RGBA 8-bit per channel, row-major
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = pngChunk('IHDR',
    Buffer.concat([u32be(w), u32be(h), Buffer.from([8, 6, 0, 0, 0])]));
  const rows = [];
  for (let y = 0; y < h; y++) {
    rows.push(Buffer.from([0])); // filter type = None
    rows.push(Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4));
  }
  const idat = pngChunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 }));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

// ─── canvas abstraction ───────────────────────────────────────────────────
class Px {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.d = new Uint8Array(w * h * 4); // RGBA, fully transparent init
  }
  set(x, y, r, g, b, a = 255) {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    this.d[o] = r; this.d[o+1] = g; this.d[o+2] = b; this.d[o+3] = a;
  }
  fill(r, g, b, a = 255) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.set(x, y, r, g, b, a);
  }
  rect(x0, y0, x1, y1, r, g, b, a = 255) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, r, g, b, a);
  }
  hline(y, x0, x1, r, g, b, a = 255) { this.rect(x0, y, x1, y, r, g, b, a); }
  vline(x, y0, y1, r, g, b, a = 255) { this.rect(x, y0, x, y1, r, g, b, a); }
  save(name) {
    writeFileSync(join(OUT, name), encodePNG(this.w, this.h, this.d));
    console.log('  ✓', name, `${this.w}×${this.h}`);
  }
}

// ─── deterministic hash ───────────────────────────────────────────────────
function h01(x, y, s = 0) {
  let h = (Math.imul(x * 374761393 + s * 17, 1) ^ Math.imul(y * 668265263, 1)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) / 4294967296;
}

console.log('Generating mine assets →', OUT, '\n');

// ─── caveFloor.png (16×16) ────────────────────────────────────────────────
{
  const c = new Px(16, 16);
  const MID=[54,50,61], DRK=[38,36,46], LIT=[68,62,74], GEM=[91,83,116];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const n = h01(x, y);
    c.set(x, y, ...(n < 0.25 ? DRK : n > 0.72 ? LIT : MID));
  }
  // scattered pebble/gem pixels
  for (const [x, y, col] of [
    [3,2,DRK],[7,9,GEM],[11,5,DRK],[5,13,GEM],[13,11,DRK],[2,7,GEM],[9,4,DRK],[14,7,GEM],
    [1,11,DRK],[6,3,LIT],[12,8,LIT],[4,14,DRK],
  ]) c.set(x, y, ...col);
  c.save('caveFloor.png');
}

// ─── caveWall.png (16×16) ─────────────────────────────────────────────────
{
  const c = new Px(16, 16);
  const MID=[38,35,47], DRK=[23,22,31], LIT=[56,50,66];
  // two rows of offset stone blocks, 8px each
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const seam = (x === 7 || y === 7);
    if (seam) { c.set(x, y, ...DRK); continue; }
    const bx = y < 8 ? x : (x + 4) % 16; // offset 2nd row
    const n = h01(Math.floor(bx / 8), Math.floor(y / 8), 3);
    c.set(x, y, ...(n > 0.55 ? LIT : MID));
  }
  // highlight top edge of each block row
  c.hline(0, 0, 6, ...LIT); c.hline(0, 8, 14, ...LIT);
  c.hline(8, 4, 14, ...LIT);
  c.save('caveWall.png');
}

// ─── ore sprites (16×16, transparent bg) ─────────────────────────────────
function makeOre(name, [or, og, ob], rarity) {
  const c = new Px(16, 16);
  const ROCK=[38,35,47], RDARK=[23,22,31];
  // small rocky patch in centre
  c.rect(5,5,9,9,...ROCK);
  c.set(4,6,...ROCK); c.set(4,7,...ROCK); c.set(10,6,...ROCK); c.set(10,7,...ROCK);
  // darken edges of patch
  c.set(5,5,...RDARK); c.set(9,5,...RDARK); c.set(5,9,...RDARK); c.set(9,9,...RDARK);
  // ore pixels (irregular cluster)
  for (const [x,y] of [[5,6],[6,5],[7,6],[8,5],[6,7],[7,7],[8,7],[6,8],[7,8]])
    c.set(x, y, or, og, ob);
  // highlight (top-left corner of cluster)
  const hi = [Math.min(255,or+60), Math.min(255,og+55), Math.min(255,ob+50)];
  c.set(5, 6, ...hi); c.set(6, 5, ...hi);
  // shadow (bottom-right)
  const sh = [Math.max(0,or-45), Math.max(0,og-40), Math.max(0,ob-35)];
  c.set(8, 8, ...sh); c.set(7, 8, ...sh);
  // rarity 3+: edge sparkle pixels
  if (rarity >= 3) {
    c.set(4, 5, ...hi, 200); c.set(10, 5, ...hi, 200);
    c.set(4, 9, ...hi, 160); c.set(10, 9, ...hi, 160);
  }
  // rarity 4: extra outer glow ring
  if (rarity >= 4) {
    for (const [x,y] of [[5,4],[7,4],[9,4],[4,6],[10,6],[4,8],[10,8],[5,10],[7,10],[9,10]])
      c.set(x, y, ...hi, 110);
  }
  c.save(name);
}

makeOre('ore_copper.png',       [184,115, 51], 1);
makeOre('ore_iron.png',         [154,160,166], 1);
makeOre('ore_silver.png',       [200,214,228], 2);
makeOre('ore_gold.png',         [244,196, 48], 2);
makeOre('ore_amethyst.png',     [163, 92,255], 3);
makeOre('ore_void_crystal.png', [ 63,215,255], 3);
makeOre('ore_starcore.png',     [255,231,138], 4);
makeOre('ore_ancient_relic.png',[216,161, 93], 4);

// ─── mineChest.png (16×16) ────────────────────────────────────────────────
{
  const c = new Px(16, 16);
  // bottom shadow
  c.rect(4, 14, 11, 14, 15, 10, 8, 120);
  // body
  c.rect(3,  9, 12, 13, 68, 35, 16);
  c.rect(4,  9, 11, 12, 100, 58, 24);
  // lid
  c.rect(3,  5, 12,  8, 90, 53, 28);
  c.rect(4,  5, 11,  7, 138, 90, 42);
  // lid highlight
  c.hline(5, 4, 11, 165, 115, 60);
  // corner nails
  for (const [x,y] of [[3,5],[12,5],[3,12],[12,12]]) c.set(x, y, 212, 178, 90);
  // clasp centre
  c.rect(7, 8, 9, 10, 212, 178, 90);
  c.set(8, 9, 255, 240, 150); // clasp highlight
  // dark line separating lid from body
  c.hline(8, 3, 12, 50, 28, 12);
  c.save('mineChest.png');
}

// ─── mineMonster_basic.png (16×16) ────────────────────────────────────────
{
  const c = new Px(16, 16);
  const BODY=[75,49,95], HI=[107,74,133], DARK=[44,28,60], EYE=[157,255,143];
  // shadow
  c.rect(5, 13, 10, 13, 20, 14, 26, 120);
  // body (hand-pixel circle)
  for (const [x0,y0,x1,y1] of [
    [5,5,9,5],[4,6,10,6],[4,7,10,7],[4,8,10,8],[5,9,9,9],[5,10,9,10],[6,11,8,11],
  ]) c.rect(x0, y0, x1, y1, ...BODY);
  // highlight top-left
  c.set(5,5,...HI); c.set(6,5,...HI); c.set(5,6,...HI);
  // dark underside
  c.hline(10, 5, 9, ...DARK); c.hline(11, 6, 8, ...DARK);
  // eyes (2px each)
  c.rect(5,7,6,7,...EYE); c.rect(9,7,10,7,...EYE);
  // pupils
  c.set(6, 7, 20, 12, 30); c.set(9, 7, 20, 12, 30);
  // mouth
  c.rect(6, 9, 9, 9, 33, 21, 47);
  c.set(5,10,33,21,47); c.set(10,10,33,21,47);
  // tiny tooth
  c.set(7, 9, 220, 218, 220);
  c.save('mineMonster_basic.png');
}

// ─── stairsDown.png (16×16) ───────────────────────────────────────────────
{
  const c = new Px(16, 16);
  const BG=[23,22,31], STEP=[99,90,114], HI=[140,130,158], HOLE=[8,7,12];
  c.fill(...BG);
  c.rect(3, 10, 12, 14, ...HOLE); // dark pit
  // 4 steps descending left-to-right into darkness
  c.hline(4, 3, 12, ...HI); c.hline(5, 3, 12, ...STEP);
  c.hline(6, 5, 12, ...HI); c.hline(7, 5, 12, ...STEP);
  c.hline(8, 7, 12, ...HI); c.hline(9, 7, 12, ...STEP);
  c.hline(10,9, 12, ...HI);
  // down-arrow hint
  c.set(7, 13, ...HI); c.set(8, 13, ...HI);
  c.set(6, 12, ...HI); c.set(9, 12, ...HI);
  c.save('stairsDown.png');
}

// ─── stairsUp.png (16×16) ─────────────────────────────────────────────────
{
  const c = new Px(16, 16);
  const BG=[38,35,47], STEP=[99,90,114], HI=[155,145,170], LITE=[230,220,195];
  c.fill(...BG);
  // warm glow at top (towards exit)
  c.rect(5,2,10,3,...LITE); c.set(7,1,...LITE); c.set(8,1,...LITE);
  // up-arrow hint
  c.set(7,2,255,240,200); c.set(8,2,255,240,200);
  // 4 steps ascending
  c.hline(12, 3, 12, ...HI); c.hline(13, 3, 12, ...STEP);
  c.hline(10, 4, 11, ...HI); c.hline(11, 4, 11, ...STEP);
  c.hline(8,  5, 10, ...HI); c.hline(9,  5, 10, ...STEP);
  c.hline(6,  6,  9, ...HI); c.hline(7,  6,  9, ...STEP);
  c.save('stairsUp.png');
}

// ─── mineExit.png (16×16) ─────────────────────────────────────────────────
{
  const c = new Px(16, 16);
  const STONE=[56,50,66], STONE_HI=[80,72,92], SKY=[168,210,255], GRASS=[104,150,72];
  c.fill(...STONE);
  // archway opening
  c.rect(5,2,10,13,...SKY);
  c.rect(4,5,11,13,...SKY);
  // grass at exit floor
  c.rect(4,11,11,13,...GRASS);
  // arch sides (stone highlight)
  c.vline(3, 5, 10, ...STONE_HI); c.vline(12, 5, 10, ...STONE_HI);
  // keystone at top
  c.rect(6,2,9,3,...STONE_HI);
  // sunlight beam (bright centre top)
  c.set(7,2,255,248,220); c.set(8,2,255,248,220);
  c.save('mineExit.png');
}

// ─── mineEntrance.png (48×48) ─────────────────────────────────────────────
{
  const c = new Px(48, 48);
  const ROCK=[56,50,66], ROCK_HI=[80,72,92], ROCK_DRK=[32,28,42];
  const CAVE=[12,9,18], CAVE_RIM=[28,22,38];
  const TORCH_COL=[255,180,60], TORCH_GLOW=[255,140,30];
  const SIGN=[44,28,16], SIGN_HI=[90,65,35], SIGN_TXT=[243,212,134];

  // rock mass background
  c.rect(0, 10, 47, 47, ...ROCK_DRK);
  // upper rocky outcrop
  c.rect(4,  4, 43,  9, ...ROCK);
  c.rect(2,  8, 45, 12, ...ROCK);
  c.rect(0, 12, 47, 20, ...ROCK);
  // side walls
  c.rect(0, 20,  9, 47, ...ROCK);
  c.rect(38,20, 47, 47, ...ROCK);
  // rock highlights (top-lit faces)
  c.hline(4,  4, 43, ...ROCK_HI);
  c.hline(8,  2, 45, ...ROCK_HI);
  c.hline(12, 0, 47, ...ROCK_HI);
  // rough top silhouette bumps
  for (const [x,y] of [[8,6],[16,4],[24,3],[32,4],[40,6],[6,9],[20,7],[28,7],[42,9]])
    c.set(x, y, ...ROCK_HI);

  // cave opening (filled ellipse cx=23.5 cy=30, rx=14.5 ry=17)
  const ecx = 23.5, ecy = 30, erx = 14.5, ery = 17;
  for (let y = 13; y <= 47; y++) for (let x = 8; x <= 39; x++) {
    const dx = (x - ecx) / erx, dy = (y - ecy) / ery;
    const d2 = dx*dx + dy*dy;
    if (d2 <= 1) c.set(x, y, ...CAVE);
    else if (d2 <= 1.14) c.set(x, y, ...CAVE_RIM); // dark rim on rock face
  }

  // left torch (pole + flame)
  c.rect(7, 20, 8, 28, 80, 55, 30);   // pole
  c.rect(6, 17, 9, 20, ...TORCH_COL); // flame body
  c.set(7, 16, ...TORCH_GLOW); c.set(8, 16, ...TORCH_GLOW); // glow tip
  // right torch
  c.rect(39, 20, 40, 28, 80, 55, 30);
  c.rect(38, 17, 41, 20, ...TORCH_COL);
  c.set(39, 16, ...TORCH_GLOW); c.set(40, 16, ...TORCH_GLOW);

  // sign plank
  c.rect(12, 38, 35, 43, ...SIGN);
  c.hline(38, 12, 35, ...SIGN_HI); // top edge highlight

  // pixel font "MINE" (3×5 bitmap, 1px gap between letters)
  const glyphs = {
    M: [[0,0],[0,1],[0,2],[0,3],[0,4],[1,1],[2,2],[3,1],[4,0],[4,1],[4,2],[4,3],[4,4]],
    I: [[0,0],[0,1],[0,2],[0,3],[0,4]],
    N: [[0,0],[0,1],[0,2],[0,3],[0,4],[1,1],[2,2],[3,3],[4,0],[4,1],[4,2],[4,3],[4,4]],
    E: [[0,0],[0,1],[0,2],[0,3],[0,4],[1,0],[2,0],[2,2],[3,0],[4,0],[4,4],[3,4],[2,4],[1,4],[1,2],[2,2]],
  };
  let gx = 14;
  for (const [key, offsets] of [['M', glyphs.M], ['I', glyphs.I], ['N', glyphs.N], ['E', glyphs.E]]) {
    for (const [ox, oy] of offsets) c.set(gx + ox, 39 + oy, ...SIGN_TXT);
    gx += (key === 'I' ? 3 : 6);
  }

  c.save('mineEntrance.png');
}

console.log('\nDone.');
