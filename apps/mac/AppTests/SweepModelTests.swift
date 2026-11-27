import Foundation
import Testing
import TalloSweepKit

@testable import TalloSweep

/// The model against files in a temporary folder standing in for a running sweep.
@MainActor
struct SweepModelTests {
  private struct Rig {
    let model: SweepModel
    let paths: SweepPaths
    var control: ControlFile { ControlFile(url: paths.control) }
  }

  private func rig(rules: PauseRules = PauseRules(), pid: Int = Int(getpid())) throws -> Rig {
    let directory = FileManager.default.temporaryDirectory.appending(
      path: "sweep-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let paths = SweepPaths(directory: directory)
    let defaults = UserDefaults(suiteName: "tallo-model-\(UUID().uuidString)")!
    var settings = SweepSettings()
    settings.keepAwake = false
    settings.rules = rules
    let store = SettingsStore(defaults: defaults)
    store.save(settings)
    let rig = Rig(model: SweepModel(paths: paths, store: store), paths: paths)
    try writeStatus(rig, pid: pid)
    return rig
  }

  private func writeStatus(
    _ rig: Rig, pid: Int = Int(getpid()), state: String = "running", paused: Bool = false,
    budgetHeld: Bool = false, age: TimeInterval = 1
  ) throws {
    let updated = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-age))
    let json = """
      {"updatedAt":"\(updated)","startedAt":"\(updated)","elapsedSec":60,"pid":\(pid),"state":"\(state)",
       "global":{"inFlight":3,"maxInFlight":40,"capacity":40,"paused":\(paused),"stop":false},
       "cost":{"rowsWritten":100,"r2Puts":10,"rowsPerMin":50,"budget":1000,"budgetUsedPct":10,"budgetHeld":\(budgetHeld)},
       "lanes":{"workday":{"state":"running","due":10,"done":4,"failedPermanent":0,"stuck":0,"etaMin":30}}}
      """
    try Data(json.utf8).write(to: rig.paths.status)
  }

  private func isPaused(_ rig: Rig) throws -> Bool? {
    (try rig.control.read()["global"] as? [String: Any])?["paused"] as? Bool
  }

  @Test func adoptsASweepThatIsAlreadyRunning() async throws {
    let rig = try rig()
    await rig.model.refresh()
    #expect(rig.model.phase == .running)
    #expect(rig.model.isAlive && !rig.model.isOwned)
    #expect(rig.model.status?.lanes.first?.name == "workday")
  }

  @Test func showsNotRunningWhenTheProcessIsGone() async throws {
    let rig = try rig(pid: 999_999)
    await rig.model.refresh()
    #expect(rig.model.phase == .idle)
  }

  @Test func aStaleStatusFromALiveProcessIsUnresponsive() async throws {
    let rig = try rig()
    try writeStatus(rig, age: 300)
    await rig.model.refresh()
    #expect(rig.model.phase == .unresponsive)
  }

  @Test func aFinishedRunShowsFinished() async throws {
    let rig = try rig()
    try writeStatus(rig, state: "finished")
    await rig.model.refresh()
    #expect(rig.model.phase == .finished)
  }

  @Test func pausingWritesTheControlFileAndResumingClearsIt() async throws {
    let rig = try rig()
    await rig.model.refresh()
    rig.model.pauseByUser()
    #expect(try isPaused(rig) == true)
    #expect(rig.model.phase == .held(.user))
    rig.model.resumeByUser()
    // A second write is held back while the sweep catches up with the first.
    #expect(rig.model.phase == .running)
  }

  @Test func sleepPausesTheSweepAndWakeLetsItGo() async throws {
    var rules = PauseRules()
    rules.settleAfterWake = 0
    let rig = try rig(rules: rules)
    await rig.model.refresh()
    rig.model.handle(.willSleep)
    #expect(try isPaused(rig) == true)
    #expect(rig.model.phase == .held(.sleeping))
    rig.model.handle(.didWake)
    #expect(rig.model.phase == .running)
  }

  @Test func goingOfflinePausesAndTheNetworkReturningResumes() async throws {
    let rig = try rig()
    await rig.model.refresh()
    rig.model.handle(.network(online: false))
    #expect(rig.model.phase == .held(.offline))
    rig.model.handle(.network(online: true))
    #expect(rig.model.phase == .running)
  }

  @Test func aSweepPausedFromTheTerminalStaysPausedWhenAdopted() async throws {
    let rig = try rig()
    try writeStatus(rig, paused: true)
    await rig.model.refresh()
    #expect(rig.model.phase == .held(.user))
    #expect(rig.model.pause.reasons.contains(.user))
  }

  @Test func followsAPauseMadeFromTheTerminalAndDoesNotUndoIt() async throws {
    let rig = try rig()
    await rig.model.refresh()
    #expect(rig.model.phase == .running)
    try writeStatus(rig, state: "paused", paused: true)
    await rig.model.refresh()
    #expect(rig.model.phase == .held(.user))
    await rig.model.refresh()
    #expect(!FileManager.default.fileExists(atPath: rig.paths.control.path))
  }

  @Test func followsAResumeMadeFromTheTerminal() async throws {
    let rig = try rig()
    try writeStatus(rig, state: "paused", paused: true)
    await rig.model.refresh()
    #expect(rig.model.phase == .held(.user))
    try writeStatus(rig, paused: false)
    await rig.model.refresh()
    #expect(rig.model.phase == .running)
  }

  @Test func anAutomaticPauseIsNotLiftedByTheSweepSayingItIsRunning() async throws {
    let rig = try rig()
    await rig.model.refresh()
    rig.model.handle(.network(online: false))
    try writeStatus(rig, paused: false)
    await rig.model.refresh()
    #expect(rig.model.phase == .held(.offline))
  }

  @Test func theBudgetHoldIsShown() async throws {
    let rig = try rig()
    try writeStatus(rig, budgetHeld: true)
    await rig.model.refresh()
    #expect(rig.model.phase == .held(.budget))
  }

  @Test func doesNotTouchTheControlFileWhenNothingDiffers() async throws {
    let rig = try rig()
    await rig.model.refresh()
    await rig.model.refresh()
    #expect(!FileManager.default.fileExists(atPath: rig.paths.control.path))
  }

  @Test func settingsChangesAreSavedAndApplyToTheRules() async throws {
    let rig = try rig()
    rig.model.settings.rules.pauseWhenOffline = false
    rig.model.handle(.network(online: false))
    #expect(!rig.model.pause.isPaused)
  }

  @Test func startingWithoutARunnerReportsWhatIsMissing() throws {
    let rig = try rig(pid: 999_999)
    rig.model.settings.repoPath = "/nonexistent/tallo"
    rig.model.start()
    #expect(rig.model.setupFailure?.problems.first == .repoMissing("/nonexistent/tallo"))
    if case .failed = rig.model.phase {} else { Issue.record("expected the failed phase") }
  }
}
