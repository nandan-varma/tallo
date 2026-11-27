import Foundation
import Testing

@testable import TalloSweepKit

struct SweepStatusTests {
  private func fixture(_ name: String) throws -> Data {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try Data(contentsOf: url)
  }

  @Test func decodesARealStatusFile() throws {
    let status = try SweepStatus.decode(fixture("status"))
    #expect(status.state == .running)
    #expect(status.pid > 0)
    #expect(status.global.maxInFlight > 0)
    #expect(status.cost.budget > 0)
    #expect(status.lanes.map(\.name) == ["greenhouse", "workday", "microsoft"])
    let workday = try #require(status.lanes.first { $0.name == "workday" })
    #expect(workday.due > 0)
    #expect(workday.inFlight.first?.name.contains(":") == false)
  }

  @Test func readsDatesWithAndWithoutFractionalSeconds() throws {
    let json = #"{"updatedAt":"2026-11-27T06:39:10.484Z","startedAt":"2026-11-27T00:31:18Z"}"#
    let status = try SweepStatus.decode(Data(json.utf8))
    #expect(status.updatedAt.timeIntervalSince(status.startedAt) > 6 * 3600)
  }

  @Test func aMissingKeyTakesADefaultInsteadOfFailing() throws {
    let status = try SweepStatus.decode(Data(#"{"pid":7,"lanes":{"ashby":{"due":10}}}"#.utf8))
    #expect(status.pid == 7)
    #expect(status.lanes.first?.due == 10)
    #expect(status.lanes.first?.done == 0)
    #expect(status.global.paused == false)
    #expect(status.cost.budgetUsedPct == 0)
  }

  @Test func anUnknownStateIsKeptNotRejected() throws {
    let status = try SweepStatus.decode(Data(#"{"state":"hibernating"}"#.utf8))
    #expect(status.state == .unknown("hibernating"))
  }

  @Test func overallProgressCountsDoneAndFailedBoards() {
    let status = SweepStatus(
      lanes: [
        .init(name: "a", due: 10, done: 6, failedPermanent: 1),
        .init(name: "b", due: 10, done: 0),
      ])
    #expect(status.boardsDue == 20)
    #expect(status.overallProgress == 7.0 / 20.0)
  }

  @Test func theLongestLaneEstimateIsTheSweepsEta() {
    let status = SweepStatus(
      lanes: [.init(name: "a", etaMin: 20), .init(name: "b", etaMin: 150), .init(name: "c", etaMin: nil)])
    #expect(status.etaMinutes == 150)
    #expect(SweepStatus(lanes: [.init(name: "a")]).etaMinutes == nil)
  }

  @Test func lanesComeInTheRunnersOrderThenByName() {
    let json = #"{"lanes":{"zeta":{},"workday":{},"greenhouse":{},"alpha":{}}}"#
    let status = try? SweepStatus.decode(Data(json.utf8))
    #expect(status?.lanes.map(\.name) == ["greenhouse", "workday", "alpha", "zeta"])
  }

  @Test func aLaneWithNothingDueIsFinished() {
    #expect(SweepStatus.Lane(name: "x", due: 0).isFinished)
    #expect(SweepStatus.Lane(name: "x", state: "done", due: 5, done: 5).isFinished)
    #expect(!SweepStatus.Lane(name: "x", due: 5, done: 2).isFinished)
  }
}
