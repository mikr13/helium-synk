import Darwin
import Foundation

public struct NativeInstallation: Codable, Sendable {
  public var format = 1
  public var createdAt = Date()
  public var serviceLabel = "com.heliumsynk.server.agent"
  public init() {}
}
public struct Installation: Sendable {
  public let root: URL
  public let relay: URL
  public let runner: any CommandRunning
  public init(
    root: URL = PrivateFiles.defaultRoot, relay: URL, runner: any CommandRunning = CommandRunner()
  ) {
    self.root = root
    self.relay = relay
    self.runner = runner
  }
  public var exists: Bool {
    FileManager.default.fileExists(atPath: root.appendingPathComponent("deployment.json").path)
  }
  public var legacy: Bool {
    let files = FileManager.default
    guard !files.fileExists(atPath: root.appendingPathComponent("native-installation.json").path)
    else { return false }
    if exists || files.fileExists(atPath: root.appendingPathComponent("bin/macos-ops.py").path) {
      return true
    }
    // Early script installs predate deployment.json but already own live account databases.
    let accounts =
      (try? files.contentsOfDirectory(
        at: root.appendingPathComponent("accounts"), includingPropertiesForKeys: nil)) ?? []
    return accounts.contains {
      files.fileExists(atPath: $0.appendingPathComponent("relay.sqlite").path)
    }
  }
  public func availableLocalPort(excluding: Set<Int>) throws -> Int {
    for port in 4318...4418 where !excluding.contains(port) {
      let fd = socket(AF_INET, SOCK_STREAM, 0)
      guard fd >= 0 else { throw SynkError.message("Couldn't check available ports.") }
      var address = sockaddr_in()
      address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
      address.sin_family = sa_family_t(AF_INET)
      address.sin_port = UInt16(port).bigEndian
      address.sin_addr.s_addr = inet_addr("127.0.0.1")
      let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
          bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
      }
      close(fd)
      if result == 0 { return port }
    }
    throw SynkError.message("No local server port is available.")
  }
  public func create(_ profile: Profile) throws {
    try PrivateFiles.rejectSymlinks(root)
    guard !legacy else {
      throw SynkError.message(
        "An existing script-managed server lives here. Keep it running and use a different data folder for this app."
      )
    }
    var deployment: Deployment
    if exists {
      deployment = try Deployment.load(root: root)
    } else {
      if FileManager.default.fileExists(atPath: root.path),
        !(try FileManager.default.contentsOfDirectory(atPath: root.path)).isEmpty
      {
        throw SynkError.message("This data folder already contains files. Choose an empty folder.")
      }
      deployment = Deployment(profiles: [:])
    }
    guard deployment.profiles[profile.name] == nil else {
      throw SynkError.message("That account already exists.")
    }
    deployment.profiles[profile.name] = profile
    deployment = try deployment.validated()
    let fresh = !exists
    let rootExisted = FileManager.default.fileExists(atPath: root.path)
    var completed = false
    defer {
      if fresh && !completed {
        try? FileManager.default.removeItem(
          at: root.appendingPathComponent("native-installation.json"))
        for name in ["accounts", "logs"] {
          let folder = root.appendingPathComponent(name)
          if (try? FileManager.default.contentsOfDirectory(atPath: folder.path).isEmpty) == true {
            try? FileManager.default.removeItem(at: folder)
          }
        }
        if !rootExisted
          && (try? FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty) == true
        {
          try? FileManager.default.removeItem(at: root)
        }
      }
    }
    try PrivateFiles.directory(root)
    try PrivateFiles.directory(root.appendingPathComponent("accounts"))
    try PrivateFiles.directory(root.appendingPathComponent("logs"))
    let destination = root.appendingPathComponent("accounts/\(profile.name)")
    guard !FileManager.default.fileExists(atPath: destination.path) else {
      throw SynkError.message("That account folder already exists. Its files have been kept.")
    }
    let staging = root.appendingPathComponent(".setup-\(UUID().uuidString)")
    try PrivateFiles.directory(staging)
    var committed = false
    defer { if !committed { try? FileManager.default.removeItem(at: staging) } }
    let database = staging.appendingPathComponent("relay.sqlite")
    let result = try runner.run(
      relay,
      [
        "--database", database.path, "issue-device", "--name", profile.deviceName, "--server-url",
        profile.serverURL, "--output", staging.appendingPathComponent("connection.json").path,
      ], timeout: 30)
    guard result.status == 0 else {
      throw SynkError.message("Couldn't create the account. Existing accounts are unchanged.")
    }
    // A fresh account must have an independent, validated initial snapshot before committing.
    try PrivateFiles.directory(staging.appendingPathComponent("backups"))
    let backup = staging.appendingPathComponent("backups/initial.sqlite")
    let saved = try runner.run(
      relay, ["--database", database.path, "backup", "--output", backup.path], timeout: 120)
    guard saved.status == 0,
      try runner.run(relay, ["verify-backup", "--path", backup.path], timeout: 120).status == 0
    else { throw SynkError.message("Couldn't verify the initial backup. Try again.") }
    try FileManager.default.moveItem(at: staging, to: destination)
    do {
      if !exists {
        try StatusFiles.save(
          NativeInstallation(), to: root.appendingPathComponent("native-installation.json"))
      }
      try PrivateFiles.save(deployment, to: root.appendingPathComponent("deployment.json"))
      committed = true
      completed = true
    } catch {
      // Only the account created by this transaction can be rolled back.
      try? FileManager.default.moveItem(at: destination, to: staging)
      throw error
    }
  }
}
