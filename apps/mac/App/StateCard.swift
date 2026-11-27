import SwiftUI
import TalloSweepKit

/// The headline: what the sweep is doing, how far along it is and when it should end.
struct StateCard: View {
  let model: SweepModel

  var body: some View {
    let phase = model.phase
    HStack(spacing: 16) {
      ZStack {
        ProgressRing(progress: model.status?.overallProgress ?? 0, tint: phase.tint)
        if model.isAlive, let status = model.status {
          Text("\(Int((status.overallProgress * 100).rounded(.down)))%")
            .font(.title3.weight(.semibold))
            .monospacedDigit()
            .contentTransition(.numericText())
        } else {
          Image(systemName: phase.symbol)
            .font(.title2)
            .foregroundStyle(phase.tint)
            .symbolRenderingMode(.hierarchical)
        }
      }
      .frame(width: 72, height: 72)

      VStack(alignment: .leading, spacing: 4) {
        Text(phase.title).font(.title2.weight(.semibold))
        Text(subtitle(phase))
          .font(.callout)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        if let line = progressLine {
          Text(line).font(.caption).foregroundStyle(.tertiary).monospacedDigit()
        }
      }
      Spacer(minLength: 0)
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .glassEffect(.regular.tint(phase.tint.opacity(0.14)), in: .rect(cornerRadius: 24))
    .accessibilityElement(children: .combine)
  }

  private func subtitle(_ phase: SweepModel.Phase) -> String {
    switch phase {
    case .idle: "Press Start to begin seeding."
    case .starting: "Launching the runner."
    case .running:
      if let status = model.status {
        "\(Format.duration(Double(status.elapsedSec))) elapsed"
          + (status.etaMinutes.map { " · about \(Format.eta(minutes: $0)) left" } ?? "")
      } else { "Seeding." }
    case .held(let reason): reason.explanation
    case .draining: "Finishing the boards in flight, then exiting."
    case .finished: "Every board has been collected."
    case .stopped: "The last run was stopped."
    case .unresponsive: "It has not updated its status for a while."
    case .failed(let message): message
    }
  }

  private var progressLine: String? {
    guard model.isAlive, let status = model.status else { return nil }
    var parts = ["\(status.boardsDone) of \(status.boardsDue) boards"]
    if status.boardsFailed > 0 { parts.append("\(status.boardsFailed) failed") }
    if status.boardsStuck > 0 { parts.append("\(status.boardsStuck) stuck") }
    return parts.joined(separator: " · ")
  }
}
