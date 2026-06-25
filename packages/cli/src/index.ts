#!/usr/bin/env node
// v0idChain CLI —— start / mine / send / balance / peers / info / wallet
import { Command } from 'commander';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { V0idNode, startHttpApi, RelayNode, SocksProxy, loadOrCreateOnionKey, makeHsDeps, serveHiddenService, GuardManager, type HopSpec } from '@v0idchain/node';
import {
  Wallet,
  loadWallet,
  writeWalletFile,
  loadOrCreateApiToken,
  loadApiToken,
  bytesToHex,
  hexToBytes,
  SYMBOL,
  MIN_FEE,
  minFeeFor,
  MESSAGE_BURN,
  GENESIS_PREMINE_ADDRESS,
} from '@v0idchain/core';

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
const difficultyText = (d: number) => d > 255 ? `nBits 0x${d.toString(16).padStart(8, '0')}` : `${d}bit`;
const defaultDataDir = (name: string) => join(process.cwd(), '.data', name);

/**
 * 调用运行中节点的 HTTP API。token 优先用 --token，否则从数据目录的 api.token 自动读取
 * （默认 --name node → ./.data/node/api.token），故同机同用户跑客户端子命令零额外参数即可。
 */
async function api(o: any, method: string, path: string, body?: unknown): Promise<any> {
  const base: string = o.api;
  const token: string | undefined = o.token || loadApiToken(o.dataDir || defaultDataDir(o.name)) || undefined;
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`连不上节点 ${base} —— 它启动了吗？（v0id start …）`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/**
 * 广播一笔交易后，轮询节点的 GET /tx?txid= 等它被矿工打包进区块——把抽象的“一个区块确认”
 * 变成看得见的“处理中 → 已到账”。给超时上限，没人挖矿时也不会卡死。
 */
async function waitConfirm(o: any, txid: string, timeoutMs = 25000): Promise<void> {
  console.log(c.dim('  ⏳ 已广播，正在等矿工打包，通常几秒…'));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1500));
    let st: any;
    try {
      st = await api(o, 'GET', `/tx?txid=${encodeURIComponent(txid)}`);
    } catch {
      continue; // 节点临时抖动，下一轮再试
    }
    if (st.status === 'confirmed') {
      console.log(c.green(`  ✅ 已到账（区块 #${st.height}）`));
      return;
    }
  }
  console.log(c.yellow('  ⏳ 还没被打包——确认网络里有矿工在挖（本地可 `v0id mine`），稍后 `v0id info` 再看。'));
}

const program = new Command();
program.name('v0id').description('v0idChain CLI —— 手搓区块链 $V0ID（PoW 挖矿出币 · 转账带手续费/gas 给矿工）').version('0.1.0');

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
  .option('--mine-interval <ms>', '出块间隔(ms)，0=连续挖、由 PoW 难度定节奏（默认）', '0')
  .option('--webrtc', '启用 WebRTC mesh（实验性）：经种子信令打洞，与 NAT 后的对端点对点直连', false)
  .option('--relay', '作为 .v0id 洋葱中继运行（独立 cell 端口 + 上链发布描述符）', false)
  .option('--relay-port <port>', '洋葱中继 cell 入口端口（默认 p2p-port+10）')
  .option('--relay-advertise <host>', '中继对外 host（公网/局域网才需要；默认 127.0.0.1）')
  .option('--exit-allow <list>', '作出口时允许连的 host:port（逗号分隔；默认空=纯中继/守卫，不作出口）', '')
  .option('--socks', '启动本地 SOCKS5 前端（普通程序经洋葱电路出网；亦支持 curl --socks5-hostname … <地址>.v0id）', false)
  .option('--socks-port <port>', 'SOCKS5 监听端口', '9050')
  .option('--hs-target <host:port>', '托管一个 .v0id 隐藏服务，把进来的连接转发到本机 host:port（需链上≥3 中继）')
  .option('--hs-intros <n>', '隐藏服务引入点数量（默认 3）', '3')
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
      enableRtc: o.webrtc, // 实验性 WebRTC mesh（docs/WEBRTC-MESH-DESIGN.md）
      // 有新节点上线 / 新地址首次上链时，实时打一行（运行中的节点窗口直接可见）
      onNotice: (m) => console.log(`  ${c.cyan(m)}`),
    });
    node.start();
    const apiToken = loadOrCreateApiToken(dataDir);
    startHttpApi(node, Number(o.apiPort), apiToken);

    console.log(c.bold(c.cyan('\n  v0idChain ⛓  节点已启动')));
    console.log(`  ${c.dim('名称  ')} ${o.name}`);
    console.log(`  ${c.dim('地址  ')} ${c.green(node.wallet.address)}`);
    console.log(`  ${c.dim('P2P   ')} ${o.advertise ?? `ws://127.0.0.1:${o.p2pPort}`}`);
    if (o.webrtc) console.log(`  ${c.dim('WebRTC')} ${c.yellow('已启用（实验性 mesh 打洞）')}`);
    console.log(`  ${c.dim('API   ')} http://127.0.0.1:${o.apiPort}`);
    console.log(`  ${c.dim('数据  ')} ${dataDir}`);
    console.log(`  ${c.dim('令牌  ')} ${join(dataDir, 'api.token')}  ${c.dim('(CLI 自动读取；仪表盘需手动粘贴)')}`);
    console.log(`  ${c.dim('链高  ')} ${node.bc.height}  ${c.dim('余额')} ${node.bc.balanceOf(node.wallet.address)} ${SYMBOL}`);
    if (peers.length) console.log(`  ${c.dim('对等  ')} ${peers.join(', ')}`);
    if (o.mine) {
      const iv = Number(o.mineInterval);
      node.startMining(iv);
      console.log(
        c.yellow(iv > 0 ? `  ⛏  自动挖矿已开启（每块间歇 ${iv}ms）` : `  ⛏  自动挖矿已开启（连续挖，出块节奏由 PoW 难度决定）`),
      );
    }
    // ---- .v0id 洋葱中继 / SOCKS5 前端 / 隐藏服务托管 ----
    if (o.relay || o.socks || o.hsTarget) {
      // 从链上目录解析中继地址 → cell 入口（用于 EXTEND 拨号 & SOCKS 选路）
      const resolver = (id: string) => {
        const d = node.relays().find((r) => r.address === id);
        return d ? { host: d.host, port: d.port } : undefined;
      };
      // 入口守卫：把所有电路的第一跳钉死在一小撮持久守卫上（抗多电路统计去匿名，见 guards.ts）。
      // SOCKS 与 HS（makeHsDeps）共用**同一个** GuardManager → 两边电路用同一守卫，攻击面统一收窄。
      const guardManager = o.socks || o.hsTarget ? new GuardManager(dataDir, { selfId: node.wallet.address }) : undefined;
      // 隐藏服务接线依赖（选路器 + 名录）：SOCKS 的 .v0id 出站与 --hs-target 托管共用一份（每次从链上重新快照）。
      const hsDeps = o.socks || o.hsTarget ? makeHsDeps(() => node.relays(), guardManager) : undefined;
      if (o.relay) {
        const relayPort = Number(o.relayPort || Number(o.p2pPort) + 10);
        const onion = loadOrCreateOnionKey(dataDir);
        const adHost = o.relayAdvertise || '127.0.0.1';
        const onionPubHex = bytesToHex(onion.pub);
        const relay = new RelayNode(node.wallet.address, onion, resolver, relayPort, '0.0.0.0');
        const allow = String(o.exitAllow).split(',').map((s: string) => s.trim()).filter(Boolean);
        if (allow.length) {
          const set = new Set(allow);
          relay.setExitPolicy((host, port) => set.has(`${host}:${port}`));
        }
        console.log(`  ${c.dim('中继  ')} cell:${relayPort}  okey:${onionPubHex.slice(0, 16)}…  出口:${allow.length ? c.yellow(allow.join(',')) : c.dim('deny-all')}`);
        // 自动发布描述符：余额够且尚未发布时发一次（挖矿/收款后自动生效）
        let published = false;
        const tryPublish = () => {
          if (published) return;
          const existing = node.relays().find((r) => r.address === node.wallet.address);
          if (existing && existing.onionPubHex === onionPubHex && existing.host === adHost && existing.port === relayPort) {
            published = true;
            return;
          }
          if (node.bc.balanceOf(node.wallet.address) < 2) return;
          const pub = node.publishRelay(onionPubHex, adHost, relayPort);
          if (pub.ok) {
            published = true;
            console.log(`  ${c.green('✓ 中继描述符已上链广播（待挖块生效，全网可发现）')}`);
          }
        };
        tryPublish();
        setInterval(tryPublish, 5000).unref();
      }
      if (o.socks) {
        const socksPort = Number(o.socksPort);
        // hop0 = 持久守卫（与 HS 共用同一 GuardManager）；守卫不可用则失败/等待冷却恢复，绝不回退随机入口。
        const pickHops = (): HopSpec[] => {
          const all = node.relays();
          if (all.length < 3) throw new Error('链上中继不足 3 个，暂无法建路');
          const hop = (d: (typeof all)[number]): HopSpec => ({ id: d.address, onionPub: hexToBytes(d.onionPubHex), host: d.host, port: d.port });
          const gid = guardManager!.currentGuard(all);
          const guard = gid ? all.find((d) => d.address === gid) : undefined;
          if (!guard) throw new Error('钉住守卫均不可用，暂无法建路');
          // middle：≠ guard 的随机中继；exit：≠ guard、≠ middle 的随机中继。
          const afterGuard = all.filter((d) => d.address !== guard.address);
          const middle = afterGuard[Math.floor(Math.random() * afterGuard.length)];
          const exitPool = afterGuard.filter((d) => d.address !== middle.address);
          const exit = exitPool[Math.floor(Math.random() * exitPool.length)];
          return [hop(guard), hop(middle), hop(exit)];
        };
        // 仅当**连守卫(hop0)失败**时才标记其不可达 → 下次 pickHops 经 currentGuard 自动切到钉住备份；
        // 并发新连接照常复用同一主守卫（不再有时间窗口误标，钉固在正常浏览下稳定）。
        new SocksProxy(pickHops, socksPort, '127.0.0.1', hsDeps, (g) => guardManager!.markUnreachable(g.id));
        console.log(`  ${c.dim('SOCKS ')} 127.0.0.1:${socksPort}  ${c.dim('（curl --socks5 …/--socks5-hostname … <地址>.v0id 经洋葱出网；需链上≥3 中继）')}`);
      }
      // ---- 托管 .v0id 隐藏服务：把进来的会合连接转发到本机 host:port ----
      if (o.hsTarget && hsDeps) {
        const i = String(o.hsTarget).lastIndexOf(':');
        const thost = i > 0 ? String(o.hsTarget).slice(0, i) : '';
        const tport = Number(String(o.hsTarget).slice(i + 1));
        if (i <= 0 || !Number.isInteger(tport) || tport < 1 || tport > 65535) {
          console.log(`  ${c.red('✖ --hs-target 格式应为 host:port，例如 127.0.0.1:8080')}`);
        } else if (node.relays().length < 3) {
          // 与 --socks 同前置：目录太小先不崩，给一行友好提示（挖矿/更多中继上链后重启即可托管）。
          console.log(`  ${c.yellow('⚠ 链上中继不足 3 个，暂无法托管隐藏服务（待更多 relay 上链后重启 --hs-target）')}`);
        } else {
          // 异步启动（建引入电路 + 发布描述符需几跳往返）；成功后打印 .v0id 地址，失败给一行提示而非崩进程。
          serveHiddenService({ dataDir, target: { host: thost, port: tport }, deps: hsDeps, numIntros: Number(o.hsIntros) })
            .then(({ address }) => {
              console.log(`  ${c.dim('隐藏  ')} ${c.green(address)}  ${c.dim('→ ' + thost + ':' + tport)}`);
              console.log(`  ${c.dim('      ')} ${c.dim('别人可 curl --socks5-hostname <某节点SOCKS> ' + address + ' 访问（双方互不知 IP）')}`);
            })
            .catch((e) => console.log(`  ${c.yellow('⚠ 隐藏服务托管失败：' + (e instanceof Error ? e.message : String(e)) + '（稍后重试 / 确认中继充足）')}`));
        }
      }
    }

    console.log(c.dim('\n  Ctrl-C 退出。另开一个终端用 `v0id` 子命令操作这个节点。\n'));

    // 每 5s 打一行状态，挖矿时能直观看到链在前进、余额在涨
    let lastHeight = node.bc.height;
    setInterval(() => {
      const i = node.info();
      const time = c.dim(new Date().toLocaleTimeString());
      if (i.syncing) {
        // 还没连上/没追平 —— 明确显示“同步中”，不再打迷惑性的“挖矿”数字
        console.log(`  🔄 ${time}  ${c.yellow('正在连接 / 同步区块…')}  链高 ${c.cyan(String(i.height))}  对等 ${i.peers}`);
        lastHeight = i.height;
        return;
      }
      const grew = i.height > lastHeight ? c.green(`+${i.height - lastHeight}`) : c.dim('·');
      lastHeight = i.height;
      const flag = o.mine ? c.yellow('⛏') : '🔗';
      console.log(
        `  ${flag} ${time}  链高 ${c.cyan(String(i.height))} ${grew}` +
          `  余额 ${c.green(`${i.balance} ${SYMBOL}`)}  难度 ${difficultyText(i.difficulty)}  对等 ${i.peers}  池 ${i.mempool}`,
      );
    }, 5000).unref?.();
  });

// ---- 客户端命令（通过 --api 和运行中的节点对话） ----
const apiOpt = (cmd: Command) =>
  cmd
    .option('--api <url>', '节点 API 地址', 'http://127.0.0.1:7001')
    .option('--token <token>', 'API 令牌（默认从数据目录的 api.token 自动读取）')
    .option('--name <name>', '节点名（用于定位 api.token）', 'node')
    .option('--data-dir <dir>', '数据目录（默认 ./.data/<name>）');

// 会广播一笔交易的“写命令”：在 apiOpt 之外再带 --no-wait（默认广播后轮询等待打包确认）
const txCmd = (cmd: Command) => apiOpt(cmd).option('--no-wait', '广播后不等待打包确认，立即返回 txid');

apiOpt(program.command('info'))
  .description('查看节点状态')
  .action(async (o) => {
    const r = await api(o,'GET', '/info');
    console.log(c.bold('地址 '), c.green(r.address));
    console.log(c.bold('余额 '), `${r.balance} ${r.symbol}`);
    console.log(c.bold('链高 '), `${r.height}（${r.blocks} 个区块）`);
    console.log(c.bold('交易池'), `${r.mempool} 笔待打包`);
    console.log(c.bold('难度 '), difficultyText(r.difficulty));
    if (r.minFee !== undefined) console.log(c.bold('手续费'), `≥ ${r.minFee}（gas，给矿工）`);
    if (r.burned !== undefined) console.log(c.bold('已销毁'), `🔥 ${r.burned} ${SYMBOL}（发消息烧进虚空）`);
    console.log(c.bold('对等 '), `${r.peers} 个节点`);
    for (const p of r.peerList) console.log('   ', p.url ?? '?', p.address ? c.dim(`(${short(p.address)})`) : '');
  });

apiOpt(program.command('newcomers'))
  .description('查看本次会话发现的新成员（新节点上线 / 新地址首次上链）')
  .action(async (o) => {
    const r = (await api(o, 'GET', '/newcomers')) as any[];
    if (!r.length) return console.log(c.dim('（暂无新成员）'));
    for (const n of r) {
      const when = c.dim(new Date(n.at).toLocaleString());
      if (n.kind === 'peer') {
        console.log(`${c.cyan('🆕 新节点')} ${short(n.address)} ${c.dim('via ' + (n.listen ?? '?'))}  ${when}`);
      } else {
        console.log(`${c.green('🆕 新地址')} ${short(n.address)} ${c.dim('@ #' + n.height)}  ${when}`);
      }
    }
  });

apiOpt(program.command('balance'))
  .argument('[address]', '要查询的地址（默认查本节点自己）')
  .description('查余额')
  .action(async (address, o) => {
    const path = address ? `/balance?address=${encodeURIComponent(address)}` : '/balance';
    const r = await api(o,'GET', path);
    console.log(c.dim(r.address));
    console.log(c.bold(`${r.balance} ${SYMBOL}`));
  });

txCmd(program.command('send'))
  .argument('<to>', '收款地址')
  .argument('<amount>', '金额')
  .option('--memo <text>', '附带一段备注（上链可查）', '')
  .option('--fee <n>', `手续费（gas；省略则自动算：max(${MIN_FEE}, 金额×0.1%)）`)
  .description('转账（需付 金额 + 手续费/gas）')
  .action(async (to, amount, o) => {
    const amt = Number(amount);
    const fee = o.fee !== undefined ? Number(o.fee) : minFeeFor(amt);
    const r = await api(o,'POST', '/send', { to, amount: amt, memo: o.memo, fee });
    console.log(c.green('✅ 交易已广播'), c.dim('txid='), r.txid, c.dim(`手续费=${fee}`));
    if (o.wait) await waitConfirm(o, r.txid);
  });

txCmd(program.command('msg'))
  .argument('<to>', '收件人地址')
  .argument('<text...>', '消息正文')
  .option('--burn <n>', `烧进虚空的 $V0ID（永久销毁；默认 ${MESSAGE_BURN}，越多越壕）`, String(MESSAGE_BURN))
  .option('--fee <n>', `手续费（gas，给打包矿工，至少 ${MIN_FEE}）`, String(MIN_FEE))
  .option('-e, --encrypt', '端到端加密（只有收件人能解；发件人也能解自己发的）', false)
  .description('给一个地址发链上消息（不转币，烧掉一点 $V0ID；-e 加密）')
  .action(async (to, text, o) => {
    const burn = Number(o.burn);
    const r = await api(o, 'POST', '/message', { to, text: text.join(' '), burn, fee: Number(o.fee), encrypt: !!o.encrypt });
    const lock = o.encrypt ? c.cyan(' 🔒加密') : '';
    console.log(c.green('✉️  消息已广播') + lock, c.dim('txid='), r.txid, c.dim(`🔥烧=${burn} 手续费=${Number(o.fee)}`));
    console.log(c.dim('（打包确认后，对方 `v0id inbox` 即可看到）'));
    if (o.wait) await waitConfirm(o, r.txid);
  });

apiOpt(program.command('inbox'))
  .argument('[address]', '要查看的地址（默认本节点自己）')
  .option('--sent', '改看发件箱（自己发出的消息）', false)
  .description('查看链上消息收件箱（发给你的消息）')
  .action(async (address, o) => {
    const path = address ? `/messages?address=${encodeURIComponent(address)}` : '/messages';
    const [r, reg] = await Promise.all([api(o, 'GET', path), api(o, 'GET', '/names').catch(() => ({}))]);
    const a2n: Record<string, string> = reg.addressToName || {};
    const nm = (addr: string) => (a2n[addr] ? c.cyan('@' + a2n[addr]) : short(addr));
    const list = o.sent ? r.sent : r.received;
    const label = o.sent ? '发件箱' : '收件箱';
    console.log(c.dim(`${nm(r.address)} 的${label}`));
    if (!list.length) return console.log(c.dim('（暂无消息）'));
    for (const m of list) {
      const who = o.sent ? `→ ${nm(m.to)}` : `← ${nm(m.from)}`;
      const when = c.dim(new Date(m.timestamp).toLocaleString());
      const lock = m.encrypted ? c.cyan('🔒') + (m.locked ? c.dim('(无法解密)') : '') + ' ' : '';
      const body = m.locked ? c.dim('（加密内容，非本人无法解密）') : c.bold(m.text);
      console.log(`${who}  ${lock}${body}  ${c.dim(`🔥${m.burn} #${m.height}`)}  ${when}`);
    }
  });

apiOpt(program.command('mine'))
  .argument('[blocks]', '挖几个块', '1')
  .description('立即挖矿（让运行中的节点挖 N 个块）')
  .action(async (blocks, o) => {
    const r = await api(o,'POST', '/mine', { blocks: Number(blocks) });
    console.log(c.yellow(`⛏  挖出 ${r.mined.length} 个区块`));
    for (const h of r.mined) console.log('   ', c.dim(h));
  });

apiOpt(program.command('peers'))
  .description('查看已连接的对等节点')
  .action(async (o) => {
    const r = await api(o,'GET', '/peers');
    console.log(`${r.length} 个对等节点`);
    for (const p of r) console.log('   ', p.url ?? '?', p.address ? c.dim(`(${short(p.address)})`) : '');
  });

apiOpt(program.command('connect'))
  .argument('<url>', '对方 ws 地址，如 ws://127.0.0.1:6002')
  .description('让本节点连接一个对等节点')
  .action(async (url, o) => {
    await api(o,'POST', '/connect', { url });
    console.log(c.green('已发起连接'), url);
  });

apiOpt(program.command('checkpoint'))
  .argument('[height]', '要冻结的高度（默认最新链顶）')
  .description('打印某高度的 checkpoint 条目，粘贴进 config.ts 的 CHECKPOINTS（冻结历史、抬高深度 reorg 成本）')
  .action(async (height, o) => {
    const chain = (await api(o, 'GET', '/chain')) as any[];
    const top = chain.length - 1;
    const h = height === undefined ? top : Number(height);
    if (!Number.isInteger(h) || h < 0 || h > top) {
      console.error(c.red(`高度无效：当前链顶为 ${top}`));
      process.exit(1);
    }
    console.log(c.bold('粘贴进 config.ts 的 CHECKPOINTS（所有节点须一致）：'));
    console.log(c.green(`  { index: ${h}, hash: '${chain[h].hash}' },`));
    console.log(c.dim('提示：选一个已被充分确认（后面又压了很多块）的高度。'));
  });

// ---- market 集市（用 $V0ID 买卖商品/服务） ----
const market = program.command('market').description('集市：用 $V0ID 买卖商品/服务');
apiOpt(market.command('list'))
  .description('看在售商品')
  .option('--all', '连已售/已下架一起显示', false)
  .action(async (o) => {
    const all = (await api(o,'GET', '/market')) as any[];
    const items = o.all ? all : all.filter((l) => !l.sold && !l.delisted);
    if (!items.length) return console.log(c.dim('（暂无商品）'));
    for (const l of items) {
      const tag = l.sold ? c.dim('[已售]') : l.delisted ? c.dim('[下架]') : c.green('[在售]');
      const mine = l.mine ? c.yellow(' (我的)') : '';
      console.log(`${tag} ${c.bold(`${l.price} ${SYMBOL}`)}  ${l.title}${mine}`);
      console.log(`      ${c.dim('卖家 ' + short(l.seller) + '  id ' + l.id.slice(0, 12) + '…')}`);
    }
  });
txCmd(market.command('sell'))
  .argument('<price>', '价格（正整数 $V0ID）')
  .argument('<title...>', '商品/服务标题')
  .description('上架一件商品（需 ≥1 余额；上架交易被挖进区块后才出现）')
  .action(async (price, title, o) => {
    const r = await api(o,'POST', '/market/sell', { price: Number(price), title: title.join(' ') });
    console.log(c.green('🏷  已上架'), c.dim('txid='), r.txid, c.dim('（打包确认后可见）'));
    if (o.wait) await waitConfirm(o, r.txid);
  });
txCmd(market.command('buy'))
  .argument('<id>', '商品 id（上架 txid，可只填前若干位则用 list 查全）')
  .description('购买商品（付标价给卖家）')
  .action(async (id, o) => {
    const r = await api(o,'POST', '/market/buy', { id });
    console.log(c.green('🛒 已下单付款'), c.dim('txid='), r.txid);
    if (o.wait) await waitConfirm(o, r.txid);
  });
txCmd(market.command('delist'))
  .argument('<id>', '商品 id')
  .description('撤下自己的商品')
  .action(async (id, o) => {
    const r = await api(o,'POST', '/market/delist', { id });
    console.log(c.green('已撤单'), c.dim('txid='), r.txid);
    if (o.wait) await waitConfirm(o, r.txid);
  });

// ---- name 昵称（全网唯一抢注，先到先得） ----
const name = program.command('name').description('链上昵称：全网唯一抢注，先到先得');
txCmd(name.command('claim'))
  .argument('<name>', '想抢的昵称（1~20 位 小写字母/数字/_/-）')
  .description('抢注一个昵称（自转 1 币 + memo；需 ≥2 余额；挖进区块后生效）')
  .action(async (n, o) => {
    const r = await api(o, 'POST', '/name/claim', { name: n });
    console.log(c.green('🪪 已提交抢注'), c.dim('txid='), r.txid, c.dim('（打包确认后生效；先到先得）'));
    if (o.wait) await waitConfirm(o, r.txid);
  });
apiOpt(name.command('list'))
  .description('看已注册的昵称')
  .action(async (o) => {
    const reg = await api(o, 'GET', '/names');
    const entries = Object.entries(reg.nameToOwner || {});
    if (!entries.length) return console.log(c.dim('（还没有人注册昵称）'));
    for (const [nm, owner] of entries) console.log(`  ${c.cyan('@' + nm)}  ${c.dim(short(owner as string))}`);
  });
apiOpt(name.command('who'))
  .argument('<name>', '昵称')
  .description('查某昵称属于哪个地址')
  .action(async (n, o) => {
    const reg = await api(o, 'GET', '/names');
    const owner = (reg.nameToOwner || {})[String(n).trim().toLowerCase()];
    console.log(owner ? `${c.cyan('@' + n)} → ${c.green(owner)}` : c.dim(`@${n} 还没人注册`));
  });
apiOpt(name.command('of'))
  .argument('[address]', '地址（默认本节点自己）')
  .description('查某地址的显示昵称')
  .action(async (address, o) => {
    const reg = await api(o, 'GET', '/names');
    const addr = address || (await api(o, 'GET', '/info')).address;
    const nm = (reg.addressToName || {})[addr];
    console.log(nm ? `${c.green(short(addr))} = ${c.cyan('@' + nm)}` : c.dim(`${short(addr)} 还没注册昵称`));
  });

// ---- red 抢红包 ----
const red = program.command('red').description('链上抢红包：发红包(锁币)→大家抢(拼手气)→过期退回');
txCmd(red.command('send'))
  .argument('<total>', '红包总额（$V0ID 正整数）')
  .argument('<count>', '份数（≥1，且 ≤ 总额）')
  .option('--equal', '均分（默认拼手气随机）', false)
  .description('发一个红包（需 ≥ 总额+手续费 余额；挖进区块后可被抢）')
  .action(async (total, count, o) => {
    const r = await api(o, 'POST', '/redpacket', { total: Number(total), count: Number(count), mode: o.equal ? 'e' : 'r' });
    console.log(c.green('🧧 红包已发出'), c.dim('txid='), r.txid, c.dim(`（这就是红包 id；打包确认后大家可 grab）`));
    if (o.wait) await waitConfirm(o, r.txid);
  });
apiOpt(red.command('list'))
  .description('看红包（在抢/已抢完/已退款）')
  .option('--all', '连已抢完/已退款一起显示', false)
  .action(async (o) => {
    const all = (await api(o, 'GET', '/redpackets')) as any[];
    const items = o.all ? all : all.filter((p) => !p.done);
    if (!items.length) return console.log(c.dim('（暂无红包）'));
    for (const p of items) {
      const tag = p.refunded ? c.dim('[已退]') : p.done ? c.dim('[抢完]') : c.green('[在抢]');
      const mine = p.mine ? c.yellow(' (我发的)') : p.grabbedByMe ? c.cyan(' (已抢)') : '';
      console.log(`${tag} ${c.bold(`${p.total} ${SYMBOL}`)} / ${p.count} 份  剩 ${p.remaining}/${p.remainingCount}  ${p.mode === 'e' ? '均分' : '拼手气'}${mine}`);
      console.log(`      ${c.dim('id ' + p.id.slice(0, 12) + '…  发起 ' + short(p.creator) + '  #' + p.createHeight)}`);
    }
  });
txCmd(red.command('grab'))
  .argument('<id>', '红包 id（发红包的 txid，可填前缀）')
  .description('抢红包（拼手气份额由共识按区块 hash 派发）')
  .action(async (id, o) => {
    const r = await api(o, 'POST', '/redpacket/grab', { id });
    console.log(c.green('🧧 已出手抢'), c.dim('txid='), r.txid, c.dim('（打包确认后看余额到账多少）'));
    if (o.wait) await waitConfirm(o, r.txid);
  });
txCmd(red.command('refund'))
  .argument('<id>', '红包 id（仅发起人、过期后可退）')
  .description('过期后取回没抢完的剩余')
  .action(async (id, o) => {
    const r = await api(o, 'POST', '/redpacket/refund', { id });
    console.log(c.green('↩️  已申请退款'), c.dim('txid='), r.txid);
    if (o.wait) await waitConfirm(o, r.txid);
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
    writeWalletFile(f, w);
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
    writeWalletFile(f, w);
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
