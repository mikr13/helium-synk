import Foundation

public enum SynkError: LocalizedError {
  case message(String)
  public var errorDescription: String? {
    if case .message(let message) = self { return message }
    return nil
  }
}

public struct Profile: Codable, Equatable, Identifiable, Sendable {
  public var id: String { name }
  public var name: String = ""
  public var port: Int
  public var serverURL: String
  public var deviceName: String
  public var backupTime: String
  enum CodingKeys: String, CodingKey {
    case port
    case serverURL = "server_url"
    case deviceName = "device_name"
    case backupTime = "backup_time"
  }
  public init(
    name: String, port: Int, serverURL: String, deviceName: String, backupTime: String = "03:10"
  ) {
    self.name = name
    self.port = port
    self.serverURL = serverURL
    self.deviceName = deviceName
    self.backupTime = backupTime
  }
}

public struct Deployment: Codable, Equatable, Sendable {
  public var version: Int = 1
  public var profiles: [String: Profile]
  public var retention: [String: Int] = ["daily": 7, "weekly": 4, "monthly": 3]
  public init(profiles: [String: Profile]) { self.profiles = profiles }
  enum CodingKeys: String, CodingKey { case version, profiles, retention }
  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    version = try values.decode(Int.self, forKey: .version)
    profiles = try values.decode([String: Profile].self, forKey: .profiles)
    retention =
      try values.decodeIfPresent([String: Int].self, forKey: .retention) ?? [
        "daily": 7, "weekly": 4, "monthly": 3,
      ]
  }
  public func validated() throws -> Deployment {
    guard version == 1, !profiles.isEmpty,
      Set(retention.keys) == Set(["daily", "weekly", "monthly"]),
      retention.values.allSatisfy({ (1...1000).contains($0) })
    else {
      throw SynkError.message("This server configuration isn't supported.")
    }
    var result = self
    var ports = Set<Int>()
    var endpoints = Set<String>()
    for (name, var profile) in profiles {
      guard name.range(of: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", options: .regularExpression) != nil,
        name.count <= 48
      else {
        throw SynkError.message("Use a short account name with letters, numbers and hyphens.")
      }
      let trimmed = profile.deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty, trimmed.utf8.count <= 100,
        !profile.deviceName.unicodeScalars.contains(where: {
          CharacterSet.controlCharacters.contains($0)
        })
      else { throw SynkError.message("Enter a device name under 100 bytes.") }
      guard (1024...65535).contains(profile.port), ports.insert(profile.port).inserted else {
        throw SynkError.message("Each account needs a different local port.")
      }
      guard
        profile.backupTime.range(of: "^([01][0-9]|2[0-3]):[0-5][0-9]$", options: .regularExpression)
          != nil
      else { throw SynkError.message("Choose a backup time in HH:MM format.") }
      guard !profile.serverURL.contains(where: { $0.isWhitespace }),
        let url = URLComponents(string: profile.serverURL), url.user == nil, url.password == nil,
        url.query == nil, url.fragment == nil, url.path == "" || url.path == "/",
        let host = url.host?.lowercased()
      else { throw SynkError.message("Use a private Tailscale HTTPS address.") }
      let remotePort = url.port ?? (url.scheme == "https" ? 443 : 80)
      guard (1...65535).contains(remotePort),
        (url.scheme == "https" && host.hasSuffix(".ts.net"))
          || (url.scheme == "http" && ["127.0.0.1", "localhost"].contains(host)
            && remotePort == profile.port)
      else {
        throw SynkError.message(
          "Use private Tailscale HTTPS, or localhost with the account's port.")
      }
      guard endpoints.insert("\(url.scheme ?? "")://\(host):\(remotePort)").inserted else {
        throw SynkError.message("Each account needs a different server address.")
      }
      profile.name = name
      profile.deviceName = trimmed
      profile.serverURL = profile.serverURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
      result.profiles[name] = profile
    }
    return result
  }
  public static func load(root: URL) throws -> Deployment {
    let file = root.appendingPathComponent("deployment.json")
    try PrivateFiles.rejectSymlinks(file)
    let data = try Data(contentsOf: file)
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys).isSubset(of: ["version", "profiles", "retention"]),
      let accounts = object["profiles"] as? [String: [String: Any]],
      accounts.values.allSatisfy({
        Set($0.keys) == Set(["port", "server_url", "device_name", "backup_time"])
      })
    else {
      throw SynkError.message(
        "This server configuration contains unsupported fields. Its files have been kept.")
    }
    return try JSONDecoder().decode(Self.self, from: data).validated()
  }
}

public enum PrivateFiles {
  public static var defaultRoot: URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
      "Library/Application Support/Helium Synk", isDirectory: true)
  }
  public static func rejectSymlinks(_ path: URL) throws {
    var current = path.path
    while !current.isEmpty && current != "/" {
      if let attrs = try? FileManager.default.attributesOfItem(atPath: current),
        attrs[.type] as? FileAttributeType == .typeSymbolicLink
      {
        // Foundation canonicalizes macOS temporary paths back to these root-owned aliases.
        let systemAliases = ["/var": "private/var", "/tmp": "private/tmp"]
        let destination = try FileManager.default.destinationOfSymbolicLink(atPath: current)
        guard systemAliases[current] == destination else {
          throw SynkError.message("Choose a data location without symbolic links: \(current)")
        }
      }
      guard let slash = current.lastIndex(of: "/") else { break }
      current = String(current[..<slash])
    }
  }
  public static func directory(_ path: URL) throws {
    try rejectSymlinks(path)
    try FileManager.default.createDirectory(
      at: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: path.path)
  }
  public static func write(_ data: Data, to path: URL) throws {
    try rejectSymlinks(path)
    let temporary = path.deletingLastPathComponent().appendingPathComponent(
      ".\(UUID().uuidString).tmp")
    defer { try? FileManager.default.removeItem(at: temporary) }
    // Set private permissions before any credential bytes reach disk.
    guard
      FileManager.default.createFile(
        atPath: temporary.path, contents: nil, attributes: [.posixPermissions: 0o600])
    else { throw SynkError.message("Couldn't create a private file.") }
    let handle = try FileHandle(forWritingTo: temporary)
    try handle.write(contentsOf: data)
    try handle.synchronize()
    try handle.close()
    if rename(temporary.path, path.path) != 0 {
      throw SynkError.message("Couldn't save the server configuration.")
    }
  }
  public static func save<T: Encodable>(_ value: T, to path: URL) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try write(encoder.encode(value), to: path)
  }
}
