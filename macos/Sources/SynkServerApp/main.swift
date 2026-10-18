import AppKit
import SwiftUI
import SynkCore
import SynkUI

@main
struct HeliumSynkServer: App {
  @NSApplicationDelegateAdaptor(ServerAppDelegate.self) private var appDelegate
  @StateObject private var model = ServerModel()
  @StateObject private var updates = UpdateController.shared
  @State private var handledLaunch = false
  init() { SynkTheme.registerFonts() }
  var body: some Scene {
    Window("Helium Synk Server", id: "server") {
      ServerRootView(model: model, updates: updates).disabled(updates.updating)
        .task {
          updates.start()
          if !handledLaunch {
            handledLaunch = true
            let existing = Installation(
              root: DataLocation().root,
              relay: Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/synk-server"))
            if existing.exists && !existing.legacy {
              await Task.yield()
              if updates.error == nil {
                for window in NSApp.windows
                where ["Helium Synk Server", "Updates"].contains(window.title) {
                  window.orderOut(nil)
                }
              }
            }
          }
        }
    }
    .windowStyle(.hiddenTitleBar).defaultSize(width: 1000, height: 760).windowResizability(
      .contentMinSize)
    Window("Updates", id: "updates") { UpdateSettingsView(updates: updates) }
      .windowResizability(.contentSize)
    MenuBarExtra {
      ServerMenu(model: model, updates: updates)
    } label: {
      Image(nsImage: SynkBranding.menuBarImage).renderingMode(.template)
        .interpolation(.high).antialiased(true).accessibilityLabel("Helium Synk Server")
    }
  }
}
private struct ServerMenu: View {
  @ObservedObject var model: ServerModel
  @ObservedObject var updates: UpdateController
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
    if updates.preparing { Text("Preparing your server…") }
    Button(updates.availableVersion.map { "Install \($0)…" } ?? "Check for Updates…") {
      updates.check()
    }
    .disabled(!updates.canCheck || updates.preparing)
    Button("Update Settings…") {
      openWindow(id: "updates")
      NSApp.activate(ignoringOtherApps: true)
    }
    Divider()
    Button("Quit app (server keeps running)") { NSApp.terminate(nil) }
  }
}

private struct ServerRootView: View {
  @ObservedObject var model: ServerModel
  @ObservedObject var updates: UpdateController
  @Environment(\.openWindow) private var openWindow
  var body: some View {
    ServerView(model: model, showUpdates: { openWindow(id: "updates") })
      .onReceive(updates.$error) { error in
        if error != nil {
          openWindow(id: "updates")
          NSApp.activate(ignoringOtherApps: true)
        }
      }
      .onReceive(updates.$preparing) { preparing in
        if preparing { openWindow(id: "updates") }
      }
  }
}
