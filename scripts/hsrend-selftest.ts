// 引入/会合密码学自检（无网络）：INTRODUCE 盲信封 + 端到端 RDV 数据封。
// 证明：① 客户端密封 → 服务用静态 onion 私钥解开往返一致；② 错密钥 / 篡改 → null；
//       ③ 会合参数明文定长编解码自洽；④ RDV 封往返一致、错密钥/篡改 → null；⑤ 金标准向量锁死跨实现。
// 跑：corepack pnpm exec tsx scripts/hsrend-selftest.ts
import {
  introduceSeal,
  introduceOpen,
  encodeIntroducePayload,
  decodeIntroducePayload,
  rdvSeal,
  rdvOpen,
  onionKeypairFromSecret,
  generateOnionKeypair,
  bytesToHex,
  utf8ToBytes,
  sha256Hex,
} from '../packages/core/src/index.js';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
}
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// ---- 1. INTRODUCE 盲信封：seal → open 往返 ----
{
  const svc = generateOnionKeypair();
  const pt = utf8ToBytes('rendezvous params: rp + cookie + ntorX');
  const env = introduceSeal(svc.pub, pt);
  const opened = introduceOpen(svc, env.ephPub, env.ct);
  check('introduceSeal→introduceOpen 明文往返一致', opened !== null && dec(opened) === dec(pt));
  check('信封 ephPub 为 32 字节', env.ephPub.length === 32);
}

// ---- 2. 错误服务密钥 → null（单向 DH：只有持 b 的服务能解）----
{
  const svc = generateOnionKeypair();
  const wrong = generateOnionKeypair();
  const env = introduceSeal(svc.pub, utf8ToBytes('secret'));
  check('错误服务 onion 私钥解封 → null', introduceOpen(wrong, env.ephPub, env.ct) === null);
}

// ---- 3. 篡改密文 → null（AEAD 完整性）----
{
  const svc = generateOnionKeypair();
  const env = introduceSeal(svc.pub, utf8ToBytes('tamper target'));
  const bad = Uint8Array.from(env.ct);
  bad[30] ^= 0xff; // 翻一位密文
  check('篡改信封密文 → null', introduceOpen(svc, env.ephPub, bad) === null);
  const badEph = Uint8Array.from(env.ephPub);
  badEph[0] ^= 0xff; // 篡改 ephPub → 共享点变 → AEAD 必败
  check('篡改信封 ephPub → null', introduceOpen(svc, badEph, env.ct) === null);
}

// ---- 4. 会合参数明文定长编解码 ----
{
  const rpPubHex = 'ab'.repeat(32);
  const cookie = new Uint8Array(20).fill(0x5a);
  const ntorX = new Uint8Array(32).fill(0x33);
  const enc = encodeIntroducePayload(rpPubHex, cookie, ntorX);
  check('INTRODUCE 明文为 84 字节定长', enc.length === 84);
  const back = decodeIntroducePayload(enc);
  check(
    'INTRODUCE 明文编解码自洽',
    back !== null &&
      back.rpPubHex === rpPubHex &&
      bytesToHex(back.cookie) === bytesToHex(cookie) &&
      bytesToHex(back.clientNtorEph) === bytesToHex(ntorX),
  );
  check('INTRODUCE 明文长度不符 → null', decodeIntroducePayload(enc.subarray(0, 83)) === null);
}

// ---- 5. 端到端 RDV 数据封：seal → open 往返 + 错密钥/篡改 → null ----
{
  const key = new Uint8Array(32).fill(0x77);
  const wrongKey = new Uint8Array(32).fill(0x88);
  const bytes = utf8ToBytes('hello hidden service');
  const cell = rdvSeal(key, 42, bytes);
  const opened = rdvOpen(key, cell);
  check('rdvSeal→rdvOpen 往返一致且 ctr 还原', opened !== null && opened.ctr === 42 && dec(opened.bytes) === dec(bytes));
  check('rdvOpen 错密钥 → null', rdvOpen(wrongKey, cell) === null);
  const bad = Uint8Array.from(cell);
  bad[bad.length - 1] ^= 0xff; // 翻 tag 一位
  check('rdvOpen 篡改密文 → null', rdvOpen(key, bad) === null);
  // 篡改 ctr 字段 → nonce 变 → AEAD 必败（计数器并非明文“可信”，改它即解不开）
  const badCtr = Uint8Array.from(cell);
  badCtr[7] ^= 0x01;
  check('rdvOpen 篡改 ctr → null', rdvOpen(key, badCtr) === null);
}

// ---- 6. 金标准向量：固定 e + 固定服务密钥 → 固定信封 ct（跨实现对齐）----
// 固定服务 onion 私钥 + 固定客户端临时私钥 → ECDH 共享点恒定 → key 恒定。
// XChaCha20-Poly1305 的 nonce 在 seal 内部随机，故信封 ct 不可复现；改为锁**派生密钥下、固定 nonce** 的密文。
// 这里直接锁 rdvSeal 的输出（其 nonce 由 ctr 确定 → 完全确定）+ introKey 的确定性密文。
{
  const svcSecret = new Uint8Array(32);
  for (let i = 0; i < 32; i++) svcSecret[i] = i + 1; // 1..32
  const svc = onionKeypairFromSecret(svcSecret);
  const ephSecret = new Uint8Array(32);
  for (let i = 0; i < 32; i++) ephSecret[i] = 200 - i; // 200..169
  // introduceSeal 用固定 eph + 固定服务公钥，但 nonce 随机 → 锁 ephPub（确定）与“解得开”而非密文。
  const env = introduceSeal(svc.pub, utf8ToBytes('golden-intro'), ephSecret);
  const ephPubHex = bytesToHex(env.ephPub);
  console.log('\n# introduceSeal ephPub(固定 e) =', ephPubHex);
  const EXPECT_EPH = '8dafcfeeae9045ee9a78d78a99fcf32e7781e441eb073096c342b8e2dcc3b612';
  if (EXPECT_EPH !== '__FILL__') check('金标准：固定 e → 固定 ephPub', ephPubHex === EXPECT_EPH);
  else console.log('  (回归锁未填——把上面 ephPub 填进 EXPECT_EPH 即生效)');
  check('金标准信封仍可被服务解开', dec(introduceOpen(svc, env.ephPub, env.ct)!) === 'golden-intro');

  // rdvSeal 完全确定（nonce 由 ctr 派生）→ 锁其密文 sha256。
  const rdvKey = new Uint8Array(32);
  for (let i = 0; i < 32; i++) rdvKey[i] = (i * 7) & 0xff;
  const rdvCell = rdvSeal(rdvKey, 1, utf8ToBytes('golden-rdv'));
  const rdvDigest = sha256Hex(bytesToHex(rdvCell));
  console.log('# rdvSeal(固定 key, ctr=1, "golden-rdv") sha256(cell) =', rdvDigest);
  const EXPECT_RDV = '8131f8b265deda9a807917982b274735a326656f24cadb29ad3032d5f046ccd2';
  if (EXPECT_RDV !== '__FILL__') check('金标准：rdvSeal 密文 sha256', rdvDigest === EXPECT_RDV);
  else console.log('  (回归锁未填——把上面 sha256 填进 EXPECT_RDV 即生效)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
