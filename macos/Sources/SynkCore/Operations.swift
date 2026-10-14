import Darwin
import Foundation

public struct BackupStatus: Codable, Sendable {
  public var ok: Bool
  public var checkedAt: Date
  public var snapshot: String
  public var snapshotModifiedAt: Date
  public init(ok: Bool, checkedAt: Date, snapshot: String, snapshotModifiedAt: Date) {
    self.ok = ok
    self.checkedAt = checkedAt
    self.snapshot = snapshot
    self.snapshotModifiedAt = snapshotModifiedAt
  }
  enum CodingKeys: String, CodingKey {
    case ok
    case checkedAt = "checked_at"
    case snapshot
    case snapshotModifiedAt = "snapshot_modified_at"
  }
}
public struct HealthStatus: Codable, Sendable {
  public var ok: Bool
  public var checkedAt: Date
  public var problems: [String]
  public var databaseBytes: Int64
  public var freeBytes: Int64
  public var backupAgeHours: Double?
  public init(
    ok: Bool, checkedAt: Date, problems: [String], databaseBytes: Int64, freeBytes: Int64,
    backupAgeHours: Double?
  ) {
    self.ok = ok
    self.checkedAt = checkedAt
    self.problems = problems
    self.databaseBytes = databaseBytes
    self.freeBytes = freeBytes
    self.backupAgeHours = backupAgeHours
  }
  enum CodingKeys: String, CodingKey {
    case ok
    case checkedAt = "checked_at"
    case problems
    case databaseBytes = "database_bytes"
    case freeBytes = "free_bytes"
    case backupAgeHours = "backup_age_hours"
  }
}
public struct RuntimeSettings: Codable, Sendable {
  public var paused: Set<String> = []
  public init(paused: Set<String> = []) { self.paused = paused }
}
public enum StatusFiles {
  public static func save<T: Encodable>(_ value: T, to path: URL) throws {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try PrivateFiles.write(encoder.encode(value), to: path)
  }
  public static func load<T: Decodable>(_ type: T.Type, at path: URL) throws -> T {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(type, from: Data(contentsOf: path))
  }
}
public struct Operations: Sendable {
  public let root: URL
  public let relay: URL
  public let runner: any CommandRunning
  public init(root: URL, relay: URL, runner: any CommandRunning = CommandRunner()) {
    self.root = root
    self.relay = relay
    self.runner = runner
  }
  public func account(_ name: String) -> URL { root.appendingPathComponent("accounts/\(name)") }
  public func relayCommand(_ name: String, _ args: [String], timeout: TimeInterval = 30) throws
    -> CommandResult
  {
    _ = try Deployment.load(root: root).profiles[name].unwrap("Account not found.")
    let result = try runner.run(
      relay, ["--database", account(name).appendingPathComponent("relay.sqlite").path] + args,
      timeout: timeout)
    guard result.status == 0 else {
      throw SynkError.message(
        "The server couldn't complete that operation. Your existing data has been kept.")
    }
    return result
  }
  public func backup(_ name: String, now: Date = Date()) throws -> BackupStatus {
    let config = try Deployment.load(root: root)
    guard config.profiles[name] != nil else { throw SynkError.message("Account not found.") }
    let lockPath = account(name).appendingPathComponent("native-backup.lock")
    try PrivateFiles.rejectSymlinks(lockPath)
    let lock = open(lockPath.path, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
    guard lock >= 0 else { throw SynkError.message("Couldn't open the backup lock.") }
    defer { close(lock) }
    guard flock(lock, LOCK_EX | LOCK_NB) == 0 else {
      throw SynkError.message("A backup is already running. Try again shortly.")
    }
    let directory = account(name).appendingPathComponent("backups")
    try PrivateFiles.directory(directory)
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd"
    let stamp = formatter.string(from: now)
    let snapshot = directory.appendingPathComponent("daily-\(stamp).sqlite")
    if !FileManager.default.fileExists(atPath: snapshot.path) {
      _ = try relayCommand(name, ["backup", "--output", snapshot.path], timeout: 120)
    }
    try verify(snapshot)
    let calendar = Calendar(identifier: .iso8601)
    for kind in ["weekly", "monthly"] {
      let components: Set<Calendar.Component> =
        kind == "weekly" ? [.yearForWeekOfYear, .weekOfYear] : [.year, .month]
      let existing = try snapshots(directory, kind: kind)
      let matches = existing.contains { file in
        guard
          let date = formatter.date(
            from: String(file.deletingPathExtension().lastPathComponent.dropFirst(kind.count + 1)))
        else { return false }
        return calendar.dateComponents(components, from: date)
          == calendar.dateComponents(components, from: now)
      }
      if !matches {
        let destination = directory.appendingPathComponent("\(kind)-\(stamp).sqlite")
        let temporary = directory.appendingPathComponent(".\(UUID().uuidString).sqlite")
        defer { try? FileManager.default.removeItem(at: temporary) }
        try FileManager.default.copyItem(at: snapshot, to: temporary)
        try FileManager.default.setAttributes(
          [.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        try verify(temporary)
        try FileManager.default.moveItem(at: temporary, to: destination)
      }
    }
    // Rotate only our fixed-name, verified snapshots, after all new snapshots are healthy.
    for (kind, keep) in config.retention {
      for old in try snapshots(directory, kind: kind).dropFirst(keep) {
        try PrivateFiles.rejectSymlinks(old)
        try FileManager.default.removeItem(at: old)
      }
    }
    let modified =
      try snapshot.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
      ?? now
    let status = BackupStatus(
      ok: true, checkedAt: now, snapshot: snapshot.lastPathComponent, snapshotModifiedAt: modified)
    try StatusFiles.save(status, to: account(name).appendingPathComponent("backup-status.json"))
    return status
  }
  private func snapshots(_ directory: URL, kind: String) throws -> [URL] {
    try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
      .filter {
        $0.lastPathComponent.range(
          of: "^\(kind)-[0-9]{4}-[0-9]{2}-[0-9]{2}\\.sqlite$", options: .regularExpression) != nil
      }.sorted { $0.lastPathComponent > $1.lastPathComponent }
  }
  public func verify(_ snapshot: URL) throws {
    try PrivateFiles.rejectSymlinks(snapshot)
    let result = try runner.run(relay, ["verify-backup", "--path", snapshot.path], timeout: 120)
    guard result.status == 0 else {
      throw SynkError.message(
        "The backup didn't pass its integrity check. Earlier backups have been kept.")
    }
  }
  public func monitor(_ name: String, ready: Bool, now: Date = Date()) throws -> HealthStatus {
    let account = account(name)
    var problems: [String] = ready ? [] : ["Server is not responding"]
    let values = try root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    let free = values.volumeAvailableCapacityForImportantUsage ?? 0
    if free < 2 * 1024 * 1024 * 1024 { problems.append("Less than 2 GB free") }
    let report = try relayCommand(name, ["operations-report"])
    let metrics = try JSONSerialization.jsonObject(with: report.output) as? [String: Any] ?? [:]
    if let bytes = metrics["journal_bytes"] as? Double,
      let max = metrics["journal_byte_limit"] as? Double, bytes >= max * 0.8
    {
      problems.append("Sync storage above 80%")
    }
    if let count = metrics["operations"] as? Double,
      let max = metrics["operation_limit"] as? Double, count >= max * 0.8
    {
      problems.append("Sync operation budget above 80%")
    }
    let status = try? StatusFiles.load(
      BackupStatus.self, at: account.appendingPathComponent("backup-status.json"))
    let age = status.map { now.timeIntervalSince($0.snapshotModifiedAt) / 3600 }
    if age == nil || age! > 30 || status?.ok != true { problems.append("Backup is overdue") }
    let files = try FileManager.default.contentsOfDirectory(
      at: account, includingPropertiesForKeys: [.fileSizeKey])
    let size = files.filter { $0.lastPathComponent.hasPrefix("relay.sqlite") }.reduce(Int64(0)) {
      total, url in total + Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
    }
    let health = HealthStatus(
      ok: problems.isEmpty, checkedAt: now, problems: problems, databaseBytes: size,
      freeBytes: free, backupAgeHours: age)
    try StatusFiles.save(health, to: account.appendingPathComponent("health-status.json"))
    return health
  }
  public func setPaused(_ name: String, paused: Bool) throws {
    guard try Deployment.load(root: root).profiles[name] != nil else {
      throw SynkError.message("Account not found.")
    }
    var settings =
      (try? StatusFiles.load(RuntimeSettings.self, at: root.appendingPathComponent("runtime.json")))
      ?? RuntimeSettings()
    if paused { settings.paused.insert(name) } else { settings.paused.remove(name) }
    try PrivateFiles.save(settings, to: root.appendingPathComponent("runtime.json"))
  }
}
extension Optional {
  func unwrap(_ message: String) throws -> Wrapped {
    guard let value = self else { throw SynkError.message(message) }
    return value
  }
}
