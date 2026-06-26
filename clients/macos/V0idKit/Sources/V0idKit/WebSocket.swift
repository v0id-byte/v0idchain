// 最小 WebSocket 客户端，建立在裸 POSIX socket 之上（RFC 6455 客户端子集）。
//
// 为什么不用 URLSession / NWConnection：两者都尊重系统 HTTP/SOCKS 代理
// （macOS 上 Clash/mihomo 的 127.0.0.1:7897）。ws:// 的 HTTP Upgrade 会被
// 当成普通 HTTP 流量送进代理隧道，代理不稳定时连接随即断开（日志里大量
// "127.0.0.1:7897 … Socket is not connected"）。`connectionProxyDictionary`
// 改键、换 NWConnection 都无法关闭这层代理。
//
// 裸 socket 的 connect() 直接进内核 TCP 栈，系统代理配置（SCDynamicStore）
// 只被 CFNetwork / Network.framework 读取，管不到 socket 层 —— 因此能真正直连。
// 注意 TUN 模式：TUN 在内核 IP 层路由所有流量，POSIX socket 也会经过 TUN。对可达目标是透明的；
// 但 TUN 代理后端访问不到的目标，有些代理实现（如 Clash/mihomo HTTP 后端）会先完成 TCP 握手再
// 返回 HTTP 502/504，而非 RST——于是 connect() 成功而握手在应用层失败。这是 TUN 代理的固有
// 行为，NodeClient 以此区分 bootstrap 种子（失败→真错误）和 gossip peer（失败→正常 P2P 现象）。
//
// 仅支持 ws://（明文）。当前所有种子都是 ws://；wss:// 需 TLS，留待生产化。
import Foundation
import Darwin

final class WebSocketConn: @unchecked Sendable {
    private let host: String
    private let port: UInt16
    private let queue: DispatchQueue
    private let lock = NSLock()

    private var fd: Int32 = -1
    private var running = false
    private var closed = false

    // 回调在专属 queue 上触发；调用方需自行跳回所需的隔离域。
    var onOpen:  (@Sendable () -> Void)?
    var onText:  (@Sendable (String) -> Void)?
    var onClose: (@Sendable (String?) -> Void)?   // 参数为错误描述（nil = 正常关闭）

    init(host: String, port: UInt16) {
        self.host = host
        self.port = port
        self.queue = DispatchQueue(label: "v0id.ws.\(host).\(port)", qos: .utility)
    }

    func start() {
        lock.lock(); running = true; lock.unlock()
        queue.async { [weak self] in self?.run() }
    }

    /// 关闭连接（幂等）。close(fd) 会让阻塞中的 recv 立即返回，读循环随之退出。
    func close() {
        lock.lock()
        running = false
        let f = fd; fd = -1
        lock.unlock()
        if f >= 0 { Darwin.close(f) }
    }

    func sendText(_ s: String) {
        sendFrame(opcode: 0x1, payload: Array(s.utf8))
    }

    // ---- 主流程（在专属 queue 上跑）----
    private func run() {
        guard let s = connectSocket(timeoutSec: 10) else {
            finish("无法直连 \(host):\(port)（已绕过系统代理）")
            return
        }
        lock.lock()
        guard running else { lock.unlock(); Darwin.close(s); return }
        fd = s
        lock.unlock()

        guard let leftover = handshake(s) else {
            finish("WebSocket 握手失败 \(host):\(port)")
            return
        }
        onOpen?()
        let err = readLoop(s, seed: leftover)
        finish(err)
    }

    private func finish(_ error: String?) {
        lock.lock()
        if closed { lock.unlock(); return }
        closed = true
        let f = fd; fd = -1
        running = false
        lock.unlock()
        if f >= 0 { Darwin.close(f) }
        onClose?(error)
    }

    // ---- 连接（非阻塞 connect + poll 超时）----
    private func connectSocket(timeoutSec: TimeInterval) -> Int32? {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = SOCK_STREAM
        hints.ai_protocol = IPPROTO_TCP
        var res: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, String(port), &hints, &res) == 0, let head = res else { return nil }
        defer { freeaddrinfo(res) }

        var ai: UnsafeMutablePointer<addrinfo>? = head
        while let cur = ai {
            let s = socket(cur.pointee.ai_family, cur.pointee.ai_socktype, cur.pointee.ai_protocol)
            if s >= 0 {
                let flags = fcntl(s, F_GETFL, 0)
                _ = fcntl(s, F_SETFL, flags | O_NONBLOCK)
                var one: Int32 = 1
                setsockopt(s, IPPROTO_TCP, TCP_NODELAY, &one, socklen_t(MemoryLayout<Int32>.size))

                let cr = connect(s, cur.pointee.ai_addr, cur.pointee.ai_addrlen)
                if cr == 0 {
                    _ = fcntl(s, F_SETFL, flags)
                    return s
                }
                if errno == EINPROGRESS {
                    var pfd = pollfd(fd: s, events: Int16(POLLOUT), revents: 0)
                    if poll(&pfd, 1, Int32(timeoutSec * 1000)) > 0,
                       (pfd.revents & Int16(POLLOUT)) != 0 {
                        var soerr: Int32 = 0
                        var len = socklen_t(MemoryLayout<Int32>.size)
                        getsockopt(s, SOL_SOCKET, SO_ERROR, &soerr, &len)
                        if soerr == 0 {
                            _ = fcntl(s, F_SETFL, flags)
                            return s
                        }
                    }
                }
                Darwin.close(s)
            }
            ai = cur.pointee.ai_next
        }
        return nil
    }

    // ---- 握手：发 Upgrade 请求 → 读到 101 → 返回响应头之后多读到的字节（首批 WS 帧）----
    private func handshake(_ s: Int32) -> [UInt8]? {
        var keyBytes = [UInt8](repeating: 0, count: 16)
        for i in 0..<16 { keyBytes[i] = UInt8.random(in: 0...255) }
        let key = Data(keyBytes).base64EncodedString()
        // 不带 Sec-WebSocket-Extensions → 服务端不会启用 permessage-deflate，免去解压。
        let req = """
        GET / HTTP/1.1\r
        Host: \(host):\(port)\r
        Upgrade: websocket\r
        Connection: Upgrade\r
        Sec-WebSocket-Key: \(key)\r
        Sec-WebSocket-Version: 13\r
        \r

        """
        guard sendAll(s, Array(req.utf8)) else { return nil }

        var buf = [UInt8]()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = recv(s, &chunk, chunk.count, 0)
            if n <= 0 { return nil }
            buf.append(contentsOf: chunk[0..<n])
            if let end = findHeaderEnd(buf) {
                let header = String(decoding: buf[0..<end], as: UTF8.self)
                guard header.contains(" 101 ") || header.uppercased().contains("101 SWITCHING") else { return nil }
                return Array(buf[(end + 4)...])   // \r\n\r\n 之后的字节属于 WS 帧
            }
            if buf.count > 16 * 1024 { return nil }   // 响应头异常巨大 → 放弃
        }
    }

    private func findHeaderEnd(_ b: [UInt8]) -> Int? {
        guard b.count >= 4 else { return nil }
        var i = 0
        while i <= b.count - 4 {
            if b[i] == 0x0d && b[i+1] == 0x0a && b[i+2] == 0x0d && b[i+3] == 0x0a { return i }
            i += 1
        }
        return nil
    }

    // ---- 读循环：解析 WS 帧，处理分片/控制帧 ----
    private func readLoop(_ s: Int32, seed: [UInt8]) -> String? {
        var inbuf = seed
        var fragOpcode: UInt8 = 0
        var fragData = [UInt8]()
        var chunk = [UInt8](repeating: 0, count: 65536)

        func drain() -> Bool {   // 解析 inbuf 中所有完整帧；返回 false = 需正常关闭
            while let (fin, opcode, payload, consumed) = parseFrame(inbuf) {
                inbuf.removeFirst(consumed)
                switch opcode {
                case 0x0, 0x1, 0x2:   // 续帧 / 文本 / 二进制
                    if opcode == 0x0 { fragData.append(contentsOf: payload) }
                    else { fragOpcode = opcode; fragData = payload }
                    if fin {
                        if fragOpcode == 0x1 { onText?(String(decoding: fragData, as: UTF8.self)) }
                        fragData = []; fragOpcode = 0
                    }
                case 0x8: return false                       // close
                case 0x9: sendFrame(opcode: 0xA, payload: payload)   // ping → pong
                default: break                               // 0xA pong 等
                }
            }
            return true
        }

        if !drain() { return nil }   // seed 里可能已含完整帧
        while true {
            lock.lock(); let alive = running; lock.unlock()
            if !alive { return nil }
            let n = recv(s, &chunk, chunk.count, 0)
            if n == 0 { return nil }                         // 对端关闭
            if n < 0 {
                lock.lock(); let stopping = !running; lock.unlock()
                return stopping ? nil : "连接中断 \(host):\(port)"
            }
            inbuf.append(contentsOf: chunk[0..<n])
            if !drain() { return nil }
        }
    }

    /// 解析一个完整帧；不足则返回 nil。服务端→客户端帧按 RFC 不带掩码，但仍兼容处理。
    private func parseFrame(_ b: [UInt8]) -> (fin: Bool, opcode: UInt8, payload: [UInt8], consumed: Int)? {
        guard b.count >= 2 else { return nil }
        let fin = (b[0] & 0x80) != 0
        let opcode = b[0] & 0x0f
        let masked = (b[1] & 0x80) != 0
        var len = Int(b[1] & 0x7f)
        var off = 2
        if len == 126 {
            guard b.count >= 4 else { return nil }
            len = (Int(b[2]) << 8) | Int(b[3]); off = 4
        } else if len == 127 {
            guard b.count >= 10 else { return nil }
            len = 0
            for i in 0..<8 { len = (len << 8) | Int(b[2 + i]) }
            off = 10
        }
        var mask = [UInt8]()
        if masked {
            guard b.count >= off + 4 else { return nil }
            mask = Array(b[off..<off+4]); off += 4
        }
        guard b.count >= off + len else { return nil }
        var payload = Array(b[off..<off+len])
        if masked { for i in 0..<payload.count { payload[i] ^= mask[i % 4] } }
        return (fin, opcode, payload, off + len)
    }

    // ---- 发送：客户端帧必须带掩码 ----
    private func sendFrame(opcode: UInt8, payload: [UInt8]) {
        var frame = [UInt8]()
        frame.append(0x80 | opcode)   // FIN + opcode
        let len = payload.count
        if len < 126 {
            frame.append(0x80 | UInt8(len))
        } else if len <= 0xFFFF {
            frame.append(0x80 | 126)
            frame.append(UInt8((len >> 8) & 0xff))
            frame.append(UInt8(len & 0xff))
        } else {
            frame.append(0x80 | 127)
            for i in (0..<8).reversed() { frame.append(UInt8((len >> (8 * i)) & 0xff)) }
        }
        var mask = [UInt8](repeating: 0, count: 4)
        for i in 0..<4 { mask[i] = UInt8.random(in: 0...255) }
        frame.append(contentsOf: mask)
        frame.reserveCapacity(frame.count + len)
        for i in 0..<len { frame.append(payload[i] ^ mask[i % 4]) }

        lock.lock(); let f = fd; lock.unlock()
        guard f >= 0 else { return }
        _ = sendAll(f, frame)
    }

    /// 全量写：send() 可能短写，循环直至写完或出错。多线程写以 lock 串行化防止帧交错。
    private let writeLock = NSLock()
    @discardableResult
    private func sendAll(_ s: Int32, _ bytes: [UInt8]) -> Bool {
        writeLock.lock(); defer { writeLock.unlock() }
        var sent = 0
        return bytes.withUnsafeBytes { raw -> Bool in
            let base = raw.baseAddress!
            while sent < bytes.count {
                let n = Darwin.send(s, base + sent, bytes.count - sent, 0)
                if n <= 0 {
                    if n < 0 && errno == EINTR { continue }
                    return false
                }
                sent += n
            }
            return true
        }
    }
}
