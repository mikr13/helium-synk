import SynkCore
import XCTest

@testable import SynkUI

final class StartupTests: XCTestCase {
  @MainActor func testNormalStartupLoadsPreferencesWithoutUsingPreviewShortcut() async {
    let model = ServerModel()
    XCTAssertEqual(model.root, DataLocation().root)
    XCTAssertEqual(model.screen, .welcome)
    XCTAssertFalse(model.busy)
  }
}
