// 五个角色/钱包板块（浏览客户端 / 中继 / 托管站点 / 链·挖矿 / 钱包）—— Phase E：接真实运行时控制 + 钱包。
//
// 安全模型回顾：本 React 页面是「窗口自身的受信页面」（contextIsolation、无 Node）。渲染层**永不**接触 API 令牌：
// 所有节点控制走 window.v0id.api.*（renderer→preload→主进程），主进程从 userData/v0id/api.token 读令牌、对
// 127.0.0.1:7001 发请求（写接口带 Bearer）。这里只调那层薄 IPC，按返回的 { ok, data } / { ok:false, error } 渲染。
//
// 质押门槛：随链难度动态计算（computeStakeMin），从 info.stakeMin 读取（避免渲染层内嵌静态常量）。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useInfo } from '../useInfo.js';

// 质押激活高度（镜像 config.ts，链未到此高度前按钮禁用）
const STAKING_ACTIVATION_HEIGHT = 16_000;

// ---- 轮询任意 GET：每 intervalMs 调一次 fn()，返回最新结果 ----
function usePoll(fn, intervalMs = 4000, deps = []) {
  const [res, setRes] = useState(undefined);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fn();
        if (alive) setRes(r);
      } catch (e) {
        if (alive) setRes({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    };
    tick();
    const t = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return res;
}

// ---- QR 码生成（client-side，不外发地址）----
function useQRCode(text) {
  const [dataUrl, setDataUrl] = useState(null);
  useEffect(() => {
    if (!text) { setDataUrl(null); return; }
    QRCode.toDataURL(text, { width: 200, margin: 2, color: { dark: '#e0e0ff', light: '#0000' } })
      .then(setDataUrl)
      .catch(() => setDataUrl(null));
  }, [text]);
  return dataUrl;
}

// ---- 角色板块底部常驻的诚实提醒 ----
function HonestNote() {
  return (
    <div className="honest-note">
      小网络 = 弱匿名（中继越少越易被关联）；v1 激励层仍较中心化（度量者裁决罚没）。详见 INCENTIVE-PROTOCOL。
    </div>
  );
}

// ---- 复制到剪贴板的小按钮 ----
function CopyBtn({ text, label = '复制' }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    } catch { /* 剪贴板不可用：静默 */ }
  };
  return (
    <button className="mini-btn" onClick={copy} disabled={!text} title="复制到剪贴板">
      {done ? '已复制' : label}
    </button>
  );
}

const shortAddr = (a) => (a && a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a || '—');

// ---- 只读状态卡 ----
function ChainStatus({ info, fields }) {
  if (info === undefined) return <p className="stat-note">读取链状态中…</p>;
  if (info === null) return <p className="stat-note">链状态不可用（外部 SOCKS 模式，或本机节点 API 尚未就绪）。</p>;
  const all = {
    height:  { k: '链高',            v: info.height },
    peers:   { k: '对等节点',        v: info.peers },
    blocks:  { k: '区块数',          v: info.blocks },
    mempool: { k: '内存池',          v: info.mempool },
    balance: { k: `余额 (${info.symbol || '$V0ID'})`, v: info.balance },
    burned:  { k: '已烧毁',          v: info.burned },
    syncing: { k: '同步中',          v: info.syncing ? '是' : '否' },
    address: { k: '本节点地址',      v: info.address, small: true },
  };
  const pick = fields || ['height', 'peers'];
  return (
    <div className="stat-grid">
      {pick.map((f) => {
        const cell = all[f];
        if (!cell) return null;
        return (
          <div className="stat" key={f}>
            <div className="k">{cell.k}</div>
            <div className={'v' + (cell.small ? ' small' : '')}>{cell.v ?? '—'}</div>
          </div>
        );
      })}
    </div>
  );
}

function ActionMsg({ msg }) {
  if (!msg) return null;
  return <div className={'action-msg ' + (msg.kind || '')}>{msg.text}</div>;
}

// ============================================================================
// 浏览客户端
// ============================================================================
export function ClientPanel() {
  const info = useInfo();
  const roles = usePoll(() => window.v0id.api.roles(), 4000);
  const socks = roles?.ok ? roles.data.socks : null;
  return (
    <div className="panel">
      <h1>浏览客户端</h1>
      <span className="role-tag">CLIENT · 出口匿名访问者 · 始终开</span>
      <p>
        你正在以「客户端」身份运行：本机守护进程通过三跳洋葱电路把你的请求送出，沿途中继逐跳剥离一层加密，
        没有任何单一节点同时知道「你是谁」和「你在访问什么」。访问 <code>.v0id</code> 隐藏服务走 rendezvous，
        连双方 IP 都互相不可见。客户端是默认、零质押、撑起浏览的基座，因此<b>没有开关</b>。
      </p>
      <div className="stat-grid">
        <div className="stat"><div className="k">SOCKS 状态</div><div className="v">{socks ? (socks.on ? '运行中' : '未启用') : '—'}</div></div>
        <div className="stat"><div className="k">SOCKS 端口</div><div className="v">{socks?.port ?? '—'}</div></div>
      </div>
      <ChainStatus info={info} fields={['height', 'peers']} />
      {roles && !roles.ok && <p className="stat-note">角色状态读取失败：{roles.error}</p>}
      <HonestNote />
    </div>
  );
}

// ============================================================================
// 中继
// ============================================================================
export function RelayPanel() {
  const info = useInfo();
  const roles = usePoll(() => window.v0id.api.roles(), 3000);
  const stakeRes = usePoll(() => window.v0id.api.stakeStatus(), 5000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [role, setRole] = useState('middle');

  const relay = roles?.ok ? roles.data.relay : null;
  const on = !!relay?.on;
  const height = info && info.height != null ? info.height : null;
  const activated = height != null && height >= STAKING_ACTIVATION_HEIGHT;
  const myStakes = stakeRes?.ok ? stakeRes.data : [];
  // 动态质押门槛（从 /info 读，随难度变化）
  const stakeMin = info?.stakeMin ?? { guard: 500, hsdir: 300, middle: 100 };

  const toggle = useCallback(async () => {
    setBusy(true);
    setMsg({ kind: '', text: on ? '正在下线中继…' : '正在上线中继…' });
    const r = on ? await window.v0id.api.relayStop() : await window.v0id.api.relayStart();
    setBusy(false);
    setMsg(r.ok ? { kind: 'ok', text: on ? '中继已下线' : '中继已上线（描述符将在余额≥2 时自动上链发布）' } : { kind: 'err', text: r.error });
  }, [on]);

  const doStake = useCallback(async () => {
    setBusy(true);
    setMsg({ kind: '', text: `正在质押 ${role}（押金 ${stakeMin[role]} $V0ID）…` });
    const r = await window.v0id.api.stake(role);
    setBusy(false);
    setMsg(r.ok ? { kind: 'ok', text: `质押已提交（txid ${r.data.txid.slice(0, 12)}…），挖进区块后锁定` } : { kind: 'err', text: r.error });
  }, [role, stakeMin]);

  const doUnstake = useCallback(async (id) => {
    setBusy(true);
    setMsg({ kind: '', text: '正在赎回…' });
    const r = await window.v0id.api.unstake(id);
    setBusy(false);
    setMsg(r.ok ? { kind: 'ok', text: `赎回已提交（txid ${r.data.txid.slice(0, 12)}…）` } : { kind: 'err', text: r.error });
  }, []);

  return (
    <div className="panel">
      <h1>中继</h1>
      <span className="role-tag">RELAY · 为网络转发流量</span>
      <p>
        中继把你的机器变成 <code>.v0id</code> 网络的一跳：转发他人电路的 cell、参与 rendezvous，让整张匿名网更大、更难被流量分析。
      </p>
      <div className="ctl-row">
        <button className={'toggle ' + (on ? 'on' : '')} onClick={toggle} disabled={busy || !roles?.ok}>
          {on ? '● 中继运行中 —— 点击下线' : '○ 中继已下线 —— 点击上线'}
        </button>
      </div>
      <div className="stat-grid">
        <div className="stat"><div className="k">cell 端口</div><div className="v">{relay?.port ?? '—'}</div></div>
        <div className="stat"><div className="k">活动电路</div><div className="v">{relay ? relay.circuits : '—'}</div></div>
        <div className="stat"><div className="k">描述符上链</div><div className="v">{relay ? (relay.published ? '已发布' : '待发布') : '—'}</div></div>
      </div>
      {relay?.address && <p className="stat-note">中继链上身份：<code>{shortAddr(relay.address)}</code></p>}

      <h3 className="sub-h">质押（诚实保证金）</h3>
      <p>
        中继质押 <code>$V0ID</code> 作为「诚实保证金」——作恶会被度量并罚没本金。
        押金按角色风险定档（随链难度动态调整）：
        <code>guard {stakeMin.guard}</code> · <code>hsdir {stakeMin.hsdir}</code> · <code>middle {stakeMin.middle}</code>
      </p>

      {!activated ? (
        <div className="gate-note">
          质押共识将于 <b>height {STAKING_ACTIVATION_HEIGHT.toLocaleString()}</b> 激活
          （当前链高 {height == null ? '读取中…' : height.toLocaleString()}）。
          在此之前质押按钮已禁用以免押金锁进托管却不生效。
        </div>
      ) : (
        <div className="ctl-row">
          <select className="select" value={role} onChange={(e) => setRole(e.target.value)} disabled={busy}>
            <option value="guard">guard（押金 {stakeMin.guard}）</option>
            <option value="hsdir">hsdir（押金 {stakeMin.hsdir}）</option>
            <option value="middle">middle（押金 {stakeMin.middle}）</option>
          </select>
          <button className="primary-btn" onClick={doStake} disabled={busy}>
            质押 {role}
          </button>
        </div>
      )}

      <div className="reward-note">引导期暂不发放奖励（见 INCENTIVE-PROTOCOL）。质押当前只承担「诚实保证金」职责，不产生收益。</div>

      {myStakes.length > 0 && (
        <div className="stake-list">
          <h3 className="sub-h">本节点质押池</h3>
          {myStakes.map((s) => (
            <div className="stake-card" key={s.id}>
              <div className="stake-line">
                <span className="badge">{s.role}</span>
                <span>本金 {s.amount}</span>
                {s.slashed > 0 && <span className="slashed">已罚没 {s.slashed}</span>}
                <span className="dim">锁至 height {s.lockedUntil}</span>
                {s.withdrawn && <span className="dim">· 已赎回</span>}
              </div>
              {!s.withdrawn && (
                <button className="mini-btn" onClick={() => doUnstake(s.id)} disabled={busy || (height != null && height < s.lockedUntil)}>
                  {height != null && height < s.lockedUntil ? '锁定中' : '赎回'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <ActionMsg msg={msg} />
      {roles && !roles.ok && <p className="stat-note">角色状态读取失败：{roles.error}</p>}
      <HonestNote />
    </div>
  );
}

// ============================================================================
// 托管站点 —— 多服务 + 访问统计 + 标签 + QR 码
// ============================================================================

function HsQRModal({ address, onClose }) {
  const qr = useQRCode(address);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h3 className="sub-h" style={{ marginTop: 0 }}>扫码访问</h3>
        {qr ? <img src={qr} alt="QR" style={{ width: 200, height: 200, display: 'block', margin: '0 auto' }} /> : <p>生成中…</p>}
        <p className="stat-note" style={{ wordBreak: 'break-all', textAlign: 'center' }}><code>{address}</code></p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 8 }}>
          <CopyBtn text={address} label="复制地址" />
          <button className="mini-btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

function HsServiceCard({ entry, onStop, busy }) {
  const [showQR, setShowQR] = useState(false);
  return (
    <div className="hs-card">
      <div className="hs-card-header">
        <span className="badge on">托管中</span>
        {entry.name && <span className="hs-name">{entry.name}</span>}
        <span className="dim" style={{ marginLeft: 'auto' }}>→ {entry.target.host}:{entry.target.port}</span>
      </div>
      <div className="hs-addr-row">
        <code className="small">{entry.address}</code>
        <CopyBtn text={entry.address} />
        <button className="mini-btn" onClick={() => setShowQR(true)} title="显示 QR 码">QR</button>
      </div>
      <div className="hs-stats">
        <span>累计连接 <b>{entry.connCount}</b></span>
      </div>
      <button className="mini-btn danger" onClick={() => onStop(entry.id)} disabled={busy}>停止</button>
      {showQR && <HsQRModal address={entry.address} onClose={() => setShowQR(false)} />}
    </div>
  );
}

export function HostPanel() {
  const roles = usePoll(() => window.v0id.api.roles(), 2000);
  const [target, setTarget] = useState('127.0.0.1:8080');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const hsList = roles?.ok ? (roles.data.hsList ?? []) : [];

  const start = useCallback(async () => {
    const m = target.trim().match(/^([^:]+):(\d+)$/);
    if (!m) { setMsg({ kind: 'err', text: '目标格式应为 host:port，例如 127.0.0.1:8080' }); return; }
    setBusy(true);
    setMsg({ kind: '', text: '正在发布隐藏服务（选引入点 / 签名 / 上 DHT，需链上 ≥3 中继）…' });
    const r = await window.v0id.api.hsStart(m[1], Number(m[2]), name.trim() || undefined);
    setBusy(false);
    if (r.ok) {
      setMsg({ kind: 'ok', text: `隐藏服务已发布：${r.data.address}` });
      setTarget('127.0.0.1:8080');
      setName('');
    } else if (/中继不足|≥?3|3 个/.test(r.error || '')) {
      setMsg({ kind: 'err', text: '链上中继不足 3 个，暂无法托管（待更多 relay 上链后重试）。' });
    } else {
      setMsg({ kind: 'err', text: r.error });
    }
  }, [target, name]);

  const stop = useCallback(async (id) => {
    setBusy(true);
    setMsg({ kind: '', text: '正在停止隐藏服务…' });
    const r = await window.v0id.api.hsStop(id);
    setBusy(false);
    setMsg(r.ok ? { kind: 'ok', text: '隐藏服务已停止（描述符靠 TTL 自然过期）' } : { kind: 'err', text: r.error });
  }, []);

  return (
    <div className="panel">
      <h1>托管站点</h1>
      <span className="role-tag">HIDDEN SERVICE · 发布 .v0id 隐藏服务</span>
      <p>
        把本机一个普通服务（如 <code>127.0.0.1:8080</code>）发布成 <code>.v0id</code> 隐藏服务：
        守护进程选引入点、签名并发布描述符到 DHT。访问者经 rendezvous 连进来——你不暴露任何对外 IP，
        访问者也只知道那串 <code>.v0id</code> 地址。支持同时托管多个服务，每个独立地址。
      </p>

      {/* 已托管服务列表 */}
      {hsList.length > 0 && (
        <div className="hs-list">
          <h3 className="sub-h">活动服务（{hsList.length} 个）</h3>
          {hsList.map((e) => (
            <HsServiceCard key={e.id} entry={e} onStop={stop} busy={busy} />
          ))}
        </div>
      )}

      {/* 添加新服务 */}
      <h3 className="sub-h">发布新服务</h3>
      <div className="form">
        <label className="field">
          <span>本机目标（host:port）</span>
          <input className="text-input" value={target} onChange={(e) => setTarget(e.target.value)}
            placeholder="127.0.0.1:8080" spellCheck={false} disabled={busy} />
        </label>
        <label className="field">
          <span>备注名（可选，仅本地显示）</span>
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="如「我的博客」" spellCheck={false} disabled={busy} />
        </label>
        <button className="primary-btn" onClick={start} disabled={busy || !roles?.ok}>
          发布隐藏服务
        </button>
      </div>

      <ActionMsg msg={msg} />
      {roles && !roles.ok && <p className="stat-note">角色状态读取失败：{roles.error}</p>}
      <HonestNote />
    </div>
  );
}

// ============================================================================
// 链 · 挖矿
// ============================================================================
export function ChainPanel() {
  const info = useInfo();
  const roles = usePoll(() => window.v0id.api.roles(), 3000);
  const [interval, setIntervalMs] = useState('8000');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const mine = roles?.ok ? roles.data.mine : null;
  const on = !!mine?.on;

  const toggle = useCallback(async () => {
    setBusy(true);
    if (on) {
      setMsg({ kind: '', text: '正在停止挖矿…' });
      const r = await window.v0id.api.mineStop();
      setBusy(false);
      setMsg(r.ok ? { kind: 'ok', text: '挖矿已停止' } : { kind: 'err', text: r.error });
    } else {
      const iv = Number(interval);
      if (!Number.isInteger(iv) || iv < 0) {
        setBusy(false);
        setMsg({ kind: 'err', text: '出块间隔须为非负整数毫秒（0 = 连续挖）' });
        return;
      }
      setMsg({ kind: '', text: '正在开始挖矿…' });
      const r = await window.v0id.api.mineStart(iv);
      setBusy(false);
      setMsg(r.ok ? { kind: 'ok', text: `挖矿已开始（间隔 ${iv === 0 ? '连续' : iv + 'ms'}）` } : { kind: 'err', text: r.error });
    }
  }, [on, interval]);

  return (
    <div className="panel">
      <h1>链 · 挖矿</h1>
      <span className="role-tag">CHAIN · v0idchain 主链</span>
      <p>
        <code>.v0id</code> 网络的信任根是 v0idchain：中继目录、质押、隐藏服务描述符的锚点都在链上。
        守护进程内嵌一个全节点，与种子对等同步。下面是它的只读状态：
      </p>
      <ChainStatus info={info} fields={['height', 'blocks', 'peers', 'mempool', 'balance', 'syncing']} />

      <h3 className="sub-h">挖矿</h3>
      <p>挖矿是把算力投向链、获得 <code>$V0ID</code> 出块奖励的过程（教学/小算力网络，CPU 即可）。</p>
      <div className="ctl-row">
        <input className="text-input narrow" value={interval} onChange={(e) => setIntervalMs(e.target.value)}
          placeholder="出块间隔(ms)" spellCheck={false} disabled={on || busy} title="两次出块尝试之间的间隔，毫秒；0 = 连续挖" />
        <span className="dim">ms 间隔（0=连续）</span>
        <button className={'toggle ' + (on ? 'on' : '')} onClick={toggle} disabled={busy || !roles?.ok}>
          {on ? '● 挖矿中 —— 点击停止' : '○ 未挖矿 —— 点击开始'}
        </button>
      </div>
      {on && mine && <p className="stat-note">当前间隔：{mine.intervalMs === 0 ? '连续' : mine.intervalMs + 'ms'}</p>}

      <ActionMsg msg={msg} />
      {roles && !roles.ok && <p className="stat-note">角色状态读取失败：{roles.error}</p>}
    </div>
  );
}

// ============================================================================
// 钱包 —— 节点托管钱包 + 私钥导入
// ============================================================================
export function WalletPanel() {
  const wallet = usePoll(() => window.v0id.api.walletInfo(), 4000);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  // 私钥导入表单状态
  const [showImport, setShowImport] = useState(false);
  const [privKey, setPrivKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState(null);

  const ok = wallet?.ok;
  const address = ok ? wallet.data.address : null;
  const balance = ok ? wallet.data.balance : null;
  const symbol = (ok && wallet.data.symbol) || '$V0ID';

  const doSend = useCallback(async () => {
    const amt = Number(amount);
    if (!to.trim()) { setMsg({ kind: 'err', text: '请填写收款地址' }); return; }
    if (!Number.isFinite(amt) || amt <= 0) { setMsg({ kind: 'err', text: '金额须为正数' }); return; }
    setBusy(true);
    setMsg({ kind: '', text: '正在提交转账…' });
    const r = await window.v0id.api.send(to.trim(), amt, memo);
    setBusy(false);
    if (r.ok) {
      setMsg({ kind: 'ok', text: `已提交（txid ${r.data.txid.slice(0, 12)}…），挖进区块后到账` });
      setTo(''); setAmount(''); setMemo('');
    } else {
      setMsg({ kind: 'err', text: r.error });
    }
  }, [to, amount, memo]);

  const doImport = useCallback(async () => {
    const hex = privKey.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      setImportMsg({ kind: 'err', text: '私钥须为 64 位十六进制字符串' });
      return;
    }
    setImportBusy(true);
    setImportMsg({ kind: '', text: '正在导入，守护进程热替换钱包…' });
    const r = await window.v0id.api.importWallet(hex);
    setImportBusy(false);
    if (r.ok) {
      setImportMsg({ kind: 'ok', text: `导入成功，新地址：${r.data.address}` });
      setPrivKey('');
      setShowImport(false);
    } else {
      setImportMsg({ kind: 'err', text: r.error });
    }
  }, [privKey]);

  return (
    <div className="panel">
      <h1>钱包</h1>
      <span className="role-tag">WALLET · $V0ID 余额与地址</span>
      <p>
        <code>$V0ID</code> 是网络的原生代币：支付手续费、质押中继保证金、参与链上社交（昵称 / 私信 / 红包）都用它。
        本钱包由守护进程托管（私钥在节点数据目录，<b>永不</b>经渲染层）。
      </p>

      {wallet === undefined ? (
        <p className="stat-note">读取钱包中…</p>
      ) : !ok ? (
        <p className="stat-note">钱包不可用：{wallet.error}</p>
      ) : (
        <>
          <div className="addr-box">
            <div className="k">收款地址</div>
            <div className="addr-val">
              <code>{address}</code>
              <CopyBtn text={address} />
            </div>
          </div>

          <div className="stat-grid">
            <div className="stat">
              <div className="k">余额（{symbol}）</div>
              <div className="v">{balance ?? '—'}</div>
            </div>
          </div>

          {/* 转账 */}
          <h3 className="sub-h">转账</h3>
          <div className="form">
            <label className="field">
              <span>收款地址</span>
              <input className="text-input" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false} disabled={busy} />
            </label>
            <label className="field">
              <span>金额（{symbol}）</span>
              <input className="text-input" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" inputMode="decimal" spellCheck={false} disabled={busy} />
            </label>
            <label className="field">
              <span>备注（可选，链上明文）</span>
              <input className="text-input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="memo" spellCheck={false} disabled={busy} maxLength={512} />
            </label>
            <button className="primary-btn" onClick={doSend} disabled={busy}>发送</button>
          </div>
          <p className="stat-note">手续费按金额自动计算（最低 {ok && wallet.data.minFee != null ? wallet.data.minFee : '—'}）。转账由守护进程签名广播。</p>
        </>
      )}

      <ActionMsg msg={msg} />

      {/* 私钥导入 */}
      <div className="import-section">
        <button className="mini-btn" onClick={() => { setShowImport(!showImport); setImportMsg(null); }}>
          {showImport ? '▲ 收起导入' : '▼ 导入已有钱包（私钥）'}
        </button>
        {showImport && (
          <div className="import-form">
            <p className="stat-note warn">
              ⚠ 导入私钥会<b>立即替换</b>守护进程当前钱包（热替换，无需重启），旧钱包文件将被覆盖。
              请提前备份旧的 <code>wallet.json</code>。私钥在主进程内完成导入，渲染层不存储。
            </p>
            <label className="field">
              <span>私钥（64 位 hex）</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  className="text-input"
                  type={showKey ? 'text' : 'password'}
                  value={privKey}
                  onChange={(e) => setPrivKey(e.target.value)}
                  placeholder="0000…（64 位 hex ed25519 私钥）"
                  spellCheck={false}
                  disabled={importBusy}
                  style={{ flex: 1, fontFamily: 'monospace' }}
                />
                <button className="mini-btn" onClick={() => setShowKey(!showKey)} style={{ whiteSpace: 'nowrap' }}>
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
            </label>
            <button className="primary-btn" onClick={doImport} disabled={importBusy || privKey.length < 64}>
              导入钱包
            </button>
            <ActionMsg msg={importMsg} />
          </div>
        )}
      </div>
    </div>
  );
}
