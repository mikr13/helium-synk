import AppKit
import CoreText
import SwiftUI

public enum SynkTheme {
  public static var resourceDirectory = Bundle.main.resourceURL
  public static let background = Color(hex: 0x080e20), foreground = Color(hex: 0xeef3ff),
    card = Color(hex: 0x101b33)
  public static let primary = Color(hex: 0x4ae5cc), primaryForeground = Color(hex: 0x071e20),
    muted = Color(hex: 0x9daecc)
  public static let border = Color(hex: 0x283b5e), secondary = Color(hex: 0x1a2b50),
    blue = Color(hex: 0x5274fa), navy = Color(hex: 0x0d1b47), destructive = Color(hex: 0xff8e9b)
  public static func font(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
    .custom("Manrope", size: size).weight(weight)
  }
  public static func mono(_ size: CGFloat = 10) -> Font { .custom("IBMPlexMono", size: size) }
  public static func registerFonts(at directory: URL? = Bundle.main.resourceURL) {
    guard let directory else { return }
    resourceDirectory = directory
    for name in ["Manrope.ttf", "IBMPlexMono-Regular.ttf"] {
      CTFontManagerRegisterFontsForURL(
        directory.appendingPathComponent(name) as CFURL, .process, nil)
    }
  }
}
extension Color {
  init(hex: UInt32) {
    self.init(
      .sRGB, red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255,
      blue: Double(hex & 255) / 255, opacity: 1)
  }
}
public struct ActionStyle: ButtonStyle {
  var primary = false
  public init(primary: Bool = false) { self.primary = primary }
  @Environment(\.isEnabled) private var enabled
  public func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(SynkTheme.font(13, weight: .bold)).padding(.horizontal, 18).padding(
      .vertical, 12
    )
    .foregroundStyle(primary ? SynkTheme.primaryForeground : SynkTheme.foreground)
    .background(primary ? SynkTheme.primary : SynkTheme.secondary)
    .overlay(Rectangle().stroke(primary ? SynkTheme.primary : SynkTheme.border, lineWidth: 1))
    .opacity(!enabled ? 0.4 : configuration.isPressed ? 0.75 : 1)
  }
}
struct Eyebrow: View {
  let text: String
  var body: some View {
    Text(text.uppercased()).font(SynkTheme.mono()).tracking(1.8).foregroundStyle(SynkTheme.muted)
  }
}
struct Signal: View {
  var good: Bool
  let text: String
  var body: some View {
    HStack(spacing: 8) {
      Rectangle().fill(good ? SynkTheme.primary : SynkTheme.muted).frame(width: 6, height: 6)
      Text(text).font(SynkTheme.mono(10))
    }.foregroundStyle(good ? SynkTheme.primary : SynkTheme.muted)
  }
}
struct Panel<Content: View>: View {
  @ViewBuilder let content: Content
  var body: some View {
    content.padding(24).frame(maxWidth: .infinity, alignment: .leading).background(SynkTheme.card)
      .overlay(Rectangle().stroke(SynkTheme.border, lineWidth: 1)).overlay(alignment: .top) {
        Rectangle().fill(SynkTheme.blue).frame(height: 2)
      }
  }
}
