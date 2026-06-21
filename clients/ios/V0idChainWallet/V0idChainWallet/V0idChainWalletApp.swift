// v0idChain 轻客户端 App 入口。
import SwiftUI
import V0idKit

@main
struct V0idChainWalletApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(model.node)   // 直接观察 NodeClient → 链/连接状态变化即时刷新 UI
                .tint(.primary)
        }
    }
}
