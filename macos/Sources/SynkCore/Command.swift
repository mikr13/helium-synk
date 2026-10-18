import Foundation

public struct CommandResult: Sendable {
  public let status: Int32
  public let output: Data
  public var text: String { String(decoding: output, as: UTF8.self) }
  public init(status: Int32, output: Data) {
    self.status = status
    self.output = output
  }
}
public protocol CommandRunning: Sendable {
  func run(_ executable: URL, _ arguments: [String], timeout: TimeInterval) throws -> CommandResult
}
public struct CommandRunner: CommandRunning {
  public init() {}
  public func run(_ executable: URL, _ arguments: [String], timeout: TimeInterval = 20) throws
    -> CommandResult
  {
    let output = FileManager.default.temporaryDirectory.appendingPathComponent(
      "synk-command-\(UUID().uuidString)")
    guard
      FileManager.default.createFile(
        atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600])
    else { throw SynkError.message("Couldn't prepare the command.") }
    defer { try? FileManager.default.removeItem(at: output) }
    let handle = try FileHandle(forWritingTo: output)
    defer { try? handle.close() }
    let process = Process()
    process.executableURL = executable
    process.arguments = arguments
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = handle
    process.standardError = handle
    try process.run()
    let deadline = Date().addingTimeInterval(timeout)
    while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
    if process.isRunning {
      process.terminate()
      let grace = Date().addingTimeInterval(3)
      while process.isRunning && Date() < grace { Thread.sleep(forTimeInterval: 0.05) }
      if process.isRunning { kill(process.processIdentifier, SIGKILL) }
      throw SynkError.message("That took too long. Check Tailscale and try again.")
    }
    let data = try Data(contentsOf: output)
    guard data.count < 4 * 1024 * 1024 else {
      throw SynkError.message("Unexpected command output.")
    }
    return CommandResult(status: process.terminationStatus, output: data)
  }
}
