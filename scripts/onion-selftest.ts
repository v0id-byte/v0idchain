// 洋葱握手 ntor 自检 + 金标准向量。跑：corepack pnpm exec tsx scripts/onion-selftest.ts
// 既是回归测试（断言失败即非零退出），也是金标准向量来源（确定性输入→输出，日后粘进 docs/HS-PROTOCOL.md 与 Swift 测试做跨实现对齐）。
import {
  ONION_PROTOID,
  generateOnionKeypair,
  onionKeypairFromSecret,
  ntorClientStart,
  ntorServer,
  ntorClientFinish,
} from '../packages/core/src/onion.js';
import { bytesToHex, hexToBytes, addressToPublicKeyHex } from '../packages/core/src/crypto.js';
import { GENESIS_PREMINE_ADDRESS } from '../packages/core/src/config.js';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
}
const hex = bytesToHex;

// ---- 1. 随机往返：客户端与中继必须各自独立导出**相同**的双向密钥，AUTH 必须校验通过 ----
{
  const relayId = hexToBytes(addressToPublicKeyHex(GENESIS_PREMINE_ADDRESS));
  const onion = generateOnionKeypair();
  const client = ntorClientStart();
  const server = ntorServer(relayId, onion, client.ephPublic);
  check('server 握手成功', server !== null);
  const ckeys = ntorClientFinish(client, relayId, onion.pub, server!.serverEph, server!.auth);
  check('client 通过 AUTH 认证并导出密钥', ckeys !== null);
  check('encForward 密钥双方一致', hex(ckeys!.encForward) === hex(server!.keys.encForward));
  check('encBackward 密钥双方一致', hex(ckeys!.encBackward) === hex(server!.keys.encBackward));
  check('macForward 密钥双方一致', hex(ckeys!.macForward) === hex(server!.keys.macForward));
  check('macBackward 密钥双方一致', hex(ckeys!.macBackward) === hex(server!.keys.macBackward));
  check('4 把密钥互不相同', new Set([hex(ckeys!.encForward), hex(ckeys!.encBackward), hex(ckeys!.macForward), hex(ckeys!.macBackward)]).size === 4);
  check('密钥长度均 32 字节', [ckeys!.encForward, ckeys!.encBackward, ckeys!.macForward, ckeys!.macBackward].every((k) => k.length === 32));
}

// ---- 2. 安全负例：中继认证必须能挡住伪造 ----
{
  const relayId = hexToBytes(addressToPublicKeyHex(GENESIS_PREMINE_ADDRESS));
  const onion = generateOnionKeypair();
  const client = ntorClientStart();
  const server = ntorServer(relayId, onion, client.ephPublic)!;

  // 2a. 篡改 AUTH → 客户端必须拒绝（返回 null）
  const badAuth = server.auth.slice();
  badAuth[0] ^= 0xff;
  check('篡改 AUTH → client 拒绝', ntorClientFinish(client, relayId, onion.pub, server.serverEph, badAuth) === null);

  // 2b. 冒名中继：攻击者用自己的 onion 密钥应答，但客户端拿真中继的 B 验证 → 必须失败
  //     （这正是 ntor 防的：中间人没有真中继的静态私钥 b，凑不出能过 AUTH 的握手）
  const imposter = generateOnionKeypair();
  const evil = ntorServer(relayId, imposter, client.ephPublic)!;
  check('冒名中继(错误静态密钥) → client 拒绝', ntorClientFinish(client, relayId, onion.pub, evil.serverEph, evil.auth) === null);

  // 2c. 错误 relayId（电路被钉到错误链上身份）→ AUTH 失败
  const wrongId = hexToBytes('ff'.repeat(32));
  check('错误 relayId → client 拒绝', ntorClientFinish(client, wrongId, onion.pub, server.serverEph, server.auth) === null);
}

// ---- 3. 确定性金标准向量（固定输入 → 固定输出）----
{
  const relayId = hexToBytes(addressToPublicKeyHex(GENESIS_PREMINE_ADDRESS));
  const onion = onionKeypairFromSecret(hexToBytes('33'.repeat(32)));
  const client = ntorClientStart(hexToBytes('11'.repeat(32)));
  const server = ntorServer(relayId, onion, client.ephPublic, hexToBytes('22'.repeat(32)))!;
  const ckeys = ntorClientFinish(client, relayId, onion.pub, server.serverEph, server.auth)!;

  console.log('\n# ---- GOLDEN VECTOR (ntor) ----');
  console.log('PROTOID    =', ONION_PROTOID);
  console.log('relayId    =', hex(relayId));
  console.log('onionSec b =', '33..(x32)');
  console.log('onionPub B =', hex(onion.pub));
  console.log('clientEphX =', hex(client.ephPublic), '(sec 11..x32)');
  console.log('serverEphY =', hex(server.serverEph), '(sec 22..x32)');
  console.log('AUTH       =', hex(server.auth));
  console.log('encForward =', hex(ckeys.encForward));
  console.log('encBackward=', hex(ckeys.encBackward));
  console.log('macForward =', hex(ckeys.macForward));
  console.log('macBackward=', hex(ckeys.macBackward));

  check('向量自洽：client==server encForward', hex(ckeys.encForward) === hex(server.keys.encForward));

  // 回归锁（首次运行后把上面打印的值粘进来，之后任何实现/重构改动了密钥派生都会被这里抓到）。
  const EXPECT = {
    onionPub: '7b0d47d93427f8311160781c7c733fd89f88970aef490d8aa0ee19a4cb8a1b14',
    clientEphX: '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13',
    serverEphY: '0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20',
    auth: 'c3beb1a821396cdaf2dfee2a7f52ca505b1280b1c69905f5b208de65cd38656c',
    encForward: 'c539217920fb7679a6c007eb41f257f6d52332cd7a912a623a7193f8c056fa27',
    encBackward: '94b80d92c92191fe90c5301e951513f9f4230548e9763515a4174e4d54520480',
    macForward: '47b7bac7d52e0807cf17e9c75480991cbd81533602a7f0fa35d758d07957680b',
    macBackward: 'ac766d9b342a639b19aeabb75b1451b9b7e00c1aa11a80cc575ffc0ca50071cb',
  };
  if (EXPECT.macForward !== '__FILL__') {
    check('回归：onionPub', hex(onion.pub) === EXPECT.onionPub);
    check('回归：clientEphX', hex(client.ephPublic) === EXPECT.clientEphX);
    check('回归：serverEphY', hex(server.serverEph) === EXPECT.serverEphY);
    check('回归：AUTH', hex(server.auth) === EXPECT.auth);
    check('回归：encForward', hex(ckeys.encForward) === EXPECT.encForward);
    check('回归：encBackward', hex(ckeys.encBackward) === EXPECT.encBackward);
    check('回归：macForward', hex(ckeys.macForward) === EXPECT.macForward);
    check('回归：macBackward', hex(ckeys.macBackward) === EXPECT.macBackward);
  } else {
    // enc* 仍校验（未变）；mac* 待填
    check('回归：encForward 不变', hex(ckeys.encForward) === EXPECT.encForward);
    check('回归：encBackward 不变', hex(ckeys.encBackward) === EXPECT.encBackward);
    console.log('  (mac* 回归锁未填——把上面 macForward/macBackward 填进 EXPECT 即生效)');
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
