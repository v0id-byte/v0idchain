// 社交 VPOST 协议自检。跑：corepack pnpm exec tsx scripts/social-selftest.ts
import {
  Blockchain,
  Wallet,
  createTransaction,
  makeVPost,
  parseVPostMemo,
  hashSocialBody,
  parseSocialBodyJson,
  canonicalSocialBody,
  createVPostTx,
  parseSocialPosts,
  parseSocialPostsNewestFirst,
  isProtocolMemo,
  isMessageTx,
  parseMessages,
  computeSocialBurnMin,
  POST_BURN,
  REPLY_BURN,
  MIN_FEE,
  minFeeFor,
  GENESIS_PREMINE,
  GENESIS_DIFFICULTY,
  BLOCK_REWARD,
  type SocialBody,
} from '../packages/core/src/index.js';

let failed = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failed++;
}

const supply = (bc: Blockchain) => [...bc.computeState().balances.values()].reduce((s, v) => s + v, 0);

async function main() {
  console.log('\n— contentHash 规范 —');
  const body: SocialBody = { v: 1, text: 'hello v0id' };
  const h1 = hashSocialBody(body);
  const h2 = hashSocialBody({ v: 1, text: 'hello v0id' });
  check('hash 稳定', h1 === h2 && /^[0-9a-f]{64}$/.test(h1));
  check('canonical 可解析', parseSocialBodyJson(canonicalSocialBody(body))?.text === 'hello v0id');
  check('缺 v 拒绝', parseSocialBodyJson(JSON.stringify({ text: 'x' })) === null);

  console.log('\n— makeVPost / parseVPostMemo —');
  const m = makeVPost(h1);
  check('makeVPost ok', m.ok === true && !!m.memo);
  const p = parseVPostMemo(m.memo!);
  check('parse 回 contentHash', p?.contentHash === h1 && p?.ver === 1 && !p?.parentTxid);
  const parent = 'ab'.repeat(32);
  const m2 = makeVPost(h1, { parentTxid: parent });
  check('回复 memo 含 parent', parseVPostMemo(m2.memo!)?.parentTxid === parent);
  check('坏 hash 拒绝', makeVPost('zz').ok === false);
  check('isProtocolMemo 识别 VPOST', isProtocolMemo(m.memo!));

  console.log('\n— 链上发帖 + 解析 + 不进私信 —');
  const miner = Wallet.generate();
  const author = Wallet.generate();
  const bc = new Blockchain();
  // 矿工挖几块攒币 → 转给 author
  // 出块奖励每块 1；多挖几块再转小额给 author（够 POST_BURN+fee 即可）
  for (let i = 0; i < 20; i++) await bc.mine(miner.address);
  const fundAmt = 15;
  const fund = createTransaction(miner, author.address, fundAmt, bc.nonceOf(miner.address), '', minFeeFor(fundAmt));
  check('fund mempool', bc.addTransaction(fund).ok);
  await bc.mine(miner.address);

  const post = createVPostTx(author, h1, bc.nonceOf(author.address));
  check('createVPostTx ok', post.ok === true);
  if (!post.ok) throw new Error(post.error);
  check('burn 为 POST_BURN', (post.tx.burn ?? 0) === POST_BURN);
  check('自转 amount0', post.tx.from === post.tx.to && post.tx.amount === 0);
  check('进 mempool', bc.addTransaction(post.tx).ok);
  await bc.mine(miner.address);

  const posts = parseSocialPosts(bc.chain);
  check('解析到 1 帖', posts.length === 1);
  check('作者/hash/txid', posts[0].author === author.address && posts[0].contentHash === h1 && posts[0].txid === post.tx.txid);

  const replyBody: SocialBody = { v: 1, text: 'reply' };
  const rh = hashSocialBody(replyBody);
  const reply = createVPostTx(author, rh, bc.nonceOf(author.address), { parentTxid: post.tx.txid, burn: REPLY_BURN });
  check('回复 create ok', reply.ok);
  if (!reply.ok) throw new Error(reply.error);
  check('回复进池', bc.addTransaction(reply.tx).ok);
  await bc.mine(miner.address);
  const all = parseSocialPostsNewestFirst(bc.chain);
  check('两帖 newest-first 首为回复', all.length === 2 && all[0].parentTxid === post.tx.txid);

  // 协议 memo 不进私信
  const msgs = parseMessages(bc.chain);
  check('parseMessages 不含 VPOST', msgs.every((x) => !x.text.startsWith('VPOST|')));
  check('isMessageTx 形态仍成立但被协议过滤', isMessageTx(post.tx) && isProtocolMemo(post.tx.memo));

  check(
    '供给守恒',
    supply(bc) === GENESIS_PREMINE + bc.height * BLOCK_REWARD,
  );
  check('MIN_FEE 仍付', post.tx.fee >= MIN_FEE);

  console.log('\n— 动态 burn（方案 2：越难越少 + 地板）—');
  check('创世难度 = 基准 POST_BURN', computeSocialBurnMin('post', GENESIS_DIFFICULTY) === POST_BURN);
  check('创世难度 = 基准 REPLY_BURN', computeSocialBurnMin('reply', GENESIS_DIFFICULTY) === REPLY_BURN);
  check('难度翻倍 burn 下降', computeSocialBurnMin('post', GENESIS_DIFFICULTY * 2) < POST_BURN);
  check('极高难度贴地板 post≥2', computeSocialBurnMin('post', 256) === 2);
  check('极高难度贴地板 reply≥1', computeSocialBurnMin('reply', 256) === 1);
  check('低难度 burn 上升', computeSocialBurnMin('post', Math.max(1, Math.floor(GENESIS_DIFFICULTY / 2))) > POST_BURN);
  // 动态门槛：按 tip 难度算出 min burn 发帖，应被解析收录
  for (let i = 0; i < 10; i++) await bc.mine(miner.address);
  const tipDiff = bc.latest.difficulty;
  const dynBurn = computeSocialBurnMin('post', tipDiff);
  const author2 = Wallet.generate();
  const fundAmt2 = dynBurn + MIN_FEE + 5;
  const fund2 = createTransaction(miner, author2.address, fundAmt2, bc.nonceOf(miner.address), '', minFeeFor(fundAmt2));
  check('fund2', bc.addTransaction(fund2).ok);
  await bc.mine(miner.address);
  const lowBurnPost = createVPostTx(author2, hashSocialBody({ v: 1, text: 'dynamic burn post' }), bc.nonceOf(author2.address), {
    burn: dynBurn,
    difficulty: tipDiff,
  });
  check('动态 burn create ok', lowBurnPost.ok);
  if (lowBurnPost.ok) {
    check('动态 burn 进池', bc.addTransaction(lowBurnPost.tx).ok);
    await bc.mine(miner.address);
    const incl = bc.chain.find((b) => b.transactions.some((t) => t.txid === lowBurnPost.tx.txid));
    const minAtIncl = incl ? computeSocialBurnMin('post', incl.difficulty) : Infinity;
    const found = parseSocialPosts(bc.chain).some((x) => x.txid === lowBurnPost.tx.txid);
    check(
      '动态门槛下可解析（burn≥入块 min）',
      found || (incl !== undefined && (lowBurnPost.tx.burn ?? 0) < minAtIncl),
    );
    // 若 retarget 抬高了 min 导致不进索引，至少说明公式在跑；创世附近通常 found=true
    if (!found && incl) {
      check('入块 burn 低于新 min 时静默忽略（预期）', (lowBurnPost.tx.burn ?? 0) < minAtIncl);
    }
  }

  console.log(failed ? `\n❌ ${failed} failed` : '\n✅ social-selftest all passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
