// 架构边界守卫（零依赖，用工具钉死 PRD §1 的“三层分离”铁律）：
//   ① 游戏层（packages/game-*）只能依赖 @v0idchain/core 的公开导出，绝不碰 node/cli。
//   ② 链层（core/node/cli）永不反向依赖游戏层。
// 这样链能脱离游戏独活（PRD G4）；将来把 game-server 拆成独立仓库，只是“剪一条单向边”而非解耦一团乱麻。
// 用法：corepack pnpm check:boundaries（非零退出 = 有越界）。
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// 抓 import/export ... from '<mod>' 与 动态 import('<mod>')
const IMPORT_RE = /(?:import|export)[^;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
function importsOf(file: string): string[] {
  const mods: string[] = [];
  let m: RegExpExecArray | null;
  const src = readFileSync(file, 'utf8');
  while ((m = IMPORT_RE.exec(src))) mods.push(m[1] ?? m[2]);
  return mods;
}

const rel = (f: string) => relative(ROOT, f);
let violations = 0;
const fail = (msg: string) => { console.error('  ❌ ' + msg); violations++; };

// 规则①：游戏层只能依赖 @v0idchain/core[/browser]
const GAME_DIRS = ['packages/game-server', 'packages/game-web'];
for (const d of GAME_DIRS) {
  const dir = join(ROOT, d);
  if (!existsSync(dir)) continue;
  for (const f of walk(dir)) {
    for (const mod of importsOf(f)) {
      if (mod.startsWith('@v0idchain/') && mod !== '@v0idchain/core' && mod !== '@v0idchain/core/browser') {
        fail(`游戏层越界依赖：${rel(f)}\n     import '${mod}' —— 只允许 @v0idchain/core 或 @v0idchain/core/browser`);
      }
    }
  }
}

// 规则②：链层不得反向依赖游戏层
for (const d of ['packages/core', 'packages/node', 'packages/cli']) {
  const dir = join(ROOT, d);
  if (!existsSync(dir)) continue;
  for (const f of walk(dir)) {
    for (const mod of importsOf(f)) {
      if (mod.startsWith('@v0idchain/game')) {
        fail(`链层反向依赖游戏层（破坏单向边）：${rel(f)}\n     import '${mod}'`);
      }
    }
  }
}

if (violations === 0) {
  console.log('✅ 架构边界 OK：游戏层只依赖 core，链层不反依赖游戏层。');
  process.exit(0);
} else {
  console.error(`\n💥 ${violations} 处越界，违反 PRD §1 三层分离铁律。`);
  process.exit(1);
}
