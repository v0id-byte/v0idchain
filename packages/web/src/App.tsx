import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getJSON, postJSON, isCoinbase, search, type Block, type Info, type Listing, type Tx, type TxRef, type Messages, type Newcomer, type NameRegistry } from './api';

const short = (a: string) => (a && a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a || '');
// 模块级显示名缓存（每次轮询更新）；disp(地址) → 有昵称显示 @名字，否则缩写地址
let NAMES: Record<string, string> = {};
const disp = (a: string) => (a && NAMES[a] ? `@${NAMES[a]}` : short(a));
const ago = (ts: number) => {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.floor(s / 60)}m 前`;
  return `${Math.floor(s / 3600)}h 前`;
};

type Banner = { kind: 'ok' | 'err'; text: string } | null;

export default function App() {
  const [api, setApi] = useState(() => localStorage.getItem('v0id-api') || 'http://127.0.0.1:7001');
  const [token, setToken] = useState(() => localStorage.getItem('v0id-token') || '');
  const [info, setInfo] = useState<Info | null>(null);
  const [chain, setChain] = useState<Block[]>([]);
  const [mempool, setMempool] = useState<Tx[]>([]);
  const [market, setMarket] = useState<Listing[]>([]);
  const [messages, setMessages] = useState<Messages | null>(null);
  const [newcomers, setNewcomers] = useState<Newcomer[]>([]);
  const [names, setNames] = useState<NameRegistry>({ nameToOwner: {}, addressToName: {} });
  const [up, setUp] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;

  const poll = useCallback(async () => {
    const base = apiRef.current;
    try {
      const [i, c, m, mk, msg, nc, nm] = await Promise.all([
        getJSON<Info>(base, '/info'),
        getJSON<Block[]>(base, '/chain'),
        getJSON<Tx[]>(base, '/mempool'),
        getJSON<Listing[]>(base, '/market'),
        getJSON<Messages>(base, '/messages'),
        getJSON<Newcomer[]>(base, '/newcomers'),
        getJSON<NameRegistry>(base, '/names'),
      ]);
      setInfo(i);
      setChain(c);
      setMempool(m);
      setMarket(mk);
      setMessages(msg);
      setNewcomers(nc);
      NAMES = nm.addressToName || {}; // 刷新模块级显示名缓存（disp 读它）
      setNames(nm);
      setUp(true);
    } catch {
      setUp(false);
    }
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 1500);
    return () => clearInterval(t);
  }, [poll]);

  useEffect(() => {
    localStorage.setItem('v0id-api', api);
  }, [api]);

  useEffect(() => {
    localStorage.setItem('v0id-token', token);
  }, [token]);

  const me = info?.address ?? '';
  const recent = [...chain].reverse().slice(0, 25);

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="brand">
          <h1>
            <span className="v0">v0id</span>Chain
          </h1>
          <span className="sym">$V0ID</span>
        </div>
        <div className="conn">
          {info?.syncing && <span className="tag diff">同步中…</span>}
          <span className={`dot ${up ? 'up' : 'down'}`} title={up ? '已连接' : '未连接'} />
          <input value={api} onChange={(e) => setApi(e.target.value.trim())} spellCheck={false} aria-label="节点 API 地址" />
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value.trim())}
            spellCheck={false}
            placeholder="API 令牌"
            aria-label="API 令牌（见节点数据目录 api.token）"
          />
        </div>
      </div>

      {!up && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="empty">
            连不上节点 <b>{api}</b>。先启动一个节点：
            <div className="kv" style={{ marginTop: 8 }}>corepack pnpm dev:node1</div>
            然后把上方地址改成该节点的 API 端口（默认 7001）。
          </div>
        </div>
      )}

      <Wallet info={info} names={names} api={api} token={token} onDone={poll} />

      <div className="chips">
        <Chip k="链高" v={info ? String(info.height) : '—'} accent />
        <Chip k="区块数" v={info ? String(info.blocks) : '—'} />
        <Chip k="难度 (bit)" v={info ? String(info.difficulty) : '—'} />
        <Chip k="对等节点" v={info ? String(info.peers) : '—'} />
        <Chip k="已销毁 🔥" v={info ? String(info.burned ?? 0) : '—'} />
      </div>

      <Explorer chain={chain} me={me} />

      <Marketplace market={market} api={api} token={token} onDone={poll} />

      <div className="cols">
        <Actions api={api} token={token} me={me} minFee={info?.minFee ?? 1} onDone={poll} />
        <Mempool mempool={mempool} me={me} />
      </div>

      <div className="cols">
        <Messaging
          api={api}
          token={token}
          me={me}
          minFee={info?.minFee ?? 1}
          defaultBurn={info?.messageBurn ?? 5}
          messages={messages}
          onDone={poll}
        />
        <Newcomers newcomers={newcomers} />
      </div>

      <div className="panel" style={{ background: 'transparent', border: 'none', padding: 0 }}>
        <h2>区块（最新在上）</h2>
        <div className="feed">
          {recent.length === 0 && <div className="empty">还没有区块</div>}
          {recent.map((b) => (
            <BlockCard key={b.hash} b={b} me={me} open={open === b.hash} onToggle={() => setOpen(open === b.hash ? null : b.hash)} />
          ))}
        </div>
      </div>

      <div className="foot">v0idChain · 手搓区块链 · PoW 挖矿出币 · 手续费给矿工 · 每 1.5s 刷新</div>
    </div>
  );
}

function Wallet({ info, names, api, token, onDone }: { info: Info | null; names: NameRegistry; api: string; token: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [claim, setClaim] = useState('');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const copy = () => {
    if (!info) return;
    navigator.clipboard?.writeText(info.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const myName = info ? names.addressToName[info.address] : undefined;
  const claimName = async () => {
    setBusy(true);
    setBanner(null);
    try {
      await postJSON(api, '/name/claim', { name: claim.trim() }, token);
      setBanner({ kind: 'ok', text: `已提交抢注 @${claim.trim().toLowerCase()}（等一个区块；先到先得）` });
      setClaim('');
      onDone();
    } catch (e) {
      setBanner({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="wallet">
      <div>
        <div className="label">本节点余额{myName && <span className="tag me" style={{ marginLeft: 8 }}>@{myName}</span>}</div>
        <div className="balance">
          {info ? info.balance.toLocaleString() : '—'}
          <small>$V0ID</small>
        </div>
        <div className="addr-row">
          <span className="addr">{info ? info.address : '—'}</span>
          {info && (
            <button className="ghost mini" onClick={copy}>
              {copied ? '已复制' : '复制'}
            </button>
          )}
        </div>
        <div className="addr-row" style={{ marginTop: 8 }}>
          <input
            value={claim}
            onChange={(e) => setClaim(e.target.value)}
            placeholder={myName ? `改名（当前 @${myName}）` : '抢个昵称（小写字母/数字/_/-）'}
            maxLength={20}
            spellCheck={false}
            style={{ maxWidth: 240 }}
          />
          <button className="ghost mini" disabled={busy || !claim.trim()} onClick={claimName}>
            🪪 抢注
          </button>
        </div>
        {banner && <div className={`msg ${banner.kind}`} style={{ marginTop: 6 }}>{banner.text}</div>}
      </div>
      <div style={{ textAlign: 'right' }}>
        <div className="label">交易池</div>
        <div className="balance" style={{ fontSize: 32 }}>
          {info ? info.mempool : '—'}
          <small>待打包</small>
        </div>
      </div>
    </div>
  );
}

function Chip({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className="chip">
      <div className="k">{k}</div>
      <div className={`v ${accent ? 'accent' : ''}`}>{v}</div>
    </div>
  );
}

function TxRow({ tx, me, block }: { tx: Tx; me: string; block?: number }) {
  return (
    <div className="txrow">
      <span className="who">
        {isCoinbase(tx) ? <span className="tag coinbase">coinbase</span> : disp(tx.from)}
        {' → '}
        {disp(tx.to)}
        {tx.to === me && <span className="tag me">给我</span>}
        {block !== undefined && <span className="tag blk">#{block}</span>}
        {(tx.burn ?? 0) > 0 && <span className="tag me">✉️ 消息</span>}
        {tx.memo && <span className="memo">“{tx.memo}”</span>}
        {!isCoinbase(tx) && tx.fee > 0 && <span className="tag diff">手续费 {tx.fee}</span>}
      </span>
      <span className={`amt ${tx.to === me ? 'in' : ''}`}>
        {(tx.burn ?? 0) > 0 ? `🔥 ${tx.burn} $V0ID` : `${tx.amount} $V0ID`}
      </span>
    </div>
  );
}

function Explorer({ chain, me }: { chain: Block[]; me: string }) {
  const [q, setQ] = useState('');
  const res = useMemo(() => search(chain, q), [chain, q]);
  return (
    <div className="panel" style={{ marginBottom: 24 }}>
      <h2>区块浏览器 · 搜索</h2>
      <input
        className="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="地址 0x… / 交易 txid（64 hex）/ 区块 # 或 hash"
        spellCheck={false}
      />
      {q && res.kind === 'none' && <div className="empty">没找到匹配的地址 / 交易 / 区块</div>}

      {res.kind === 'address' && (
        <div className="exresult">
          <div className="kv">
            地址 {res.address} {res.address === me && <span className="tag me">本节点</span>}
          </div>
          <div className="bigbal">
            {res.balance.toLocaleString()} <small>$V0ID</small>
          </div>
          <div className="exsub">{res.history.length} 笔相关交易</div>
          {res.history.slice(0, 20).map((r: TxRef) => (
            <TxRow key={r.tx.txid + r.blockIndex} tx={r.tx} me={me} block={r.blockIndex} />
          ))}
        </div>
      )}

      {res.kind === 'tx' && (
        <div className="exresult">
          <div className="exsub">交易在区块 #{res.ref.blockIndex}</div>
          <TxRow tx={res.ref.tx} me={me} />
          <div className="kv">txid: {res.ref.tx.txid}</div>
          {res.ref.tx.memo && <div className="kv">备注: {res.ref.tx.memo}</div>}
        </div>
      )}

      {res.kind === 'block' && (
        <div className="exresult">
          <div className="exsub">
            区块 #{res.block.index} · 难度 {res.block.difficulty} bit · {res.block.transactions.length} 笔
          </div>
          <div className="kv">hash: {res.block.hash}</div>
          <div className="kv">merkleRoot: {res.block.merkleRoot}</div>
          {res.block.transactions.map((tx) => (
            <TxRow key={tx.txid} tx={tx} me={me} />
          ))}
        </div>
      )}
    </div>
  );
}

function Actions({ api, token, me, minFee, onDone }: { api: string; token: string; me: string; minFee: number; onDone: () => void }) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState(String(minFee));
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

  const submit = async () => {
    setBusy(true);
    setBanner(null);
    try {
      const r = await postJSON<{ txid: string }>(api, '/send', { to: to.trim(), amount: Number(amount), fee: Number(fee), memo }, token);
      setBanner({ kind: 'ok', text: `已广播 · txid ${r.txid.slice(0, 24)}…` });
      setTo('');
      setAmount('');
      setFee(String(minFee));
      setMemo('');
      onDone();
    } catch (e) {
      setBanner({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>转账</h2>
      <div className="field">
        <label>收款地址</label>
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x… (64 hex)" spellCheck={false} />
      </div>
      <div className="row2">
        <div className="field">
          <label>金额（正整数）</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="100" inputMode="numeric" />
        </div>
        <div className="field">
          <label>手续费 / gas（给矿工，≥{minFee}）</label>
          <input value={fee} onChange={(e) => setFee(e.target.value)} placeholder={String(minFee)} inputMode="numeric" />
        </div>
      </div>
      <div className="field">
        <label>备注（可选，≤128 字，上链可查）</label>
        <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="给同学的留言…" maxLength={128} />
      </div>
      <div className="btns">
        <button disabled={busy || !to || !amount} onClick={submit}>
          转账（本节点付）
        </button>
      </div>
      {me && (
        <div style={{ marginTop: 10 }}>
          <span className="linklike" style={{ fontSize: 12 }} onClick={() => setTo(me)}>
            ↳ 填入本节点地址
          </span>
        </div>
      )}
      {banner && <div className={`msg ${banner.kind}`}>{banner.text}</div>}
    </div>
  );
}

function Mempool({ mempool, me }: { mempool: Tx[]; me: string }) {
  return (
    <div className="panel">
      <h2>交易池 · {mempool.length} 笔</h2>
      {mempool.length === 0 && <div className="empty">空空如也</div>}
      {mempool.map((tx) => (
        <TxRow key={tx.txid} tx={tx} me={me} />
      ))}
    </div>
  );
}

function Messaging({
  api,
  token,
  me,
  minFee,
  defaultBurn,
  messages,
  onDone,
}: {
  api: string;
  token: string;
  me: string;
  minFee: number;
  defaultBurn: number;
  messages: Messages | null;
  onDone: () => void;
}) {
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [burn, setBurn] = useState(String(defaultBurn));
  const [enc, setEnc] = useState(false);
  const [tab, setTab] = useState<'in' | 'out'>('in');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

  const send = async () => {
    setBusy(true);
    setBanner(null);
    try {
      const r = await postJSON<{ txid: string }>(api, '/message', { to: to.trim(), text, burn: Number(burn), fee: minFee, encrypt: enc }, token);
      setBanner({ kind: 'ok', text: `已广播${enc ? ' 🔒加密' : ''} · 烧 ${burn} 🔥 · txid ${r.txid.slice(0, 20)}…` });
      setTo('');
      setText('');
      setBurn(String(defaultBurn));
      onDone();
    } catch (e) {
      setBanner({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const list = messages ? (tab === 'in' ? messages.received : messages.sent) : [];

  return (
    <div className="panel">
      <h2>链上消息 ✉️</h2>
      <div className="field">
        <label>收件人地址</label>
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x… (64 hex)" spellCheck={false} />
      </div>
      <div className="row2">
        <div className="field" style={{ flex: 2 }}>
          <label>消息正文（≤128 字，明文上链）</label>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="在链上给 TA 留句话…" maxLength={128} />
        </div>
        <div className="field">
          <label>烧 🔥（销毁，≥1）</label>
          <input value={burn} onChange={(e) => setBurn(e.target.value)} placeholder={String(defaultBurn)} inputMode="numeric" />
        </div>
      </div>
      <div className="btns" style={{ alignItems: 'center', gap: 12 }}>
        <button disabled={busy || !to || !text} onClick={send}>
          发送（烧 {burn || 0} $V0ID + {minFee} gas）
        </button>
        <label className="linklike" style={{ fontSize: 13, userSelect: 'none' }}>
          <input type="checkbox" checked={enc} onChange={(e) => setEnc(e.target.checked)} style={{ marginRight: 4 }} />
          🔒 加密（只有 TA 能解）
        </label>
      </div>
      {banner && <div className={`msg ${banner.kind}`}>{banner.text}</div>}

      <div className="tabs" style={{ marginTop: 14 }}>
        <span className={`linklike ${tab === 'in' ? 'on' : ''}`} onClick={() => setTab('in')}>
          收件箱 {messages ? `(${messages.received.length})` : ''}
        </span>
        {'　'}
        <span className={`linklike ${tab === 'out' ? 'on' : ''}`} onClick={() => setTab('out')}>
          发件箱 {messages ? `(${messages.sent.length})` : ''}
        </span>
      </div>
      {list.length === 0 && <div className="empty">（暂无消息）</div>}
      {list.map((m) => (
        <div className="txrow" key={m.txid}>
          <span className="who">
            {tab === 'in' ? `← ${disp(m.from)}` : `→ ${disp(m.to)}`}
            <span className="tag blk">#{m.height}</span>
            {m.encrypted && <span className="tag me">🔒</span>}
            <span className="memo">{m.locked ? '（加密内容，无法解密）' : `“${m.text}”`}</span>
          </span>
          <span className="amt">🔥 {m.burn}</span>
        </div>
      ))}
    </div>
  );
}

function Newcomers({ newcomers }: { newcomers: Newcomer[] }) {
  return (
    <div className="panel">
      <h2>新成员 🆕 · {newcomers.length}</h2>
      {newcomers.length === 0 && <div className="empty">本次会话还没发现新节点 / 新地址</div>}
      {newcomers.map((n, i) => (
        <div className="txrow" key={n.address + n.at + i}>
          <span className="who">
            <span className={`tag ${n.kind === 'peer' ? 'diff' : 'me'}`}>{n.kind === 'peer' ? '新节点' : '新地址'}</span>
            {disp(n.address)}
            {n.kind === 'peer' && n.listen && <span className="memo">{n.listen}</span>}
            {n.kind === 'address' && n.height !== undefined && <span className="tag blk">#{n.height}</span>}
          </span>
          <span className="amt">{ago(n.at)}</span>
        </div>
      ))}
    </div>
  );
}

function Marketplace({ market, api, token, onDone }: { market: Listing[]; api: string; token: string; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

  const act = async (path: string, body: unknown, okMsg: string) => {
    setBusy(true);
    setBanner(null);
    try {
      await postJSON(api, path, body, token);
      setBanner({ kind: 'ok', text: okMsg });
      onDone();
      return true;
    } catch (e) {
      setBanner({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const sell = async () => {
    if (await act('/market/sell', { price: Number(price), title: title.trim() }, '已上架（等一个区块确认后显示）')) {
      setTitle('');
      setPrice('');
    }
  };

  const active = market.filter((l) => !l.sold && !l.delisted);
  const done = market.filter((l) => l.sold || l.delisted);

  return (
    <div className="panel" style={{ marginBottom: 24 }}>
      <h2>集市 · {active.length} 件在售</h2>
      <div className="row2">
        <div className="field" style={{ flex: 2 }}>
          <label>商品 / 服务</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：复习笔记 / 帮做PPT / 请喝奶茶" maxLength={100} />
        </div>
        <div className="field">
          <label>价格 $V0ID</label>
          <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="20" inputMode="numeric" />
        </div>
      </div>
      <div className="btns">
        <button disabled={busy || !title || !price} onClick={sell}>
          上架
        </button>
      </div>
      {banner && <div className={`msg ${banner.kind}`}>{banner.text}</div>}

      <div className="mkt-grid">
        {active.length === 0 && <div className="empty">还没有人上架，来当第一个卖家吧</div>}
        {active.map((l) => (
          <div className="mkt-item" key={l.id}>
            <div className="mkt-top">
              <span className="mkt-price">{l.price} $V0ID</span>
              {l.mine && <span className="tag me">我的</span>}
            </div>
            <div className="mkt-title">{l.title}</div>
            <div className="mkt-seller">卖家 {disp(l.seller)}</div>
            {l.mine ? (
              <button className="ghost mini" disabled={busy} onClick={() => act('/market/delist', { id: l.id }, '已撤单')}>
                撤下
              </button>
            ) : (
              <button className="mini" disabled={busy} onClick={() => act('/market/buy', { id: l.id }, '已下单付款')}>
                购买
              </button>
            )}
          </div>
        ))}
      </div>
      {done.length > 0 && (
        <div className="mkt-done">
          {done.slice(0, 10).map((l) => (
            <span key={l.id} className="mkt-doneitem">
              {l.sold ? '✓ 已售' : '✕ 下架'} {l.title} · {l.price} $V0ID
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function BlockCard({ b, me, open, onToggle }: { b: Block; me: string; open: boolean; onToggle: () => void }) {
  const reward = b.transactions.filter(isCoinbase).reduce((s, t) => s + t.amount, 0);
  const fees = b.transactions.filter((t) => !isCoinbase(t)).reduce((s, t) => s + (t.fee ?? 0), 0);
  return (
    <div className="block" onClick={onToggle}>
      <div className="head">
        <span className="idx">
          #{b.index} <span className="hash">{b.hash.slice(0, 12)}…</span>
        </span>
        <span className="meta">
          <span>{b.transactions.length} 笔</span>
          <span className="tag diff">{b.difficulty} bit</span>
          <span>矿工 {b.index === 0 ? '创世' : disp(b.miner)}</span>
          <span>{ago(b.timestamp)}</span>
        </span>
      </div>
      {open && (
        <div className="body">
          <div className="kv">hash: {b.hash}</div>
          <div className="kv">prev: {b.prevHash}</div>
          <div className="kv">merkleRoot: {b.merkleRoot}</div>
          <div className="kv">
            nonce: {b.nonce}　难度: {b.difficulty} bit　奖励/预挖: {reward} $V0ID
            {fees > 0 ? `（含手续费 ${fees}）` : ''}
          </div>
          <div style={{ marginTop: 8 }}>
            {b.transactions.map((tx) => (
              <TxRow key={tx.txid} tx={tx} me={me} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
