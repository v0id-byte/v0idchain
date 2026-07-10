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
  POST_BURN,
  REPLY_BURN,
  MIN_FEE,
  minFeeFor,
  GENESIS_PREMINE,
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

  console.log(failed ? `\n❌ ${failed} failed` : '\n✅ social-selftest all passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
