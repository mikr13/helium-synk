import XCTest

@testable import SynkCore

final class CoreTests: XCTestCase {
  func fixture() throws -> URL {
    let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
      .appendingPathComponent("synk-tests-\(UUID().uuidString)")
    try PrivateFiles.directory(root)
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    return root
  }
  func profile(
    _ name: String = "personal", port: Int = 4318, origin: String = "https://test.example.ts.net"
  ) -> Profile {
    Profile(name: name, port: port, serverURL: origin, deviceName: "My browser")
  }
  func testConfigurationPreservesLegacyFormatAndRejectsUnsafeSharing() throws {
    let root = try fixture()
    let first = profile()
    try PrivateFiles.save(
      Deployment(profiles: [first.name: first]), to: root.appendingPathComponent("deployment.json"))
    XCTAssertEqual(try Deployment.load(root: root).profiles["personal"], first)
    let json =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: root.appendingPathComponent("deployment.json"))) as! [String: Any]
    XCTAssertEqual(
      (json["profiles"] as! [String: [String: Any]])["personal"]?["server_url"] as? String,
      first.serverURL)
    for invalid in [
      profile("../outside"), profile("one", origin: "https://public.example.com"),
      profile("one", origin: "https://test.example.ts.net/path"),
      profile("one", origin: "https://me:secret@test.example.ts.net"), profile("one", port: 80),
      profile("one", origin: "http://localhost:9999"),
    ] {
      XCTAssertThrowsError(try Deployment(profiles: [invalid.name: invalid]).validated())
    }
    XCTAssertThrowsError(
      try Deployment(profiles: ["personal": first, "other": profile("other")]).validated())
    XCTAssertThrowsError(
      try Deployment(profiles: ["personal": first, "other": profile("other", port: 4319)])
        .validated())
  }
  func testConfigurationDefaultsAndUnknownFieldsFailWithoutRewriting() throws {
    let root = try fixture()
    let file = root.appendingPathComponent("deployment.json")
    var value: [String: Any] = [
      "version": 1,
      "profiles": [
        "personal": [
          "port": 4318, "server_url": "https://test.example.ts.net", "device_name": "My Mac",
          "backup_time": "03:10",
        ]
      ],
    ]
    try PrivateFiles.write(JSONSerialization.data(withJSONObject: value), to: file)
    XCTAssertEqual(try Deployment.load(root: root).retention["daily"], 7)
    value["future_setting"] = true
    let before = try JSONSerialization.data(withJSONObject: value)
    try PrivateFiles.write(before, to: file)
    XCTAssertThrowsError(try Deployment.load(root: root))
    XCTAssertEqual(try Data(contentsOf: file), before)
  }
  func testPrivateWritesRejectSymlinkAndNeverExposeCredentialPermissions() throws {
    let root = try fixture()
    let target = root.appendingPathComponent("credential.json")
    try PrivateFiles.write(Data("secret".utf8), to: target)
    XCTAssertEqual(
      (try FileManager.default.attributesOfItem(atPath: target.path)[.posixPermissions] as! NSNumber)
        .intValue, 0o600)
    let link = root.appendingPathComponent("redirect")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
    XCTAssertThrowsError(try PrivateFiles.write(Data("replace".utf8), to: link))
    XCTAssertEqual(try String(contentsOf: target), "secret")
  }
  func testRouteSelectionPreservesOtherServicesAndRejectsFunnel() throws {
    let host = "test.example.ts.net"
    let existing: [String: Any] = [
      "TCP": ["443": ["HTTPS": true]],
      "Web": ["\(host):443": ["Handlers": ["/": ["Proxy": "http://localhost:9999"]]]],
    ]
    let choice = try Tailscale.chooseRoute(host: host, localPort: 4318, config: existing)
    XCTAssertEqual(choice.httpsPort, 8443)
    XCTAssertFalse(choice.alreadyConfigured)
    let own: [String: Any] = [
      "TCP": ["443": ["HTTPS": true]],
      "Web": ["\(host):443": ["Handlers": ["/": ["Proxy": "http://127.0.0.1:4318"]]]],
    ]
    XCTAssertTrue(
      try Tailscale.chooseRoute(host: host, localPort: 4318, config: own).alreadyConfigured)
    var publicConfig = own
    publicConfig["AllowFunnel"] = ["\(host):443": true]
    XCTAssertEqual(
      try Tailscale.chooseRoute(host: host, localPort: 4318, config: publicConfig).httpsPort, 8443)
    XCTAssertThrowsError(
      try Tailscale.chooseRoute(
        host: host, localPort: 4318, config: existing,
        excluded: Set(Tailscale.httpsPorts.filter { $0 != 443 })))
    XCTAssertThrowsError(
      try Tailscale.chooseRoute(host: "evil.test/path.ts.net", localPort: 4318, config: [:]))
  }
  func testRouteChangeBetweenPreviewAndApplyNeverWrites() throws {
    let host = "test.example.ts.net"
    let runner = FakeRunner { _, args in
      XCTAssertEqual(args, ["serve", "status", "--json"])
      return CommandResult(status: 0, output: Data("{\"TCP\":{\"443\":{\"HTTPS\":true}}}".utf8))
    }
    let tailscale = Tailscale(executable: URL(fileURLWithPath: "/fake"), runner: runner)
    XCTAssertThrowsError(
      try tailscale.configure(
        RouteChoice(
          httpsPort: 443, localPort: 4318, origin: "https://\(host)", alreadyConfigured: false),
        host: host))
  }
  func testLegacyInstallationNeverGetsTakenOver() throws {
    let root = try fixture()
    let first = profile()
    try PrivateFiles.save(
      Deployment(profiles: [first.name: first]), to: root.appendingPathComponent("deployment.json"))
    let before = try Data(contentsOf: root.appendingPathComponent("deployment.json"))
    let runner = FakeRunner { _, _ in
      XCTFail("Legacy installs must never execute changes")
      return CommandResult(status: 1, output: Data())
    }
    let install = Installation(root: root, relay: URL(fileURLWithPath: "/fake"), runner: runner)
    XCTAssertTrue(install.legacy)
    XCTAssertThrowsError(
      try install.create(profile("other", port: 4319, origin: "https://test.example.ts.net:8443")))
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("deployment.json")), before)
  }
  func testLegacyLayoutWithoutDeploymentMetadataIsRecognizedAndPreserved() throws {
    let root = try fixture()
    let account = root.appendingPathComponent("accounts/personal")
    try PrivateFiles.directory(account)
    let database = account.appendingPathComponent("relay.sqlite")
    let original = Data("existing private account data".utf8)
    try PrivateFiles.write(original, to: database)
    let runner = FakeRunner { _, _ in
      XCTFail("An old account layout must never trigger setup commands")
      return CommandResult(status: 1, output: Data())
    }
    let install = Installation(root: root, relay: URL(fileURLWithPath: "/fake"), runner: runner)
    XCTAssertFalse(install.exists)
    XCTAssertTrue(install.legacy)
    XCTAssertThrowsError(try install.create(profile("new")))
    XCTAssertEqual(try Data(contentsOf: database), original)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: root.appendingPathComponent("deployment.json").path))
  }
  func testFailedInitialBackupNeverCommitsAnAccount() throws {
    let parent = try fixture()
    let root = parent.appendingPathComponent("fresh")
    let runner = FakeRunner { _, args in
      if args.contains("issue-device"), let index = args.firstIndex(of: "--output") {
        try Data("credential".utf8).write(to: URL(fileURLWithPath: args[index + 1]))
        return CommandResult(status: 0, output: Data())
      }
      return CommandResult(status: 1, output: Data())
    }
    XCTAssertThrowsError(
      try Installation(root: root, relay: URL(fileURLWithPath: "/fake"), runner: runner).create(
        profile()))
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: root.appendingPathComponent("deployment.json").path))
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: root.appendingPathComponent("accounts/personal").path))
    XCTAssertFalse(
      (try? FileManager.default.contentsOfDirectory(atPath: root.path).contains {
        $0.hasPrefix(".setup-")
      }) ?? false)
  }
  func testRealRelayInstallAddBackupAndPausePreserveIdentity() async throws {
    guard let path = ProcessInfo.processInfo.environment["SYNK_TEST_RELAY"] else {
      throw XCTSkip("Set SYNK_TEST_RELAY to run the real native operations flow")
    }
    let parent = try fixture()
    let root = parent.appendingPathComponent("fresh")
    let relay = URL(fileURLWithPath: path)
    let install = Installation(root: root, relay: relay)
    let port = try install.availableLocalPort(excluding: [])
    let first = profile(port: port)
    try install.create(first)
    let credentials = try Data(
      contentsOf: root.appendingPathComponent("accounts/personal/connection.json"))
    let database = try Data(
      contentsOf: root.appendingPathComponent("accounts/personal/relay.sqlite"))
    let second = profile("work", port: port + 1, origin: "https://test.example.ts.net:8443")
    try install.create(second)
    XCTAssertEqual(
      try Data(contentsOf: root.appendingPathComponent("accounts/personal/connection.json")),
      credentials)
    XCTAssertEqual(
      try Data(contentsOf: root.appendingPathComponent("accounts/personal/relay.sqlite")), database)
    let operations = Operations(root: root, relay: relay)
    let date = Date()
    let backup = try operations.backup("personal", now: date)
    XCTAssertTrue(backup.ok)
    let contents = try Data(
      contentsOf: root.appendingPathComponent("accounts/personal/backups/\(backup.snapshot)"))
    _ = try operations.backup("personal", now: date)
    XCTAssertEqual(
      try Data(
        contentsOf: root.appendingPathComponent("accounts/personal/backups/\(backup.snapshot)")),
      contents)
    try operations.setPaused("work", paused: true)
    let stop = StopFlag()
    try await Supervisor(root: root, relay: relay).run(stop: stop, once: true)
    let health = try StatusFiles.load(
      HealthStatus.self, at: root.appendingPathComponent("accounts/personal/health-status.json"))
    XCTAssertFalse(health.problems.contains("Server is not responding"))
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: root.appendingPathComponent("accounts/work/health-status.json").path))
    XCTAssertEqual(
      try Data(contentsOf: root.appendingPathComponent("accounts/personal/connection.json")),
      credentials)
    let stopped = await Supervisor.readiness(port: port)
    XCTAssertFalse(stopped)
    let secondCredential =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: root.appendingPathComponent("accounts/work/connection.json")))
      as! [String: Any]
    let firstCredential = try JSONSerialization.jsonObject(with: credentials) as! [String: Any]
    XCTAssertNotEqual(
      firstCredential["account_id"] as? String, secondCredential["account_id"] as? String)
  }
}
struct FakeRunner: CommandRunning, @unchecked Sendable {
  let handler: (URL, [String]) throws -> CommandResult
  init(_ handler: @escaping (URL, [String]) throws -> CommandResult) { self.handler = handler }
  func run(_ executable: URL, _ arguments: [String], timeout: TimeInterval) throws -> CommandResult
  { try handler(executable, arguments) }
}
