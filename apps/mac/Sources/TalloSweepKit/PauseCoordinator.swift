import Foundation

/// Why the sweep is held. Any one of these is enough to keep it paused; it resumes when none is left.
public enum PauseReason: String, CaseIterable, Codable, Sendable, Identifiable {
  /// You pressed Pause.
  case user
  /// The Mac is asleep (lid closed, Apple menu, idle sleep).
  case sleeping
  /// The Mac just woke: waiting a few seconds so requests do not all fail at once.
  case settling
  /// No network path.
  case offline
  /// On battery, below the chosen level.
  case lowBattery
  /// The Mac is running hot.
  case hot
  /// The sweep held itself at its row budget.
  case budget

  public var id: String { rawValue }

  /// Shown first when several apply: the most specific cause wins.
  fileprivate static let priority: [PauseReason] = [.sleeping, .settling, .offline, .lowBattery, .hot, .budget, .user]
}

/// The rules for when the app pauses by itself (not the button: that always works).
public struct PauseRules: Equatable, Codable, Sendable {
  public var pauseOnSleep = true
  public var pauseWhenOffline = true
  public var pauseOnLowBattery = false
  /// Pause on battery below this percentage; resumes 5 points above it, or on power.
  public var batteryFloorPercent = 20
  public var pauseWhenHot = true
  /// Seconds to wait after waking before resuming.
  public var settleAfterWake: TimeInterval = 10

  public init() {}
}

/// Decides, from what the Mac reports, whether the sweep should be paused. Pure: feed it events and a clock, read
/// `isPaused`. Nothing here touches the sweep, so every rule is a unit test.
public struct PauseCoordinator: Equatable, Sendable {
  public enum Event: Equatable, Sendable {
    case userPaused(Bool)
    case willSleep
    case didWake
    case network(online: Bool)
    case battery(percent: Int, onPower: Bool)
    case thermal(hot: Bool)
    case budgetHeld(Bool)
    /// Time moving on, so a wake delay can end.
    case clock
  }

  public var rules: PauseRules
  public private(set) var reasons: Set<PauseReason> = []
  /// When the wake delay ends, while one is running.
  public private(set) var settlesAt: Date?

  public init(rules: PauseRules = PauseRules()) { self.rules = rules }

  public var isPaused: Bool { !reasons.isEmpty }

  /// The reason to show: the most specific one that applies.
  public var primaryReason: PauseReason? {
    PauseReason.priority.first(where: reasons.contains)
  }

  public mutating func apply(_ event: Event, now: Date = .now) {
    switch event {
    case .userPaused(let paused):
      set(.user, paused)
    case .willSleep:
      guard rules.pauseOnSleep else { return }
      settlesAt = nil
      reasons.remove(.settling)
      reasons.insert(.sleeping)
    case .didWake:
      guard reasons.contains(.sleeping) else { return }
      reasons.remove(.sleeping)
      if rules.settleAfterWake > 0 {
        settlesAt = now.addingTimeInterval(rules.settleAfterWake)
        reasons.insert(.settling)
      }
    case .network(let online):
      set(.offline, rules.pauseWhenOffline && !online)
    case .battery(let percent, let onPower):
      guard rules.pauseOnLowBattery else { return set(.lowBattery, false) }
      if onPower {
        set(.lowBattery, false)
      } else if percent < rules.batteryFloorPercent {
        set(.lowBattery, true)
      } else if percent >= rules.batteryFloorPercent + 5 {
        set(.lowBattery, false)
      }
    case .thermal(let hot):
      set(.hot, rules.pauseWhenHot && hot)
    case .budgetHeld(let held):
      set(.budget, held)
    case .clock:
      break
    }
    if let settlesAt, now >= settlesAt {
      reasons.remove(.settling)
      self.settlesAt = nil
    }
  }

  private mutating func set(_ reason: PauseReason, _ on: Bool) {
    if on { reasons.insert(reason) } else { reasons.remove(reason) }
  }
}
