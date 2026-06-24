// 中继目录 parseRelays 自检。跑：corepack pnpm exec tsx scripts/relays-selftest.ts
import { parseRelays, makeRelayClaim, buildRelayMemo, lookupRelay } from '../packages/core/src/relays.js';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
}

const A = '0x' + 'a'.repeat(64);
const B = '0x' + 'b'.repeat(64);
const C = '0x' + 'c'.repeat(64);
const KA = '1'.repeat(64); // onion 公钥 (假)
const KA2 = '2'.repeat(64);
const KB = '3'.repeat(64);

// 构造最小区块 stub（parseRelays 只读 transactions[].{memo,from,to,burn}）
function tx(from: string, to: string, memo: string, burn = 0) {
  return { from, to, memo, burn, amount: 1, fee: 1, nonce: 0, timestamp: 0, signature: '', txid: '' };
}
function block(txs: ReturnType<typeof tx>[]) {
  return { index: 0, transactions: txs };
}
const chain = [
  block([
    tx(A, A, buildRelayMemo(KA, '127.0.0.1', 6011)), // A 首次发布
    tx(B, B, buildRelayMemo(KB, 'relay.example', 7011, 'h')), // B 发布
    tx(C, A, buildRelayMemo(KA, '127.0.0.1', 6011)), // 非自转(from≠to) → 忽略
  ]),
  block([
    tx(A, A, buildRelayMemo(KA2, '10.0.0.5', 6099)), // A 更新(换 okey+host) → latest wins
    tx(B, B, buildRelayMemo(KB, 'x.example', 7011), 5), // burn>0 消息形态 → 忽略
    tx(C, C, 'RELAY|zzz|bad'), // 字段非法 → 忽略
  ]),
] as any;

const dir = parseRelays(chain);

// ---- 解析正确性 ----
check('目录含 A 与 B（2 个有效中继）', dir.size === 2);
check('A latest-wins：okey 更新为 KA2', lookupRelay(dir, A)?.onionPubHex === KA2);
check('A latest-wins：host 更新为 10.0.0.5:6099', lookupRelay(dir, A)?.host === '10.0.0.5' && lookupRelay(dir, A)?.port === 6099);
check('B 正确解析（主机名+档位 h）', lookupRelay(dir, B)?.host === 'relay.example' && lookupRelay(dir, B)?.bandwidth === 'h');
check('C 不在目录（非自转 + 非法描述符都被拒）', !dir.has(C));
check('address 字段回填正确', lookupRelay(dir, A)?.address === A);

// ---- makeRelayClaim 校验 ----
check('合法 claim 通过', makeRelayClaim(KA, '127.0.0.1', 6011).ok === true);
check('坏 okey 被拒', makeRelayClaim('xyz', '127.0.0.1', 6011).ok === false);
check('坏 port 被拒', makeRelayClaim(KA, '127.0.0.1', 70000).ok === false);
check('host 含冒号被拒（防 IPv6 歧义）', makeRelayClaim(KA, '::1', 6011).ok === false);
check('坏 bandwidth 被拒', makeRelayClaim(KA, '127.0.0.1', 6011, 'hi').ok === false);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
