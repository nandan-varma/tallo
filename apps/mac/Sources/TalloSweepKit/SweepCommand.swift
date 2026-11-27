import Foundation

/// A problem that stops the sweep from starting, with what to do about it.
public enum SetupProblem: Equatable, Sendable, Identifiable {
  case repoMissing(String)
  case runnerMissing(String)
  case nodeMissing
  case credentialsMissing(String)

  public var id: String { message }

  public var message: String {
    switch self {
    case .repoMissing(let path): "The tallo folder was not found at \(path)."
    case .runnerMissing(let path): "There is no runner at \(path)."
    case .nodeMissing: "Node was not found."
    case .credentialsMissing(let path): "There is no .env with the API address and token at \(path)."
    }
  }

  public var fix: String {
    switch self {
    case .repoMissing: "Choose the folder in Settings."
    case .runnerMissing: "Choose the root of the tallo repository in Settings."
    case .nodeMissing: "Install Node (brew install node) or choose it in Settings."
    case .credentialsMissing: "Create apps/runner/.env with TALLO_API_URL and TALLO_INGEST_TOKEN."
    }
  }
}

/// The exact command that starts the sweep, built from the settings. Pure, so it can be checked without running it.
public struct SweepCommand: Equatable, Sendable {
  public var executable: URL
  public var arguments: [String]
  public var workingDirectory: URL
  public var environment: [String: String]

  /// Builds the command, or says everything that is wrong with the setup.
  public static func make(
    settings: SweepSettings,
    paths: SweepPaths,
    environment base: [String: String] = ProcessInfo.processInfo.environment,
    fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
    isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
  ) -> Result<SweepCommand, SetupFailure> {
    let repo = NSString(string: settings.repoPath).expandingTildeInPath
    let runner = repo + "/apps/runner"
    var problems: [SetupProblem] = []
    if !fileExists(repo) {
      problems.append(.repoMissing(repo))
    } else if !fileExists(runner + "/src/cli.ts") {
      problems.append(.runnerMissing(runner + "/src/cli.ts"))
    } else if !fileExists(runner + "/.env") {
      problems.append(.credentialsMissing(runner + "/.env"))
    }
    let node = NodeLocator.find(preferred: settings.nodePath, path: base["PATH"], isExecutable: isExecutable)
    if node == nil { problems.append(.nodeMissing) }
    guard problems.isEmpty, let node else { return .failure(SetupFailure(problems: problems)) }

    var arguments = [
      "--max-http-header-size=65536", "src/cli.ts", "sweep", "start",
      "--stale-hours", String(max(0, settings.staleHours)),
      "--dir", paths.directory.path,
      // The app holds the keep-awake assertion itself, so pausing lets the Mac sleep.
      "--no-caffeinate",
    ]
    arguments += settings.lanes
    var environment = base
    environment["PATH"] = Self.path(prepending: [(node as NSString).deletingLastPathComponent], to: base["PATH"])
    environment["TALLO_SWEEP_DIR"] = paths.directory.path
    return .success(
      SweepCommand(
        executable: URL(fileURLWithPath: node), arguments: arguments,
        workingDirectory: URL(fileURLWithPath: runner, isDirectory: true), environment: environment))
  }

  /// A PATH that starts with `directories` (Homebrew's, for the tools the runner calls), without repeats.
  static func path(prepending directories: [String], to existing: String?) -> String {
    var seen = Set<String>()
    let all = directories + ["/opt/homebrew/bin", "/usr/local/bin"] + (existing ?? "/usr/bin:/bin").split(separator: ":").map(String.init)
    return all.filter { seen.insert($0).inserted }.joined(separator: ":")
  }
}

public struct SetupFailure: Error, Equatable, Sendable {
  public var problems: [SetupProblem]
  public init(problems: [SetupProblem]) { self.problems = problems }
}

/// Finds a Node to run the runner with.
public enum NodeLocator {
  public static func find(
    preferred: String, path: String?, isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
  ) -> String? {
    let chosen = NSString(string: preferred).expandingTildeInPath
    if !chosen.isEmpty, isExecutable(chosen) { return chosen }
    let fromPath = (path ?? "").split(separator: ":").map { "\($0)/node" }
    let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"] + fromPath
    return candidates.first(where: isExecutable)
  }
}
