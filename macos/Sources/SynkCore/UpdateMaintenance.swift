import CryptoKit
import Darwin
import Foundation

public struct AppGeneration: Codable, Equatable, Sendable {
  public let version: String
  public let digest: String
  public init(app: URL) throws {
    let contents = app.appendingPathComponent("Contents")
    let info = try Data(contentsOf: contents.appendingPathComponent("Info.plist"))
    let plist =
      try PropertyListSerialization.propertyList(from: info, format: nil) as? [String: Any]
    guard let version = plist?["CFBundleVersion"] as? String else {
      throw SynkError.message("Couldn't identify the server application.")
    }
    self.version = version
    var hash = SHA256()
    hash.update(data: info)
    for name in ["synk-agent", "synk-server"] {
      hash.update(data: try Data(contentsOf: contents.appendingPathComponent("MacOS/\(name)")))
    }
    digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
  }
}

public struct UpdateRequest: Codable, Sendable {
  public enum Action: String, Codable, Sendable { case prepare, cancel }
  public let id: UUID
  public let targetVersion: String
  public let expiresAt: Date
  public var action: Action = .prepare
  public init(targetVersion: String, now: Date = Date(), lease: TimeInterval = 600) throws {
    guard lease > 0 && lease <= 600 else { throw SynkError.message("Invalid update timeout.") }
    guard targetVersion.range(of: "^[0-9]+\\.[0-9]+\\.[0-9]+$", options: .regularExpression) != nil
    else {
      throw SynkError.message("This update has an invalid version.")
    }
    id = UUID()
    self.targetVersion = targetVersion
    expiresAt = now.addingTimeInterval(lease)
  }
}

public struct UpdateStatus: Codable, Sendable {
  public enum Phase: String, Codable, Sendable {
    case preparing, ready, failed, restarting, completed
  }
  public let id: UUID
  public var phase: Phase
  public let generation: AppGeneration
  public var message: String?
}

public struct UpdateAgentInfo: Codable, Sendable {
  public let protocolVersion: Int
  public let generation: AppGeneration
  public init(generation: AppGeneration) {
    protocolVersion = 1
    self.generation = generation
  }
}

/// A private, expiring handover. No account settings, credentials or service registration are changed.
public struct UpdateMaintenance: Sendable {
  public let root: URL
  public let relay: URL
  public init(root: URL, relay: URL) {
    self.root = root
    self.relay = relay
  }
  private var requestURL: URL { root.appendingPathComponent("update-request.json") }
  private var statusURL: URL { root.appendingPathComponent("update-status.json") }
  public var managed: Bool {
    guard
      let installation = try? StatusFiles.load(
        NativeInstallation.self, at: root.appendingPathComponent("native-installation.json"))
    else { return false }
    return installation.format == 1 && installation.serviceLabel == "com.heliumsynk.server.agent"
  }
  public func request() throws -> UpdateRequest? {
    try PrivateFiles.rejectSymlinks(requestURL)
    guard FileManager.default.fileExists(atPath: requestURL.path) else { return nil }
    return try StatusFiles.load(UpdateRequest.self, at: requestURL)
  }
  public func status() throws -> UpdateStatus? {
    try PrivateFiles.rejectSymlinks(statusURL)
    guard FileManager.default.fileExists(atPath: statusURL.path) else { return nil }
    return try StatusFiles.load(UpdateStatus.self, at: statusURL)
  }
  public func save(_ status: UpdateStatus) throws { try StatusFiles.save(status, to: statusURL) }
  public func begin(targetVersion: String, now: Date = Date()) throws -> UpdateRequest {
    guard managed else {
      throw SynkError.message(
        "This data folder is managed by another server. Its data has been kept.")
    }
    if let existing = try request(), existing.action == .prepare && existing.expiresAt > now,
      try status()?.phase != .completed && status()?.phase != .failed
    {
      throw SynkError.message("An update is already being prepared.")
    }
    let request = try UpdateRequest(targetVersion: targetVersion, now: now)
    try StatusFiles.save(request, to: requestURL)
    return request
  }
  public func cancel(_ id: UUID) throws {
    guard var request = try request(), request.id == id else { return }
    request.action = .cancel
    try StatusFiles.save(request, to: requestURL)
  }
  private func lockIfStopped() throws -> Int32? {
    let lock = root.appendingPathComponent("native-agent.lock")
    try PrivateFiles.rejectSymlinks(lock)
    let fd = open(lock.path, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw SynkError.message("Couldn't check the background server.") }
    if flock(fd, LOCK_EX | LOCK_NB) == 0 { return fd }
    let code = errno
    close(fd)
    guard code == EWOULDBLOCK else {
      throw SynkError.message("Couldn't check the background server lock.")
    }
    return nil
  }
  public func helperRunning() throws -> Bool {
    guard let fd = try lockIfStopped() else { return true }
    close(fd)
    return false
  }
  public func prepare(targetVersion: String, generation: AppGeneration) async throws -> UUID? {
    // An unconfigured app can update without touching an existing foreign installation.
    guard managed else { return nil }
    let request = try begin(targetVersion: targetVersion)
    do {
      if let fd = try lockIfStopped() {
        // Keep a starting helper out until the offline snapshot and ready marker are complete.
        defer { close(fd) }
        try snapshot(request)
        try save(UpdateStatus(id: request.id, phase: .ready, generation: generation))
      } else {
        let info = try? StatusFiles.load(
          UpdateAgentInfo.self, at: root.appendingPathComponent("update-agent.json"))
        guard info?.protocolVersion == 1, info?.generation == generation else {
          throw SynkError.message(
            "Restart the background server once to enable updates. Your accounts and browser connections stay the same."
          )
        }
      }
      while Date() < request.expiresAt {
        try Task.checkCancellation()
        if let status = try status(), status.id == request.id {
          if status.phase == .ready { return request.id }
          if status.phase == .failed {
            throw SynkError.message(status.message ?? "Couldn't prepare the update.")
          }
        }
        try await Task.sleep(nanoseconds: 250_000_000)
      }
      throw SynkError.message(
        "The server didn't prepare the update in time. Your current server has been kept.")
    } catch {
      try? cancel(request.id)
      throw error
    }
  }
  /// Called by the relaunched app. A disabled helper stays disabled; enabled accounts must recover.
  @discardableResult
  public func verifyRestart(
    generation: AppGeneration, helperExpected: Bool, timeout: TimeInterval = 60
  ) async throws -> Bool {
    guard managed, let request = try request(), let previous = try status(),
      previous.id == request.id, request.action == .prepare,
      request.targetVersion == generation.version,
      [.ready, .restarting, .completed].contains(previous.phase),
      previous.phase != .completed || previous.message != "verified"
    else { return false }
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      try Task.checkCancellation()
      let running = try helperRunning()
      if !helperExpected && !running {
        try verifyPreservedFiles(request)
        try save(
          UpdateStatus(
            id: request.id, phase: .completed, generation: generation, message: "verified"))
        return true
      }
      if let current = try status(), current.id == request.id,
        current.phase == .completed, current.generation == generation
      {
        let config = try Deployment.load(root: root)
        let settings =
          (try? StatusFiles.load(
            RuntimeSettings.self, at: root.appendingPathComponent("runtime.json")))
          ?? RuntimeSettings()
        var ready = true
        for (name, profile) in config.profiles where !settings.paused.contains(name) {
          if !(await Supervisor.readiness(port: profile.port)) { ready = false }
        }
        if ready {
          try verifyPreservedFiles(request)
          try save(
            UpdateStatus(
              id: request.id, phase: .completed, generation: generation, message: "verified"))
          return true
        }
      }
      try await Task.sleep(nanoseconds: 500_000_000)
    }
    throw SynkError.message(
      "The app updated, but a server hasn't restarted. Your data and update backup are retained. Open the server overview to check its status."
    )
  }
  private func verifyPreservedFiles(_ request: UpdateRequest) throws {
    let hashes = try StatusFiles.load(
      [String: String].self,
      at: root.appendingPathComponent("updates/\(request.id.uuidString)/preserved-files.json"))
    for (name, expected) in hashes {
      try PrivateFiles.rejectSymlinks(root.appendingPathComponent(name))
      guard Self.digest(try Data(contentsOf: root.appendingPathComponent(name))) == expected else {
        throw SynkError.message(
          "The app updated, but server settings changed during installation. Your update backup is retained for review."
        )
      }
    }
  }
  /// Fresh independent snapshots, not the possibly older daily snapshot. Never restores a live database.
  public func snapshot(_ request: UpdateRequest) throws {
    guard managed else { throw SynkError.message("This server data isn't managed by the app.") }
    let config = try Deployment.load(root: root)
    let destination = root.appendingPathComponent("updates/\(request.id.uuidString)")
    try PrivateFiles.directory(destination)
    let operations = Operations(root: root, relay: relay)
    var hashes: [String: String] = [:]
    for name in ["deployment.json", "runtime.json", "native-installation.json"] {
      let source = root.appendingPathComponent(name)
      try PrivateFiles.rejectSymlinks(source)
      if FileManager.default.fileExists(atPath: source.path) {
        let bytes = try Data(contentsOf: source)
        hashes[name] = Self.digest(bytes)
        try PrivateFiles.write(bytes, to: destination.appendingPathComponent(name))
      }
    }
    for name in config.profiles.keys.sorted() {
      let directory = destination.appendingPathComponent(name)
      try PrivateFiles.directory(directory)
      let credential = root.appendingPathComponent("accounts/\(name)/connection.json")
      try PrivateFiles.rejectSymlinks(credential)
      let bytes = try Data(contentsOf: credential)
      hashes["accounts/\(name)/connection.json"] = Self.digest(bytes)
      try PrivateFiles.write(bytes, to: directory.appendingPathComponent("connection.json"))
      let snapshot = directory.appendingPathComponent("relay.sqlite")
      _ = try operations.relayCommand(name, ["backup", "--output", snapshot.path], timeout: 120)
      try operations.verify(snapshot)
    }
    for (name, expected) in hashes {
      guard Self.digest(try Data(contentsOf: root.appendingPathComponent(name))) == expected else {
        throw SynkError.message("Server settings changed while preparing the update. Try again.")
      }
    }
    try StatusFiles.save(hashes, to: destination.appendingPathComponent("preserved-files.json"))
  }
  private static func digest(_ bytes: Data) -> String {
    SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
  }
}
