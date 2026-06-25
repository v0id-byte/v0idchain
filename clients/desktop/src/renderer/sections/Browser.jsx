// 「浏览器」板块 —— 真正可用的多标签 .v0id 浏览器。
//
// 每个标签 = 一个 <webview partition="v0id">（共享同一个 SOCKS 代理会话；内存型、不落盘）。
// 非活动标签用 CSS 隐藏、不销毁（保留其会话状态）。导航条驱动「当前」webview。
//
// 安全：所有 webview 都在 'v0id' partition（无 persist 前缀），main.js 已对它 setProxy(socks5://…) +
// deny-all 权限 + WebRTC 加固 + 拒绝弹窗；webview 无 Node、无 preload。地址校验经 window.v0id.validate
//（主进程的 normalizeTarget）。书签经 window.v0id.bookmarks.*（主进程文件 I/O）。浏览历史默认不落盘。
import React, { useCallback, useEffect, useRef, useState } from 'react';

let TAB_SEQ = 1;
const newTab = () => ({
  id: TAB_SEQ++,
  // 输入框里的地址（受控）；与已加载的 url 分开，便于「正在编辑但没回车」。
  input: '',
  url: null, // 已请求加载的规整 URL；null = 停在起始页
  title: '新标签页',
  loading: false,
  error: null, // { code, desc }
  canBack: false,
  canForward: false,
  ready: false, // webview 是否已 dom-ready（之前调导航方法会抛）
});

// 安全调用 webview 方法：未 attach/dom-ready 时这些方法会抛，统一吞掉（只读导航控制，失败无副作用）。
function safeCall(el, fn) {
  try {
    return fn(el);
  } catch {
    return undefined;
  }
}

export function Browser({ status }) {
  const [tabs, setTabs] = useState(() => [newTab()]);
  const [activeId, setActiveId] = useState(() => tabs[0].id);
  const [bookmarks, setBookmarks] = useState([]);
  // 会话内最近访问（不持久化、不写盘——隐私默认关历史）。
  const [recent, setRecent] = useState([]);
  // demo 地址提示（外部 SOCKS 模式下有意义；这里仅作引导文案，不硬编码任何真实地址）。
  const externalMode = status.external;

  // webview DOM 引用：id -> element
  const viewRefs = useRef(new Map());
  const setViewRef = useCallback((id, el) => {
    if (el) viewRefs.current.set(id, el);
    else viewRefs.current.delete(id);
  }, []);

  const activeTab = tabs.find((t) => t.id === activeId) || tabs[0];

  // ---- 载入书签 ----
  const reloadBookmarks = useCallback(async () => {
    if (!window.v0id?.bookmarks) return;
    try {
      const list = await window.v0id.bookmarks.list();
      setBookmarks(Array.isArray(list) ? list : []);
    } catch {
      setBookmarks([]);
    }
  }, []);
  useEffect(() => {
    reloadBookmarks();
  }, [reloadBookmarks]);

  // ---- 更新某个 tab 的字段 ----
  const patchTab = useCallback((id, patch) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  // ---- 给一个 webview 绑定事件（加载/失败/标题/导航态）。返回解绑函数。----
  const bindEvents = useCallback(
    (id, el) => {
      const onReady = () => patchTab(id, { ready: true });
      const onStart = () => patchTab(id, { loading: true, error: null });
      const onStop = () => {
        patchTab(id, {
          loading: false,
          canBack: safeCall(el, (e) => e.canGoBack()) ?? false,
          canForward: safeCall(el, (e) => e.canGoForward()) ?? false,
        });
      };
      const onTitle = (e) => {
        if (e.title) patchTab(id, { title: e.title });
      };
      const onFail = (e) => {
        // -3 = ABORTED（正常的重定向/取消），不当错误。
        if (e.errorCode === -3) return;
        // 只关心主框架失败（isMainFrame 为 false 的子资源失败不弹整页错误）。
        if (e.isMainFrame === false) return;
        patchTab(id, {
          loading: false,
          error: { code: e.errorCode, desc: e.errorDescription || '' },
        });
      };
      const onNav = (e) => {
        // 页面内导航（含 SPA pushState）后刷新地址与前进/后退态。
        if (e.url && !e.url.startsWith('about:')) {
          patchTab(id, {
            input: e.url,
            url: e.url,
            canBack: safeCall(el, (x) => x.canGoBack()) ?? false,
            canForward: safeCall(el, (x) => x.canGoForward()) ?? false,
          });
        }
      };
      el.addEventListener('dom-ready', onReady);
      el.addEventListener('did-start-loading', onStart);
      el.addEventListener('did-stop-loading', onStop);
      el.addEventListener('page-title-updated', onTitle);
      el.addEventListener('did-fail-load', onFail);
      el.addEventListener('did-navigate', onNav);
      el.addEventListener('did-navigate-in-page', onNav);
      return () => {
        el.removeEventListener('dom-ready', onReady);
        el.removeEventListener('did-start-loading', onStart);
        el.removeEventListener('did-stop-loading', onStop);
        el.removeEventListener('page-title-updated', onTitle);
        el.removeEventListener('did-fail-load', onFail);
        el.removeEventListener('did-navigate', onNav);
        el.removeEventListener('did-navigate-in-page', onNav);
      };
    },
    [patchTab],
  );

  // 为每个存在的 tab 绑定/解绑事件（依赖 tab id 列表）。
  const tabIds = tabs.map((t) => t.id).join(',');
  useEffect(() => {
    const cleanups = [];
    for (const t of tabs) {
      const el = viewRefs.current.get(t.id);
      if (el) cleanups.push(bindEvents(t.id, el));
    }
    return () => cleanups.forEach((fn) => fn && fn());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabIds, bindEvents]);

  // ---- 导航到地址（校验 → 设 webview.src）----
  const navigate = useCallback(
    async (rawAddr, targetId = activeId) => {
      const raw = (rawAddr ?? '').trim();
      if (!raw) return;
      const r = await window.v0id.validate(raw);
      if (!r.ok) {
        patchTab(targetId, { error: { code: 'addr', desc: r.error }, loading: false });
        return;
      }
      patchTab(targetId, { url: r.url, input: r.url, error: null, loading: true, title: r.url });
      setRecent((prev) => {
        const next = [r.url, ...prev.filter((u) => u !== r.url)];
        return next.slice(0, 30);
      });
      // 设 src：webview 经 'v0id' partition 的 SOCKS5 代理发起请求（命令式赋值 = 导航单一真相源）。
      const el = viewRefs.current.get(targetId);
      if (el) el.src = r.url;
    },
    [activeId, patchTab],
  );

  // ---- 工具条动作（全部经 safeCall：webview 未就绪时这些方法会抛）----
  const goBack = () => {
    const el = viewRefs.current.get(activeId);
    if (el && safeCall(el, (e) => e.canGoBack())) safeCall(el, (e) => e.goBack());
  };
  const goForward = () => {
    const el = viewRefs.current.get(activeId);
    if (el && safeCall(el, (e) => e.canGoForward())) safeCall(el, (e) => e.goForward());
  };
  const reload = () => {
    const el = viewRefs.current.get(activeId);
    if (el && activeTab.url) safeCall(el, (e) => e.reload());
  };
  const stop = () => {
    const el = viewRefs.current.get(activeId);
    if (el) safeCall(el, (e) => e.stop());
  };

  // ---- 标签管理 ----
  const addTab = () => {
    const t = newTab();
    setTabs((prev) => [...prev, t]);
    setActiveId(t.id);
  };
  const closeTab = (id) => {
    // 用函数式 setState，让连续多次关闭（快速点击）基于最新状态组合，避免读到闭包里的旧 tabs。
    let nextActive = null; // 需要切换的新 activeId（若关的是当前标签）
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev; // 已经被关掉了
      const left = prev.filter((t) => t.id !== id);
      if (left.length === 0) {
        const fresh = newTab();
        nextActive = fresh.id;
        return [fresh];
      }
      // 关的是当前标签 → 激活它左边一个（没有则第一个）。
      if (id === activeId) nextActive = left[Math.max(0, idx - 1)].id;
      return left;
    });
    if (nextActive != null) setActiveId(nextActive);
  };

  // ---- 书签：当前页是否已收藏 / 切换 ----
  const isBookmarked = activeTab.url && bookmarks.some((b) => b.url === activeTab.url);
  const toggleBookmark = async () => {
    if (!activeTab.url || !window.v0id?.bookmarks) return;
    try {
      const res = isBookmarked
        ? await window.v0id.bookmarks.remove(activeTab.url)
        : await window.v0id.bookmarks.add({ url: activeTab.url, title: activeTab.title });
      if (res && Array.isArray(res.list)) setBookmarks(res.list);
      else reloadBookmarks();
    } catch {
      reloadBookmarks();
    }
  };
  const removeBookmark = async (url) => {
    try {
      const res = await window.v0id.bookmarks.remove(url);
      if (res && Array.isArray(res.list)) setBookmarks(res.list);
    } catch {
      reloadBookmarks();
    }
  };

  // 地址栏受控输入
  const onAddrChange = (e) => patchTab(activeId, { input: e.target.value });
  const onAddrKey = (e) => {
    if (e.key === 'Enter') navigate(activeTab.input);
  };

  const showStart = !activeTab.url && !activeTab.error;
  const showError = !!activeTab.error;

  return (
    <div className="browser">
      {/* 标签条 */}
      <div className="tabstrip">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={'tab' + (t.id === activeId ? ' active' : '')}
            onClick={() => setActiveId(t.id)}
            title={t.url || '新标签页'}
          >
            {t.loading && <span className="tab-spin" />}
            <span className="tab-title">{t.title || '新标签页'}</span>
            <span
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            >
              ✕
            </span>
          </div>
        ))}
        <button className="tab-new" onClick={addTab} title="新标签页">
          +
        </button>
      </div>

      {/* 导航 / 地址栏 */}
      <div className="navbar">
        <button className="nav-btn" onClick={goBack} disabled={!activeTab.canBack} title="后退">
          ‹
        </button>
        <button className="nav-btn" onClick={goForward} disabled={!activeTab.canForward} title="前进">
          ›
        </button>
        <button
          className="nav-btn"
          onClick={activeTab.loading ? stop : reload}
          disabled={!activeTab.url && !activeTab.loading}
          title={activeTab.loading ? '停止' : '刷新'}
        >
          {activeTab.loading ? '✕' : '⟲'}
        </button>
        <input
          className="addr"
          value={activeTab.input}
          onChange={onAddrChange}
          onKeyDown={onAddrKey}
          placeholder="xxxxx.v0id 或 http(s):// 链接"
          spellCheck={false}
          autoComplete="off"
        />
        <button
          className={'star' + (isBookmarked ? ' on' : '')}
          onClick={toggleBookmark}
          disabled={!activeTab.url}
          title={isBookmarked ? '取消收藏' : '收藏'}
        >
          {isBookmarked ? '★' : '☆'}
        </button>
      </div>

      {/* webview 舞台：每个 tab 一个 webview，非活动的 CSS 隐藏 */}
      <div className="stage">
        {tabs.map((t) => (
          <webview
            key={t.id}
            ref={(el) => setViewRef(t.id, el)}
            className={t.id === activeId ? '' : 'hidden'}
            // partition 必须与 main.js 的 PARTITION 完全一致（'v0id'，内存型、无 persist 前缀），
            // 这样 main.js 给这个 session 设的 SOCKS 代理 + deny-all 权限 + WebRTC 加固才作用到它身上。
            partition="v0id"
            // src 用常量 about:blank：① 保证 webview 可靠 attach 并触发 dom-ready（否则导航方法会抛
            //「must be attached … before this method」）；② 常量 prop → React 重渲染时不会回写 src，
            // 故后续 navigate() 的 el.src 命令式赋值是单一真相源、不被覆盖。起始页用本地 DOM 面板覆盖呈现。
            src="about:blank"
          />
        ))}

        {/* 起始页（仅当前 tab 没有 url 且无错误时显示，覆盖在 webview 之上） */}
        {showStart && (
          <StartPage
            bookmarks={bookmarks}
            recent={recent}
            externalMode={externalMode}
            onOpen={(url) => navigate(url)}
            onRemoveBookmark={removeBookmark}
          />
        )}

        {/* 错误覆盖层 */}
        {showError && (
          <div className="overlay">
            <h2>{activeTab.error.code === 'addr' ? '地址无效' : '连不上该 .v0id 服务'}</h2>
            {activeTab.error.code === 'addr' ? (
              <p>{activeTab.error.desc}</p>
            ) : (
              <>
                <p>未发布 / 取不到描述符 / 守护未就绪 / 链上中继不足。</p>
                <p className="mono-err">
                  ({activeTab.error.code} {activeTab.error.desc})
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {/* 底部状态行：沿用守护阶段 + 链高 */}
      <div className="statusbar">
        <span className={'dot ' + (status.socksReady ? 'ready' : status.phase === 'error' ? 'err' : '')} />
        <span className={status.phase === 'error' ? 'err-text' : 'phase'}>{status.phaseText}</span>
        {status.chain && (
          <span>
            {status.chain.syncing ? '同步中 · ' : ''}链高 {status.chain.height} · 对等 {status.chain.peers}
          </span>
        )}
      </div>
    </div>
  );
}

// ---- 新标签起始页：书签 + 诚实空态/引导（不硬编码任何假 .v0id 地址）----
function StartPage({ bookmarks, recent, externalMode, onOpen, onRemoveBookmark }) {
  return (
    <div className="startpage">
      <div className="sp-logo">.v0id</div>
      <div className="sp-tag">匿名 · 去中心 · 隐藏服务浏览器</div>

      <h3>书签</h3>
      {bookmarks.length === 0 ? (
        <div className="empty">
          还没有书签。访问一个 <code>.v0id</code> 地址后，点地址栏右侧的 <b>☆</b> 即可收藏到这里。
        </div>
      ) : (
        <div className="bm-list">
          {bookmarks.map((b) => (
            <div className="bm-card" key={b.url} onClick={() => onOpen(b.url)} title={b.url}>
              <span
                className="bm-del"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveBookmark(b.url);
                }}
              >
                ✕
              </span>
              <div className="bm-title">{b.title || b.url}</div>
              <div className="bm-url">{b.url}</div>
            </div>
          ))}
        </div>
      )}

      <h3>开始浏览</h3>
      <div className="empty">
        在上方地址栏输入一个 <code>xxxxx.v0id</code> 隐藏服务地址（或普通 http(s) 链接）回车。
        目前还没有公开的 <code>.v0id</code> 站点目录——地址需要由站点托管者分享给你。
        要先体验，可按 <code>VERIFY.md</code> 跑一个本地 demo 隐藏服务，用它打印出的地址访问。
        {externalMode && (
          <div className="hint-demo">
            <b>外部 SOCKS 验证模式已启用。</b> 把你在 <code>demo-network.mjs</code> 终端里看到的那个{' '}
            <code>.v0id</code> 地址粘到地址栏回车，即可访问本地 demo 隐藏服务。
          </div>
        )}
      </div>

      {recent.length > 0 && (
        <>
          <h3>本次会话最近访问（不保存）</h3>
          <ul className="recent">
            {recent.map((u) => (
              <li key={u} onClick={() => onOpen(u)} title={u}>
                {u}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
