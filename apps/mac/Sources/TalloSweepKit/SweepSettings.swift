import Foundation

/// What you can change in the app. Every field has a default and decodes leniently, so adding one later never
/// loses what is already saved.
public struct SweepSettings: Equatable, Codable, Sendable {
  /// The tallo checkout. `~` is expanded.
  public var repoPath = "~/dev/web/tallo"
  /// The Node to run the sweep with; empty finds one (Homebrew, then the PATH).
  public var nodePath = ""
  /// Boards completed within this many hours are skipped, so a restart resumes where the last run stopped.
  public var staleHours = 20
  /// Lanes to run; empty runs them all.
  public var lanes: [String] = []
  /// Hold the Mac awake while the sweep runs and is not paused.
  public var keepAwake = true
  /// Start the sweep when the app opens.
  public var startOnLaunch = false
  public var rules = PauseRules()
  public var notifications = Notifications()

  public struct Notifications: Equatable, Codable, Sendable {
    public var finished = true
    public var problems = true
    public var budget = true
    public init() {}
    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      finished = try c.decodeIfPresent(Bool.self, forKey: .finished) ?? true
      problems = try c.decodeIfPresent(Bool.self, forKey: .problems) ?? true
      budget = try c.decodeIfPresent(Bool.self, forKey: .budget) ?? true
    }
  }

  public init() {}

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let d = SweepSettings()
    repoPath = try c.decodeIfPresent(String.self, forKey: .repoPath) ?? d.repoPath
    nodePath = try c.decodeIfPresent(String.self, forKey: .nodePath) ?? d.nodePath
    staleHours = try c.decodeIfPresent(Int.self, forKey: .staleHours) ?? d.staleHours
    lanes = try c.decodeIfPresent([String].self, forKey: .lanes) ?? d.lanes
    keepAwake = try c.decodeIfPresent(Bool.self, forKey: .keepAwake) ?? d.keepAwake
    startOnLaunch = try c.decodeIfPresent(Bool.self, forKey: .startOnLaunch) ?? d.startOnLaunch
    rules = try c.decodeIfPresent(PauseRules.self, forKey: .rules) ?? d.rules
    notifications = try c.decodeIfPresent(Notifications.self, forKey: .notifications) ?? d.notifications
  }
}

extension PauseRules {
  enum CodingKeys: String, CodingKey {
    case pauseOnSleep, pauseWhenOffline, pauseOnLowBattery, batteryFloorPercent, pauseWhenHot, settleAfterWake
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let d = PauseRules()
    pauseOnSleep = try c.decodeIfPresent(Bool.self, forKey: .pauseOnSleep) ?? d.pauseOnSleep
    pauseWhenOffline = try c.decodeIfPresent(Bool.self, forKey: .pauseWhenOffline) ?? d.pauseWhenOffline
    pauseOnLowBattery = try c.decodeIfPresent(Bool.self, forKey: .pauseOnLowBattery) ?? d.pauseOnLowBattery
    batteryFloorPercent = try c.decodeIfPresent(Int.self, forKey: .batteryFloorPercent) ?? d.batteryFloorPercent
    pauseWhenHot = try c.decodeIfPresent(Bool.self, forKey: .pauseWhenHot) ?? d.pauseWhenHot
    settleAfterWake = try c.decodeIfPresent(TimeInterval.self, forKey: .settleAfterWake) ?? d.settleAfterWake
  }
}

/// Settings kept in `UserDefaults` as one JSON value.
public struct SettingsStore: Sendable {
  private let key = "tallo.sweep.settings.v1"
  nonisolated(unsafe) private let defaults: UserDefaults

  public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

  public func load() -> SweepSettings {
    guard let data = defaults.data(forKey: key),
      let settings = try? JSONDecoder().decode(SweepSettings.self, from: data)
    else { return SweepSettings() }
    return settings
  }

  public func save(_ settings: SweepSettings) {
    if let data = try? JSONEncoder().encode(settings) { defaults.set(data, forKey: key) }
  }
}
