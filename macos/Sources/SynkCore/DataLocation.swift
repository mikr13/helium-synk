import CoreFoundation
import Foundation

/// The app and its launch agent share this application preference domain.
/// Access it directly: UserDefaults(suiteName:) cannot use the caller's own bundle ID.
public struct DataLocation {
  private let domain: String
  public init(domain: String = "com.heliumsynk.server") { self.domain = domain }

  public var root: URL {
    guard
      let path = CFPreferencesCopyAppValue("dataRoot" as CFString, domain as CFString) as? String,
      path.hasPrefix("/")
    else { return PrivateFiles.defaultRoot }
    return URL(fileURLWithPath: path)
  }

  public func save(_ root: URL) throws {
    CFPreferencesSetAppValue("dataRoot" as CFString, root.path as CFString, domain as CFString)
    guard CFPreferencesAppSynchronize(domain as CFString) else {
      throw SynkError.message("Couldn't save the server's data location. Its files have been kept.")
    }
  }
}
