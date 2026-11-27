import SwiftUI
import TalloSweepKit

/// Start, pause and stop. Glass buttons that blend together, as one control.
struct ControlBar: View {
  let model: SweepModel

  var body: some View {
    GlassEffectContainer(spacing: 10) {
      HStack(spacing: 10) {
        primary
        if model.isActive {
          Button(role: .destructive) {
            model.stop()
          } label: {
            Label(model.phase == .draining ? "Stop now" : "Stop", systemImage: "stop.fill")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.glass)
          .help(
            model.phase == .draining
              ? "End the sweep immediately, without letting boards finish."
              : "Let the boards in flight finish, then exit.")
        }
      }
      .controlSize(.large)
    }
  }

  @ViewBuilder private var primary: some View {
    if !model.isActive {
      Button {
        model.start()
      } label: {
        Label(model.phase == .finished ? "Run again" : "Start", systemImage: "play.fill")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.glassProminent)
      .keyboardShortcut(.defaultAction)
    } else if model.pause.reasons.contains(.user) {
      Button {
        model.resumeByUser()
      } label: {
        Label("Resume", systemImage: "play.fill").frame(maxWidth: .infinity)
      }
      .buttonStyle(.glassProminent)
    } else {
      Button {
        model.pauseByUser()
      } label: {
        Label("Pause", systemImage: "pause.fill").frame(maxWidth: .infinity)
      }
      .buttonStyle(.glassProminent)
      .disabled(model.phase == .draining)
    }
  }
}
