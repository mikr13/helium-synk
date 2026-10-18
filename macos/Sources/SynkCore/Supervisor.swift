import Darwin
import Foundation

final class RotatingLog: @unchecked Sendable {
  private let url: URL
  private let lock = NSLock()
  init(url: URL) { self.url = url }
  func write(_ data: Data) {
    lock.lock()
    defer { lock.unlock() }
    do {
      try PrivateFiles.rejectSymlinks(url)
      let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
      if size + data.count > 5 * 1024 * 1024 {
        for n in stride(from: 3, through: 1, by: -1) {
          let dest = URL(fileURLWithPath: url.path + ".\(n)")
          let source = n == 1 ? url : URL(fileURLWithPath: url.path + ".\(n - 1)")
          try PrivateFiles.rejectSymlinks(dest)
          try PrivateFiles.rejectSymlinks(source)
          if FileManager.default.fileExists(atPath: dest.path) {
            try FileManager.default.removeItem(at: dest)
          }
          if FileManager.default.fileExists(atPath: source.path) {
            try FileManager.default.moveItem(at: source, to: dest)
          }
        }
      }
      if !FileManager.default.fileExists(atPath: url.path) {
        FileManager.default.createFile(
          atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
      }
      let handle = try FileHandle(forWritingTo: url)
      defer { try? handle.close() }
      try handle.seekToEnd()
      try handle.write(contentsOf: data.prefix(65536))
    } catch {  // Log failures never take down a relay. Health monitoring reports disk pressure.
    }
  }
}
public final class StopFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false
  public init() {}
  public var stopped: Bool {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
  public func stop() {
    lock.lock()
    value = true
    lock.unlock()
  }
}
public final class Supervisor {
  private var children: [String: Process] = [:]
  private var pipes: [String: Pipe] = [:]
  private var lastBackupAttempt: [String: Date] = [:]
  private var lastMonitor: [String: Date] = [:]
  private var restartAt: [String: Date] = [:]
  private let operations: Operations
  private let app: URL?
  public init(root: URL, relay: URL, app: URL? = nil) {
    operations = Operations(root: root, relay: relay)
    self.app = app
  }
  public static func readiness(port: Int) async -> Bool {
    var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/health/ready")!)
    request.timeoutInterval = 3
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
      return (response as? HTTPURLResponse)?.statusCode == 200
        && json?["status"] as? String == "ready"
    } catch { return false }
  }
  public func run(stop: StopFlag, once: Bool = false) async throws {
    let root = operations.root
    try PrivateFiles.rejectSymlinks(root)
    // A native marker prevents accidental takeover of script-managed production jobs.
    _ = try StatusFiles.load(
      NativeInstallation.self, at: root.appendingPathComponent("native-installation.json"))
    let fd = open(
      root.appendingPathComponent("native-agent.lock").path, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw SynkError.message("Couldn't open the server lock.") }
    defer { close(fd) }
    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
      throw SynkError.message("The server helper is already running.")
    }
    defer { stopAll() }
    let maintenance = UpdateMaintenance(root: root, relay: operations.relay)
    let generation = try app.map { try AppGeneration(app: $0) }
    if let generation {
      try StatusFiles.save(
        UpdateAgentInfo(generation: generation),
        to: root.appendingPathComponent("update-agent.json"))
    }
    repeat {
      if let app, let generation {
        let directive = try maintain(maintenance, app: app, generation: generation)
        if directive == .restart { return }
        if directive == .hold {
          if once { return }
          try await Task.sleep(nanoseconds: 500_000_000)
          continue
        }
      }
      let config = try Deployment.load(root: root)
      let settings =
        (try? StatusFiles.load(
          RuntimeSettings.self, at: root.appendingPathComponent("runtime.json")))
        ?? RuntimeSettings()
      for name in Array(children.keys)
      where config.profiles[name] == nil || settings.paused.contains(name) { stopChild(name) }
      for (name, profile) in config.profiles where !settings.paused.contains(name) {
        if let process = children[name], !process.isRunning {
          stopChild(name)
          restartAt[name] = Date().addingTimeInterval(10)
        }
        if children[name] == nil && (restartAt[name] ?? .distantPast) <= Date() {
          do { try start(profile) } catch {
            restartAt[name] = Date().addingTimeInterval(30)
            let health = HealthStatus(
              ok: false, checkedAt: Date(),
              problems: ["This account couldn't start. Check its database and local port."],
              databaseBytes: 0, freeBytes: 0, backupAgeHours: nil)
            try? StatusFiles.save(
              health, to: operations.account(name).appendingPathComponent("health-status.json"))
            continue
          }
        }
        let now = Date()
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        let today = formatter.string(from: now)
        let status = try? StatusFiles.load(
          BackupStatus.self,
          at: operations.account(name).appendingPathComponent("backup-status.json"))
        let snapshotToday = status?.snapshot == "daily-\(today).sqlite" && status?.ok == true
        let time = DateFormatter()
        time.dateFormat = "HH:mm"
        let due =
          !snapshotToday
          && (status == nil || time.string(from: now) >= profile.backupTime
            || (status.map { now.timeIntervalSince($0.snapshotModifiedAt) > 30 * 3600 } ?? true))
        if (due || once) && now.timeIntervalSince(lastBackupAttempt[name] ?? .distantPast) > 300 {
          lastBackupAttempt[name] = now
          do { _ = try operations.backup(name) } catch {
            let failed = BackupStatus(
              ok: false, checkedAt: now, snapshot: status?.snapshot ?? "",
              snapshotModifiedAt: status?.snapshotModifiedAt ?? .distantPast)
            try? StatusFiles.save(
              failed, to: operations.account(name).appendingPathComponent("backup-status.json"))
          }
        }
        if now.timeIntervalSince(lastMonitor[name] ?? .distantPast) > 3600 || once {
          var ready = await Self.readiness(port: profile.port)
          if once {
            for _ in 0..<20 where !ready {
              try await Task.sleep(nanoseconds: 100_000_000)
              ready = await Self.readiness(port: profile.port)
            }
          }
          do { _ = try operations.monitor(name, ready: ready) } catch {
            let health = HealthStatus(
              ok: false, checkedAt: now, problems: ["Monitoring couldn't complete"],
              databaseBytes: 0, freeBytes: 0, backupAgeHours: nil)
            try? StatusFiles.save(
              health, to: operations.account(name).appendingPathComponent("health-status.json"))
          }
          lastMonitor[name] = now
        }
      }
      if once { break }
      for _ in 0..<2 where !stop.stopped { try await Task.sleep(nanoseconds: 1_000_000_000) }
    } while !stop.stopped
  }
  private enum UpdateDirective { case run, hold, restart }
  private func maintain(_ maintenance: UpdateMaintenance, app: URL, generation: AppGeneration)
    throws -> UpdateDirective
  {
    guard let request = try? maintenance.request() else { return .run }
    var status = try? maintenance.status()
    if status?.id == request.id, [.completed, .failed].contains(status?.phase) { return .run }
    // A helper from the replaced bundle exits cleanly. KeepAlive starts the new approved helper.
    if let current = try? AppGeneration(app: app), current != generation,
      current.version == request.targetVersion, status?.id == request.id,
      [.ready, .restarting].contains(status?.phase)
    {
      try maintenance.save(UpdateStatus(id: request.id, phase: .restarting, generation: generation))
      return .restart
    }
    if status?.id == request.id, status?.generation != generation,
      generation.version == request.targetVersion,
      [.ready, .restarting].contains(status?.phase)
    {
      try maintenance.save(UpdateStatus(id: request.id, phase: .completed, generation: generation))
      return .run
    }
    guard request.action == .prepare && request.expiresAt > Date() else { return .run }
    if status?.id == request.id, status?.phase == .preparing {
      try maintenance.save(
        UpdateStatus(
          id: request.id, phase: .failed, generation: generation,
          message: "Update preparation was interrupted. Your current server is running; try again.")
      )
      return .run
    }
    if status?.id != request.id {
      do {
        try maintenance.save(
          UpdateStatus(id: request.id, phase: .preparing, generation: generation))
        // Back up while the current relays are still available, then drain them for replacement.
        try maintenance.snapshot(request)
        guard request.expiresAt > Date(), try maintenance.request()?.action == .prepare else {
          throw SynkError.message("Update preparation expired or was cancelled. Try again.")
        }
        guard stopAll() else {
          throw SynkError.message("A server didn't stop cleanly. The update was cancelled.")
        }
        try maintenance.save(UpdateStatus(id: request.id, phase: .ready, generation: generation))
      } catch {
        try? maintenance.save(
          UpdateStatus(
            id: request.id, phase: .failed, generation: generation,
            message: error.localizedDescription))
        return .run
      }
      status = try maintenance.status()
    }
    return status?.phase == .ready ? .hold : .run
  }
  private func start(_ profile: Profile) throws {
    let directory = operations.account(profile.name)
    try PrivateFiles.rejectSymlinks(directory)
    guard
      FileManager.default.fileExists(atPath: directory.appendingPathComponent("relay.sqlite").path)
    else { throw SynkError.message("An account database is missing. Restore it before starting.") }
    let log = RotatingLog(url: operations.root.appendingPathComponent("logs/\(profile.name).log"))
    let pipe = Pipe()
    pipe.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      if data.isEmpty { handle.readabilityHandler = nil } else { log.write(data) }
    }
    let process = Process()
    process.executableURL = operations.relay
    process.arguments = [
      "--database", directory.appendingPathComponent("relay.sqlite").path, "serve", "--port",
      String(profile.port),
    ]
    process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "RUST_LOG": "info"]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = pipe
    process.standardError = pipe
    try process.run()
    children[profile.name] = process
    pipes[profile.name] = pipe
  }
  @discardableResult private func stopChild(_ name: String) -> Bool {
    var graceful = true
    if let process = children.removeValue(forKey: name), process.isRunning {
      process.terminate()
      let deadline = Date().addingTimeInterval(15)
      while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
      if process.isRunning {
        graceful = false
        kill(process.processIdentifier, SIGKILL)
      }
      // isRunning already observes termination. waitUntilExit can deadlock when an async
      // supervisor resumes on a different thread from the one that launched the process.
      let killedDeadline = Date().addingTimeInterval(3)
      while process.isRunning && Date() < killedDeadline { Thread.sleep(forTimeInterval: 0.05) }
      if process.isRunning { graceful = false }
    }
    pipes.removeValue(forKey: name)?.fileHandleForReading.readabilityHandler = nil
    return graceful
  }
  @discardableResult private func stopAll() -> Bool {
    var graceful = true
    for name in Array(children.keys) { if !stopChild(name) { graceful = false } }
    return graceful
  }
}
