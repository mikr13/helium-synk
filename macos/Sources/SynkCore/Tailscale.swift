import Foundation

public struct Tailnet: Sendable, Equatable {
  public var state: String
  public var hostname: String
  public var connected: Bool { state == "Running" && hostname.hasSuffix(".ts.net") }
  public init(state: String, hostname: String) {
    self.state = state
    self.hostname = hostname
  }
}
public struct RouteChoice: Sendable, Equatable {
  public var httpsPort: Int
  public var localPort: Int
  public var origin: String
  public var alreadyConfigured: Bool
  public init(httpsPort: Int, localPort: Int, origin: String, alreadyConfigured: Bool) {
    self.httpsPort = httpsPort
    self.localPort = localPort
    self.origin = origin
    self.alreadyConfigured = alreadyConfigured
  }
}
public struct Tailscale: Sendable {
  public static let httpsPorts = [443, 8443] + Array(10000...10099)
  public let executable: URL
  public let runner: any CommandRunning
  public init(executable: URL, runner: any CommandRunning = CommandRunner()) {
    self.executable = executable
    self.runner = runner
  }
  public static func discover() -> URL? {
    [
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale",
      "/usr/local/bin/tailscale",
    ].map { URL(fileURLWithPath: $0) }.first {
      FileManager.default.isExecutableFile(atPath: $0.path)
    }
  }
  public func status() throws -> Tailnet {
    let result = try runner.run(executable, ["status", "--json"], timeout: 10)
    guard result.status == 0,
      let object = try JSONSerialization.jsonObject(with: result.output) as? [String: Any]
    else { throw SynkError.message("Open Tailscale and sign in, then check again.") }
    let selfObject = object["Self"] as? [String: Any] ?? [:]
    return Tailnet(
      state: object["BackendState"] as? String ?? "Stopped",
      hostname: (selfObject["DNSName"] as? String ?? "").trimmingCharacters(
        in: CharacterSet(charactersIn: ".")))
  }
  public func routes() throws -> [String: Any] {
    let result = try runner.run(executable, ["serve", "status", "--json"], timeout: 10)
    guard result.status == 0,
      let object = try JSONSerialization.jsonObject(with: result.output) as? [String: Any]
    else { throw SynkError.message("Couldn't check existing Tailscale routes.") }
    return object
  }
  public static func chooseRoute(
    host: String, localPort: Int, config: [String: Any], excluded: Set<Int> = []
  ) throws -> RouteChoice {
    guard host.range(of: "^[a-zA-Z0-9.-]+\\.ts\\.net$", options: .regularExpression) != nil else {
      throw SynkError.message("Tailscale hasn't provided a private HTTPS address yet.")
    }
    let web = config["Web"] as? [String: Any] ?? [:]
    let tcp = config["TCP"] as? [String: Any] ?? [:]
    let funnel = config["AllowFunnel"] as? [String: Bool] ?? [:]
    let proxy = "http://127.0.0.1:\(localPort)"
    for port in httpsPorts where !excluded.contains(port) {
      let key = "\(host):\(port)"
      if funnel[key] == true { continue }
      if let route = web[key] as? [String: Any], let handlers = route["Handlers"] as? [String: Any],
        handlers.count == 1, let root = handlers["/"] as? [String: Any],
        root["Proxy"] as? String == proxy
      {
        return RouteChoice(
          httpsPort: port, localPort: localPort,
          origin: "https://\(host)" + (port == 443 ? "" : ":\(port)"), alreadyConfigured: true)
      }
      if web[key] == nil && tcp[String(port)] == nil
        && !web.keys.contains(where: { $0.hasSuffix(":\(port)") })
        && !funnel.keys.contains(where: { $0.hasSuffix(":\(port)") && funnel[$0] == true })
      {
        return RouteChoice(
          httpsPort: port, localPort: localPort,
          origin: "https://\(host)" + (port == 443 ? "" : ":\(port)"), alreadyConfigured: false)
      }
    }
    throw SynkError.message(
      "No private HTTPS port is available. Check existing Tailscale services, then try again.")
  }
  public func configure(_ route: RouteChoice, host: String) throws {
    let current = try Self.chooseRoute(
      host: host, localPort: route.localPort, config: routes(),
      excluded: Set(Self.httpsPorts.filter { $0 != route.httpsPort }))
    guard current.httpsPort == route.httpsPort else {
      throw SynkError.message("That Tailscale route changed. Check again before continuing.")
    }
    if !current.alreadyConfigured {
      let result = try runner.run(
        executable,
        [
          "serve", "--bg", "--yes", "--https=\(route.httpsPort)",
          "http://127.0.0.1:\(route.localPort)",
        ], timeout: 25)
      guard result.status == 0 else {
        throw SynkError.message(
          "Tailscale needs HTTPS permission. Open its admin console, enable HTTPS certificates, and try again."
        )
      }
    }
    let after = try Self.chooseRoute(
      host: host, localPort: route.localPort, config: routes(),
      excluded: Set(Self.httpsPorts.filter { $0 != route.httpsPort }))
    guard after.alreadyConfigured else {
      throw SynkError.message("The private route couldn't be verified.")
    }
  }
}
