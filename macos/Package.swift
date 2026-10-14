// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "HeliumSynkServer",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "HeliumSynkServer", targets: ["SynkServerApp"]),
    .executable(name: "synk-agent", targets: ["SynkAgent"]),
    .executable(name: "synk-preview", targets: ["SynkPreview"]),
  ],
  targets: [
    .target(name: "SynkCore"),
    .target(name: "SynkUI", dependencies: ["SynkCore"]),
    .executableTarget(name: "SynkServerApp", dependencies: ["SynkUI"]),
    .executableTarget(name: "SynkAgent", dependencies: ["SynkCore"]),
    .executableTarget(name: "SynkPreview", dependencies: ["SynkUI"]),
    .testTarget(name: "SynkCoreTests", dependencies: ["SynkCore"]),
    .testTarget(name: "SynkUITests", dependencies: ["SynkUI", "SynkCore"]),
  ]
)
