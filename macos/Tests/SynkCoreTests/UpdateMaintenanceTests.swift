import XCTest

@testable import SynkCore

final class UpdateMaintenanceTests: XCTestCase {
  func fixture() throws -> (URL, URL, URL, Int) {
    guard let path = ProcessInfo.processInfo.environment["SYNK_TEST_RELAY"] else {
      throw XCTSkip("SYNK_TEST_RELAY is required")
    }
    let directory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
      .appendingPathComponent("synk-update-tests-\(UUID())")
    try PrivateFiles.directory(directory)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let root = directory.appendingPathComponent("data")
    let app = directory.appendingPathComponent("Fixture.app")
    try PrivateFiles.directory(app.appendingPathComponent("Contents/MacOS"))
    for name in ["synk-agent", "synk-server"] {
      try Data("old binary".utf8).write(to: app.appendingPathComponent("Contents/MacOS/\(name)"))
    }
    try setVersion("0.3.0", app: app)
    let relay = URL(fileURLWithPath: path)
    let install = Installation(root: root, relay: relay)
    let port = try install.availableLocalPort(excluding: [])
    try install.create(
      Profile(
        name: "personal", port: port, serverURL: "https://test.example.ts.net",
        deviceName: "Browser"))
    try install.create(
      Profile(
        name: "paused", port: port + 1, serverURL: "https://test.example.ts.net:8443",
        deviceName: "Paused browser"))
    try Operations(root: root, relay: relay).setPaused("paused", paused: true)
    return (root, app, relay, port)
  }
  func setVersion(_ version: String, app: URL) throws {
    try PropertyListSerialization.data(
      fromPropertyList: ["CFBundleVersion": version], format: .xml, options: 0
    ).write(to: app.appendingPathComponent("Contents/Info.plist"), options: .atomic)
  }
  func wait(_ condition: () async throws -> Bool) async throws {
    for _ in 0..<100 {
      if try await condition() { return }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    XCTFail("Timed out waiting for update handover")
    throw SynkError.message("Test timed out")
  }
  func start(root: URL, app: URL, relay: URL) -> Task<Void, Error> {
    let stop = StopFlag()
    let task = Task { try await Supervisor(root: root, relay: relay, app: app).run(stop: stop) }
    addTeardownBlock {
      stop.stop()
      _ = try? await task.value
    }
    return task
  }
  func testUpgradeRestartsNewGenerationAndPreservesAccountsPausedStateAndFreshSnapshots()
    async throws
  {
    let (root, app, relay, port) = try fixture()
    let before = try Data(contentsOf: root.appendingPathComponent("runtime.json"))
    let credential = try Data(
      contentsOf: root.appendingPathComponent("accounts/personal/connection.json"))
    let old = start(root: root, app: app, relay: relay)
    try await wait { await Supervisor.readiness(port: port) }
    let maintenance = UpdateMaintenance(root: root, relay: relay)
    let id = try await maintenance.prepare(
      targetVersion: "0.4.0", generation: AppGeneration(app: app))!
    let stopped = await Supervisor.readiness(port: port)
    XCTAssertFalse(stopped)
    let snapshot = root.appendingPathComponent("updates/\(id)/personal/relay.sqlite")
    try Operations(root: root, relay: relay).verify(snapshot)
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("runtime.json")), before)
    XCTAssertEqual(
      try Data(contentsOf: root.appendingPathComponent("updates/\(id)/personal/connection.json")),
      credential)
    try setVersion("0.4.0", app: app)
    try await old.value
    // Losing approval/registration must not turn a formerly running server into an
    // apparently successful offline update, even if ServiceManagement now reports disabled.
    do {
      _ = try await maintenance.verifyRestart(
        generation: AppGeneration(app: app), helperExpected: false, timeout: 0.1)
      XCTFail("Expected a missing previously running helper to fail recovery")
    } catch { XCTAssertTrue(error.localizedDescription.contains("hasn't restarted")) }
    _ = start(root: root, app: app, relay: relay)
    try await wait { await Supervisor.readiness(port: port) }
    XCTAssertEqual(try maintenance.status()?.phase, .completed)
    let verified = try await maintenance.verifyRestart(
      generation: AppGeneration(app: app), helperExpected: true, timeout: 10)
    XCTAssertTrue(verified)
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("runtime.json")), before)
    XCTAssertEqual(
      try Data(contentsOf: root.appendingPathComponent("accounts/personal/connection.json")),
      credential)
    let paused = await Supervisor.readiness(port: port + 1)
    XCTAssertFalse(paused)
  }
  func testCancellationResumesOriginalServerWithoutChangingPausePreferences() async throws {
    let (root, app, relay, port) = try fixture()
    _ = start(root: root, app: app, relay: relay)
    try await wait { await Supervisor.readiness(port: port) }
    let maintenance = UpdateMaintenance(root: root, relay: relay)
    let id = try await maintenance.prepare(
      targetVersion: "0.4.0", generation: AppGeneration(app: app))!
    try maintenance.cancel(id)
    try await wait { await Supervisor.readiness(port: port) }
    XCTAssertEqual(
      try StatusFiles.load(RuntimeSettings.self, at: root.appendingPathComponent("runtime.json"))
        .paused, ["paused"])
  }
  func testFailedBackupLeavesRunningServerAvailable() async throws {
    let (root, app, relay, port) = try fixture()
    _ = start(root: root, app: app, relay: relay)
    try await wait { await Supervisor.readiness(port: port) }
    // A missing credential makes preparation fail before draining the running relay.
    try FileManager.default.removeItem(
      at: root.appendingPathComponent("accounts/paused/connection.json"))
    let maintenance = UpdateMaintenance(root: root, relay: relay)
    do {
      _ = try await maintenance.prepare(targetVersion: "0.4.0", generation: AppGeneration(app: app))
      XCTFail("Expected failed preparation")
    } catch {}
    XCTAssertEqual(try maintenance.status()?.phase, .failed)
    let ready = await Supervisor.readiness(port: port)
    XCTAssertTrue(ready)
  }
  func testLeaseExpiryResumesServerAfterUIHasDisappeared() async throws {
    let (root, app, relay, port) = try fixture()
    _ = start(root: root, app: app, relay: relay)
    try await wait { await Supervisor.readiness(port: port) }
    let request = try UpdateRequest(targetVersion: "0.4.0", lease: 8)
    try StatusFiles.save(request, to: root.appendingPathComponent("update-request.json"))
    let maintenance = UpdateMaintenance(root: root, relay: relay)
    try await wait { try maintenance.status()?.phase == .ready }
    let stopped = await Supervisor.readiness(port: port)
    XCTAssertFalse(stopped)
    try await wait { await Supervisor.readiness(port: port) }
    XCTAssertEqual(
      try StatusFiles.load(RuntimeSettings.self, at: root.appendingPathComponent("runtime.json"))
        .paused, ["paused"])
  }
  func testOfflineUpdatePreservesDisabledHelperAndDetectsChangedCredentials() async throws {
    let (root, app, relay, _) = try fixture()
    let maintenance = UpdateMaintenance(root: root, relay: relay)
    _ = try await maintenance.prepare(targetVersion: "0.4.0", generation: AppGeneration(app: app))
    try setVersion("0.4.0", app: app)
    let verified = try await maintenance.verifyRestart(
      generation: AppGeneration(app: app), helperExpected: false)
    XCTAssertTrue(verified)
    XCTAssertFalse(try maintenance.helperRunning())
    _ = try await maintenance.prepare(targetVersion: "0.5.0", generation: AppGeneration(app: app))
    try setVersion("0.5.0", app: app)
    try PrivateFiles.write(
      Data("changed".utf8), to: root.appendingPathComponent("accounts/personal/connection.json"))
    do {
      _ = try await maintenance.verifyRestart(
        generation: AppGeneration(app: app), helperExpected: false)
      XCTFail("Expected preservation failure")
    } catch { XCTAssertTrue(error.localizedDescription.contains("settings changed")) }
  }
  func testMissingEnabledHelperReportsRecoveryFailureWithoutRestoringOrChangingData() async throws {
    let (root, app, relay, _) = try fixture()
    let maintenance = UpdateMaintenance(root: root, relay: relay)
    let credential = try Data(
      contentsOf: root.appendingPathComponent("accounts/personal/connection.json"))
    _ = try await maintenance.prepare(targetVersion: "0.4.0", generation: AppGeneration(app: app))
    try setVersion("0.4.0", app: app)
    do {
      _ = try await maintenance.verifyRestart(
        generation: AppGeneration(app: app), helperExpected: true, timeout: 0.1)
      XCTFail("Expected restart health failure")
    } catch { XCTAssertTrue(error.localizedDescription.contains("hasn't restarted")) }
    XCTAssertEqual(
      try Data(contentsOf: root.appendingPathComponent("accounts/personal/connection.json")),
      credential)
    XCTAssertEqual(try maintenance.status()?.phase, .ready)
  }
  func testExpiredRequestNeverPausesServerAndForeignDataRemainsUntouched() async throws {
    let (root, app, relay, port) = try fixture()
    let request = try UpdateRequest(targetVersion: "0.4.0", now: Date().addingTimeInterval(-601))
    try StatusFiles.save(request, to: root.appendingPathComponent("update-request.json"))
    _ = start(root: root, app: app, relay: relay)
    try await wait { await Supervisor.readiness(port: port) }
    XCTAssertNil(try UpdateMaintenance(root: root, relay: relay).status())
    let foreign = root.deletingLastPathComponent().appendingPathComponent("foreign")
    try PrivateFiles.directory(foreign)
    let sentinel = foreign.appendingPathComponent("private.txt")
    try Data("existing data".utf8).write(to: sentinel)
    let result = try await UpdateMaintenance(root: foreign, relay: relay).prepare(
      targetVersion: "0.4.0", generation: AppGeneration(app: app))
    XCTAssertNil(result)
    XCTAssertEqual(try String(contentsOf: sentinel), "existing data")
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: foreign.path), ["private.txt"])
  }
}
