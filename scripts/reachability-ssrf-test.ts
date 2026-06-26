// 可达性探测 SSRF 守卫测试（PR #32 review 第 5 条）：验证 RelayReachability 默认（allowPrivateHosts=false）下
// **绝不**对链上目录里的私网/回环 host 描述符发起连接探测——否则恶意/陈旧描述符（127.0.0.1 / 10.x /
// 169.254.169.254）会让每个用户的机器周期性向内网 / 云元数据地址发 WS Upgrade（SSRF）。
//
// 手法：本机起一个**裸 TCP 服务**计数“连接尝试”（探测的 WS 建连先要 TCP connect；用裸 TCP 即可数到尝试，
// 无需 ws 依赖）。默认下连接尝试必须为 0（被守卫挡在 connect 之前）且该中继被缓存为不可达；
// allowPrivateHosts=true（本机回环自测）时守卫放行 → 真的发起 TCP 连接（计数 ≥1）。
// 跑：corepack pnpm exec tsx scripts/reachability-ssrf-test.ts
import { createServer, type AddressInfo } from 'node:net';
import { RelayReachability } from '../packages/node/src/relay/reachability.js';
import type { RelayDescriptor } from '../packages/core/src/index.js';

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const desc = (host: string, port: number, address: string): RelayDescriptor => ({
  address,
  onionPubHex: '00'.repeat(32),
  host,
  port,
  bandwidth: 'm',
  stakeTxid: '0',
});

async function main(): Promise<void> {
  // 裸 TCP 服务，绑 127.0.0.1：每个进来的 TCP 连接 = 一次“探测尝试”（充当 host=127.0.0.1 的私网中继 cell 端点）。
  let conns = 0;
  const srv = createServer((sock) => {
    conns++;
    sock.destroy();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as AddressInfo).port;
  const loopback = [desc('127.0.0.1', port, '0xaaaa')];

  // ---- 默认（生产）：allowPrivateHosts=false → 绝不探测私网 host ----
  const guarded = new RelayReachability();
  await guarded.refresh(loopback);
  await sleep(60); // 给“万一真连了”留出 'connection' 触发窗口，确保 0 是真 0
  check('SSRF 守卫：默认下对 127.0.0.1 中继发起 0 次 TCP 连接（未真去连内网）', conns === 0);
  check('SSRF 守卫：该私网中继被缓存为不可达（选路剔除）', guarded.knownUsable(loopback).length === 0);

  // ---- 自测：allowPrivateHosts=true → 守卫放行，真的发起连接（>=1；裸 TCP 上 WS 握手会失败，但连接已发起=守卫已放行）----
  const open = new RelayReachability(true);
  await open.refresh(loopback);
  await sleep(80);
  check('allowPrivateHosts=true：放行后真的发起 TCP 连接探测（>=1 次，证明默认的 0 来自守卫）', conns >= 1);

  // ---- 纯私网 IP 字面量（无服务）：默认守卫应**同步**判不可达，不耗满 5s 探测超时 ----
  const privIps = [desc('169.254.169.254', 80, '0xbbbb'), desc('10.1.2.3', 6011, '0xcccc')];
  const t0 = Date.now();
  const r = new RelayReachability();
  await r.refresh(privIps);
  const elapsed = Date.now() - t0;
  check('SSRF 守卫：169.254/10.x 私网 IP 被同步判负（未走满 5s 探测超时）', elapsed < 2000);
  check('SSRF 守卫：私网 IP 字面量均不可达（选路剔除）', r.knownUsable(privIps).length === 0);

  srv.close();
  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}\n`, () => process.exit(failures === 0 ? 0 : 1));
}
main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
