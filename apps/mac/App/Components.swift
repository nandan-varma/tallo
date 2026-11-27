import SwiftUI

/// A section title in the popover.
struct SectionHeader: View {
  let title: String
  var trailing: String?

  var body: some View {
    HStack {
      Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
      Spacer()
      if let trailing { Text(trailing).font(.caption).foregroundStyle(.tertiary).monospacedDigit() }
    }
    .accessibilityAddTraits(.isHeader)
  }
}

/// A ring that fills as work finishes.
struct ProgressRing: View {
  let progress: Double
  let tint: Color
  var lineWidth: CGFloat = 7

  var body: some View {
    ZStack {
      Circle().stroke(.primary.opacity(0.12), lineWidth: lineWidth)
      Circle()
        .trim(from: 0, to: max(0.001, progress))
        .stroke(tint.gradient, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
        .rotationEffect(.degrees(-90))
        .animation(.smooth, value: progress)
    }
  }
}

/// One number with a caption, on glass.
struct MetricTile: View {
  let title: String
  let value: String
  let symbol: String
  var detail: String?
  var gauge: Double?
  var tint: Color = .accentColor

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Label(title, systemImage: symbol)
        .font(.caption)
        .foregroundStyle(.secondary)
        .labelStyle(.titleAndIcon)
      Text(value)
        .font(.title3.weight(.semibold))
        .monospacedDigit()
        .contentTransition(.numericText())
      if let gauge {
        ProgressView(value: gauge).progressViewStyle(.linear).tint(tint)
      }
      if let detail {
        Text(detail).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .padding(12)
    .glassEffect(.regular, in: .rect(cornerRadius: 16))
    .accessibilityElement(children: .combine)
  }
}
