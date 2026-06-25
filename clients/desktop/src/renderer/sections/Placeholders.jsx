// 五个角色/钱包板块（浏览客户端 / 中继 / 托管站点 / 链·挖矿 / 钱包）—— Phase E：接真实运行时控制 + 钱包。
//
// 安全模型回顾：本 React 页面是「窗口自身的受信页面」（contextIsolation、无 Node）。渲染层**永不**接触 API 令牌：
// 所有节点控制走 window.v0id.api.*（renderer→preload→主进程），主进程从 userData/v0id/api.token 读令牌、对
// 127.0.0.1:7001 发请求（写接口带 Bearer）。这里只调那层薄 IPC，按返回的 { ok, data } / { ok:false, error } 渲染。
//
// 诚实原则：质押激活高度（16000）前禁用质押并解释原因；引导期不发奖励（见 INCENTIVE-PROTOCOL）；
// 小网络=弱匿名 + v1 激励中心化的提醒常驻每个角色板块底部。
import React, { useCallback, useEffect, useState } from 'react';
import { useInfo } from '../useInfo.js';

// 这两个常量镜像 packages/core/src/config.ts（渲染层无法 import core）。改 config 时同步这里。
const STAKING_ACTIVATION_HEIGHT = 16_000;
const STAKE_MIN = { guard: 12, hsdir: 8, middle: 4 }; // $V0ID 最低押金（与 config.STAKE_MIN 一致）

// ---- 轮询任意 GET：每 intervalMs 调一次 fn()，返回最新结果。fn 必须返回 { ok, data } 形。----
function usePoll(fn, intervalMs = 4000, deps = []) {
  const [res, setRes] = useState(undefined); // undefined=加载中
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
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return res;
}

// ---- 角色板块底部常驻的诚实提醒 ----
function HonestNote() {
  return (
    <div className="honest-note">
      小网络 = 弱匿名（中继越少越易被关联）；v1 激励层仍较中心化（度量者裁决罚没）。详见 INCENTIVE-PROTOCOL。
    </div>
  );
}

// ---- 复制到剪贴板的小按钮（无第三方依赖，用浏览器 clipboard API）----
function CopyBtn({ text, label = '复制' }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    } catch {
      /* 剪贴板不可用：静默（非关键路径） */
    }
  };
  return (
    <button className="mini-btn" onClick={copy} disabled={!text} title="复制到剪贴板">
      {done ? '已复制' : label}
    </button>
  );
}

// 缩址显示（与 game-web shortAddr 同款）。
const shortAddr = (a) => (a && a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a || '—');

// ---- 只读状态卡（从 /info）----
function ChainStatus({ info, fields }) {
  if (info === undefined) return <p className="stat-note">读取链状态中…</p>;
  if (info === null)
    return (
      <p className="stat-note">链状态不可用（当前可能处于外部 SOCKS 验证模式，或本机节点 API 尚未就绪）。</p>
    );
  const all = {
    height: { k: '链高', v: info.height },
    peers: { k: '对等节点', v: info.peers },
    blocks: { k: '区块数', v: info.blocks },
    mempool: { k: '内存池', v: info.mempool },
    balance: { k: `余额 (${info.symbol || '$V0ID'})`, v: info.balance },
    burned: { k: '已烧毁', v: info.burned },
    syncing: { k: '同步中', v: info.syncing ? '是' : '否' },
    address: { k: '本节点地址', v: info.address, small: true },
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

// 操作结果反馈行（成功/失败/进行中）。
function ActionMsg({ msg }) {
  if (!msg) return null;
  return <div className={'action-msg ' + (msg.kind || '')}>{msg.text}</div>;
}

// ============================================================================
// 浏览客户端 —— 始终开的匿名出站基座（无开关）
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
        连双方 IP 都互相不可见。这正是「浏览器」板块每个标签页背后用的能力——客户端是默认、零质押、撑起浏览的基座，
        因此**没有开关**（关掉它等于失去 .v0id 出站能力）。
      </p>
      <div className="stat-grid">
        <div className="stat">
          <div className="k">SOCKS 状态</div>
          <div className="v">{socks ? (socks.on ? '运行中' : '未启用') : '—'}</div>
        </div>
        <div className="stat">
          <div className="k">SOCKS 端口</div>
          <div className="v">{socks?.port ?? '—'}</div>
        </div>
      </div>
      <ChainStatus info={info} fields={['height', 'peers']} />
      {roles && !roles.ok && <p className="stat-note">角色状态读取失败：{roles.error}</p>}
      <HonestNote />
    </div>
  );
}

// ============================================================================
// 中继 —— 上线/下线开关 + 质押
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

  const toggle = useCallback(async () => {
    setBusy(true);
    setMsg({ kind: '', text: on ? '正在下线中继…' : '正在上线中继…' });
    const r = on ? await window.v0id.api.relayStop() : await window.v0id.api.relayStart();
    setBusy(false);
    setMsg(r.ok ? { kind: 'ok', text: on ? '中继已下线' : '中继已上线（描述符将在余额≥2 时自动上链发布）' } : { kind: 'err', text: r.error });
  }, [on]);

  const doStake = useCallback(async () => {
    setBusy(true);
    setMsg({ kind: '', text: `正在质押 ${role}（押金 ${STAKE_MIN[role]} $V0ID）…` });
    const r = await window.v0id.api.stake(role);
    setBusy(false);
    setMsg(r.ok ? { kind: 'ok', text: `质押已提交（txid ${r.data.txid.slice(0, 12)}…），挖进区块后锁定` } : { kind: 'err', text: r.error });
  }, [role]);

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
        中继把你的机器变成 <code>.v0id</code> 网络的一跳：转发他人电路的 cell、参与 rendezvous，
        让整张匿名网更大、更难被流量分析。中继只看到「上一跳」和「下一跳」，看不到完整路径，也读不到载荷明文。
      </p>

      {/* 上线/下线开关 + 状态 */}
      <div className="ctl-row">
        <button className={'toggle ' + (on ? 'on' : '')} onClick={toggle} disabled={busy || !roles?.ok}>
          {on ? '● 中继运行中 —— 点击下线' : '○ 中继已下线 —— 点击上线'}
        </button>
      </div>
      <div className="stat-grid">
        <div className="stat">
          <div className="k">cell 端口</div>
          <div className="v">{relay?.port ?? '—'}</div>
        </div>
        <div className="stat">
          <div className="k">活动电路</div>
          <div className="v">{relay ? relay.circuits : '—'}</div>
        </div>
        <div className="stat">
          <div className="k">描述符上链</div>
          <div className="v">{relay ? (relay.published ? '已发布' : '待发布') : '—'}</div>
        </div>
      </div>
      {relay?.address && (
        <p className="stat-note">
          中继链上身份：<code>{shortAddr(relay.address)}</code>
        </p>
      )}

      {/* 质押 */}
      <h3 className="sub-h">质押（诚实保证金）</h3>
      <p>
        中继质押 <code>$V0ID</code> 作为「诚实保证金」——作恶（丢包、审查、女巫）会被度量并罚没本金。
        押金按角色风险定档：<code>guard {STAKE_MIN.guard}</code> · <code>hsdir {STAKE_MIN.hsdir}</code> ·{' '}
        <code>middle {STAKE_MIN.middle}</code>（guard 直接看到客户端 IP，风险最高、押金最高）。
      </p>

      {!activated ? (
        <div className="gate-note">
          质押共识将于 <b>height {STAKING_ACTIVATION_HEIGHT.toLocaleString()}</b> 激活
          （当前链高 {height == null ? '读取中…' : height.toLocaleString()}）。
          在此之前 <code>STAKE|</code> 备注按普通转账处理，质押按钮已禁用以免误把押金锁进托管却不生效。
        </div>
      ) : (
        <div className="ctl-row">
          <select className="select" value={role} onChange={(e) => setRole(e.target.value)} disabled={busy}>
            <option value="guard">guard（押金 {STAKE_MIN.guard}）</option>
            <option value="hsdir">hsdir（押金 {STAKE_MIN.hsdir}）</option>
            <option value="middle">middle（押金 {STAKE_MIN.middle}）</option>
          </select>
          <button className="primary-btn" onClick={doStake} disabled={busy}>
            质押 {role}
          </button>
        </div>
      )}

      <div className="reward-note">引导期暂不发放奖励（见 INCENTIVE-PROTOCOL）。质押当前只承担「诚实保证金」职责，不产生收益。</div>

      {/* 本节点已有质押 */}
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
// 托管站点 —— 把本机服务发布成 .v0id 隐藏服务
// ============================================================================
export function HostPanel() {
  const roles = usePoll(() => window.v0id.api.roles(), 3000);
  const [target, setTarget] = useState('127.0.0.1:8080');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const hs = roles?.ok ? roles.data.hs : null;
  const on = !!hs?.on;

  const start = useCallback(async () => {
    const m = target.trim().match(/^([^:]+):(\d+)$/);
    if (!m) {
      setMsg({ kind: 'err', text: '目标格式应为 host:port，例如 127.0.0.1:8080' });
      return;
    }
    setBusy(true);
    setMsg({ kind: '', text: '正在发布隐藏服务（选引入点 / 签名 / 上 DHT，需链上 ≥3 中继）…' });
    const r = await window.v0id.api.hsStart(m[1], Number(m[2]));
    setBusy(false);
    if (r.ok) setMsg({ kind: 'ok', text: '隐藏服务已发布' });
    else if (/中继不足|≥?3|3 个/.test(r.error || '')) setMsg({ kind: 'err', text: '链上中继不足 3 个，暂无法托管（待更多 relay 上链后重试）。' });
    else setMsg({ kind: 'err', text: r.error });
  }, [target]);

  const stop = useCallback(async () => {
    setBusy(true);
    setMsg({ kind: '', text: '正在停止隐藏服务…' });
    const r = await window.v0id.api.hsStop();
    setBusy(false);
    setMsg(r.ok ? { kind: 'ok', text: '隐藏服务已停止（描述符在 HSDir 上靠 TTL 自然过期）' } : { kind: 'err', text: r.error });
  }, []);

  return (
    <div className="panel">
      <h1>托管站点</h1>
      <span className="role-tag">HIDDEN SERVICE · 发布 .v0id 隐藏服务</span>
      <p>
        把本机一个普通服务（如 <code>127.0.0.1:8080</code>）发布成 <code>.v0id</code> 隐藏服务：
        守护进程选引入点、签名并发布描述符到 DHT，访问者经 rendezvous 连进来——你不暴露任何对外 IP/端口，
        访问者也只知道那串 <code>.v0id</code> 地址、不知道你在哪台机器。
      </p>

      <div className="ctl-row">
        <input
          className="text-input"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="host:port（默认 127.0.0.1:8080）"
          spellCheck={false}
          disabled={on || busy}
        />
        {on ? (
          <button className="toggle on" onClick={stop} disabled={busy}>
            停止托管
          </button>
        ) : (
          <button className="primary-btn" onClick={start} disabled={busy || !roles?.ok}>
            发布隐藏服务
          </button>
        )}
      </div>

      {on && hs?.address && (
        <div className="addr-box">
          <div className="k">你的 .v0id 地址（分享给访问者）</div>
          <div className="addr-val">
            <code>{hs.address}</code>
            <CopyBtn text={hs.address} />
          </div>
          {hs.target && (
            <div className="dim">→ 转发到本机 {hs.target.host}:{hs.target.port}</div>
          )}
        </div>
      )}

      <ActionMsg msg={msg} />
      {roles && !roles.ok && <p className="stat-note">角色状态读取失败：{roles.error}</p>}
      <HonestNote />
    </div>
  );
}

// ============================================================================
// 链 · 挖矿 —— 链状态 + 挖矿开关
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
        <input
          className="text-input narrow"
          value={interval}
          onChange={(e) => setIntervalMs(e.target.value)}
          placeholder="出块间隔(ms)"
          spellCheck={false}
          disabled={on || busy}
          title="两次出块尝试之间的间隔，毫秒；0 = 连续挖"
        />
        <span className="dim">ms 间隔（0=连续）</span>
        <button className={'toggle ' + (on ? 'on' : '')} onClick={toggle} disabled={busy || !roles?.ok}>
          {on ? '● 挖矿中 —— 点击停止' : '○ 未挖矿 —— 点击开始'}
        </button>
      </div>
      {on && mine && (
        <p className="stat-note">当前间隔：{mine.intervalMs === 0 ? '连续' : mine.intervalMs + 'ms'}</p>
      )}

      <ActionMsg msg={msg} />
      {roles && !roles.ok && <p className="stat-note">角色状态读取失败：{roles.error}</p>}
    </div>
  );
}

// ============================================================================
// 钱包 —— 节点托管钱包：地址 / 余额 / 转账 / 收款
// ============================================================================
// 注：与 game-web 的「自托管钱包」（私钥存浏览器、本地签名）不同——桌面端钱包是**节点托管**：
// 守护进程持有钱包，转账经 Bearer 门控的 /send 由守护签名广播；渲染层只发指令、不接触私钥/令牌。
export function WalletPanel() {
  const wallet = usePoll(() => window.v0id.api.walletInfo(), 4000);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const ok = wallet?.ok;
  const address = ok ? wallet.data.address : null;
  const balance = ok ? wallet.data.balance : null;
  const symbol = (ok && wallet.data.symbol) || '$V0ID';

  const doSend = useCallback(async () => {
    const amt = Number(amount);
    if (!to.trim()) {
      setMsg({ kind: 'err', text: '请填写收款地址' });
      return;
    }
    if (!Number.isFinite(amt) || amt <= 0) {
      setMsg({ kind: 'err', text: '金额须为正数' });
      return;
    }
    setBusy(true);
    setMsg({ kind: '', text: '正在提交转账…' });
    const r = await window.v0id.api.send(to.trim(), amt, memo);
    setBusy(false);
    if (r.ok) {
      setMsg({ kind: 'ok', text: `已提交（txid ${r.data.txid.slice(0, 12)}…），挖进区块后到账` });
      setTo('');
      setAmount('');
      setMemo('');
    } else {
      setMsg({ kind: 'err', text: r.error });
    }
  }, [to, amount, memo]);

  return (
    <div className="panel">
      <h1>钱包</h1>
      <span className="role-tag">WALLET · $V0ID 余额与地址</span>
      <p>
        <code>$V0ID</code> 是网络的原生代币：支付手续费、质押中继保证金、参与链上社交（昵称 / 私信 / 红包）都用它。
        本钱包由守护进程托管（私钥在节点数据目录，**永不**经渲染层）。
      </p>

      {wallet === undefined ? (
        <p className="stat-note">读取钱包中…</p>
      ) : !ok ? (
        <p className="stat-note">钱包不可用：{wallet.error}</p>
      ) : (
        <>
          {/* 收款：地址 + 复制 */}
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
            <button className="primary-btn" onClick={doSend} disabled={busy}>
              发送
            </button>
          </div>
          <p className="stat-note">手续费按金额自动计算（最低 {ok && wallet.data.minFee != null ? wallet.data.minFee : '—'}）。转账由守护进程签名广播。</p>
        </>
      )}

      <ActionMsg msg={msg} />
    </div>
  );
}
