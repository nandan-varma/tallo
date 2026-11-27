import SwiftUI
import TalloSweepKit

@main
struct TalloSweepApp: App {
  @State private var model: SweepModel

  init() {
    let model = SweepModel(paths: Self.paths())
    _model = State(initialValue: model)
    model.begin()
  }

  /// `--sweep-dir <folder>` points the app at another set of sweep files (for trying it without a real sweep).
  private static func paths() -> SweepPaths {
    let arguments = CommandLine.arguments
    if let flag = arguments.firstIndex(of: "--sweep-dir"), arguments.indices.contains(flag + 1) {
      return SweepPaths(directory: URL(fileURLWithPath: arguments[flag + 1], isDirectory: true))
    }
    return .standard
  }

  var body: some Scene {
    MenuBarExtra {
      PopoverView(model: model)
    } label: {
      MenuBarLabel(model: model)
    }
    .menuBarExtraStyle(.window)

    // The same view in an ordinary window, for keeping it on screen. Not opened at launch.
    Window("Tallo Sweep", id: DashboardWindow.id) {
      PopoverView(model: model, inWindow: true)
    }
    .windowResizability(.contentSize)
    .defaultLaunchBehavior(.suppressed)

    Settings {
      SettingsView(model: model)
    }
  }
}

enum DashboardWindow {
  static let id = "dashboard"
}
