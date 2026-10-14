import AppKit

public enum SynkBranding {
  /// The Helium six-spoke mark and sync arrows, simplified for an 18-point status item.
  /// A drawing-backed template stays sharp at each display's native scale.
  public static let menuBarImage: NSImage = {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { rect in
      guard let context = NSGraphicsContext.current?.cgContext else { return false }
      context.saveGState()
      defer { context.restoreGState() }
      context.translateBy(x: rect.minX, y: rect.minY)
      context.scaleBy(x: rect.width / 100, y: rect.height / 100)
      context.setShouldAntialias(true)
      context.setFillColor(NSColor.black.cgColor)
      context.setStrokeColor(NSColor.black.cgColor)
      context.setLineWidth(7)
      context.setLineCap(.round)
      context.move(to: CGPoint(x: 10, y: 50))
      context.addCurve(
        to: CGPoint(x: 50, y: 10), control1: CGPoint(x: 10, y: 28),
        control2: CGPoint(x: 28, y: 10))
      context.addCurve(
        to: CGPoint(x: 86, y: 32), control1: CGPoint(x: 66, y: 10),
        control2: CGPoint(x: 79, y: 19))
      context.strokePath()
      context.move(to: CGPoint(x: 90, y: 50))
      context.addCurve(
        to: CGPoint(x: 50, y: 90), control1: CGPoint(x: 90, y: 72),
        control2: CGPoint(x: 72, y: 90))
      context.addCurve(
        to: CGPoint(x: 14, y: 68), control1: CGPoint(x: 34, y: 90),
        control2: CGPoint(x: 21, y: 81))
      context.strokePath()
      for points: [CGPoint] in [
        [CGPoint(x: 92, y: 20), CGPoint(x: 92, y: 42), CGPoint(x: 72, y: 32)],
        [CGPoint(x: 8, y: 58), CGPoint(x: 28, y: 68), CGPoint(x: 8, y: 80)],
        [
          CGPoint(x: 46, y: 30), CGPoint(x: 50, y: 27), CGPoint(x: 54, y: 30),
          CGPoint(x: 53, y: 44), CGPoint(x: 65, y: 36), CGPoint(x: 70, y: 39),
          CGPoint(x: 69, y: 44), CGPoint(x: 56, y: 50), CGPoint(x: 69, y: 56),
          CGPoint(x: 70, y: 61), CGPoint(x: 65, y: 64), CGPoint(x: 53, y: 56),
          CGPoint(x: 54, y: 70), CGPoint(x: 50, y: 73), CGPoint(x: 46, y: 70),
          CGPoint(x: 47, y: 56), CGPoint(x: 35, y: 64), CGPoint(x: 30, y: 61),
          CGPoint(x: 31, y: 56), CGPoint(x: 44, y: 50), CGPoint(x: 31, y: 44),
          CGPoint(x: 30, y: 39), CGPoint(x: 35, y: 36), CGPoint(x: 47, y: 44),
        ],
      ] {
        context.addLines(between: points)
        context.closePath()
        context.fillPath()
      }
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "Helium Synk Server"
    return image
  }()
}
