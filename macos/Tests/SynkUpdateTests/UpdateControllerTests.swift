import Foundation
import Sparkle
import SynkCore
import XCTest

@testable import SynkServerApp

@MainActor final class UpdateControllerTests: XCTestCase {
  func fixture() throws -> (UpdateController, UpdateMaintenance, URL) {
    guard let path = ProcessInfo.processInfo.environment["SYNK_TEST_RELAY"] else {
      throw XCTSkip("SYNK_TEST_RELAY is required")
    }
    let directory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
      .appendingPathComponent("synk-update-choice-\(UUID())")
    let app = directory.appendingPathComponent("Fixture.app")
    let root = directory.appendingPathComponent("data")
    try PrivateFiles.directory(app.appendingPathComponent("Contents/MacOS"))
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let relay = app.appendingPathComponent("Contents/MacOS/synk-server")
    try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: relay)
    try Data("fixture agent".utf8).write(
      to: app.appendingPathComponent("Contents/MacOS/synk-agent"))
    try PropertyListSerialization.data(
      fromPropertyList: ["CFBundleVersion": "0.3.0"], format: .xml, options: 0
    ).write(to: app.appendingPathComponent("Contents/Info.plist"))
    try Installation(root: root, relay: relay).create(
      Profile(
        name: "personal", port: 45678, serverURL: "http://127.0.0.1:45678", deviceName: "Fixture"))
    let controller = UpdateController(applicationURL: app, dataRoot: { root })
    controller.offer(version: "0.4.0", displayVersion: "0.4.0")
    return (controller, UpdateMaintenance(root: root, relay: relay), root)
  }
  func testDownloadChoiceWaitsForBackupAndFinalChoiceReusesValidHandover() async throws {
    let (controller, maintenance, root) = try fixture()
    let download = expectation(description: "download allowed only after backup")
    var initialChoice: SPUUserUpdateChoice?
    controller.select(.install, requiresHandover: true, finalStage: false) { choice in
      initialChoice = choice
      download.fulfill()
    }
    XCTAssertNil(initialChoice)
    XCTAssertTrue(controller.preparing)
    await fulfillment(of: [download], timeout: 10)
    XCTAssertEqual(initialChoice, .install)
    let request = try XCTUnwrap(maintenance.request())
    XCTAssertEqual(try maintenance.status()?.phase, .ready)
    try Operations(root: root, relay: maintenance.relay).verify(
      root.appendingPathComponent("updates/\(request.id)/personal/relay.sqlite"))
    XCTAssertFalse(controller.mayQuit)
    let install = expectation(description: "install and relaunch allowed")
    controller.select(.install, requiresHandover: true) { choice in
      XCTAssertEqual(choice, .install)
      install.fulfill()
    }
    await fulfillment(of: [install], timeout: 10)
    XCTAssertEqual(try maintenance.request()?.id, request.id)
    XCTAssertTrue(controller.mayQuit)
    controller.finished()
    XCTAssertEqual(try maintenance.request()?.action, .cancel)
  }
  func testFailedBackupPreventsDownloadingAndLeavesAnActionableError() async throws {
    let (controller, maintenance, root) = try fixture()
    try FileManager.default.removeItem(
      at: root.appendingPathComponent("accounts/personal/connection.json"))
    let failed = expectation(description: "failed preflight")
    controller.select(.install, requiresHandover: true, finalStage: false) { choice in
      XCTAssertEqual(choice, .skip)
      failed.fulfill()
    }
    await fulfillment(of: [failed], timeout: 10)
    XCTAssertNotNil(controller.error)
    XCTAssertEqual(try maintenance.request()?.action, .cancel)
    XCTAssertFalse(controller.updating)
  }
  func testAbortedPreparationCannotStartDownloadLater() async throws {
    let (controller, maintenance, _) = try fixture()
    let cancelled = expectation(description: "cancelled preparation")
    controller.select(.install, requiresHandover: true, finalStage: false) { choice in
      XCTAssertEqual(choice, .skip)
      cancelled.fulfill()
    }
    controller.finished()
    await fulfillment(of: [cancelled], timeout: 10)
    XCTAssertEqual(try maintenance.request()?.action, .cancel)
    XCTAssertNil(controller.error)
    XCTAssertFalse(controller.updating)
  }
  func testClosingStagedUpdateCancelsItsImplicitInstallOnQuit() throws {
    let (controller, _, _) = try fixture()
    var reply: SPUUserUpdateChoice?
    controller.select(.dismiss, requiresHandover: true) { reply = $0 }
    XCTAssertEqual(reply, .skip)
    for selector in [
      "standardUserDriverShouldHandleShowingScheduledUpdate:andInImmediateFocus:",
      "standardUserDriverWillFinishUpdateSession",
    ] {
      XCTAssertTrue(controller.responds(to: NSSelectorFromString(selector)))
    }
  }
}
