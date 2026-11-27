import Foundation
import TalloSweepKit

/// One read of the sweep's files, done off the main actor.
struct SweepSnapshot: Sendable {
  var status: SweepStatus?
  /// Only read on some polls (the log changes slowly).
  var events: [SweepEvent]?
}

enum SweepReader {
  @concurrent
  static func read(_ paths: SweepPaths, includeEvents: Bool) async -> SweepSnapshot {
    let status = (try? Data(contentsOf: paths.status)).flatMap { try? SweepStatus.decode($0) }
    let events = includeEvents ? EventLog(url: paths.events).recent(limit: 40) : nil
    return SweepSnapshot(status: status, events: events)
  }

  /// The last few lines the sweep process printed, for explaining a crash.
  @concurrent
  static func processLogTail(_ paths: SweepPaths, bytes: Int = 3000) async -> String {
    guard let handle = try? FileHandle(forReadingFrom: paths.processLog) else { return "" }
    defer { try? handle.close() }
    guard let size = try? handle.seekToEnd() else { return "" }
    try? handle.seek(toOffset: size > UInt64(bytes) ? size - UInt64(bytes) : 0)
    let text = String(decoding: (try? handle.readToEnd()) ?? Data(), as: UTF8.self)
    return text.split(separator: "\n").suffix(6).joined(separator: "\n")
  }
}
