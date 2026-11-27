import Foundation

/// Where the sweep keeps its files. `tallo sweep start` writes `status.json` and `events.jsonl` here and reads
/// `control.json` back every few seconds.
public struct SweepPaths: Equatable, Sendable {
  public var directory: URL
  public var status: URL { directory.appending(path: "status.json") }
  public var control: URL { directory.appending(path: "control.json") }
  public var events: URL { directory.appending(path: "events.jsonl") }
  /// What the app captured from the sweep process's own output.
  public var processLog: URL { directory.appending(path: "app-process.log") }

  public init(directory: URL) { self.directory = directory }

  /// `~/Library/Logs/tallo/sweep`, the runner's default.
  public static var standard: SweepPaths {
    SweepPaths(
      directory: FileManager.default.homeDirectoryForCurrentUser
        .appending(path: "Library/Logs/tallo/sweep", directoryHint: .isDirectory))
  }
}
