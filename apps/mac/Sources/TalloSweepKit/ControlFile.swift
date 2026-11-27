import Foundation

/// The file the sweep re-reads every few seconds to take orders (`tallo sweep pause`, `tallo sweep set`).
///
/// An order is a value under `global`, `budget` or `lanes.<name>`, plus a millisecond stamp under
/// `_stamps["<path>"]`; the sweep acts on a value when its stamp changes. This writes exactly what the CLI does,
/// keeping every key it does not know, so the two can be used side by side.
public struct ControlFile: Sendable {
  public let url: URL

  public init(url: URL) { self.url = url }

  public enum ControlError: Error, Equatable {
    case notAnObject
  }

  /// `tallo sweep pause` / `resume`: stop starting boards, or start again. Boards already running finish.
  public func setPaused(_ paused: Bool, now: Date = .now) throws {
    try set(["global", "paused"], to: paused, now: now)
  }

  /// Sets one value, by its path (`["lanes", "workday", "concurrency"]`), and stamps it.
  public func set(_ path: [String], to value: Bool, now: Date = .now) throws {
    var file = try read()
    Self.insert(value, at: path, in: &file)
    var stamps = file["_stamps"] as? [String: Any] ?? [:]
    stamps[path.joined(separator: ".")] = Int((now.timeIntervalSince1970 * 1000).rounded())
    file["_stamps"] = stamps
    try write(file)
  }

  /// The values currently in the file (empty when there is none).
  public func read() throws -> [String: Any] {
    guard let data = try? Data(contentsOf: url), !data.isEmpty else { return [:] }
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw ControlError.notAnObject
    }
    return object
  }

  /// Written to a temporary file and renamed over the target, so the sweep never reads half a file.
  private func write(_ file: [String: Any]) throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = try JSONSerialization.data(withJSONObject: file, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: url, options: .atomic)
  }

  private static func insert(_ value: Bool, at path: [String], in object: inout [String: Any]) {
    guard let head = path.first else { return }
    if path.count == 1 {
      object[head] = value
      return
    }
    var child = object[head] as? [String: Any] ?? [:]
    insert(value, at: Array(path.dropFirst()), in: &child)
    object[head] = child
  }
}
