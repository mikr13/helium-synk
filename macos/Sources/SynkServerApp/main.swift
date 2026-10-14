import AppKit
import SwiftUI
import SynkUI

@main
struct HeliumSynkServer: App {
  @StateObject private var model = ServerModel()
  init() { SynkTheme.registerFonts() }
  var body: some Scene {
    Window("Helium Synk Server", id: "server") { ServerView(model: model) }
      .windowStyle(.hiddenTitleBar).defaultSize(width: 1000, height: 760).windowResizability(
        .contentMinSize)
    MenuBarExtra {
      ServerMenu(model: model)
    } label: {
      Image(nsImage: SynkBranding.menuBarImage).renderingMode(.template)
        .interpolation(.high).antialiased(true).accessibilityLabel("Helium Synk Server")
    }
  }
}
private struct ServerMenu: View {
  @ObservedObject var model: ServerModel
  @Environment(\.openWindow) private var openWindow
  var body: some View {
    Text(
      model.online && !model.paused
        ? "Server running" : model.paused ? "Server paused" : "Server offline")
    Button("Open server overview") {
      openWindow(id: "server")
      NSApp.activate(ignoringOtherApps: true)
    }
    Button("Refresh status") { Task { await model.refresh() } }
    Divider()
    Button("Quit app (server keeps running)") { NSApp.terminate(nil) }
  }
}
