import {
  Wallet,
  bytesToHex,
  decryptMemo,
  encryptMemoWithNonce,
  hexToBytes,
  memoSharedKey,
  sign,
  transactionPayloadHash,
  transactionPreimage,
  verify,
} from '../packages/core/src/index.js';

let failed = 0;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failed++;
};

const PRIV_HEX = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const PUB_HEX = '79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664';
const ADDRESS = `0x${PUB_HEX}`;
const TO = `0x${'ab'.repeat(32)}`;
const TIMESTAMP = 1_700_000_000_000;

const wallet = Wallet.fromPrivateKeyHex(PRIV_HEX);
check('§9 PRIV_HEX derives PUB_HEX', bytesToHex(wallet.publicKey) === PUB_HEX);
check('§9 PUB_HEX derives ADDRESS', wallet.address === ADDRESS);

const transferPayload = {
  from: ADDRESS,
  to: TO,
  amount: 100,
  fee: 1,
  nonce: 0,
  timestamp: TIMESTAMP,
  memo: 'hi 🍜',
};
const transferPreimage =
  '["0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664","0xabababababababababababababababababababababababababababababababab",100,1,0,1700000000000,"hi 🍜"]';
const transferTxid = 'da4527a9715dd7e9d098f6615b588ceb051401d9e6846125feb7bdd1c4362932';
const transferSig =
  'dab11981063113c8b5fff5f8fcaad3d9c0a49879f7cca8a9dcee16be1171b17ea8919217ab87c077f320e3ea0eaca8a31c49467dc5df6c3e28b9ba689fc07108';
check('§3.2 transfer preimage matches JSON.stringify bytes', transactionPreimage(transferPayload) === transferPreimage);
check('§3.2 transfer txid matches vector', transactionPayloadHash(transferPayload) === transferTxid);
check('§3.3 transfer signature matches vector', sign(transferTxid, wallet.privateKey) === transferSig);
check('§3.3 transfer signature verifies', verify(transferSig, transferTxid, PUB_HEX));

const messagePayload = {
  from: ADDRESS,
  to: TO,
  amount: 0,
  fee: 1,
  nonce: 1,
  timestamp: TIMESTAMP,
  memo: 'gm',
  burn: 5,
};
const messagePreimage =
  '["0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664","0xabababababababababababababababababababababababababababababababab",0,1,1,1700000000000,"gm",5]';
const messageTxid = 'bb451006fa4c197f7944346de8f24e9712c8d1fd90e47abf52f8b9fa2b52cd06';
const messageSig =
  '817ccc45061524d52b8f1fc41f0b3542498993679c5e73a9497f60421dd0f7c19ea1837de981dedcd20301e2ea0d2076c029a6249c0e9b832f24962ae7972104';
check('§3.2 message preimage includes burn only when >0', transactionPreimage(messagePayload) === messagePreimage);
check('§3.2 message txid matches vector', transactionPayloadHash(messagePayload) === messageTxid);
check('§3.3 message signature matches vector', sign(messageTxid, wallet.privateKey) === messageSig);
check('§3.3 message signature verifies', verify(messageSig, messageTxid, PUB_HEX));

check('§3.2 JSON escaping matches ECMA JSON.stringify', JSON.stringify(['x"y\nz\t🎲']) === '["x\\"y\\nz\\t🎲"]');

const B_PRIV_HEX = '2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40';
const B_ADDRESS = '0xe7f162a10bec559afea195e4dce84b69568d5d2cb0963eb446c0685e2b17f2f0';
const shared = '22dd9afeb5878d76b7b7eba66e349a1a00858963745f1b92b78a1741e9ccf249';
const bWallet = Wallet.fromPrivateKeyHex(B_PRIV_HEX);
check('§8.6 B seed derives B address', bWallet.address === B_ADDRESS);
check('§8.6 A->B shared key matches vector', bytesToHex(memoSharedKey(wallet.privateKey, B_ADDRESS)) === shared);
check('§8.6 B->A shared key matches vector', bytesToHex(memoSharedKey(bWallet.privateKey, ADDRESS)) === shared);

const fixedMemo = 'ENC|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6359b5d168414e050a885e42c9dc6eabf98ecbaea44fa9';
const encrypted = encryptMemoWithNonce('hi 🔐', B_ADDRESS, wallet.privateKey, hexToBytes('aa'.repeat(24)));
check('§8.6 fixed nonce encrypted memo matches vector', encrypted === fixedMemo);
check('§8.6 recipient decrypts fixed memo', decryptMemo(encrypted, ADDRESS, bWallet.privateKey) === 'hi 🔐');
check('§8.6 sender decrypts own fixed memo', decryptMemo(encrypted, B_ADDRESS, wallet.privateKey) === 'hi 🔐');

console.log(failed === 0 ? '\n🎉 CLIENT-PROTOCOL vectors all passed\n' : `\n💥 ${failed} vector checks failed\n`);
process.exit(failed === 0 ? 0 : 1);
