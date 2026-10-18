import Darwin
import Foundation
import SynkCore

let arguments = CommandLine.arguments
func argument(_ name: String) -> String? {
  guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
    return nil
  }
  return arguments[index + 1]
}
let root =
  argument("--root").map { URL(fileURLWithPath: $0) } ?? DataLocation().root
var executableBuffer = [CChar](repeating: 0, count: 4096)
var executableSize = UInt32(executableBuffer.count)
guard _NSGetExecutablePath(&executableBuffer, &executableSize) == 0 else { exit(1) }
let executableURL = URL(fileURLWithPath: String(cString: executableBuffer))
  .resolvingSymlinksInPath()
let relay =
  argument("--relay").map { URL(fileURLWithPath: $0) }
  ?? executableURL.deletingLastPathComponent().appendingPathComponent("synk-server")
umask(0o077)
let stop = StopFlag()
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
term.setEventHandler { stop.stop() }
term.resume()
let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
interrupt.setEventHandler { stop.stop() }
interrupt.resume()
Task {
  do {
    let app = executableURL.deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
    let maintenance = UpdateMaintenance(root: root, relay: relay)
    if arguments.contains("--prepare-update") {
      guard let version = argument("--prepare-update"), app.pathExtension == "app" else {
        throw SynkError.message("Specify the target update version from the installed app.")
      }
      let id = try await maintenance.prepare(
        targetVersion: version, generation: AppGeneration(app: app))
      print(id?.uuidString ?? "unconfigured")
      exit(0)
    }
    if arguments.contains("--cancel-update") {
      guard let value = argument("--cancel-update"), let id = UUID(uuidString: value) else {
        throw SynkError.message("Specify the prepared update identifier.")
      }
      try maintenance.cancel(id)
      exit(0)
    }
    try await Supervisor(root: root, relay: relay, app: app.pathExtension == "app" ? app : nil).run(
      stop: stop, once: arguments.contains("--once"))
    exit(0)
  } catch {
    fputs("Helium Synk: \(error.localizedDescription)\n", stderr)
    exit(1)
  }
}
dispatchMain()
