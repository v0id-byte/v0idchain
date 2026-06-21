// v0idChain macOS 轻客户端入口。
import SwiftUI

@main
struct V0idChainApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .frame(minWidth: 820, minHeight: 560)
                .task { model.bootstrap() }
        }
        .windowResizability(.contentMinSize)
    }
}
