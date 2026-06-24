// 隐藏服务描述符密码学自检 + 金标准向量。跑：corepack pnpm exec tsx scripts/hsdesc-selftest.ts
// 既是回归测试（断言失败即非零退出），也是金标准向量来源（确定性输入→输出，日后跨实现对齐）。
// 铁锚：盲签名必须能被 @noble 的 ed25519.verify(sig,msg,Ap) 通过 —— 这是盲化数学正确的唯一证明。
import {
  VERSION,
  encodeV0idAddress,
  decodeV0idAddress,
  identityPub,
  blindPublic,
  blindSecret,
  signBlinded,
  buildDescriptor,
  parseDescriptor,
  descriptorId,
  responsibleHsDirs,
  verifyDescriptorPublishable,
  ed25519,
  sha256,
} from '../packages/core/src/hsdesc.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '../packages/core/src/crypto.js';

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

// 固定身份种子（32 字节 0x07）+ 固定周期 → 确定性向量。第二个身份用于跨身份负例。
const SEED = new Uint8Array(32).fill(0x07);
const SEED2 = new Uint8Array(32).fill(0x09);
const TP = 20000;
const TP2 = 20001;

// ---- 1. 地址 encode→decode 往返；翻一个校验和字节 → decode null ----
{
  const A = identityPub(SEED);
  check('identityPub == ed25519.getPublicKey', hex(A) === hex(ed25519.getPublicKey(SEED)));
  const addr = encodeV0idAddress(A);
  check('地址以 .v0id 结尾', addr.endsWith('.v0id'));
  const back = decodeV0idAddress(addr);
  check('地址 encode→decode 往返', back !== null && hex(back) === hex(A));

  // 翻校验和字节：解码内层 payload，校验和在 [32]，重新编码后 decode 必须 null。
  // 直接构造一个坏地址：在 base32 解码层修改不便，改为在字符级翻转一个字符再校验。
  const flipped = corruptB32Char(addr);
  check('翻转地址一个字符 → decode null', decodeV0idAddress(flipped) === null);

  // 错误版本：解码会因 version!=VERSION 而 null（间接验证 VERSION 路径）。
  check('VERSION 常量为 0x01', VERSION === 0x01);
}

// ---- 2. 服务端 blindSecret(seed,TP).Ap === 客户端 blindPublic(A,TP)（同一字节）----
{
  const A = identityPub(SEED);
  const { Ap } = blindSecret(SEED, TP);
  const ApClient = blindPublic(A, TP);
  check('blindSecret.Ap == blindPublic(A)（盲化两端一致）', hex(Ap) === hex(ApClient));
}

// ---- 3. 铁锚：ed25519.verify(signBlinded, msg, Ap) === true；篡改 msg/sig → false ----
{
  const { Ap } = blindSecret(SEED, TP);
  const msg = utf8ToBytes('hello v0id hidden service');
  const sig = signBlinded(SEED, TP, msg);
  check('★铁锚：ed25519.verify(盲签名, msg, Ap) == true', ed25519.verify(sig, msg, Ap, { zip215: false }) === true);

  const badMsg = utf8ToBytes('hello v0id hidden servicE');
  check('篡改 msg → verify false', ed25519.verify(sig, badMsg, Ap, { zip215: false }) === false);

  const badSig = sig.slice();
  badSig[10] ^= 0xff;
  let r = true;
  try {
    r = ed25519.verify(badSig, msg, Ap, { zip215: false });
  } catch {
    r = false; // 畸形签名抛错也算拒绝
  }
  check('篡改 sig 字节 → verify false', r === false);
}

// ---- 4. 不同 TP → 不同 Ap 且不同 descId ----
{
  const ApA = blindSecret(SEED, TP).Ap;
  const ApB = blindSecret(SEED, TP2).Ap;
  check('不同 TP → 不同 Ap', hex(ApA) !== hex(ApB));
  check('不同 TP → 不同 descId', descriptorId(ApA, TP) !== descriptorId(ApB, TP2));
}

// ---- 5. buildDescriptor → parseDescriptor(正确地址) 精确往返 introPoints + serviceOnionPubHex ----
const introPoints = [
  { relayId: '0x' + 'aa'.repeat(32), relayOnionPubHex: 'bb'.repeat(32), authKeyHex: 'cc'.repeat(32) },
  { relayId: '0x' + 'dd'.repeat(32), relayOnionPubHex: 'ee'.repeat(32), authKeyHex: 'ff'.repeat(32) },
];
const serviceOnionPubHex = '12'.repeat(32);
{
  const A = identityPub(SEED);
  const addr = encodeV0idAddress(A);
  const desc = buildDescriptor(SEED, TP, introPoints, serviceOnionPubHex);
  const parsed = parseDescriptor(addr, desc);
  check('parseDescriptor 非 null', parsed !== null);
  check(
    'parse 往返 introPoints 精确一致',
    parsed !== null && JSON.stringify(parsed.introPoints) === JSON.stringify(introPoints),
  );
  check('parse 往返 serviceOnionPubHex 精确一致', parsed !== null && parsed.serviceOnionPubHex === serviceOnionPubHex);
}

// ---- 6. parseDescriptor 用**不同身份**的 .v0id 地址 → null ----
{
  const desc = buildDescriptor(SEED, TP, introPoints, serviceOnionPubHex);
  const wrongAddr = encodeV0idAddress(identityPub(SEED2));
  check('用别人的地址解析描述符 → null', parseDescriptor(wrongAddr, desc) === null);
}

// ---- 7. 翻 desc.enc 一字节 → null；翻 desc.sig → null ----
{
  const A = identityPub(SEED);
  const addr = encodeV0idAddress(A);
  const desc = buildDescriptor(SEED, TP, introPoints, serviceOnionPubHex);

  const encBytes = hexToBytes(desc.enc);
  encBytes[30] ^= 0xff; // 翻密文中段（落在 ciphertext，AEAD tag 校验必败）
  check('翻 desc.enc 一字节 → null', parseDescriptor(addr, { ...desc, enc: hex(encBytes) }) === null);

  const sigBytes = hexToBytes(desc.sig);
  sigBytes[5] ^= 0xff;
  check('翻 desc.sig 一字节 → null', parseDescriptor(addr, { ...desc, sig: hex(sigBytes) }) === null);
}

// ---- 7b. verifyDescriptorPublishable：合法 desc → true；篡改 enc/sig → false（HSDir 不持 A 也能拒垃圾）----
{
  const desc = buildDescriptor(SEED, TP, introPoints, serviceOnionPubHex);
  check('verifyDescriptorPublishable(合法 desc) == true', verifyDescriptorPublishable(desc) === true);

  const encBytes = hexToBytes(desc.enc);
  encBytes[30] ^= 0xff; // 篡改密文 → 盲签名覆盖 blob，verify 必败
  check('篡改 enc → verifyDescriptorPublishable false', verifyDescriptorPublishable({ ...desc, enc: hex(encBytes) }) === false);

  const sigBytes = hexToBytes(desc.sig);
  sigBytes[5] ^= 0xff;
  check('篡改 sig → verifyDescriptorPublishable false', verifyDescriptorPublishable({ ...desc, sig: hex(sigBytes) }) === false);
}

// ---- 8. descriptorId 确定性；responsibleHsDirs 确定 / 返回 3 个不重复 / 跨运行稳定 ----
{
  const Ap = blindSecret(SEED, TP).Ap;
  check('descriptorId 确定性', descriptorId(Ap, TP) === descriptorId(Ap, TP));
  const descId = descriptorId(Ap, TP);

  const relays = Array.from({ length: 10 }, (_, i) => '0x' + bytesToHex(sha256(utf8ToBytes('relay-' + i))));
  const ring1 = responsibleHsDirs(descId, relays, 3);
  const ring2 = responsibleHsDirs(descId, relays.slice(), 3);
  check('responsibleHsDirs 确定（两次同序输入一致）', JSON.stringify(ring1) === JSON.stringify(ring2));
  check('responsibleHsDirs 返回 3 个', ring1.length === 3);
  check('responsibleHsDirs 3 个互不重复', new Set(ring1).size === 3);
  // 打乱输入顺序仍得同一集合（按距离排序 → 与输入顺序无关）。
  const shuffled = relays.slice().reverse();
  const ring3 = responsibleHsDirs(descId, shuffled, 3);
  check('responsibleHsDirs 与输入顺序无关', JSON.stringify(ring1) === JSON.stringify(ring3));
}

// ---- 9. 金标准向量（固定 SEED=0x07 ×32, TP=20000）：锁 address / Ap@TP / descId ----
{
  const A = identityPub(SEED);
  const addr = encodeV0idAddress(A);
  const Ap = blindSecret(SEED, TP).Ap;
  const descId = descriptorId(Ap, TP);

  console.log('\n# ---- GOLDEN VECTOR (hsdesc) ----');
  console.log('SEED       = 07..(x32)');
  console.log('TP         =', TP);
  console.log('A (idPub)  =', hex(A));
  console.log('address    =', addr);
  console.log('Ap@TP      =', hex(Ap));
  console.log('descId     =', descId);

  // 回归锁（首次运行后把上面打印的值粘进来）。
  const EXPECT = {
    address: '5jfgyy7ctrjavpxvkb5rglwf7gkuo5vox27hxescd3vgsfcg2iwifoab.v0id',
    ap: '1b142c345a835f7af884fe3ae3ed7cb86a0063d51e7cfb51ab96a61c00a28304',
    descId: '2fc52b1d23c1b601061139371260207a81318ffec1903537053577073acab9cb',
  };
  if (EXPECT.address !== '__FILL__') {
    check('回归：address', addr === EXPECT.address);
    check('回归：Ap@TP', hex(Ap) === EXPECT.ap);
    check('回归：descId', descId === EXPECT.descId);
  } else {
    console.log('  (回归锁未填——把上面 address/Ap@TP/descId 填进 EXPECT 即生效)');
  }
}

// ---- 辅助：在地址的 base32 部分翻一个字符（保持仍是合法 base32 字符，但改变值）----
function corruptB32Char(addr: string): string {
  const suffix = '.v0id';
  const body = addr.slice(0, -suffix.length);
  const ch = body[0];
  // 换成字母表里不同的另一个字符
  const repl = ch === 'a' ? 'b' : 'a';
  return repl + body.slice(1) + suffix;
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
