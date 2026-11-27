import Foundation

/// One line of `events.jsonl`: what the sweep decided, in its own words ("workday: perHost 20 -> 28").
public struct SweepEvent: Decodable, Equatable, Identifiable, Sendable {
  public enum Level: String, Decodable, Sendable { case info, warn }

  public var date: Date
  public var level: Level
  public var message: String
  public var id: String { "\(date.timeIntervalSince1970)|\(message)" }

  enum CodingKeys: String, CodingKey { case date = "t", level, message }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let text = try c.decode(String.self, forKey: .date)
    guard let date = Self.parse(text) else {
      throw DecodingError.dataCorruptedError(forKey: .date, in: c, debugDescription: "Not a date: \(text)")
    }
    self.date = date
    level = (try? c.decode(Level.self, forKey: .level)) ?? .info
    message = try c.decode(String.self, forKey: .message)
  }

  public init(date: Date, level: Level = .info, message: String) {
    self.date = date
    self.level = level
    self.message = message
  }

  private static func parse(_ text: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
  }
}

/// The most recent events of the sweep's log, read from the end of the file so a megabyte of history costs nothing.
public struct EventLog: Sendable {
  public let url: URL
  public init(url: URL) { self.url = url }

  /// The last `limit` events, oldest first. Lines that do not parse (a partial write, a foreign line) are skipped.
  public func recent(limit: Int = 30, tailBytes: Int = 96 * 1024) -> [SweepEvent] {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return [] }
    defer { try? handle.close() }
    guard let size = try? handle.seekToEnd() else { return [] }
    let start = size > UInt64(tailBytes) ? size - UInt64(tailBytes) : 0
    guard (try? handle.seek(toOffset: start)) != nil, let data = try? handle.readToEnd() else { return [] }
    var lines = String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: true)
    if start > 0, !lines.isEmpty { lines.removeFirst() }  // the first line was cut by the offset
    let decoder = JSONDecoder()
    let events = lines.suffix(limit * 2).compactMap { line in
      try? decoder.decode(SweepEvent.self, from: Data(line.utf8))
    }
    return Array(events.suffix(limit))
  }
}
