import SwiftUI
import TalloSweepKit

/// Throughput, cost against the budget, and rate limiting, as four tiles.
struct MetricGrid: View {
  let status: SweepStatus

  var body: some View {
    GlassEffectContainer(spacing: 10) {
      Grid(horizontalSpacing: 10, verticalSpacing: 10) {
        GridRow {
          MetricTile(
            title: "Requests", value: "\(Format.count(status.requestsPerMinute))/min", symbol: "arrow.up.arrow.down",
            detail: "\(status.global.inFlight) boards in flight")
          MetricTile(
            title: "Rows written", value: Format.count(status.cost.rowsWritten), symbol: "cylinder.split.1x2",
            detail: "of \(Format.count(status.cost.budget)) budget", gauge: status.cost.budgetFraction,
            tint: status.cost.budgetFraction > 0.8 ? .orange : .green)
        }
        GridRow {
          MetricTile(
            title: "R2 writes", value: Format.count(status.cost.r2Puts), symbol: "externaldrive",
            detail: "\(Format.count(status.cost.rowsPerMin)) rows/min")
          MetricTile(
            title: "Rate limits", value: Format.count(status.rate429), symbol: "gauge.with.dots.needle.50percent",
            detail: "ingest \(status.global.ingestLatencyMs) ms")
        }
      }
    }
  }
}

/// What needs you, in plain words: a setup problem, a crash, a silent sweep or a spent budget. A board that failed
/// for good is not here: that is normal for a sweep this size, and it shows on its lane.
struct ProblemList: View {
  let model: SweepModel

  var body: some View {
    let items = problems
    if !items.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        SectionHeader(title: "Needs attention")
        ForEach(items) { item in
          VStack(alignment: .leading, spacing: 3) {
            Label(item.title, systemImage: "exclamationmark.triangle.fill")
              .font(.callout.weight(.medium))
              .foregroundStyle(.orange)
            if let detail = item.detail {
              Text(detail).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                .lineLimit(5)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(12)
          .glassEffect(.regular.tint(.orange.opacity(0.12)), in: .rect(cornerRadius: 14))
          .accessibilityElement(children: .combine)
        }
      }
    }
  }

  private struct Item: Identifiable {
    var title: String
    var detail: String?
    var id: String { title }
  }

  private var problems: [Item] {
    var items: [Item] = []
    for problem in model.setupFailure?.problems ?? [] {
      items.append(Item(title: problem.message, detail: problem.fix))
    }
    if case .failed(let message) = model.phase, items.isEmpty {
      items.append(Item(title: message, detail: model.crashDetail.isEmpty ? nil : model.crashDetail))
    }
    if case .unresponsive = model.health {
      items.append(Item(title: "The sweep stopped reporting", detail: "It is running but its status is old. Check the log."))
    }
    if model.pause.reasons.contains(.budget) {
      items.append(Item(title: "The sweep is at its row budget", detail: PauseReason.budget.explanation))
    }
    return Array(items.prefix(4))
  }
}

/// The sweep's own words about what it just decided.
struct EventList: View {
  let events: [SweepEvent]
  @State private var isExpanded = false

  var body: some View {
    if !events.isEmpty {
      DisclosureGroup(isExpanded: $isExpanded) {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(events.suffix(8).reversed()) { event in
            HStack(alignment: .firstTextBaseline, spacing: 8) {
              Text(event.date, format: .dateTime.hour().minute().second())
                .font(.caption2).foregroundStyle(.tertiary).monospacedDigit()
              Text(event.message)
                .font(.caption)
                .foregroundStyle(event.level == .warn ? .orange : .secondary)
                .lineLimit(2)
            }
          }
        }
        .padding(.top, 6)
      } label: {
        Text("Recent activity").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
      }
    }
  }
}
