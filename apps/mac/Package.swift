// swift-tools-version: 6.2
import PackageDescription

// The logic of the Tallo Sweep menu-bar app: what the sweep writes, what the app writes back, and when to pause.
// No UI here, so it builds and tests with `swift test` and no Xcode project.
let package = Package(
  name: "TalloSweepKit",
  platforms: [.macOS("27.0")],
  products: [.library(name: "TalloSweepKit", targets: ["TalloSweepKit"])],
  targets: [
    .target(
      name: "TalloSweepKit",
      swiftSettings: [.enableUpcomingFeature("NonisolatedNonsendingByDefault")]
    ),
    .testTarget(
      name: "TalloSweepKitTests", dependencies: ["TalloSweepKit"], resources: [.copy("Fixtures")]),
  ]
)
