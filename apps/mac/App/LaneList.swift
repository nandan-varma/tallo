import SwiftUI
import TalloSweepKit

/// The lanes that still have work, each with its progress; the finished ones fold away.
struct LaneList: View {
  let status: SweepStatus
  @State private var expanded: Set<String> = []
  @State private var showFinished = false

  var body: some View {
    let active = status.lanes.filter { !$0.isFinished && $0.done + $0.failedPermanent < $0.due || $0.inFlight.count > 0 }
    let finished = status.lanes.filter { lane in !active.contains(where: { $0.id == lane.id }) }
    VStack(alignment: .leading, spacing: 4) {
      SectionHeader(title: "Lanes", trailing: "\(status.boardsDone) / \(status.boardsDue) boards")
      VStack(spacing: 2) {
        ForEach(active) { lane in
          LaneRow(lane: lane, isExpanded: expanded.contains(lane.id)) {
            withAnimation(.smooth(duration: 0.25)) {
              if expanded.contains(lane.id) { expanded.remove(lane.id) } else { expanded.insert(lane.id) }
            }
          }
        }
      }
      if !finished.isEmpty {
        DisclosureGroup(isExpanded: $showFinished) {
          VStack(spacing: 2) {
            ForEach(finished) { lane in LaneRow(lane: lane, isExpanded: false, toggle: nil) }
          }
        } label: {
          Text("\(finished.count) finished").font(.caption).foregroundStyle(.secondary)
        }
        .padding(.top, 4)
      }
    }
  }
}

private struct LaneRow: View {
  let lane: SweepStatus.Lane
  let isExpanded: Bool
  let toggle: (() -> Void)?

  var body: some View {
    VStack(spacing: 6) {
      Button {
        toggle?()
      } label: {
        VStack(spacing: 5) {
          HStack(spacing: 8) {
            Text(laneTitle(lane.name)).font(.callout.weight(.medium))
            if lane.stuck > 0 || lane.failedPermanent > 0 { warning }
            Spacer()
            Text("\(lane.done) / \(lane.due)").font(.callout).monospacedDigit().foregroundStyle(.secondary)
            if toggle != nil {
              Image(systemName: "chevron.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
                .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
          }
          ProgressView(value: lane.progress)
            .progressViewStyle(.linear)
            .tint(lane.isFinished ? .blue : .green)
          HStack {
            Text(detail).font(.caption).foregroundStyle(.tertiary).monospacedDigit()
            Spacer()
            if let eta = lane.etaMin, !lane.isFinished {
              Text("about \(Format.eta(minutes: eta)) left").font(.caption).foregroundStyle(.tertiary).monospacedDigit()
            }
          }
        }
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .disabled(toggle == nil)

      if isExpanded { runningBoards.transition(.opacity.combined(with: .move(edge: .top))) }
    }
    .padding(.vertical, 6)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(laneTitle(lane.name)), \(lane.done) of \(lane.due) boards done")
  }

  private var warning: some View {
    Label {
      Text(
        [lane.failedPermanent > 0 ? "\(lane.failedPermanent) failed" : nil, lane.stuck > 0 ? "\(lane.stuck) stuck" : nil]
          .compactMap { $0 }.joined(separator: ", "))
    } icon: {
      Image(systemName: "exclamationmark.triangle.fill")
    }
    .font(.caption2)
    .foregroundStyle(.orange)
    .labelStyle(.titleAndIcon)
  }

  private var detail: String {
    var parts: [String] = []
    if lane.inFlight.count > 0 { parts.append("\(lane.inFlight.count) running") }
    if lane.requestsPerMin > 0 { parts.append("\(Format.count(lane.requestsPerMin)) req/min") }
    if lane.r429 > 0 { parts.append("\(lane.r429) rate limits") }
    return parts.joined(separator: " · ")
  }

  private var runningBoards: some View {
    VStack(alignment: .leading, spacing: 3) {
      ForEach(lane.inFlight.sorted { $0.runningSec > $1.runningSec }.prefix(8)) { board in
        HStack {
          Text(board.name).font(.caption).lineLimit(1).truncationMode(.middle)
          Spacer()
          Text(Format.duration(Double(board.runningSec))).font(.caption).foregroundStyle(.tertiary).monospacedDigit()
        }
      }
      if lane.inFlight.count > 8 {
        Text("and \(lane.inFlight.count - 8) more").font(.caption2).foregroundStyle(.tertiary)
      }
      if lane.inFlight.isEmpty { Text("Nothing running right now.").font(.caption).foregroundStyle(.tertiary) }
      if let error = lane.errors.last {
        Label(error, systemImage: "exclamationmark.circle")
          .font(.caption2)
          .foregroundStyle(.orange)
          .lineLimit(2)
          .padding(.top, 2)
      }
    }
    .padding(.leading, 4)
  }
}
