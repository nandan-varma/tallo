import Foundation

/// Numbers and times the way the menu shows them.
enum Format {
  /// `5h 38m`, `12m`, `45s`.
  static func duration(_ seconds: Double) -> String {
    let total = max(0, Int(seconds.rounded()))
    let (h, m, s) = (total / 3600, total % 3600 / 60, total % 60)
    if h > 0 { return m > 0 ? "\(h)h \(m)m" : "\(h)h" }
    if m > 0 { return "\(m)m" }
    return "\(s)s"
  }

  /// `5.4M`, `143k`, `812`.
  static func count(_ value: Int) -> String {
    switch abs(value) {
    case 1_000_000...: String(format: "%.1fM", Double(value) / 1_000_000)
    case 10_000...: "\(value / 1000)k"
    case 1000...: String(format: "%.1fk", Double(value) / 1000)
    default: "\(value)"
    }
  }

  /// `about 57 min`, `about 2h 10m`, for the sweep's own estimate in minutes.
  static func eta(minutes: Int) -> String {
    minutes < 90 ? "\(minutes) min" : duration(Double(minutes) * 60)
  }
}
