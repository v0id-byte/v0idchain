// 传输无关连接句柄：让 P2P 的收发逻辑同时适配 WebSocket 与（Stage 1）WebRTC DataChannel。
// 设计见 docs/WEBRTC-MESH-DESIGN.md §3.1。本文件 Stage 0 只含 Conn 抽象 + WS 实现，零行为变化。
import { WebSocket } from 'ws';
import type { P2PMessage } from './p2p.js';

/**
 * 一条对等连接的统一句柄。P2P 只通过它收发 JSON 帧，不关心底层是 ws 还是 rtc。
 * `handle()` 的消息分发因此 transport-agnostic：换传输只需换出产 Conn 的工厂。
 */
export interface Conn {
  readonly kind: 'ws' | 'rtc';
  /** 对端 peerId = 其 ed25519 钱包地址（HELLO.address）；学到前为 ''。用于 §3.3 信令 1-hop 中继寻址。 */
  id: string;
  send(msg: P2PMessage): void;
  close(): void;
  isOpen(): boolean;
}

/** 把一条 ws.WebSocket 包成 Conn。事件（message/close/error）仍由 P2P.setupSocket 在原始 ws 上挂接。 */
export class WsConn implements Conn {
  readonly kind = 'ws' as const;
  id = '';
  constructor(readonly ws: WebSocket) {}
  send(msg: P2PMessage): void {
    // 与重构前 P2P.send 逐字节一致：仅在 OPEN 时发送，序列化为 JSON 文本帧。
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
  close(): void {
    this.ws.close();
  }
  isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }
}
