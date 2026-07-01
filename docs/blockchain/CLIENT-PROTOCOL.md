# v0idChain 轻客户端互操作规范（CLIENT-PROTOCOL）

> 写**任何**非 Node 客户端（Swift / Kotlin / Rust …）都必须严格照此实现。
> **核心铁律：你的客户端算出的 `txid` 和签名，必须与 `packages/core` 逐字节一致**，否则签出的交易全网校验不过、直接被丢弃。
> 权威参考实现：`packages/core/src/{crypto,transaction,block,blockchain,messages}.ts`。本规范若与代码冲突，**以代码为准**——但下面的金标准测试向量可让你自检是否对齐。

---

## 0. 角色：轻客户端能做什么

轻客户端 = **本地保管私钥 + 本地签名 + 连一个节点收发**。它**不挖矿**也能完整参与：建钱包、查余额、转账、发消息/收件箱、逛链、集市。

- 私钥永远只在本机（Keychain / Keystore）。
- 交易在本地用 ed25519 签名。
- 通过 WebSocket 连到任意节点（如公网种子 `ws://mc.void1211.com:6001`）：可拉全链算余额，也可先拉 headers + 最近区块，再按需请求历史证明。
- 当前协议已有**轻同步基础**：headers 可验证 PoW/header hash/prevHash，交易可用 Merkle proof 证明“确实在某个 PoW 区块里”。但账户余额仍来自重放状态；没有 `stateRoot`/地址 accumulator 前，地址历史证明只能证明“返回的交易存在”，不能单节点证明“没有漏掉旧交易”。

---

## 1. 密钥与地址

- **算法**：ed25519（RFC 8032 标准，`zip215:false` 严格验签）。
- **私钥** = 32 字节随机种子。**公钥** = 由种子派生的 32 字节。
- **地址** = `"0x"` + 公钥的小写 hex（32 字节 → 64 hex 字符）。`/^0x[0-9a-f]{64}$/`。
- 地址**内含公钥** → 验签时直接从 `from` 取公钥，无需额外字段。
- 原生库：Apple **CryptoKit** `Curve25519.Signing.PrivateKey(rawRepresentation:)`；Android **Tink** / BouncyCastle `Ed25519` / lazysodium。注意：种子=私钥的 `rawRepresentation`（32 字节），公钥=`publicKey.rawRepresentation`（32 字节），与标准 ed25519 一致。

`NULL_ADDRESS = "0x" + "0"×64`（虚空/销毁地址 + coinbase 的 from；客户端**永不**构造 coinbase/创世）。

---

## 2. 哈希

`sha256Hex(s)` = 对字符串 `s` 的 **UTF-8 字节**做 SHA-256，输出**小写 hex**。全协议所有哈希都是它。

---

## 3. 交易与 txid（⚠️ 共识关键，必须逐字节一致）

### 3.1 交易字段

```
from: string        // 发送方地址（=公钥），= 你的地址
to: string          // 接收方地址
amount: number      // 转账金额（整数 ≥0）；消息恒为 0
fee: number         // 手续费/gas（整数 ≥1，普通交易）；给打包矿工
nonce: number       // 发送方自增计数（防重放）
timestamp: number   // 毫秒 epoch 整数
memo: string        // 备注 / 消息正文（≤ MAX_MEMO=512 Unicode 码点；曾为 128，已软分叉抬升以容纳加密私信 ENC| 密文，见 §8.6）
burn?: number       // 销毁额（消息用，整数 >0）；普通转账省略（=0）
signature: string   // ed25519 签名 hex（见 3.3）
txid: string        // = sha256(规范化预映像)（见 3.2）
```

### 3.2 txid 预映像（preimage）—— 必须等于 JS `JSON.stringify`

```
preimage = JSON.stringify([from, to, amount, fee, nonce, timestamp, memo])
若 (burn ?? 0) > 0：在数组末尾追加 burn → JSON.stringify([..., memo, burn])
txid = sha256Hex(preimage)
```

**`burn` 只在 >0 时才进数组**——所以普通转账（无 burn）的预映像永远是 7 元素，与历史/创世逐字节一致（这正是“加消息不重置链”的根基，别破坏它）。

**你必须手写一个与 ECMA-262 `JSON.stringify` 一致的序列化器**（不要用通用 JSON 编码器，各家转义/空格/数字格式不同）：

- 数组：`[`、元素间 `,`、`]`，**无任何空格**。
- 数字：均为整数 → 纯十进制，无 `+`、无前导 0、无小数点、无指数（值都在安全整数范围内，由共识强制整数）。
- 字符串：`"` 开头结尾；转义且**仅**转义：`"`→`\"`，`\`→`\\`，U+0008→`\b`，U+0009→`\t`，U+000A→`\n`，U+000C→`\f`，U+000D→`\r`，其余 U+0000–U+001F 控制字符→`\u00xx`（小写 hex）。**其他所有字符（含中文/emoji）原样输出**（最终按 UTF-8 编码），**不转义 `/`**，不转 `\uXXXX`。
  - 示例：`["x\"y\nz\t🎲"]` ——引号/换行/制表符转义，🎲 原样保留。

### 3.3 签名（注意：签的是 txid 解码后的 32 字节，不是 hex 字符串）

```
signature = hex( ed25519_sign( hexDecode(txid)  /* 32 字节 */ , privateKey ) )
```

即：把 `txid`（64 hex）**解码成 32 字节**作为待签消息，ed25519 签名得 64 字节 → 小写 hex（128 字符）。验签同理用 `from` 内的公钥。

### 3.4 两种交易

- **转账**：`amount>0`，`fee≥1`，无 `burn`（=0），有签名。
- **消息**：`amount=0`，`burn>0`（默认 5），`memo`=正文，`fee≥1`，有签名。收件人=`to`（收 0 币），`burn` 被销毁（记到 `NULL_ADDRESS`）。
- **禁止**：`amount=0 且 burn=0`（空操作，被拒）；给 `to=NULL_ADDRESS` 转账（被拒）；`fee<1`（被拒）。

---

## 4. 余额 / nonce（重放全链自行计算，无服务端）

对链上每个区块、每笔交易，按顺序：

```
若 from != NULL_ADDRESS（即非 coinbase/创世）：
    balance[from] -= amount + fee + (burn||0)
    若 burn>0: balance[NULL_ADDRESS] += burn      // 销毁额记入虚空（守恒、= 全网已销毁）
    nonce[from] += 1
balance[to] += amount                              // 收款方实收（消息为 0）
```

默认 balance/nonce 为 0。**你下一笔交易该用的 nonce** = `nonce[你的地址]` + （你已广播但还没被打包进块的待发交易数）。

---

## 5. 区块结构与（可选）校验

```
Block { index, timestamp, prevHash, transactions[], merkleRoot, difficulty, nonce, miner, hash }
calcBlockHash = sha256Hex(JSON.stringify([index, timestamp, prevHash, merkleRoot, difficulty, nonce, miner]))
meetsDifficulty(hash, d) = (hash 的前导 0 比特数) >= d         // 注意是 bit 不是 hex 位
merkleRoot(txids): 两两 sha256Hex(a+b) 逐层归并，奇数复制末尾；空集 → sha256Hex("")
```

- **最省事（信任所连节点）**：直接用收到的链算余额即可（适合先跑通）。
- **trustless（推荐进阶）**：自行跑整链校验——每块重算 `calcBlockHash` 并比对、`meetsDifficulty`、每笔 `txid==预映像哈希`、非 coinbase 验签、nonce 顺序 + 余额足够、coinbase 金额 == `出块奖励(1) + Σ手续费`、merkleRoot 吻合。详见 `blockchain.ts: validateChain`。
- **最长链规则**：接受**累计工作量更大**（Σ 2^difficulty）的合法链。

---

## 6. P2P 协议（WebSocket，JSON 文本帧）

消息类型（与节点完全一致）：

```
{type:'HELLO', address, height, listen}   // 自报家门
{type:'QUERY_LATEST'}                      // 要最新块
{type:'QUERY_ALL'}                         // 要整条链
{type:'BLOCKS', blocks:[...]}              // 区块（整链同步走这条）
{type:'QUERY_HEADERS', from?, to?}          // 要 header 范围
{type:'HEADERS', headers:[...], from?, total?}
{type:'QUERY_BLOCK_RANGE', from, to}        // 要完整区块范围（节点会限量）
{type:'QUERY_RECENT', maxBlocks?, minTimestamp?} // 最近窗口：块数与时间同时满足
{type:'QUERY_TX_PROOF', txid}               // 要单笔交易 Merkle inclusion proof
{type:'TX_PROOF', txid, proof?, error?}
{type:'QUERY_ADDRESS_PROOFS', address, from?, to?} // 要地址相关交易的 inclusion proofs
{type:'ADDRESS_PROOFS', address, proofs:[...], from?, to?}
{type:'TX', tx:{...}}                       // 广播一笔交易
{type:'QUERY_PEERS'} / {type:'PEERS', peers:[...]}
```

**轻客户端最小流程（纯出站，不必开 WS 服务器）：**

1. WS 连到节点（如 `ws://mc.void1211.com:6001`）。
2. 发 `HELLO`：`address`=你的地址，`height`=0（或本地已知高度），`listen`=任意串（你不被回拨，无所谓）。
3. 发 `QUERY_ALL` → 收到 `BLOCKS`（整条链）→ 按 §4 算余额/nonce。
4. 发交易：本地构造+签名 → 发 `{type:'TX', tx}`。
5. 保持监听 `BLOCKS` 增量更新（或定期 `QUERY_LATEST`/`QUERY_ALL` 重拉）。

单条 WS 消息上限 64MB（整链单帧发送）。

**轻同步流程（推荐新钱包/索引器逐步迁移）：**

1. 发 `QUERY_HEADERS` 拉 header 链；本地验证 `calcBlockHash`、PoW、`prevHash` 连续、checkpoint 与累计工作量。
2. 发 `QUERY_RECENT`，例如 `{maxBlocks:10000,minTimestamp:Date.now()-3*24*3600*1000}`，只缓存同时满足“最近 10000 块”和“三天内”的完整块。
3. 用户导入老地址或打开历史页时，发 `QUERY_ADDRESS_PROOFS` 回填该地址历史；每条 proof 用区块 header 的 `merkleRoot` 验证交易存在。
4. 若要查单笔交易，发 `QUERY_TX_PROOF`；若要浏览旧区块，发 `QUERY_BLOCK_RANGE` 按高度段拉取。

安全边界：Merkle proof 是**存在证明**，不是“无遗漏证明”。如果钱包不拉全链，最好向多个节点交叉请求同一地址历史；真正的单节点余额证明需要未来共识层加入状态承诺。

---

## 7. 移动端坑（务必处理）

- **iOS ATS 默认禁明文 `ws://`**：要么给种子域名加 ATS 例外（`NSAppTransportSecurity` → `NSExceptionDomains` → `mc.void1211.com`，允许 insecure WS），要么后续把种子套 TLS 走 `wss://`。
- **Android 默认禁明文流量**：在 `network_security_config.xml` 给种子域名设 `cleartextTrafficPermitted="true"`，或后续上 `wss://`。
- 长期方向：种子前置反向代理上 `wss://`（更干净），届时本规范唯一变化是连接 URL。

---

## 8. 软分叉提醒

**消息交易（burn>0）是一次软分叉**：旧版本节点会拒绝含消息交易的块。客户端发消息前，请确保所连节点已升级到含 Phase 11 的版本（公网种子已升级）。纯转账不受影响。

---

## 8.5 链上昵称（可选，显示用 —— 纯 memo 约定，不改共识）

让 UI 显示 `@名字` 而非一长串地址。**抢注** = 一笔自转交易：`from==to`、`amount=1`、`burn=0`、`fee≥1`、`memo = "NAME|" + 名字`。广播方式同普通交易（参考实现 `packages/core/src/names.ts`）。

**解析注册表（扫链）**：对每笔满足 `from==to` 且 `(burn??0)==0` 且 `memo` 以 `NAME|` 开头的交易：

1. `name = memo 去掉 "NAME|" 前缀后 .trim().toLowerCase()`（**读端务必小写规范化**，与写端一致）。
2. 校验：`^[a-z0-9_-]{1,20}$`、不以 `0x` 开头、且**不是保留名**（`treasury official admin system null v0id v0idchain genesis coinbase`）；不合法则跳过。
3. **先到先得**：某名字的第一笔有效抢注者永久拥有它，之后别的地址抢同名一律忽略。
4. **显示名**：一个地址的显示名 = 它最近一次成功拥有的名字（同一地址可改名）。

解析是纯函数（只依赖链、按区块序+块内交易序），各端结果一致、reorg 安全。

**安全显示建议**：把地址渲染成 `@名字` 时，**仍让完整/缩写地址可见**（如长按/tooltip），便于识破同形/仿冒名；保留名已禁注以防冒充“央行/官方”。

## 8.6 端到端加密私信（可选）

让一条消息只有收发双方能读，密文上链、其他人只看到乱码。**仍是普通 burn 消息**（amount0+burn+memo），只是 memo 是密文。

**算法（务必完全照此，否则与全网/参考实现不互通）：**

1. 双方都把自己的 **ed25519 私钥(32 字节种子) → x25519 私钥**、对方 **ed25519 公钥(地址) → x25519 公钥**（Edwards→Montgomery 转换，见 `@noble/curves` 的 `edwardsToMontgomeryPriv/Pub`）。
2. **x25519 原始 ECDH**（RFC 7748）得 32 字节共享密钥——**直接当对称密钥用，不再做 HSalsa20/HKDF 派生**。⚠️ 因此**不能用 libsodium 的 `crypto_box`**（它内部是 X25519+HSalsa20+XSalsa20，和这里不一样）；要用「裸 x25519 ECDH + XChaCha20-Poly1305」。
3. **XChaCha20-Poly1305** 加密：24 字节**随机** nonce + 共享密钥 → 密文(含 16 字节 poly1305 tag)。
4. memo = `"ENC|"` + `hex(nonce(24) ‖ 密文+tag)`。长度需 ≤ `MAX_MEMO`（现 512）。
5. **解密**：我是收件人→对方=`tx.from`；我是发件人→对方=`tx.to`。用 (我的 x25519 私钥, 对方 x25519 公钥) 得同一共享密钥；认证失败/非本人→解不开。ECDH 对称 → 发件人也能解自己发的。

**隐私边界**：只有**正文**加密；收发地址、时间、烧币额、"有这么一条消息"都公开（链上元数据）。无前向保密（同一对地址共享密钥固定，每条仅 nonce 变化）。教学链够用。

**原生库**：Apple 端 ed25519→x25519 转换 + 裸 x25519 可用 CryptoKit `Curve25519.KeyAgreement`（注意它对 ed25519 种子的处理，需自行 clamp/转换以匹配 RFC7748 结果）或直接移植 noble 算法；XChaCha20-Poly1305 用 swift-sodium 的 `aead_xchacha20poly1305`（**只用它的 AEAD，别用 box**）。Android 同理：BouncyCastle `X25519Agreement` + XChaCha20-Poly1305 AEAD。务必用下面向量对齐。

## 9. 金标准测试向量（自检用）

固定私钥种子 = 32 字节 `01 02 03 … 20`：

```
PRIV_HEX  0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20
PUB_HEX   79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664
ADDRESS   0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664
```

收款方固定 `TO = 0x` + `ab`×32，`timestamp = 1700000000000`：

**转账**（amount=100, fee=1, nonce=0, memo=`hi 🍜`）：
```
PREIMAGE  ["0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664","0xabababababababababababababababababababababababababababababababab",100,1,0,1700000000000,"hi 🍜"]
TXID      da4527a9715dd7e9d098f6615b588ceb051401d9e6846125feb7bdd1c4362932
SIGNATURE dab11981063113c8b5fff5f8fcaad3d9c0a49879f7cca8a9dcee16be1171b17ea8919217ab87c077f320e3ea0eaca8a31c49467dc5df6c3e28b9ba689fc07108
```

**消息**（amount=0, fee=1, nonce=1, memo=`gm`, burn=5）：
```
PREIMAGE  ["0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664","0xabababababababababababababababababababababababababababababababab",0,1,1,1700000000000,"gm",5]
TXID      bb451006fa4c197f7944346de8f24e9712c8d1fd90e47abf52f8b9fa2b52cd06
SIGNATURE 817ccc45061524d52b8f1fc41f0b3542498993679c5e73a9497f60421dd0f7c19ea1837de981dedcd20301e2ea0d2076c029a6249c0e9b832f24962ae7972104
```

转义自检：`JSON.stringify(["x\"y\nz\t🎲"])` 必须 == `["x\"y\nz\t🎲"]`（即字面 `[`、`"x\"y\nz\t🎲"`、`]`）。

**加密私信向量**（A 种子=`01..20`；B 种子=`21 22 … 40`，即 0x21–0x40）：
```
A 地址      0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664
B 地址      0xe7f162a10bec559afea195e4dce84b69568d5d2cb0963eb446c0685e2b17f2f0
共享密钥    22dd9afeb5878d76b7b7eba66e349a1a00858963745f1b92b78a1741e9ccf249   (A↔B 双向一致)
```
固定 nonce=`aa`×24 时，明文 `hi 🔐` 的密文 memo：
```
ENC|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6359b5d168414e050a885e42c9dc6eabf98ecbaea44fa9
```
你的实现：先复现「共享密钥」（最易错——Edwards→Montgomery 转换 + 裸 x25519），再用固定 nonce 复现上面这条 memo，最后让 B 解出 `hi 🔐`。实际发送请用**随机** nonce。

**对齐顺序**：先让你的实现复现上面的 PUB_HEX/ADDRESS → 再复现两条 PREIMAGE 字符串（最容易错的一步）→ 再复现 TXID → 最后复现 SIGNATURE。四步全绿即与全网兼容。
