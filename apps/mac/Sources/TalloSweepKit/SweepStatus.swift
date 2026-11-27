import Foundation

/// What the sweep says about itself: `status.json`, rewritten every few seconds by `tallo sweep start`.
///
/// Every field decodes leniently (a missing key takes a default) so a runner that adds or drops a field never
/// stops the app from showing the rest.
public struct SweepStatus: Decodable, Equatable, Sendable {
  public var updatedAt: Date
  public var startedAt: Date
  public var elapsedSec: Int
  public var pid: Int
  public var state: RunState
  public var global: Global
  public var cost: Cost
  public var lanes: [Lane]

  enum CodingKeys: String, CodingKey {
    case updatedAt, startedAt, elapsedSec, pid, state, global, cost, lanes
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? .distantPast
    startedAt = try c.decodeIfPresent(Date.self, forKey: .startedAt) ?? .distantPast
    elapsedSec = c.count(.elapsedSec) ?? 0
    pid = c.count(.pid) ?? 0
    state = try c.decodeIfPresent(RunState.self, forKey: .state) ?? .unknown("")
    global = try c.decodeIfPresent(Global.self, forKey: .global) ?? Global()
    cost = try c.decodeIfPresent(Cost.self, forKey: .cost) ?? Cost()
    let byName = try c.decodeIfPresent([String: Lane.Body].self, forKey: .lanes) ?? [:]
    lanes = byName.map { Lane(name: $0.key, body: $0.value) }.sorted(by: Lane.displayOrder)
  }

  public init(
    updatedAt: Date = .now, startedAt: Date = .now, elapsedSec: Int = 0, pid: Int = 0,
    state: RunState = .running, global: Global = Global(), cost: Cost = Cost(), lanes: [Lane] = []
  ) {
    self.updatedAt = updatedAt
    self.startedAt = startedAt
    self.elapsedSec = elapsedSec
    self.pid = pid
    self.state = state
    self.global = global
    self.cost = cost
    self.lanes = lanes
  }

  public static func decode(_ data: Data) throws -> SweepStatus {
    try decoder.decode(SweepStatus.self, from: data)
  }

  /// `status.json` carries ISO-8601 instants with fractional seconds.
  nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  private static var decoder: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let text = try decoder.singleValueContainer().decode(String.self)
      if let date = fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text) { return date }
      throw DecodingError.dataCorrupted(
        .init(codingPath: decoder.codingPath, debugDescription: "Not an ISO-8601 date: \(text)"))
    }
    return decoder
  }

  // MARK: Derived

  /// All boards across lanes.
  public var boardsDue: Int { lanes.reduce(0) { $0 + $1.due } }
  public var boardsDone: Int { lanes.reduce(0) { $0 + $1.done } }
  public var boardsFailed: Int { lanes.reduce(0) { $0 + $1.failedPermanent } }
  public var boardsStuck: Int { lanes.reduce(0) { $0 + $1.stuck } }

  /// Finished share of all boards (done + failed for good), 0...1.
  public var overallProgress: Double {
    guard boardsDue > 0 else { return 0 }
    return min(1, Double(boardsDone + boardsFailed) / Double(boardsDue))
  }

  /// The lane that will finish last, by the sweep's own estimate (minutes), if any lane has one.
  public var etaMinutes: Int? { lanes.compactMap(\.etaMin).max() }

  /// Lanes that still have work: not done, not idle.
  public var activeLanes: [Lane] { lanes.filter { !$0.isFinished } }

  public var rate429: Int { lanes.reduce(0) { $0 + $1.r429 } }
  public var requestsPerMinute: Int { lanes.reduce(0) { $0 + $1.requestsPerMin } }
}

extension KeyedDecodingContainer {
  /// A count the sweep wrote as a whole number or, for a rate it averaged, with a fraction (`799.4`).
  fileprivate func count(_ key: Key) -> Int? {
    if let whole = try? decodeIfPresent(Int.self, forKey: key) { return whole }
    if let fraction = try? decodeIfPresent(Double.self, forKey: key), fraction.isFinite { return Int(fraction.rounded()) }
    return nil
  }
}

public enum RunState: Equatable, Sendable, Decodable {
  case running, draining, finished, stopped
  case unknown(String)

  public init(from decoder: any Decoder) throws {
    let text = try decoder.singleValueContainer().decode(String.self)
    switch text {
    case "running": self = .running
    case "draining": self = .draining
    case "finished": self = .finished
    case "stopped": self = .stopped
    default: self = .unknown(text)
    }
  }
}

extension SweepStatus {
  public struct Global: Decodable, Equatable, Sendable {
    public var inFlight = 0
    public var maxInFlight = 0
    public var capacity = 0
    public var paused = false
    public var stop = false
    public var ingestLatencyMs = 0

    public init() {}
    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      inFlight = c.count(.inFlight) ?? 0
      maxInFlight = c.count(.maxInFlight) ?? 0
      capacity = c.count(.capacity) ?? 0
      paused = try c.decodeIfPresent(Bool.self, forKey: .paused) ?? false
      stop = try c.decodeIfPresent(Bool.self, forKey: .stop) ?? false
      ingestLatencyMs = c.count(.ingestLatencyMs) ?? 0
    }
    enum CodingKeys: String, CodingKey {
      case inFlight, maxInFlight, capacity, paused, stop, ingestLatencyMs
    }
  }

  /// What the run has cost against its own budget (D1 rows written, R2 writes).
  public struct Cost: Decodable, Equatable, Sendable {
    public var rowsWritten = 0
    public var r2Puts = 0
    public var rowsPerMin = 0
    public var budget = 0
    public var budgetUsedPct = 0.0
    public var budgetHeld = false

    public init() {}
    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      rowsWritten = c.count(.rowsWritten) ?? 0
      r2Puts = c.count(.r2Puts) ?? 0
      rowsPerMin = c.count(.rowsPerMin) ?? 0
      budget = c.count(.budget) ?? 0
      budgetUsedPct = try c.decodeIfPresent(Double.self, forKey: .budgetUsedPct) ?? 0
      budgetHeld = try c.decodeIfPresent(Bool.self, forKey: .budgetHeld) ?? false
    }
    enum CodingKeys: String, CodingKey {
      case rowsWritten, r2Puts, rowsPerMin, budget, budgetUsedPct, budgetHeld
    }

    /// Budget used, 0...1.
    public var budgetFraction: Double { min(1, max(0, budgetUsedPct / 100)) }
  }

  public struct Lane: Equatable, Identifiable, Sendable {
    public var id: String { name }
    public var name: String
    public var state: String
    public var due: Int
    public var done: Int
    public var pending: Int
    public var failedPermanent: Int
    public var stuck: Int
    public var deferred: Int
    public var inFlight: [Board]
    public var requests: Int
    public var r429: Int
    public var requestsPerMin: Int
    public var boardsPerMin: Double
    public var etaMin: Int?
    public var errors: [String]

    /// A board running now.
    public struct Board: Decodable, Equatable, Identifiable, Sendable {
      public var id: String
      public var runningSec: Int

      enum CodingKeys: String, CodingKey { case id, runningSec }

      public init(id: String, runningSec: Int = 0) {
        self.id = id
        self.runningSec = runningSec
      }

      public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        runningSec = c.count(.runningSec) ?? 0
      }

      /// The board without its platform prefix: `workday:cvshealth/CVS_Health_Careers` is `cvshealth/CVS_Health_Careers`.
      public var name: String { id.split(separator: ":", maxSplits: 1).last.map(String.init) ?? id }
    }

    /// Lane keys of `status.json`, as the sweep writes them.
    struct Body: Decodable {
      var state: String?
      var due: Int?
      var done: Int?
      var pending: Int?
      var failedPermanent: Int?
      var stuck: Int?
      var deferred: Int?
      var inFlight: [Board]?
      var requests: Int?
      var r429: Int?
      var requestsPerMin: Int?
      var boardsPerMin: Double?
      var etaMin: Int?
      var errors: [String]?

      enum CodingKeys: String, CodingKey {
        case state, due, done, pending, failedPermanent, stuck, deferred, inFlight, requests, r429
        case requestsPerMin, boardsPerMin, etaMin, errors
      }

      init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try? c.decodeIfPresent(String.self, forKey: .state)
        due = c.count(.due)
        done = c.count(.done)
        pending = c.count(.pending)
        failedPermanent = c.count(.failedPermanent)
        stuck = c.count(.stuck)
        deferred = c.count(.deferred)
        inFlight = try? c.decodeIfPresent([Board].self, forKey: .inFlight)
        requests = c.count(.requests)
        r429 = c.count(.r429)
        requestsPerMin = c.count(.requestsPerMin)
        boardsPerMin = try? c.decodeIfPresent(Double.self, forKey: .boardsPerMin)
        etaMin = c.count(.etaMin)
        errors = try? c.decodeIfPresent([String].self, forKey: .errors)
      }
    }

    init(name: String, body b: Body) {
      self.name = name
      state = b.state ?? ""
      due = b.due ?? 0
      done = b.done ?? 0
      pending = b.pending ?? 0
      failedPermanent = b.failedPermanent ?? 0
      stuck = b.stuck ?? 0
      deferred = b.deferred ?? 0
      inFlight = b.inFlight ?? []
      requests = b.requests ?? 0
      r429 = b.r429 ?? 0
      requestsPerMin = b.requestsPerMin ?? 0
      boardsPerMin = b.boardsPerMin ?? 0
      etaMin = b.etaMin
      errors = b.errors ?? []
    }

    public init(
      name: String, state: String = "running", due: Int = 0, done: Int = 0, pending: Int = 0,
      failedPermanent: Int = 0, stuck: Int = 0, deferred: Int = 0, inFlight: [Board] = [], requests: Int = 0,
      r429: Int = 0, requestsPerMin: Int = 0, boardsPerMin: Double = 0, etaMin: Int? = nil, errors: [String] = []
    ) {
      self.name = name
      self.state = state
      self.due = due
      self.done = done
      self.pending = pending
      self.failedPermanent = failedPermanent
      self.stuck = stuck
      self.deferred = deferred
      self.inFlight = inFlight
      self.requests = requests
      self.r429 = r429
      self.requestsPerMin = requestsPerMin
      self.boardsPerMin = boardsPerMin
      self.etaMin = etaMin
      self.errors = errors
    }

    /// Nothing left to start or finish: every due board is done or failed for good.
    public var isFinished: Bool { due == 0 || state == "done" }

    /// Finished share of this lane's boards, 0...1 (done and failed for good both count as finished).
    public var progress: Double {
      guard due > 0 else { return 1 }
      return min(1, Double(done + failedPermanent) / Double(due))
    }

    /// Sweep order: the catalog lanes in the order the runner lists them, then any other lane by name.
    static func displayOrder(_ a: Lane, _ b: Lane) -> Bool {
      let ranks = Dictionary(uniqueKeysWithValues: known.enumerated().map { ($1, $0) })
      let (ra, rb) = (ranks[a.name] ?? known.count, ranks[b.name] ?? known.count)
      return ra == rb ? a.name < b.name : ra < rb
    }

    private static let known = [
      "greenhouse", "lever", "ashby", "smartrecruiters", "workday", "oracle-icims", "small-ats", "walmart",
      "microsoft", "starbucks", "apple", "meta", "big-sites",
    ]
  }
}
