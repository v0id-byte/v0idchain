// 中继广播地址守卫测试（杜绝死中继污染全网目录，配合 PR#32 消费侧抗污染）：
// 验证 RoleManager.startRelay 只在「公网可达」的广播 host 下才把 RELAY| 描述符上链；回环/私网 host
// （浏览器默认的 127.0.0.1、localhost、::1、10.x、192.168.x…）一律**只起本地 cell 中继、绝不发布**。
// 反向不得误伤：公网 IP 与主机名（含经 CF 隧道暴露的中继域名）照常上链。
//
// 手法：用一个最小 fake node（spy 住 publishRelay + 余额恒 1000≥2）把判定逻辑单独拎出来，快且确定、不挖矿。
// 余额恒充足 → 「没发布」只可能来自广播地址守卫而非余额不足，排除假阴性。
// 跑：corepack pnpm exec tsx scripts/relay-advertise-guard-test.ts
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadOrCreateOnionKey, RoleManager, type V0idNode } from '../packages/node/src/index.js';

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PublishCall { onionPubHex: string; host: string; port: number }

// 最小 fake node：只暴露 RoleManager.startRelay 触达的面（钱包地址 / 链上中继目录 / 余额 / publishRelay）。
// publishRelay 被 spy 住——测试断言它在何种广播 host 下被调用、何种下绝不被调用。relays() 返回空数组，
// 故 tryPublish 不会因「已存在等价描述符」提前置位 published，能真实走到发布决策点。
function makeFakeNode(): { node: V0idNode; calls: PublishCall[] } {
  const calls: PublishCall[] = [];
  const node = {
    wallet: { address: '0x' + '11'.repeat(32) },
    relays: () => [] as unknown[],
    bc: { balanceOf: (_a: string) => 1000 },
    publishRelay: (onionPubHex: string, host: string, port: number) => {
      calls.push({ onionPubHex, host, port });
      return { ok: true };
    },
  } as unknown as V0idNode;
  return { node, calls };
}

async function scenario(opts: {
  label: string;
  advertiseHost: string;
  advertisePort: number;
  relayPort: number;
  expectPublish: boolean;
  dataDir: string;
}): Promise<void> {
  const { node, calls } = makeFakeNode();
  const rm = new RoleManager({
    node,
    dataDir: opts.dataDir,
    onion: loadOrCreateOnionKey(opts.dataDir),
    relayPort: opts.relayPort,
    relayAdvertiseHost: opts.advertiseHost,
    relayAdvertisePort: opts.advertisePort,
    relayBindHost: '127.0.0.1', // 绑回环即可：广播 host 只是上链元数据，不影响本地监听
  });
  await rm.startRelay();
  await sleep(50); // tryPublish 本是同步；留一拍兜底任何异步
  const st = rm.status();
  // 本地中继永远允许（守卫只拦「上链发布」，不拦起 cell 服务）
  check(`${opts.label}: relay 已起（本地中继始终允许）`, st.relay.on === true);
  if (opts.expectPublish) {
    check(`${opts.label}: 描述符上链（publishRelay 恰好 1 次）`, calls.length === 1);
    check(`${opts.label}: 上链 host=${opts.advertiseHost} port=${opts.advertisePort}`, calls[0]?.host === opts.advertiseHost && calls[0]?.port === opts.advertisePort);
    check(`${opts.label}: status.published === true`, st.relay.published === true);
  } else {
    check(`${opts.label}: 绝不上链（publishRelay 0 次）`, calls.length === 0);
    check(`${opts.label}: status.published === false`, st.relay.published === false);
  }
  await rm.stopRelay();
}

async function main(): Promise<void> {
  const dataDir = join(tmpdir(), 'v0id-relay-advertise-guard');
  rmSync(dataDir, { recursive: true, force: true });

  // ---- 负向：回环/私网广播 host → 绝不上链（核心：浏览器默认 127.0.0.1）----
  await scenario({ label: '127.0.0.1（浏览器默认）', advertiseHost: '127.0.0.1', advertisePort: 6011, relayPort: 6311, expectPublish: false, dataDir });
  await scenario({ label: 'localhost', advertiseHost: 'localhost', advertisePort: 6011, relayPort: 6312, expectPublish: false, dataDir });
  await scenario({ label: '::1', advertiseHost: '::1', advertisePort: 6011, relayPort: 6313, expectPublish: false, dataDir });
  await scenario({ label: '10.x 私网', advertiseHost: '10.0.0.7', advertisePort: 6011, relayPort: 6314, expectPublish: false, dataDir });
  await scenario({ label: '192.168.x 私网', advertiseHost: '192.168.1.50', advertisePort: 6011, relayPort: 6315, expectPublish: false, dataDir });
  await scenario({ label: '169.254 链路本地', advertiseHost: '169.254.10.20', advertisePort: 6011, relayPort: 6316, expectPublish: false, dataDir });

  // ---- 正向：公网 IP / 主机名（CF 隧道域名）→ 照常上链，不得误伤 ----
  await scenario({ label: '公网 IP', advertiseHost: '8.8.8.8', advertisePort: 6011, relayPort: 6317, expectPublish: true, dataDir });
  await scenario({ label: '主机名（CF 隧道域名，广播 443）', advertiseHost: 'relay.void1211.com', advertisePort: 443, relayPort: 6318, expectPublish: true, dataDir });

  rmSync(dataDir, { recursive: true, force: true });
  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}\n`, () => process.exit(failures === 0 ? 0 : 1));
}
main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
