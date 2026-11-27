import AppKit
import SwiftUI
import TalloSweepKit

/// The window that opens from the menu bar.
struct PopoverView: View {
  let model: SweepModel
  /// True when shown in its own window rather than the menu bar window.
  var inWindow = false
  @Environment(\.openSettings) private var openSettings
  @Environment(\.openWindow) private var openWindow
  @State private var contentHeight: CGFloat = 420

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(spacing: 16) {
          StateCard(model: model)
          ControlBar(model: model)
          ProblemList(model: model)
          if let status = model.status, model.isAlive || model.health != .notRunning {
            if model.isAlive {
              MetricGrid(status: status)
              LaneList(status: status)
            }
          }
          EventList(events: model.events)
        }
        .padding(16)
        .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { contentHeight = $0 }
      }
      .scrollIndicators(.never)
      .scrollBounceBehavior(.basedOnSize)
      // The window fits its content up to a limit, then scrolls.
      .frame(height: min(contentHeight, Self.maxContentHeight))
      Divider().opacity(0.5)
      footer
    }
    .frame(width: 400)
  }

  private static let maxContentHeight: CGFloat = 620

  private var footer: some View {
    HStack(spacing: 4) {
      if let read = model.lastRead, model.isAlive {
        Text("Updated \(read, style: .relative) ago").font(.caption2).foregroundStyle(.tertiary)
      }
      Spacer()
      Button {
        model.openLogs()
      } label: {
        Image(systemName: "folder")
      }
      .help("Open the log folder")
      .accessibilityLabel("Open log folder")
      if !inWindow {
        Button {
          NSApp.activate()
          openWindow(id: DashboardWindow.id)
        } label: {
          Image(systemName: "macwindow")
        }
        .help("Open in a window")
        .accessibilityLabel("Open in a window")
      }
      Button {
        NSApp.activate()
        openSettings()
      } label: {
        Image(systemName: "gearshape")
      }
      .help("Settings")
      .accessibilityLabel("Settings")
      Button {
        QuitFlow.run(model: model)
      } label: {
        Image(systemName: "power")
      }
      .help("Quit Tallo Sweep")
      .accessibilityLabel("Quit")
    }
    .buttonStyle(.borderless)
    .controlSize(.regular)
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
  }
}

/// Quit, asking what to do with a sweep that is still going.
@MainActor
enum QuitFlow {
  static func run(model: SweepModel) {
    guard model.isActive else {
      NSApp.terminate(nil)
      return
    }
    let alert = NSAlert()
    alert.messageText = "A sweep is still running"
    alert.informativeText = "You can leave it running in the background, or stop it first. It resumes where it left off either way."
    alert.addButton(withTitle: "Quit and Keep Running")
    alert.addButton(withTitle: "Stop Sweep and Quit")
    alert.addButton(withTitle: "Cancel")
    NSApp.activate()
    switch alert.runModal() {
    case .alertFirstButtonReturn:
      NSApp.terminate(nil)
    case .alertSecondButtonReturn:
      model.stop()
      NSApp.terminate(nil)
    default:
      break
    }
  }
}
