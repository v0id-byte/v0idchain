// 实验 5：改坏 chain.json 一个字节 → 节点不静默清空，而是「备份坏文件 + 从创世重建」。
// 否则：入侵者 / 共享主机同用户 / 磁盘位翻转，改一个字节就能让节点重启即丢光本地链。
//
// 跑：corepack pnpm tsx scripts/labs/05-corrupt-chainjson.ts
import { Blockchain, Wallet, saveChain, loadChain } from '../../packages/core/src/index.js';
import { rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';

const DIR = '.data/labs/lab5';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

// 先写一条合法链落盘
const bc = new Blockchain();
const bob = Wallet.generate();
for (let i = 0; i < 3; i++) await bc.mine(bob.address);
saveChain(DIR, bc);
console.log(`落盘一条合法链：高度 ${bc.height}（${bc.chain.length} 个区块）→ ${DIR}/chain.json\n`);

// 改坏「一个字符」：把链顶区块 hash 的某一位十六进制翻掉（JSON 仍能解析，但整链校验会失败）
const f = `${DIR}/chain.json`;
let text = readFileSync(f, 'utf8');
const at = text.lastIndexOf('"hash": "') + '"hash": "'.length + 10; // 链顶 hash 的第 10 位
const before = text[at];
text = text.slice(0, at) + (before === '0' ? '1' : '0') + text.slice(at + 1);
writeFileSync(f, text);
console.log(`把链顶区块 hash 的 1 个十六进制位 '${before}' 翻成 '${text[at]}'（仅 1 字节）。\n`);

// 重新加载——loadChain 会自己打印一行 ⚠️ 警告
console.log('重新加载 loadChain(dir)：');
const reloaded = loadChain(DIR);
console.log(`\n加载结果：高度 = ${reloaded.height}（回退到创世，等联网再同步回来，绝不静默丢账）`);
const backups = readdirSync(DIR).filter((n) => n.startsWith('chain.json.corrupt-'));
console.log(`坏文件已改名备份（未静默删除）：${backups.join(', ')}`);
