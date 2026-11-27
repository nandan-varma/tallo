import Darwin
import Foundation

/// Whether a sweep is really running, judged from its status file and its process.
public enum SweepHealth: Equatable, Sendable {
  /// No status file, or the one there describes a process that is gone.
  case notRunning
  /// Alive and reporting.
  case alive
  /// The process exists but has not updated its status for a while.
  case unresponsive(since: Date)
  /// The last run ended by itself.
  case ended(RunState)

  /// The status is considered stale after this long without an update (the sweep writes every 5 seconds).
  public static let staleAfter: TimeInterval = 45

  public static func evaluate(
    status: SweepStatus?, now: Date = .now, isAlive: (Int) -> Bool = ProcessLiveness.isAlive
  ) -> SweepHealth {
    guard let status else { return .notRunning }
    switch status.state {
    case .finished, .stopped:
      return .ended(status.state)
    default:
      guard status.pid > 0, isAlive(status.pid) else { return .notRunning }
      return now.timeIntervalSince(status.updatedAt) > staleAfter ? .unresponsive(since: status.updatedAt) : .alive
    }
  }
}

public enum ProcessLiveness {
  /// True when a process with this id exists (including one we may not signal).
  public static func isAlive(_ pid: Int) -> Bool {
    guard pid > 0 else { return false }
    return kill(pid_t(pid), 0) == 0 || errno == EPERM
  }
}
