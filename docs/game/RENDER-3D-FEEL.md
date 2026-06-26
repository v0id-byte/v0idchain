# 像素 2D 如何"假装 3D"——给我们这套程序化 canvas 渲染器的落地调研

> 目标：把 Stardew Valley（及 Terraria/RPG Maker/经典塞尔达系）"明明是 2D 却有立体纵深"的观感，拆成**可直接改进我们这套纯程序化 canvas 渲染器**的具体改动。
>
> 范围：本文只研究 + 给出改法，**不改任何代码**（代码由主会话统一提交）。涉及文件：
> `packages/game-web/src/engine/{buildings,foliage,ground,effects,game}.ts`。

---

## 0. 一句话结论

Stardew 的"立体感"**不是真 3D，而是一组互相叠加的廉价错觉**：① 选一个**斜上方俯视（oblique / "3⁄4"）的固定投影**，物体把"正面 + 一小条顶面"压平贴在地上画出来；② 全场景**统一光向（约左上）**，靠**受光面/暗面分层 + 落地接触阴影（blob）+ 底部环境光遮蔽压暗**奠定体积；③ 靠 **y-sorting + 直立 billboard** 让玩家能走到物体前后，把"高度"读出来；④ 像素层面靠**限色 + 抖动渐变 + 选择性描边 + 冷暗暖亮的 hue-shift** 把曲面"雕"出来。

我们现状（见 §6 现状盘点）已经踩中了其中几条（y-sort、歇山顶暗坡、树落地影、昼夜罩），**最缺的是：统一光向常量、建筑/家具的落地方向阴影 + 底部 AO、屋顶顶面厚度、地砖伪透视**。这四条是性价比最高的增量（见 §7 落地清单）。

---

## 1. 投影 / 视角：Stardew 用的是什么？

### 1.1 它是"斜俯视的 oblique（3⁄4 视角）"，**不是**真正的等距 isometric，也不是纯正俯视

- 社区与开发分析的共识口径：Stardew 是**从上方、但带一点角度**看下去的视图，正式术语最贴近 **oblique（斜投影）**，俗称 "angled top-down" / "3⁄4 perspective"。它**不是** Hotline Miami 那种完全压平的纯鸟瞰，也**不是**真正的轴测/等距。【R1】【R2】
- 关键技术点（多处复述同一句）："**Anything that portrays height is flattened against the ground, while depth is left alone on the vertical axis.**（凡是表现'高度'的都被压平贴到地面上，而'纵深'留在竖直轴上不动。）"——可类比一本被压扁的**立体书（pop-up book）**：所有高度被压平到书页上。【R2】
- 画法的工程红利（为什么选它）："**By choosing one orthographic projection you can make assets in any order and stack them together anywhere in a room and they will look ok.**" 即所有物体共用同一套平行投影 ⇒ 任意拼叠都协调、且**画师只画一个朝向**就够。【R3】 这点对我们尤其重要：**我们正是"每个物体一张正面贴图、按 y 堆叠"**，天然就在这个体系里。

> ⚠️ 名词打架的对抗式核实：同一个 Steam 帖里有人说 "orthographic"、有人说 "isometric"、有人说 "oblique"。【R1】 这不矛盾——严格几何上 Stardew 是**平行投影**（无消失点，故"orthographic/parallel"对）；但它**带俯角且只露正面+顶面薄片**，所以归类到 oblique 的 "3⁄4" 子类最准确；它**不是等距**（等距要三轴等比斜 30°，Stardew 的横竖线仍是正交网格）。【R5】 → 我们采用的口径：**正交平行投影 + 物体按 oblique/3⁄4 手法绘制**。

### 1.2 物体怎么画出"正面 + 一点顶/侧"来暗示体积

- oblique 的本质：**正面保持真实形状（不变形），纵深轴朝一个固定方向斜出去**，于是同时露出正面 + 顶面（和/或侧面），且**没有透视消失点**（平行线仍平行）。【R5】
- 两种斜法的取舍（直接决定"看着假不假"）：
  - **Cavalier（骑士）**：纵深按 1:1 全长斜出 ⇒ 顶/侧面显得过厚、夸张。
  - **Cabinet（橱柜）**：纵深**砍到一半**再斜出 ⇒ "forced depth"，更耐看、不突兀。【R5】
  - → **落地取向：我们给屋顶/家具加顶面厚度时，厚度要"薄"（约真实的 1⁄3～1⁄2），即 cabinet 而非 cavalier**，否则像积木。
- 经典 RPG 口径佐证："All lines are parallel at 90 degree angles and you don't see any of the sides... used to great effect in Stardew Valley."【R2】 注意这里说"看不到侧面"是指**没有透视收束的侧墙**；Stardew 实际仍画了**很薄的顶面/檐厚**来暗示高度——这正是我们要补的。

### 1.3 瓦片地面有没有"透视错觉"？怎么做？

- Stardew 的地面**本质是正交平铺的方格**，并没有真正的地面透视（不像赛车游戏那种近大远小）。它的"纵深感"来自**物体压在地面上的方式 + 接触阴影**，而不是地砖本身被拉斜。【R2】【R3】
- 但像素圈常用一个**伪透视小技巧**增强地面"被斜俯视"的暗示：**地砖/路面的高光偏向受光的上沿、暗缝偏向下沿**（即每格顶边亮、底边/竖缝暗），读起来像每块砖有一点点厚度被斜看。我们的 `ground.ts` 在 cobble 上已部分做了（顶高光/底暗），可推广到 stone/dirt（见 §7-D）。【R6】【R8】

---

## 2. 光影：立体感的地基

### 2.1 统一光向（通常左上）+ 受光/暗面分层

- 像素美术的第一原则：**先定一个光源方向再上色，全局保持一致**；不一致是"扁平脏"的头号原因。【R4】
- 体积怎么"雕"出来：**圆/曲面用 color ramp（明→暗多档）**，**平面用单一均匀色**；明暗交界（terminator）要**锐利**以避免 banding。【R4】
- 三个必避的错误（直接对应"看着假"）：① **soft faces**（平面被过度柔化）；② **pillow shading**（无视光源、沿轮廓一圈均匀压暗——最致命）；③ **flat light**（忘了画的是 3D 物体）。【R4】
- → 落地：我们所有手绘物件（建筑墙、家具、树、灯柱…）应**统一"左上受光、右下变暗"**，而不是各画各的。为此引入一个**全局光向常量**（§7-A）。

### 2.2 投射阴影：落地 blob / 方向性影——把物体"焊"在地上

- 16-bit 时代最高效的 2D 打光法："**the most efficient way to light a 2D game is to paint the shadows directly onto your sprites**"，外加角色脚下的 **drop shadow**。【R7】
- blob（团状）落地影的双重作用：**既当"接触阴影/AO"，又是判断物体是浮空还是站在地上的唯一线索**。【R10】 在 3D 平台跳跃游戏里这甚至是必备的落点指示。【R10】
- 形状来历：从物体朝下投一个圆/球 ⇒ 落在地面上自然成**椭圆**。【R10】 这正是 Stardew/我们该给树、家具、灯柱、玩家加的**椭圆地影**。
- 方向性：影子应**沿光向的反方向偏移**（左上来光 ⇒ 影子朝右下拖一点），并比物体略小、半透明。【R8】
- → 落地：给**每个直立物件**（树✅已有/家具/建筑/灯柱/喷泉/玩家/崽）统一加一枚**朝右下、半透明的椭圆接触影**（§7-B）。这是**单位投入立体感增益最高**的一条。

### 2.3 环境光遮蔽（AO）+ 底部压暗 + 顶部受光

- AO 定义："**ambient occlusion is the subtle darkening of the corners and crevices where the light is less likely to reach.**" 它告诉打光系统"这些地方别照亮"，**边缘与缝隙的暗化是卖出'深度'的关键**。【R6】
- 实操：**物体与地面接触的底沿、物体彼此的夹角/缝隙处压一道暗**；**朝光的顶面/上沿提亮**。哪怕只是底边 1px 暗线、顶边 1px 亮线，也立刻有体积。【R6】【R8】
- 环境色：整场景用一层 ambient modulate（如夜晚 `#24293b`）压暗，发光物用"不受影响层"跳出来形成对比。【R8】 我们的 `game.ts` 昼夜罩已是这个套路，可再补一个**白天的暖色/对比微调**让正午也有空气感（见 §7-F，低优先）。

---

## 3. 深度 / 遮挡：把"高度"读出来

### 3.1 y-sorting（我们已有）

- 物体按"脚底/底边的世界 y"排序后绘制，y 大者后画 ⇒ 靠下（更近）的盖住靠上（更远）的，玩家走到物体下方就被它挡住。这是 2.5D 顶视游戏的标准做法。我们的 `game.ts` 已用 `ds.sort((a,b)=>a.y-b.y)` 实现。
- **细节坑**：排序键必须是**物体的"接地 y"（底边/锚点）**，不是包围盒顶。我们树用 `f.y`、建筑用 `b.y+b.h-1`、炊烟用 `1e6` 强制最上层——方向正确。

### 3.2 直立 billboard vs 贴地：表达"高度"

- 表达高度的物体（树、灯柱、人、建筑）应作为**直立精灵**绘制——**底边锚在所在格、画面向上长**（"高度被压平贴地"的反面操作：让高度沿屏幕竖直轴向上伸）。【R2】 我们的树/角色/建筑已是"底中心/底边锚定、向上画"，正确。
- 贴地的物体（地毯、路面、影子、水面波光）则**铺在地面层、不参与 billboard**。我们 `drawWaterShimmer`/地砖正是铺地面层。

### 3.3 前后遮挡 + 分层（地面层 / 物件层 / 头顶层）

- 三层心智模型：**地面层（永远最底，不排序）→ 物件层（按 y-sort，玩家与之互相遮挡）→ 头顶层（永远最上，如炊烟、树梢飘叶、天气）**。我们已隐含这三层（瓦片层 / `ds` 排序层 / 炊烟 `1e6`）。
- "玩家走到物体后面被挡"= 物件层 y-sort 的直接结果，已生效。
- 可增强：**高大物体（树/建筑）当玩家走到其后被它挡住时，把该物体整体降到 ~70% 不透明**（Stardew 树就是这样让你看见身后的自己）——见 §7-E（中优先，需要知道玩家是否在物体覆盖格内）。

---

## 4. 像素手法：把体积"雕"进有限像素

### 4.1 限色 + 抖动（dithering）做曲面/光照渐变

- Stardew 风格三件套：**limited palette + dithering 上色 + 偏平的透视 + 亮色**。dithering 是早期为"用有限色板假装更平滑的渐变"发明的。【R2】
- 我们 `ground.ts`/`foliage.ts` 已用 **4×4 Bayer 有序抖动 + 限色量化**，方向完全正确。可把同一套抖动**用到墙面/屋顶的明暗过渡**上（目前墙面是平涂 + 整块 shade），让大平面不死板。

### 4.2 选择性描边（selective outlining）

- 不是所有边都描黑边：**只在需要和背景/相邻物分离处描，且描边用"附近最暗色的更暗版"而非纯黑**，避免像贴纸。【R4】 软化轮廓的诀窍是"把轮廓想成一张张小脸去顺"。【R4】
- 我们树冠已用 `rim` 暗边描边（非纯黑），正确；建筑目前几乎无描边，**贴在亮地面上时边界会糊**——可给建筑**底沿/暗侧加一道暗描边**帮助"浮"出来（与 §2.3 AO 合并做）。

### 4.3 Hue-shift：冷暗、暖亮（不要只调明度）

- 关键规则（强证据，开发者教程反复强调）：**别用纯明度 ramp**；**暗部往蓝移、降饱和（更冷），亮部往黄移、升饱和（更暖）**。只调明度会"dull and muddy（发闷发脏）"。【R9】
- 温度对立："usually a **hot light and cold shadows**"。【R9】 这条让同样的几档色立刻"通透"。
- → 落地：把建筑/家具/树的 `shade(hex, ±d)`（**纯加减 RGB = 纯明度**）升级成**带 hue-shift 的 ramp**：变亮时同时 +R/+G、略升饱和；变暗时 +B、降饱和（§7-C）。这是**改一个工具函数、全局受益**的高杠杆改动。

### 4.4 内部明暗分层 / rim light 强化体积

- 在轮廓**内部**再分 2～3 档明暗（不是只描外圈），并可加一条**朝光侧的 rim 高光**：rim shader "找到精灵最外圈像素按受光描一圈亮边，给出更多深度"。【R7】 我们树冠内部已分 light/mid/dark；建筑墙/屋顶可补**朝光侧（左/上）一条亮 rim**。

---

## 5. 关键结论的对抗式核实小结

| 说法 | 证据强度 | 处理 |
|---|---|---|
| Stardew = oblique/3⁄4，非真等距 | 高（社区+多篇分析一致，且与"横竖正交网格"自洽） | 采纳，口径=正交投影+oblique 手法【R1】【R2】【R5】 |
| "高度压平贴地、纵深留竖轴" | 中高（原话被多处复述，来源为二手分析非官方 GDC） | 采纳为指导隐喻，不当精确规范【R2】 |
| 暗部偏蓝降饱和、亮部偏黄升饱和 | 高（资深像素教程，机制可独立验证） | 采纳为 ramp 规则【R9】 |
| blob 椭圆影=接触阴影/AO+浮空判定 | 高（多来源+图形学课程） | 采纳为首要落地项【R7】【R10】 |
| 地砖"伪透视高光"是 Stardew 明确技法 | **低**（教程层面常见技巧，未见 Stardew 官方确认其用此） | 标注为**通用像素技巧**，非"Stardew 同款"，谨慎采纳【R6】【R8】 |
| Cabinet（半深）比 Cavalier（全深）耐看 | 高（几何定义） | 采纳：顶面厚度要薄【R5】 |

剔除的 folklore：网传"Stardew 用了 normal map / 动态光照"——**无据**；xDasher 那套 normal map/rim shader 是**另一款 Unity 游戏**的做法【R7】，Stardew 是**手绘进精灵的静态光影**（与 §2.2 一致）。我们是 canvas 程序化，**走手绘进像素这一路，不引入 normal map**。

---

## 6. 我们渲染现状盘点（改之前先对账）

✅ 已经做对的：
- **y-sort 深度排序**（`game.ts` `ds.sort`，键=接地 y）——核心已具备。
- **直立 billboard**（树/角色/建筑底边锚定向上画）。
- **限色 + 4×4 Bayer 抖动 + 最近邻放大**（`ground.ts`/`foliage.ts`）——像素质感对路。
- **树落地阴影**（`foliage.ts` 末尾 `[24,34,20] α70` 贴地条）——但是**居中竖条、非椭圆、无方向**。
- **歇山顶右坡暗面 + 屋脊高光 + 檐影**（`buildings.ts` `drawGableRoof`/`drawRoof`）——已有方向光意识，但**仅屋顶，墙面/门窗无**。
- **昼夜夜罩 + 窗/篝火/灯发光**（`game.ts` daylight 段）——AO/环境光的一种。
- **cobble 顶高光/底暗**（`ground.ts` `genCobble`）——伪体积已局部存在。

❌ 缺口（按立体感增益排序，对应 §7）：
1. **没有全局光向常量**——各物件明暗方向各自为政，不统一。
2. **建筑/家具/灯柱/玩家/崽 无落地接触阴影**（只有树有，且形状不对）。
3. **墙面是平涂**，无左上受光 / 右下暗面 / 底部 AO / 朝光 rim。
4. **屋顶无"顶面厚度"**（只有正面坡），少了 oblique 的关键体积线索。
5. **`shade()` 是纯明度加减**，无 hue-shift（暗不偏蓝、亮不偏黄）。
6. **地砖（stone/dirt）无伪透视高光**（仅 cobble 有）。

---

## 7. 落地清单（按"性价比 / 立体感增益"排序）

> 标注：💰=性价比（投入小） 📦=立体感增益（观感提升） 🎯=改哪个文件。
> 排序原则：**改一处、全局受益**的工具级改动优先；单物件细修靠后。

### A. 【最高优先】引入全局光向常量 + 统一受光约定 💰💰💰 📦📦
- 🎯 新增到 `game.ts` 或单独 `light.ts`，导出 `const LIGHT = { dx: -1, dy: -1 }`（左上来光，归一化）+ 约定文档注释。
- 所有手绘物件遵守：**朝 (-1,-1) 的面提亮、朝 (+1,+1) 的面压暗**。本条本身不改像素，但为 B/C/D 提供唯一光向，**消除"各画各"的扁平感**。依据 §2.1【R4】。

### B. 【最高优先】统一落地接触阴影（椭圆 / 朝右下 / 半透明）💰💰💰 📦📦📦
- 🎯 `game.ts` 渲染层加一个 `drawContactShadow(ctx, cxWorld, byWorld, rx, ry)`：在物体**接地点**画一枚 `ctx.ellipse`，`fillStyle rgba(0,0,0,0.22~0.3)`，**中心沿光向反方向（右下）偏移 1~2px**，rx≈物体宽×0.45、ry≈rx×0.4。
- 在 `ds` 里**每个直立物件 draw() 开头先画影、再画体**：建筑、家具（非贴地类）、灯柱/喷泉/水井（`effects.ts` 也可在各 drawer 顶部加）、玩家、崽、其他玩家。
- 顺带**把 `foliage.ts` 现有的居中竖条影换成椭圆**（或保留树影由本函数统一接管，删掉 foliage 末尾那段）。
- 依据：blob=接触阴影/AO + 浮空判定，2D 打光最高效【R7】【R10】；方向沿光反向偏移【R8】。**这是单条增益最高的改动。**

### C. 【高优先】把 `shade()` 升级成 hue-shift ramp 💰💰💰 📦📦
- 🎯 `buildings.ts`（`shade()`）+ `foliage.ts`/`ground.ts`（`shift()`、量化档）共用一个新工具：变亮 ⇒ +明度同时**升饱和、色相偏黄/暖**；变暗 ⇒ 降明度同时**降饱和、色相偏蓝/冷**。
- 实现可在 RGB 上近似：`light: r+=d; g+=d; b+=d*0.5`（蓝加得少=偏暖）；`dark: r-=d; g-=d; b-=d*0.6`（蓝减得少=残蓝偏冷）。一个函数改完，**建筑/树/地面全局通透**。
- 依据：暗冷亮暖、别只调明度【R9】。**改一处全局受益，杠杆极高。**

### D. 【高优先】墙面/家具加"左上受光 + 右下暗面 + 底部 AO + 朝光 rim"💰💰 📦📦
- 🎯 `buildings.ts` `drawTimberWall`/`drawStoneWall`：
  - 顶沿/左沿各 1px **rim 高光**（朝光侧），底沿/右沿各 1~2px **AO 暗线**（背光侧 + 接地）。
  - 墙身大平面叠一层**极淡的左上→右下明→暗梯度**（可用现有 Bayer 抖动量化，避免 banding，§4.1【R2】）。
- 家具同理（`sprites.ts` 的 `buildFurniture` 若是程序化，同法加顶亮底暗）。
- 依据：AO 暗化边缘缝隙卖深度【R6】；选择性描边用"更暗版"非纯黑【R4】；rim light【R7】。

### E. 【中优先】屋顶画出"顶面厚度"（cabinet 薄厚度）💰💰 📦📦
- 🎯 `buildings.ts` `drawRoof`/`drawGableRoof`：在屋脊与正面坡之间，沿屋脊画一条**朝观察者倾斜的薄顶面**（高度≈真实的 1⁄3~1⁄2=cabinet），顶面比正面坡更亮（受光），并在屋檐处补**檐厚 + 檐下 AO 暗线**。
- 这是补齐 oblique "正面 + 一条顶面"的关键体积线索（§1.2），让屋顶不再像一张贴纸。
- 依据：oblique 露正面+顶面、cabinet 半深更耐看【R5】。

### F. 【中优先】玩家走到高物体后方时该物体半透明 💰 📦📦
- 🎯 `game.ts`：渲染树/建筑前，判断**玩家接地格是否落在该物体覆盖范围内且玩家 y < 物体接地 y**（即站在其后被挡），若是则该物体 `globalAlpha=0.7` 绘制。
- 让"被挡"可读、不丢失玩家。Stardew 树即此手感（§3.3）。需要物体覆盖格信息，故列中优先。

### G. 【低优先】地砖伪透视高光推广到 stone/dirt 💰💰 📦
- 🎯 `ground.ts` `genStone`/`genDirt`：仿 `genCobble`，给每块/每缝**顶边 1px 亮、底边/竖缝 1px 暗**，制造"每块砖被斜俯视、有一点厚"的伪透视。
- 注意：**标注为通用像素技巧而非"Stardew 同款"**（§5 对抗核实，证据 tier 低）【R6】【R8】。增益较小，放最后。

### H. 【低优先】白天空气感微调 + 地面接触渐隐 💰 📦
- 🎯 `game.ts` daylight 段：正午也叠一层极淡暖色 modulate + 远处轻微降饱和，给空气透视暗示（§2.3【R8】）。增益最小，可选。

> 建议落地顺序：**A → B → C** 先做（三条都是"工具级、全局受益"，预计观感跳变最大），再 **D → E**（建筑细化），最后按需 F/G/H。

---

## References

> 可信度 tier：**高**=资深开发者/像素美术专著式教程 · 图形学课程；**中**=媒体/设计分析二手概述；**低**=论坛个人发言 / 未经官方确认的技法归因。关键数字与归因已在 §5 做对抗式核实。

- **【R1】** *"What is this perspective called?" — Stardew Valley General Discussions*（Steam 社区讨论帖，无明确年份；访问 2026-06）. https://steamcommunity.com/app/413150/discussions/0/3223871682622343166/ — **tier: 低**（论坛众说，但多人交叉印证 oblique/orthographic/非等距）。
- **【R2】** *Stardew Valley Art Style*（Stardew/Sundrop 美术风格概述，复述 "height flattened against the ground / limited palette + dithering / parallel lines, no sides" 等核心口径；scribd 预览 + 搜索摘要，2024 前后）. https://www.scribd.com/document/694721155/SundropArtGuide — **tier: 中**（二手风格指南，原话被多源复述）。
- **【R3】** *Game Design Perspective: Stardew Valley — Hacker News 讨论*（2021）. https://news.ycombinator.com/item?id=25875395 — **tier: 中**（"choose one orthographic projection → stack assets in any order" 的工程论点出处）。
- **【R4】** Pedro Medeiros, *How to start making pixel art #4 — Basic Shading*（Pixel Grimoire / Medium，资深像素美术师，~2018）. https://medium.com/pixel-grimoire/how-to-start-making-pixel-art-4-f57f51dcfa02 — **tier: 高**（光向一致、ramp 雕体积、避免 pillow shading/soft faces/flat light）。
- **【R5】** *Oblique projection / Axonometric projection*（Wikipedia，持续更新；访问 2026-06）. https://en.wikipedia.org/wiki/Oblique_projection — **tier: 高**（oblique vs orthographic vs isometric 定义；cavalier 全深 vs cabinet 半深；"3⁄4 perspective" 即 cabinet/military 变体）。
- **【R6】** *Mapping Pixel Art for 3D Lighting — RefresherTowel Games*（开发者博客，2025-06-10）. https://refreshertowelgames.wordpress.com/2025/06/10/mapping-pixel-art-for-3d-lighting/ — **tier: 中高**（AO=边缘缝隙的微暗化是卖深度的关键；rim light）。
- **【R7】** Pixel Beef 团队, *4 things we did to add light and depth to our Pixel Art Game (xDasher)*（itch.io devlog）. https://pixel-beef.itch.io/xdasher/devlog/192949/ — **tier: 中高**（"最高效的 2D 打光=把阴影直接画进精灵 + 脚下 drop shadow"；rim light shader；并据此澄清 normal map 是该 Unity 游戏做法、非 Stardew）。
- **【R8】** *2D Lighting for Pixel Art / Cast shadows — Unity Learn* 与 *Light and Shadow — True Top-Down 2D (Catlike Coding, Godot)*（引擎官方/资深教程；访问 2026-06）. https://learn.unity.com/course/2d-lighting-for-pixel-art/ · https://catlikecoding.com/godot/true-top-down-2d/4-light-and-shadow/ — **tier: 高**（方向性投影阴影、ambient modulate `#24293b` 压暗 + unlit 跳层、阴影沿光反向偏移、整数坐标避免幻影阴影）。
- **【R9】** Pedro Medeiros, *How to start making pixel art #6 — Basic Color Theory*（Pixel Grimoire / Medium，~2018）. https://medium.com/pixel-grimoire/how-to-start-making-pixel-art-6-a74f562a4056 — **tier: 高**（hue-shift：暗部偏蓝降饱和、亮部偏黄升饱和；热光冷影；别只调明度否则发闷发脏）。
- **【R10】** *Shadows — CMU 15-466 Computer Game Programming（课程讲义）*（Carnegie Mellon，课程材料，访问 2026-06）. https://15466.courses.cs.cmu.edu/lesson/shadows — **tier: 高**（blob 影=接触阴影/AO + "浮空还是落地"的判定线索；投影成椭圆的来历）。

---

*调研产出：本文（`docs/RENDER-3D-FEEL.md`）。代码改动见 §7，由主会话统一实施与提交。*
