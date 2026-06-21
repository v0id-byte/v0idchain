// 根视图：无钱包 → 引导页；有钱包 → 五个 Tab。
import SwiftUI
import V0idKit

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Group {
            if model.hasWallet {
                MainTabs()
            } else {
                OnboardingView()
            }
        }
        .toastHost()
    }
}

private struct MainTabs: View {
    var body: some View {
        TabView {
            WalletView()
                .tabItem { Label("钱包", systemImage: "wallet.pass") }
            SendView()
                .tabItem { Label("转账", systemImage: "paperplane") }
            MessagesView()
                .tabItem { Label("消息", systemImage: "envelope") }
            ExploreView()
                .tabItem { Label("逛链", systemImage: "cube.transparent") }
            SettingsView()
                .tabItem { Label("设置", systemImage: "gearshape") }
        }
    }
}
