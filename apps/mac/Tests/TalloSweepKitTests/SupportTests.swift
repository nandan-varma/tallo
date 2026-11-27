import Foundation
import Testing

@testable import TalloSweepKit

struct EventLogTests {
  private func log(_ lines: [String]) throws -> EventLog {
    let url = FileManager.default.temporaryDirectory.appending(path: "events-\(UUID().uuidString).jsonl")
    try Data((lines.joined(separator: "\n") + "\n").utf8).write(to: url)
    return EventLog(url: url)
  }

  private func line(_ n: Int, level: String = "info") -> String {
    #"{"t":"2026-11-27T06:\#(String(format: "%02d", n)):00.000Z","level":"\#(level)","message":"event \#(n)"}"#
  }

  @Test func returnsTheLastEventsOldestFirst() throws {
    let events = try log((0..<20).map { line($0) }).recent(limit: 5)
    #expect(events.map(\.message) == ["event 15", "event 16", "event 17", "event 18", "event 19"])
  }

  @Test func skipsLinesThatDoNotParse() throws {
    let events = try log([line(1), "not json", line(2, level: "warn"), #"{"t":"bad","message":"x"}"#]).recent()
    #expect(events.map(\.message) == ["event 1", "event 2"])
    #expect(events.last?.level == .warn)
  }

  @Test func aMissingFileIsEmpty() {
    #expect(EventLog(url: URL(fileURLWithPath: "/nonexistent/events.jsonl")).recent().isEmpty)
  }

  @Test func readsOnlyTheEndOfALargeFile() throws {
    let filler = (0..<6000).map { _ in line(1) }
    let events = try log(filler + [line(42)]).recent(limit: 3, tailBytes: 4096)
    #expect(events.last?.message == "event 42")
    #expect(events.count == 3)
  }
}

struct SweepHealthTests {
  private let now = Date(timeIntervalSince1970: 2_000_000)

  private func status(_ state: RunState, pid: Int = 10, age: TimeInterval = 5) -> SweepStatus {
    SweepStatus(updatedAt: now.addingTimeInterval(-age), pid: pid, state: state)
  }

  @Test func noStatusMeansNotRunning() {
    #expect(SweepHealth.evaluate(status: nil, now: now, isAlive: { _ in true }) == .notRunning)
  }

  @Test func aLiveProcessThatKeepsReportingIsAlive() {
    #expect(SweepHealth.evaluate(status: status(.running), now: now, isAlive: { _ in true }) == .alive)
  }

  @Test func aDeadProcessIsNotRunningEvenIfTheFileSaysRunning() {
    #expect(SweepHealth.evaluate(status: status(.running), now: now, isAlive: { _ in false }) == .notRunning)
  }

  @Test func aLiveProcessWithAStaleFileIsUnresponsive() {
    let result = SweepHealth.evaluate(status: status(.running, age: 120), now: now, isAlive: { _ in true })
    #expect(result == .unresponsive(since: now.addingTimeInterval(-120)))
  }

  @Test func aFinishedRunKeepsItsEndState() {
    #expect(SweepHealth.evaluate(status: status(.finished), now: now, isAlive: { _ in false }) == .ended(.finished))
    #expect(SweepHealth.evaluate(status: status(.stopped), now: now, isAlive: { _ in false }) == .ended(.stopped))
  }

  @Test func thisProcessIsAlive() {
    #expect(ProcessLiveness.isAlive(Int(getpid())))
    #expect(!ProcessLiveness.isAlive(0))
  }
}

struct SweepCommandTests {
  private let paths = SweepPaths(directory: URL(fileURLWithPath: "/tmp/sweep", isDirectory: true))

  private func make(
    _ settings: SweepSettings = SweepSettings(), have: Set<String>, env: [String: String] = ["PATH": "/usr/bin:/bin"]
  ) -> Result<SweepCommand, SetupFailure> {
    SweepCommand.make(
      settings: settings, paths: paths, environment: env, fileExists: { have.contains($0) },
      isExecutable: { have.contains($0) })
  }

  private var good: Set<String> {
    let repo = NSString(string: "~/dev/web/tallo").expandingTildeInPath
    return [repo, repo + "/apps/runner/src/cli.ts", repo + "/apps/runner/.env", "/opt/homebrew/bin/node"]
  }

  @Test func buildsTheCommandTheRunnerExpects() throws {
    let command = try make(have: good).get()
    #expect(command.executable.path == "/opt/homebrew/bin/node")
    #expect(command.workingDirectory.path.hasSuffix("/dev/web/tallo/apps/runner"))
    #expect(
      command.arguments == [
        "--max-http-header-size=65536", "src/cli.ts", "sweep", "start", "--stale-hours", "20",
        "--dir", "/tmp/sweep", "--no-caffeinate",
      ])
    #expect(command.environment["TALLO_SWEEP_DIR"] == "/tmp/sweep")
  }

  @Test func lanesAndStaleHoursFollowTheSettings() throws {
    var settings = SweepSettings()
    settings.lanes = ["workday", "oracle-icims"]
    settings.staleHours = 6
    let command = try make(settings, have: good).get()
    #expect(command.arguments.suffix(2) == ["workday", "oracle-icims"])
    #expect(command.arguments.contains("6"))
  }

  @Test func putsNodesFolderAndHomebrewFirstOnThePath() throws {
    let command = try make(have: good, env: ["PATH": "/usr/bin:/opt/homebrew/bin"]).get()
    let parts = command.environment["PATH"]?.split(separator: ":").map(String.init) ?? []
    #expect(parts.first == "/opt/homebrew/bin")
    #expect(parts.filter { $0 == "/opt/homebrew/bin" }.count == 1)
    #expect(parts.contains("/usr/bin"))
  }

  @Test func reportsEverythingMissingAtOnce() {
    guard case .failure(let failure) = make(have: []) else {
      Issue.record("expected a failure")
      return
    }
    #expect(failure.problems.contains(.nodeMissing))
    #expect(failure.problems.count == 2)
  }

  @Test func saysWhichPartIsMissing() {
    let repo = NSString(string: "~/dev/web/tallo").expandingTildeInPath
    guard case .failure(let noEnv) = make(have: [repo, repo + "/apps/runner/src/cli.ts", "/opt/homebrew/bin/node"])
    else {
      Issue.record("expected a failure")
      return
    }
    #expect(noEnv.problems == [.credentialsMissing(repo + "/apps/runner/.env")])
  }

  @Test func aChosenNodeBeatsTheDefaults() throws {
    var settings = SweepSettings()
    settings.nodePath = "/custom/node"
    let command = try make(settings, have: good.union(["/custom/node"])).get()
    #expect(command.executable.path == "/custom/node")
  }
}

struct SweepSettingsTests {
  @Test func anOldSavedValueMissingNewKeysStillLoads() throws {
    let saved = #"{"repoPath":"/x","staleHours":6}"#
    let settings = try JSONDecoder().decode(SweepSettings.self, from: Data(saved.utf8))
    #expect(settings.repoPath == "/x")
    #expect(settings.staleHours == 6)
    #expect(settings.keepAwake)
    #expect(settings.rules.settleAfterWake == 10)
    #expect(settings.notifications.finished)
  }

  @Test func roundTripsThroughTheStore() {
    let defaults = UserDefaults(suiteName: "tallo-test-\(UUID().uuidString)")!
    let store = SettingsStore(defaults: defaults)
    #expect(store.load() == SweepSettings())
    var settings = SweepSettings()
    settings.lanes = ["ashby"]
    settings.rules.pauseOnLowBattery = true
    store.save(settings)
    #expect(store.load() == settings)
  }
}
