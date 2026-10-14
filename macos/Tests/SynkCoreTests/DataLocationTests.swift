import CoreFoundation
import XCTest

@testable import SynkCore

final class DataLocationTests: XCTestCase {
  func testAppAndAgentReadTheSamePersistedDataRoot() throws {
    let domain = "com.heliumsynk.tests.\(UUID().uuidString)"
    defer {
      CFPreferencesSetAppValue("dataRoot" as CFString, nil, domain as CFString)
      CFPreferencesAppSynchronize(domain as CFString)
    }
    let location = DataLocation(domain: domain)
    XCTAssertEqual(location.root, PrivateFiles.defaultRoot)
    let custom = URL(fileURLWithPath: "/private/tmp/synk-data-\(UUID().uuidString)")
    try location.save(custom)
    XCTAssertEqual(DataLocation(domain: domain).root, custom)
    CFPreferencesSetAppValue(
      "dataRoot" as CFString, "relative/path" as CFString, domain as CFString)
    XCTAssertEqual(location.root, PrivateFiles.defaultRoot)
  }
}
