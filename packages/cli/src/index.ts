#!/usr/bin/env node
// v0idChain CLI —— start / mine / send / balance / peers / info / wallet
import { Command } from 'commander';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { V0idNode, startHttpApi } from '@v0idchain/node';
import { Wallet, loadWallet, bytesToHex, SYMBOL, GENESIS_PREMINE_ADDRESS } from '@v0idchain/core';

// --- 小工具：极简 ANSI 颜色 ---
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};
const short = (addr: string) => (addr.length > 16 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr);
const defaultDataDir = (name: string) => join(process.cwd(), '.data', name);

/** 调用运行中节点的 HTTP API */
async function api(base: string, method: string, path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`连不上节点 ${base} —— 它启动了吗？（v0id start …）`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const program = new Command();
program.name('v0id').description('v0idChain CLI —— 手搓区块链 $V0ID（零 gas / 零手续费）').version('0.1.0');

// ---- start ----
program
  .command('start')
  .description('启动一个节点：P2P 网络 + 本地 HTTP API（可选自动挖矿）')
  .option('--name <name>', '节点名（决定数据目录）', 'node')
  .option('--data-dir <dir>', '数据目录（默认 ./.data/<name>）')
  .option('--p2p-port <port>', 'P2P 监听端口', '6001')
  .option('--api-port <port>', '本地 HTTP API 端口', '7001')
  .option('--peers <urls>', '逗号分隔的对等/种子节点 ws 地址', '')
  .option('--bootstrap <urls>', '同 --peers（种子节点）', '')
  .option('--advertise <url>', '对外广播的本节点 ws 地址（公网/局域网才需要）')
  .option('--mine', '启动后自动挖矿', false)
  .option('--mine-interval <ms>', '自动挖矿出块间隔(ms)', '4000')
  .action((o) => {
    const dataDir = o.dataDir || defaultDataDir(o.name);
    const peers = [o.peers, o.bootstrap]
      .flatMap((s: string) => String(s).split(','))
      .map((s) => s.trim())
      .filter(Boolean);

    const node = new V0idNode({
      dataDir,
      p2pPort: Number(o.p2pPort),
      advertise: o.advertise,
      peers,
    });
    node.start();
    startHttpApi(node, Number(o.apiPort));

    console.log(c.bold(c.cyan('\n  v0idChain ⛓  节点已启动')));
    console.log(`  ${c.dim('名称  ')} ${o.name}`);
    console.log(`  ${c.dim('地址  ')} ${c.green(node.wallet.address)}`);
    console.log(`  ${c.dim('P2P   ')} ${o.advertise ?? `ws://127.0.0.1:${o.p2pPort}`}`);
    console.log(`  ${c.dim('API   ')} http://127.0.0.1:${o.apiPort}`);
    console.log(`  ${c.dim('数据  ')} ${dataDir}`);
    console.log(`  ${c.dim('链高  ')} ${node.bc.height}  ${c.dim('余额')} ${node.bc.balanceOf(node.wallet.address)} ${SYMBOL}`);
    if (peers.length) console.log(`  ${c.dim('对等  ')} ${peers.join(', ')}`);
    if (o.mine) {
      node.startMining(Number(o.mineInterval));
      console.log(c.yellow(`  ⛏  自动挖矿已开启（每 ${o.mineInterval}ms 出一块）`));
    }
    console.log(c.dim('\n  Ctrl-C 退出。另开一个终端用 `v0id` 子命令操作这个节点。\n'));

    // 每 5s 打一行状态，挖矿时能直观看到链在前进、余额在涨
    let lastHeight = node.bc.height;
    setInterval(() => {
      const i = node.info();
      const grew = i.height > lastHeight ? c.green(`+${i.height - lastHeight}`) : c.dim('·');
      lastHeight = i.height;
      const flag = o.mine ? c.yellow('⛏') : '🔗';
      console.log(
        `  ${flag} ${c.dim(new Date().toLocaleTimeString())}  链高 ${c.cyan(String(i.height))} ${grew}` +
          `  余额 ${c.green(`${i.balance} ${SYMBOL}`)}  难度 ${i.difficulty}bit  对等 ${i.peers}  池 ${i.mempool}`,
      );
    }, 5000).unref?.();
  });

// ---- 客户端命令（通过 --api 和运行中的节点对话） ----
const apiOpt = (cmd: Command) =>
  cmd.option('--api <url>', '节点 API 地址', 'http://127.0.0.1:7001');

apiOpt(program.command('info'))
  .description('查看节点状态')
  .action(async (o) => {
    const r = await api(o.api, 'GET', '/info');
    console.log(c.bold('地址 '), c.green(r.address));
    console.log(c.bold('余额 '), `${r.balance} ${r.symbol}`);
    console.log(c.bold('链高 '), `${r.height}（${r.blocks} 个区块）`);
    console.log(c.bold('交易池'), `${r.mempool} 笔待打包`);
    console.log(c.bold('难度 '), r.difficulty);
    console.log(c.bold('对等 '), `${r.peers} 个节点`);
    for (const p of r.peerList) console.log('   ', p.url ?? '?', p.address ? c.dim(`(${short(p.address)})`) : '');
  });

apiOpt(program.command('balance'))
  .argument('[address]', '要查询的地址（默认查本节点自己）')
  .description('查余额')
  .action(async (address, o) => {
    const path = address ? `/balance?address=${encodeURIComponent(address)}` : '/balance';
    const r = await api(o.api, 'GET', path);
    console.log(c.dim(r.address));
    console.log(c.bold(`${r.balance} ${SYMBOL}`));
  });

apiOpt(program.command('send'))
  .argument('<to>', '收款地址')
  .argument('<amount>', '金额')
  .option('--memo <text>', '附带一段备注（上链可查）', '')
  .description('转账（零手续费）')
  .action(async (to, amount, o) => {
    const r = await api(o.api, 'POST', '/send', { to, amount: Number(amount), memo: o.memo });
    console.log(c.green('✅ 交易已广播'), c.dim('txid='), r.txid);
  });

apiOpt(program.command('mine'))
  .argument('[blocks]', '挖几个块', '1')
  .description('立即挖矿（让运行中的节点挖 N 个块）')
  .action(async (blocks, o) => {
    const r = await api(o.api, 'POST', '/mine', { blocks: Number(blocks) });
    console.log(c.yellow(`⛏  挖出 ${r.mined.length} 个区块`));
    for (const h of r.mined) console.log('   ', c.dim(h));
  });

apiOpt(program.command('peers'))
  .description('查看已连接的对等节点')
  .action(async (o) => {
    const r = await api(o.api, 'GET', '/peers');
    console.log(`${r.length} 个对等节点`);
    for (const p of r) console.log('   ', p.url ?? '?', p.address ? c.dim(`(${short(p.address)})`) : '');
  });

apiOpt(program.command('connect'))
  .argument('<url>', '对方 ws 地址，如 ws://127.0.0.1:6002')
  .description('让本节点连接一个对等节点')
  .action(async (url, o) => {
    await api(o.api, 'POST', '/connect', { url });
    console.log(c.green('已发起连接'), url);
  });

// ---- market 集市（用 $V0ID 买卖商品/服务） ----
const market = program.command('market').description('集市：用 $V0ID 买卖商品/服务');
apiOpt(market.command('list'))
  .description('看在售商品')
  .option('--all', '连已售/已下架一起显示', false)
  .action(async (o) => {
    const all = (await api(o.api, 'GET', '/market')) as any[];
    const items = o.all ? all : all.filter((l) => !l.sold && !l.delisted);
    if (!items.length) return console.log(c.dim('（暂无商品）'));
    for (const l of items) {
      const tag = l.sold ? c.dim('[已售]') : l.delisted ? c.dim('[下架]') : c.green('[在售]');
      const mine = l.mine ? c.yellow(' (我的)') : '';
      console.log(`${tag} ${c.bold(`${l.price} ${SYMBOL}`)}  ${l.title}${mine}`);
      console.log(`      ${c.dim('卖家 ' + short(l.seller) + '  id ' + l.id.slice(0, 12) + '…')}`);
    }
  });
apiOpt(market.command('sell'))
  .argument('<price>', '价格（正整数 $V0ID）')
  .argument('<title...>', '商品/服务标题')
  .description('上架一件商品（需 ≥1 余额；上架交易被挖进区块后才出现）')
  .action(async (price, title, o) => {
    const r = await api(o.api, 'POST', '/market/sell', { price: Number(price), title: title.join(' ') });
    console.log(c.green('🏷  已上架'), c.dim('txid='), r.txid, c.dim('（等一个区块确认后可见）'));
  });
apiOpt(market.command('buy'))
  .argument('<id>', '商品 id（上架 txid，可只填前若干位则用 list 查全）')
  .description('购买商品（付标价给卖家）')
  .action(async (id, o) => {
    const r = await api(o.api, 'POST', '/market/buy', { id });
    console.log(c.green('🛒 已下单付款'), c.dim('txid='), r.txid);
  });
apiOpt(market.command('delist'))
  .argument('<id>', '商品 id')
  .description('撤下自己的商品')
  .action(async (id, o) => {
    const r = await api(o.api, 'POST', '/market/delist', { id });
    console.log(c.green('已撤单'), c.dim('txid='), r.txid);
  });

// ---- wallet（直接读数据目录，不需要节点在跑） ----
const wallet = program.command('wallet').description('钱包管理');
wallet
  .command('show')
  .option('--name <name>', '节点名', 'node')
  .option('--data-dir <dir>', '数据目录')
  .option('--secret', '同时显示私钥（小心泄露）', false)
  .action((o) => {
    const dir = o.dataDir || defaultDataDir(o.name);
    const w = loadWallet(dir); // 只读，不偷偷新建
    if (!w) {
      console.error(c.red(`该目录下没有钱包：${dir}`));
      console.error(c.dim('先用 `v0id wallet new` 新建，或 `v0id start` 启动节点（会自动建钱包）。'));
      process.exit(1);
    }
    console.log(c.bold('地址 '), c.green(w.address));
    console.log(c.bold('公钥 '), bytesToHex(w.publicKey));
    if (o.secret) {
      console.log(c.red('私钥 '), bytesToHex(w.privateKey));
      console.log(c.dim('↑ 把这串私钥存好就是备份。换机/丢失后用 `v0id wallet import <私钥>` 恢复（连币一起回来）。'));
    }
    console.log(c.dim(`(${dir})`));
  });
wallet
  .command('import')
  .argument('<privateKey>', '64 位 hex 私钥（来自 `wallet show --secret` 的备份）')
  .description('用私钥恢复钱包到数据目录（找回备份的钱包及其链上余额）')
  .option('--name <name>', '节点名', 'node')
  .option('--data-dir <dir>', '数据目录')
  .option('--force', '覆盖该目录已有钱包（危险：会丢掉现有钱包）', false)
  .action((privateKey, o) => {
    const key = String(privateKey).trim().replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{64}$/.test(key)) {
      console.error(c.red('私钥格式无效：应为 64 位十六进制'));
      process.exit(1);
    }
    const dir = o.dataDir || defaultDataDir(o.name);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'wallet.json');
    if (existsSync(f) && !o.force) {
      console.error(c.red(`${f} 已有钱包；如确定要覆盖，加 --force（会丢掉现有钱包！）`));
      process.exit(1);
    }
    const w = Wallet.fromPrivateKeyHex(key);
    writeFileSync(f, JSON.stringify(w.toJSON(), null, 2));
    console.log(c.green('🔑 钱包已恢复'), c.green(w.address));
    console.log(c.dim(`(${dir})  连上网络后余额会自动同步回来`));
  });
wallet
  .command('new')
  .description('在指定数据目录生成一个新钱包')
  .option('--name <name>', '节点名', 'node')
  .option('--data-dir <dir>', '数据目录')
  .action((o) => {
    const dir = o.dataDir || defaultDataDir(o.name);
    const w = Wallet.generate();
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'wallet.json');
    if (existsSync(f)) {
      console.error(c.red(`${f} 已存在，拒绝覆盖`));
      process.exit(1);
    }
    writeFileSync(f, JSON.stringify(w.toJSON(), null, 2));
    console.log(c.green('🔑 新钱包已生成'), c.green(w.address));
  });
wallet
  .command('treasury-address')
  .description('显示创世预挖（“央行”）地址')
  .action(() => {
    console.log(c.bold('央行/预挖地址 '), c.green(GENESIS_PREMINE_ADDRESS));
    console.log(c.dim('（其私钥只在所有者本机，用普通 send 分发这笔启动币）'));
  });

// 统一把命令里抛出的错误收成一行干净提示，而不是甩一坨 Node 堆栈给用户
program.parseAsync(process.argv).catch((err) => {
  console.error(c.red('✖ ' + (err instanceof Error ? err.message : String(err))));
  process.exit(1);
});
