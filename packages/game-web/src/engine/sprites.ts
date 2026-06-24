// 程序化占位精灵（后续 Task #11 换 Kenney CC0）。全部 16px 瓦片，离屏生成 + 缓存。
// 角色用“胶囊 + 朝向眼睛 + 2 帧上下微跳”，和崽的程序化像素同一调性。
export const TILE = 16;
export type Dir = 'down' | 'up' | 'left' | 'right';

type C = HTMLCanvasElement;
function mk(w = TILE, h = TILE): [C, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

// ---- 瓦片 ----
function tile(base: string, edge: string, speckle?: string): C {
  const [c, x] = mk();
  x.fillStyle = base;
  x.fillRect(0, 0, TILE, TILE);
  x.fillStyle = edge;
  x.fillRect(0, TILE - 1, TILE, 1);
  x.fillRect(TILE - 1, 0, 1, TILE);
  if (speckle) {
    x.fillStyle = speckle;
    for (const [px, py] of [[3, 4], [10, 7], [6, 12], [13, 2]]) x.fillRect(px, py, 1, 1);
  }
  return c;
}

export interface TileSet {
  floor: C;
  floorAlt: C;
  wall: C;
  wallTop: C;
  grass: C;
  path: C;
  rug: C;
  door: C;
}
export function buildTiles(): TileSet {
  return {
    floor: tile('#6f4d31', '#5b3f28', '#7a5638'),
    floorAlt: tile('#79543a', '#5b3f28'),
    wall: tile('#37334c', '#272338'),
    wallTop: tile('#454063', '#312c49'),
    grass: tile('#3f7d4a', '#367042', '#4a8c55'),
    path: tile('#9c8b63', '#85764f', '#a89978'),
    rug: tile('#8a3f5a', '#73334a'),
    door: tile('#caa15a', '#9a7942'),
  };
}

// ---- 家具与装饰（透明底，画在格子中央）----
// 开放目录：kind 为字符串，坐标见 tileset.FURNITURE_TILES，可放清单见 FURNITURE_CATALOG。
// 程序化兜底只覆盖少数室内件；其余只走 Kenney 图集。
export type FurnitureKind = string;
function furniture(kind: FurnitureKind): C {
  const [c, x] = mk(TILE, TILE);
  const round = (px: number, py: number, w: number, h: number, fill: string) => {
    x.fillStyle = fill;
    x.fillRect(px, py, w, h);
  };
  switch (kind) {
    case 'table':
      round(2, 5, 12, 1, '#5c3c18');     // 顶面 cabinet 厚度（oblique 深度线索）
      round(2, 6, 12, 5, '#8a5230');     // 桌面（暖橡木）
      round(2, 6, 12, 1, '#b06840');     // 桌面顶沿 rim 高光（左上受光）
      round(3, 8, 10, 1, '#724828');     // 木纹
      round(2, 10, 12, 1, '#4a2c10');    // 桌面底沿 AO
      round(2, 11, 12, 1, '#7a4a28');    // 前边缘厚度（oblique 侧面）
      round(2, 12, 2, 3, '#5e3820');     // 左腿
      round(12, 12, 2, 3, '#5e3820');    // 右腿
      round(2, 12, 1, 3, '#7a4e2e');     // 左腿高光
      break;
    case 'plant':
      round(6, 9, 4, 5, '#8a5a32');
      x.fillStyle = '#3f9a55';
      x.beginPath();
      x.arc(8, 6, 5, 0, 7);
      x.fill();
      break;
    case 'bed':
      round(2, 3, 12, 1, '#6b4a2c');     // 床头板
      round(2, 3, 1, 1, '#8a6040');      // 床头板左 rim 高光
      round(2, 4, 12, 10, '#d4ceba');    // 亚麻被单（暖色，取代冷蓝灰）
      round(2, 4, 12, 3, '#e08a9a');     // 枕头
      round(2, 4, 12, 1, '#eeaabc');     // 枕头顶沿 rim
      round(2, 4, 1, 3, '#f0c0cc');      // 枕头左 rim 高光
      round(2, 8, 12, 1, '#bcb69e');     // 被单折痕 1
      round(2, 11, 12, 1, '#bcb69e');    // 被单折痕 2
      round(2, 4, 4, 10, '#bab29c');     // 左侧板（暖亚麻，较床面微暗）
      round(2, 13, 12, 1, '#9a9280');    // 底部 AO
      break;
    case 'chair':
      // 靠背立柱
      round(3, 2, 2, 4, '#7a4e28');
      round(11, 2, 2, 4, '#7a4e28');
      round(3, 2, 1, 4, '#9a6840');      // 左柱 rim 高光
      // 靠背横梁
      round(3, 5, 10, 2, '#8a5a30');
      round(3, 5, 10, 1, '#a46a3a');     // 横梁顶 rim
      // 座面（暖橡木）
      round(3, 7, 10, 4, '#8a5a30');
      round(3, 7, 10, 1, '#a46a3a');     // 座面顶 rim 高光
      round(3, 10, 10, 1, '#5a3818');    // 座面底 AO
      // 前腿
      round(3, 11, 2, 4, '#6a4028');
      round(11, 11, 2, 4, '#6a4028');
      round(3, 11, 1, 4, '#8a5830');     // 前腿高光
      break;
    case 'lamp':
      // 灯柱（古铜色）
      round(7, 6, 2, 8, '#8a6838');
      round(7, 6, 1, 8, '#b08a4a');      // 柱左 rim 高光
      // 灯罩（像素梯形，顶小底大）
      round(6, 1, 4, 1, '#c4a060');      // 罩顶
      round(5, 2, 6, 1, '#c4a060');      // 罩中
      round(4, 3, 8, 1, '#c4a060');      // 罩底边
      round(4, 3, 1, 1, '#d8ba70');      // 左边 rim 高光
      // 灯泡（暖黄白）
      round(7, 4, 2, 2, '#fff0a0');
      // 暖光晕
      x.fillStyle = 'rgba(255,200,80,0.28)';
      x.beginPath(); x.arc(8, 5, 3, 0, Math.PI * 2); x.fill();
      break;
    case 'pedestal':
      round(3, 13, 10, 2, '#4a4560');    // 基座底（先画，其余盖上）
      round(4, 9, 8, 5, '#5b5570');      // 柱体
      round(4, 9, 8, 1, '#7a7698');      // 柱体顶 rim 高光
      round(5, 7, 6, 2, '#6d6688');      // 顶台面
      round(5, 7, 6, 1, '#8a82a8');      // 台面顶 rim 高光（受光）
      round(5, 8, 1, 1, '#9a94be');      // 台面左上角高光
      break;
    case 'rug':
      round(1, 3, 14, 10, '#8a3f5a');
      round(3, 5, 10, 6, '#a85470');
      break;
    case 'fence':
      round(0, 6, 16, 2, '#8a6840');   // 上横杆
      round(0, 10, 16, 2, '#8a6840');  // 下横杆
      round(0, 6, 16, 1, '#a07e52');   // 上横杆顶 rim 高光
      round(2, 4, 2, 11, '#6b4a2c');   // 左立柱
      round(12, 4, 2, 11, '#6b4a2c');  // 右立柱
      round(2, 4, 1, 11, '#7c5836');   // 左柱高光
      round(13, 4, 1, 11, '#5a3820');  // 右柱暗面（背光侧）
      break;
    case 'mailbox': // 美式信箱:木柱 + 半圆顶铁箱 + 红旗
      round(7, 8, 2, 7, '#6b4a2c'); // 立柱
      round(7, 8, 1, 7, '#7c5836'); // 柱高光
      round(4, 3, 8, 5, '#4a5a6a'); // 箱体
      round(4, 3, 8, 1, '#6a7a8a'); // 箱顶高光
      x.fillStyle = '#4a5a6a';
      x.beginPath();
      x.arc(8, 3, 4, Math.PI, 0); // 半圆顶
      x.fill();
      round(11, 4, 1, 3, '#c2462f'); // 红旗杆
      round(11, 4, 2, 2, '#d8543a'); // 红旗
      break;
    // ───────── 场景专属道具（R2）：统一左上受光 + 顶面/rim/AO，告别占位件 ─────────
    case 'piling': // 码头木桩：粗木柱 + 顶切面 + 缆绳环 + 水线
      round(5, 2, 6, 1, '#7a5230');   // 顶切面（受光环）
      round(5, 3, 6, 11, '#5e3c20');  // 柱身
      round(5, 3, 1, 11, '#7a4e2c');  // 左 rim 高光
      round(10, 3, 1, 11, '#3f2814'); // 右暗面
      round(6, 5, 1, 7, '#6a4524');   // 木纹
      round(8, 6, 1, 6, '#4a2e16');   // 木纹2
      round(4, 8, 8, 2, '#3a2614');   // 缆绳环（深）
      round(4, 8, 8, 1, '#6a5236');   // 绳高光
      round(5, 13, 6, 2, '#2e3a44');  // 水线（湿暗）
      break;
    case 'shell': // 沙滩贝壳（可踩装饰，扇贝）
      round(6, 9, 5, 4, '#f0d9c4');   // 扇贝身
      round(6, 9, 5, 1, '#fbeede');   // 顶高光
      round(7, 10, 1, 3, '#d9b59a');  // 扇纹
      round(9, 10, 1, 3, '#d9b59a');  // 扇纹2
      round(6, 12, 5, 1, '#c79a82');  // 底暗
      round(8, 8, 1, 1, '#fff6ec');   // 高光点
      break;
    case 'driftwood': // 漂流木（横卧漂白枯木）
      round(2, 8, 12, 4, '#b7a890');  // 木身
      round(2, 8, 12, 1, '#cdbfa6');  // 顶高光
      round(2, 11, 12, 1, '#8f8068'); // 底暗
      round(2, 9, 12, 1, '#a3937a');  // 纹
      round(2, 8, 2, 4, '#7a6d58');   // 左端断面
      round(12, 8, 2, 4, '#7a6d58');  // 右端断面
      round(5, 8, 1, 4, '#9a8b72');   // 裂
      break;
    case 'brokenColumn': // 残破石柱：断顶 + 凹槽 + 基座青苔
      round(4, 5, 8, 2, '#9a9588');   // 柱头（残）
      round(4, 7, 8, 8, '#88837a');   // 柱身
      round(4, 7, 1, 8, '#a7a294');   // 左 rim
      round(11, 7, 1, 8, '#605c54');  // 右暗
      round(6, 7, 1, 8, '#6f6a62');   // 凹槽线
      round(8, 7, 1, 8, '#6f6a62');   // 凹槽线2
      round(5, 5, 1, 2, '#a9a497');   // 断口参差
      round(9, 4, 1, 3, '#a9a497');   // 断口参差2
      round(7, 6, 1, 1, '#605c54');   // 断口缺
      round(4, 13, 8, 2, '#73706a');  // 基座
      round(4, 12, 2, 1, '#5f7d3c');  // 青苔
      round(9, 13, 2, 1, '#4c6630');  // 青苔2
      break;
    case 'rubble': // 碎石堆（小障碍）
      round(3, 10, 10, 4, '#8a857a'); // 底堆
      round(3, 10, 10, 1, '#a39e92'); // 顶高光
      round(4, 8, 4, 3, '#959084');   // 上块
      round(4, 8, 4, 1, '#aaa498');   // 上块顶高光
      round(9, 9, 3, 2, '#7c776e');   // 右块
      round(6, 12, 2, 1, '#5f5b54');  // 缝影
      round(5, 9, 1, 1, '#5f7d3c');   // 青苔点
      break;
    case 'standingStone': // 立石（森林石圈）：竖巨石 + 青苔 + 符文
      round(5, 1, 7, 2, '#7d8a90');   // 顶
      round(4, 3, 9, 12, '#6f7c82');  // 身
      round(4, 3, 1, 12, '#90a0a6');  // 左 rim
      round(12, 3, 1, 12, '#4e585d'); // 右暗
      round(6, 5, 1, 8, '#5b666b');   // 刻痕竖
      round(8, 6, 3, 1, '#5b666b');   // 符文横
      round(8, 9, 3, 1, '#5b666b');   // 符文横2
      round(4, 3, 5, 2, '#5f7d3c');   // 顶青苔
      round(4, 12, 3, 2, '#4c6630');  // 基青苔
      round(10, 11, 2, 1, '#5f7d3c'); // 青苔点
      break;
    case 'stall': // 集市货摊：条纹布棚 + 柜台 + 货物
      round(1, 2, 14, 4, '#c2462f');  // 布棚底（红）
      for (let i = 0; i < 7; i++) round(1 + i * 2, 2, 1, 4, '#f3ece0'); // 白条纹
      round(1, 2, 14, 1, '#d8674a');  // 棚顶高光
      round(1, 6, 14, 1, '#7a2c1c');  // 棚下影
      round(2, 6, 1, 8, '#6b4a2c');   // 左柱
      round(13, 6, 1, 8, '#6b4a2c');  // 右柱
      round(2, 11, 12, 3, '#9a6a3a'); // 柜台
      round(2, 11, 12, 1, '#b5824a'); // 台面高光
      round(2, 13, 12, 1, '#6b4524'); // 台底 AO
      round(4, 9, 2, 2, '#d8543a');   // 货：番茄
      round(7, 9, 2, 2, '#e0a93f');   // 货：南瓜
      round(10, 9, 2, 2, '#5a9a5a');  // 货：菜
      break;
    // ───────── 门口主题陈列道具（R3 生活感，按店铺类型摆门口） ─────────
    case 'flowerBucket': // 花店：木桶插花
      round(5, 9, 6, 5, '#8a6038'); round(5, 9, 6, 1, '#a87c4a'); round(5, 13, 6, 1, '#5e3c20');
      round(6, 10, 1, 3, '#6b4a2c'); round(9, 10, 1, 3, '#6b4a2c'); // 桶箍
      round(5, 6, 2, 2, '#e07aa8'); round(8, 5, 2, 2, '#f2c63a'); round(10, 7, 2, 2, '#e0584a'); // 花
      round(6, 8, 1, 2, '#4a8a4a'); round(9, 7, 1, 2, '#4a8a4a'); round(11, 8, 1, 1, '#4a8a4a'); // 茎
      break;
    case 'breadRack': // 面包房：面包架
      round(3, 11, 10, 3, '#8a5a30'); round(3, 11, 10, 1, '#a86a3a'); round(3, 13, 10, 1, '#5e3a18');
      round(4, 8, 3, 3, '#c98a48'); round(4, 8, 3, 1, '#dba35a');
      round(7, 7, 3, 4, '#c07a3a'); round(7, 7, 3, 1, '#d49a52');
      round(10, 8, 3, 3, '#c98a48'); round(10, 8, 3, 1, '#dba35a');
      round(5, 9, 1, 1, '#8a5a28'); round(11, 9, 1, 1, '#8a5a28'); // 裂纹
      break;
    case 'coalPile': // 铁匠铺：煤堆 + 余烬
      round(3, 10, 10, 4, '#33333b'); round(4, 8, 5, 3, '#3e3e48'); round(8, 9, 4, 2, '#2a2a33');
      round(4, 8, 5, 1, '#58585f'); round(8, 9, 4, 1, '#4c4c56'); // 受光面
      round(5, 9, 1, 1, '#6c6c78'); round(9, 10, 1, 1, '#60606c'); // 反光点
      round(7, 11, 1, 1, '#e8843a'); round(6, 12, 1, 1, '#c8542a'); // 余烬(forge 暖光)
      round(3, 13, 10, 1, '#1a1a20'); // 底 AO
      break;
    case 'kegStack': // 酒馆/客栈：叠桶
      round(3, 10, 10, 4, '#9a6a3a'); round(3, 10, 10, 1, '#b5824a'); round(3, 13, 10, 1, '#5e3a18');
      round(3, 11, 10, 1, '#6b4524'); round(4, 10, 1, 4, '#3a2a16'); round(11, 10, 1, 4, '#3a2a16');
      round(6, 6, 5, 4, '#a8743f'); round(6, 6, 5, 1, '#c08a4a'); round(6, 9, 5, 1, '#6b4524');
      round(7, 6, 1, 4, '#3a2a16'); round(9, 6, 1, 4, '#3a2a16');
      break;
    case 'cropSack': // 杂货/磨坊：谷物麻袋
      round(3, 8, 5, 6, '#c2a86a'); round(3, 8, 5, 1, '#d4bd80'); round(3, 13, 5, 1, '#9a8450'); round(4, 7, 3, 1, '#8a7038');
      round(8, 9, 5, 5, '#b89a5e'); round(8, 9, 5, 1, '#cab074'); round(8, 13, 5, 1, '#90784a'); round(9, 8, 3, 1, '#8a7038');
      round(5, 11, 1, 1, '#e8c86a'); round(10, 11, 1, 1, '#e8c86a'); // 漏谷
      break;
    case 'bookStack': // 书店：书堆
      round(4, 11, 9, 3, '#9a3a3a'); round(4, 11, 9, 1, '#b85a5a');
      round(3, 9, 9, 2, '#3a5a8a'); round(3, 9, 9, 1, '#5a7aa8');
      round(5, 7, 8, 2, '#3a7a4a'); round(5, 7, 8, 1, '#5a9a6a');
      round(12, 9, 1, 2, '#cdbf9a'); round(11, 7, 1, 2, '#cdbf9a'); // 书页侧
      break;
    case 'potionShelf': // 药铺：瓶架
      round(3, 5, 10, 9, '#6b4a2c'); round(3, 5, 10, 1, '#8a6038'); round(3, 9, 10, 1, '#5a3f28'); round(3, 13, 10, 1, '#4a3220');
      round(5, 6, 2, 3, '#4fae7a'); round(5, 6, 2, 1, '#9ad8b4');
      round(8, 6, 2, 3, '#b85a8a'); round(8, 6, 2, 1, '#e0a0c0');
      round(5, 10, 2, 3, '#5a8ac0'); round(5, 10, 2, 1, '#a0c0e0');
      round(9, 10, 2, 3, '#caa23f'); round(9, 10, 2, 1, '#e8d26a');
      break;
    case 'signboard': // 通用：A 字招牌
      round(4, 5, 8, 7, '#7a5230'); round(5, 6, 6, 5, '#e8dcc0');
      round(6, 7, 4, 1, '#5a4030'); round(6, 9, 4, 1, '#5a4030'); // 字行
      round(4, 5, 8, 1, '#9a6a3a');
      round(3, 12, 4, 2, '#6b4a2c'); round(9, 12, 4, 2, '#6b4a2c'); // A 字腿
      round(4, 12, 1, 2, '#7c5836'); round(10, 12, 1, 2, '#7c5836');
      break;
  }
  return c;
}
export function buildFurniture(): Partial<Record<FurnitureKind, C>> {
  return {
    table: furniture('table'),
    plant: furniture('plant'),
    bed: furniture('bed'),
    chair: furniture('chair'),
    lamp: furniture('lamp'),
    pedestal: furniture('pedestal'),
    rug: furniture('rug'),
    fence: furniture('fence'),
    mailbox: furniture('mailbox'),
    // 场景专属道具（R2）
    piling: furniture('piling'),
    shell: furniture('shell'),
    driftwood: furniture('driftwood'),
    brokenColumn: furniture('brokenColumn'),
    rubble: furniture('rubble'),
    standingStone: furniture('standingStone'),
    stall: furniture('stall'),
    // 门口主题陈列（R3）
    flowerBucket: furniture('flowerBucket'),
    breadRack: furniture('breadRack'),
    coalPile: furniture('coalPile'),
    kegStack: furniture('kegStack'),
    cropSack: furniture('cropSack'),
    bookStack: furniture('bookStack'),
    potionShelf: furniture('potionShelf'),
    signboard: furniture('signboard'),
  };
}

// ---- 角色（胶囊 + 朝向眼睛 + 2 帧微跳）----
const W = TILE;
const H = 18; // 比一格略高，脚对齐格底
function drawChar(dir: Dir, frame: number, hue: number): C {
  const [c, x] = mk(W, H);
  const bob = frame === 1 ? 1 : 0;
  const top = 2 + bob;
  const shirt = `hsl(${hue} 52% 52%)`;
  const shirtD = `hsl(${hue} 52% 40%)`;
  const skin = '#f1c89f';
  const hair = '#46342a';
  // 身体
  x.fillStyle = shirtD;
  x.fillRect(3, top + 7, 10, 8);
  x.fillStyle = shirt;
  x.fillRect(4, top + 7, 8, 7);
  // 脚
  x.fillStyle = '#2e2740';
  if (frame === 0) {
    x.fillRect(4, H - 2, 3, 2);
    x.fillRect(9, H - 2, 3, 2);
  } else {
    x.fillRect(5, H - 2, 3, 2);
    x.fillRect(8, H - 2, 3, 2);
  }
  // 头
  x.fillStyle = skin;
  x.fillRect(4, top, 8, 8);
  // 头发
  x.fillStyle = hair;
  x.fillRect(4, top, 8, 3);
  if (dir === 'up') x.fillRect(4, top, 8, 7); // 背面：后脑勺一片发
  // 眼睛
  x.fillStyle = '#241c2e';
  if (dir === 'down') {
    x.fillRect(6, top + 4, 1, 2);
    x.fillRect(9, top + 4, 1, 2);
  } else if (dir === 'left') {
    x.fillRect(5, top + 4, 1, 2);
  } else if (dir === 'right') {
    x.fillRect(10, top + 4, 1, 2);
  }
  return c;
}
export type CharFrames = Record<Dir, C[]>;
export function buildCharacter(hue: number): CharFrames {
  const dirs: Dir[] = ['down', 'up', 'left', 'right'];
  const out = {} as CharFrames;
  for (const d of dirs) out[d] = [drawChar(d, 0, hue), drawChar(d, 1, hue)];
  return out;
}

/** 由地址确定性取一个色相，给玩家上不同衣服色 */
export function hueFromAddress(address: string): number {
  const h = parseInt(address.slice(2, 8), 16);
  return h % 360;
}
