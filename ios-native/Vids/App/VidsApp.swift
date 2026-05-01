import SwiftUI

@main
struct VidsApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var services = ServiceContainer()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(services)
                .environment(services.playback)
                .environment(services.feed)
                .environment(services.terminal)
                .environment(services.theme)
                .environment(services.push)
                .preferredColorScheme(.dark)
                .task { await services.start() }
                .onOpenURL { url in services.handleDeepLink(url) }
        }
    }
}
