// 五个占位板块（浏览客户端 / 中继 / 托管站点 / 链·挖矿 / 钱包）。
//
// 本阶段（2F-2）目标：把外壳填满、可导航——每个板块说明它的角色/职责，
// 并（凡是便宜的地方）展示从 GET /info 拉来的只读状态（链高/对等等），
// 外加一条「运行时开关与质押/钱包接线在下一阶段 (E)」的明确提示。
// 不在此实现任何开关/质押/钱包动作（那是任务 E）。
import React from 'react';
import { useInfo } from '../useInfo.js';

// ---- 只读状态条（链高/对等）。info===undefined 加载中；null 不可用（外部 SOCKS / 节点未起）。----
function ChainStatus({ info, fields }) {
  if (info === undefined) return <p className="stat-note">读取链状态中…</p>;
  if (info === null)
    return (
      <p className="stat-note">
        链状态不可用（当前可能处于外部 SOCKS 验证模式，或本机节点 API 尚未就绪）。
      </p>
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

function NextPhaseE({ what }) {
  return (
    <div className="next-phase">
      <b>下一阶段 (E)：</b>
      {what}
    </div>
  );
}

// ---- 浏览客户端 ----
export function ClientPanel() {
  const info = useInfo();
  return (
    <div className="panel">
      <h1>浏览客户端</h1>
      <span className="role-tag">CLIENT · 出口匿名访问者</span>
      <p>
        你正在以「客户端」身份运行：本机守护进程通过三跳洋葱电路把你的请求送出，沿途中继逐跳剥离一层加密，
        没有任何单一节点同时知道「你是谁」和「你在访问什么」。访问 <code>.v0id</code> 隐藏服务时走 rendezvous
        会合，连双方的 IP 都互相不可见。
      </p>
      <p>这正是「浏览器」板块每个标签页背后用的能力——客户端是默认、零质押的角色。</p>
      <ChainStatus info={info} fields={['height', 'peers']} />
      <NextPhaseE what="客户端运行时开关（入口守卫策略、mixnet 延迟模式、电路重建）将在角色页接入并可视化。" />
    </div>
  );
}

// ---- 中继 ----
export function RelayPanel() {
  const info = useInfo();
  return (
    <div className="panel">
      <h1>中继</h1>
      <span className="role-tag">RELAY · 为网络转发流量</span>
      <p>
        中继把你的机器变成 <code>.v0id</code> 网络的一跳：转发他人电路的 cell、参与 rendezvous，
        让整张匿名网更大、更难被流量分析。中继只看到「上一跳」和「下一跳」，看不到电路的完整路径，也读不到载荷明文。
      </p>
      <p>
        中继需要在链上发布描述符（地址 / 洋葱公钥 / 带宽）并质押 <code>$V0ID</code> 作为「诚实保证金」——
        作恶（如丢包、审查、女巫攻击）会被测量并罚没。质押与上线开关属于运行时操作。
      </p>
      <ChainStatus info={info} fields={['height', 'peers']} />
      <NextPhaseE what="中继上线/下线开关、链上描述符发布、质押额度与罚没看板将在中继板块接入（含 3A-5 激励层）。" />
    </div>
  );
}

// ---- 托管站点 ----
export function HostPanel() {
  return (
    <div className="panel">
      <h1>托管站点</h1>
      <span className="role-tag">HIDDEN SERVICE · 发布 .v0id 隐藏服务</span>
      <p>
        把你本机的一个普通服务（如 <code>127.0.0.1:8080</code>）发布成一个 <code>.v0id</code> 隐藏服务：
        守护进程选取引入点、签名并发布描述符到 DHT，访问者经 rendezvous 连进来——你不暴露任何对外 IP/端口，
        访问者也只知道那串 <code>.v0id</code> 地址、不知道你在哪台机器。
      </p>
      <p>
        命令行已可托管（<code>v0id start --hs-target 127.0.0.1:8080 …</code>，见 VERIFY 进阶一节）。
        本板块未来把它做成图形化：选择本地目标、生成/管理地址、查看描述符发布状态。
      </p>
      <NextPhaseE what="图形化托管（选本地目标端口、生成与保存 .v0id 地址、描述符发布/续期状态）将在托管板块接入。" />
    </div>
  );
}

// ---- 链·挖矿 ----
export function ChainPanel() {
  const info = useInfo();
  return (
    <div className="panel">
      <h1>链 · 挖矿</h1>
      <span className="role-tag">CHAIN · v0idchain 主链</span>
      <p>
        <code>.v0id</code> 网络的信任根是 v0idchain：中继目录、质押、隐藏服务描述符的锚点都在链上。
        守护进程内嵌一个全节点，与种子对等同步。下面是它的只读状态：
      </p>
      <ChainStatus info={info} fields={['height', 'blocks', 'peers', 'mempool', 'balance', 'syncing']} />
      <p className="stat-note">
        以上为只读快照（每 5 秒刷新一次）。挖矿是把算力投向链、获得 <code>$V0ID</code> 出块奖励的过程。
      </p>
      <NextPhaseE what="本机挖矿开关、出块/收益看板、转账与水龙头将在链板块与钱包页接入。" />
    </div>
  );
}

// ---- 钱包 ----
export function WalletPanel() {
  const info = useInfo();
  return (
    <div className="panel">
      <h1>钱包</h1>
      <span className="role-tag">WALLET · $V0ID 余额与地址</span>
      <p>
        <code>$V0ID</code> 是网络的原生代币：支付手续费、质押中继保证金、参与链上社交（昵称 / 私信 / 红包）都用它。
        守护进程持有本节点钱包，下面是只读的地址与余额：
      </p>
      <ChainStatus info={info} fields={['address', 'balance', 'burned']} />
      <NextPhaseE what="转账 / 收款二维码 / 导入导出私钥 / 质押划转等钱包动作将在钱包页接入（写操作，本阶段不做）。" />
    </div>
  );
}
