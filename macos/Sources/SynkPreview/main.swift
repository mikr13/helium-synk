import AppKit
import SwiftUI
import SynkUI

@main
struct Preview {
  @MainActor static func main() {
    let arguments = CommandLine.arguments
    guard arguments.count >= 3, let screen = Screen(rawValue: arguments[1]) else {
      fputs(
        "Usage: synk-preview welcome|network|account|connect|dashboard OUTPUT.png [resources]\n",
        stderr)
      exit(1)
    }
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.prohibited)
    if arguments.count > 3 { SynkTheme.registerFonts(at: URL(fileURLWithPath: arguments[3])) }
    let model = ServerModel(previewScreen: screen)
    let view = ServerView(model: model).frame(width: 1040, height: screen == .dashboard ? 820 : 760)
    let hosting = NSHostingView(rootView: view)
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1040, height: screen == .dashboard ? 820 : 760),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = hosting
    hosting.layoutSubtreeIfNeeded()
    RunLoop.current.run(until: Date().addingTimeInterval(0.5))
    guard let image = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { exit(2) }
    hosting.cacheDisplay(in: hosting.bounds, to: image)
    guard let data = image.representation(using: .png, properties: [:]) else { exit(3) }
    do {
      try data.write(to: URL(fileURLWithPath: arguments[2]))
      print(arguments[2])
    } catch {
      fputs("\(error)\n", stderr)
      exit(4)
    }
  }
}
