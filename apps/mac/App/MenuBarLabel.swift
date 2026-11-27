import AppKit
import SwiftUI

/// What sits in the menu bar: a symbol for the state and, while seeding, how far along it is.
struct MenuBarLabel: View {
  let model: SweepModel
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    let phase = model.phase
    HStack(spacing: 4) {
      Image(systemName: phase.symbol)
        .symbolRenderingMode(.hierarchical)
      if let percent {
        Text("\(percent)%").monospacedDigit()
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Tallo Sweep")
    .accessibilityValue(accessibilityValue(phase))
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
      model.end()
    }
    .task {
      if CommandLine.arguments.contains("--show-dashboard") {
        NSApp.activate()
        openWindow(id: DashboardWindow.id)
      }
    }
  }

  private var percent: Int? {
    guard model.isAlive, let status = model.status else { return nil }
    return Int((status.overallProgress * 100).rounded(.down))
  }

  private func accessibilityValue(_ phase: SweepModel.Phase) -> String {
    percent.map { "\(phase.title), \($0) percent" } ?? phase.title
  }
}
