// 回归：节点地址必须规范化成 ws/wss，否则 URLSessionWebSocketTask 会抛 ObjC 异常崩溃。
import XCTest
@testable import V0idKit

final class NodeClientURLTests: XCTestCase {
    func testNormalization() {
        // 合法 ws/wss 原样通过
        XCTAssertEqual(NodeClient.normalizedWebSocketURL("ws://mc.void1211.com:6001")?.absoluteString,
                       "ws://mc.void1211.com:6001")
        XCTAssertEqual(NodeClient.normalizedWebSocketURL("wss://example.com")?.scheme, "wss")

        // 没写 scheme → 自动补 ws://（最常见的崩溃诱因：用户直接填 host:port）
        XCTAssertEqual(NodeClient.normalizedWebSocketURL("localhost:6001")?.absoluteString, "ws://localhost:6001")
        XCTAssertEqual(NodeClient.normalizedWebSocketURL("127.0.0.1:6001")?.scheme, "ws")
        XCTAssertEqual(NodeClient.normalizedWebSocketURL("  ws://localhost:6001  ")?.host, "localhost")

        // 非 ws/wss 或空 → nil（不连、不崩）
        XCTAssertNil(NodeClient.normalizedWebSocketURL("http://example.com"))
        XCTAssertNil(NodeClient.normalizedWebSocketURL("https://example.com"))
        XCTAssertNil(NodeClient.normalizedWebSocketURL(""))
        XCTAssertNil(NodeClient.normalizedWebSocketURL("   "))
    }
}
