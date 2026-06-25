# 巨型矿洞材质需求书

## 目标

为 `game-web` 的巨型矿洞玩法补一套像素材质。当前代码已有程序化占位绘制，材质 agent 只需要交付可替换的位图资源，不需要改玩法逻辑。

## 基础规格

- 基础瓦片尺寸：`16x16` px。
- 游戏内会以 nearest-neighbor 放大到约 `3x`，所以边缘必须像素清晰，不要模糊、羽化或抗锯齿。
- 地面/墙面用无缝 tile；物件用透明背景 PNG。
- 视角：俯视 2D，和现有城镇/农场像素风一致。
- 色彩：矿洞整体偏冷暗，但矿石必须在暗背景上清楚可辨。

## 资源清单

### 城镇入口

- `mineEntrance.png`
  - 建议占位尺寸：`48x48` px 或 `64x64` px。
  - 视觉必须一眼读成“矿洞入口”，包含深色洞口、岩石外框、入口牌或灯光。
  - 接地点应对齐入口底部中线，适配代码里的单格交互点。

### 矿洞地形

- `caveFloor.png`
  - `16x16` px，无缝。
  - 用于可行走地面，不能太亮。
- `caveWall.png`
  - `16x16` px，无缝或半无缝。
  - 用于可破坏墙体，轮廓要比地面更硬。

### 矿石覆盖层

每种矿石建议做 `16x16` px 透明 PNG，可直接叠在 `caveWall` 上：

- `ore_copper.png`
- `ore_iron.png`
- `ore_silver.png`
- `ore_gold.png`
- `ore_amethyst.png`
- `ore_void_crystal.png`
- `ore_starcore.png`
- `ore_ancient_relic.png`

稀有度需要能从颜色和发光感区分：

- 铜/铁：常见，低饱和，少量高光。
- 银/金：中高价值，更亮但不要变成纯白/纯黄块。
- 紫晶/虚空水晶：高饱和，适合轻微晶体边缘光。
- 星核/古代遗物：最高稀有度，要有收藏品感觉，但仍保持像素风。

### 交互物件

- `mineChest.png`
  - `16x16` px 或 `32x32` px，透明背景。
  - 需要在暗地面上清楚可见。
- `mineMonster_basic.png`
  - `16x16` px 或 `32x32` px，透明背景。
  - 战斗先轻量，怪物可以可爱/低威胁，不要恐怖血腥。
- `stairsDown.png`
  - `16x16` px，表达“继续下矿”。
- `stairsUp.png`
  - `16x16` px，表达“回上一层”。
- `mineExit.png`
  - `16x16` px，表达“回城镇”。

## 命名与接入建议

代码里的对象名已经固定：

- 地形：`caveFloor`, `caveWall`
- 城镇入口：`mineEntrance`
- 矿石种类：`copper`, `iron`, `silver`, `gold`, `amethyst`, `void_crystal`, `starcore`, `ancient_relic`
- 物件：`chest`, `monster`, `stairsDown`, `stairsUp`, `exit`

材质 agent 可以先把资源放在 `packages/game-web/public/assets/mine/`，再由接入 agent 决定是否做 atlas 或直接加载 PNG。

## 验收标准

- 城镇东侧入口在第一眼能读成矿洞，不需要说明文字也能找到。
- 矿洞内地面、墙、矿石、宝箱、怪物、上下楼梯都能在暗色环境中分辨。
- 所有资源以 `16px` 网格对齐，放大后没有模糊边。
- 稀有矿石比普通矿石更有收藏感，但不会抢走整个画面注意力。
- 透明 PNG 没有脏边、半透明噪点或多余背景色。
