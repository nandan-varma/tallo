import Foundation
import Testing

@testable import TalloSweepKit

struct ControlFileTests {
  private func temporaryFile() -> ControlFile {
    ControlFile(url: FileManager.default.temporaryDirectory.appending(path: "control-\(UUID().uuidString).json"))
  }

  @Test func pausingWritesTheValueAndItsStamp() throws {
    let file = temporaryFile()
    let now = Date(timeIntervalSince1970: 1_800_000_000.5)
    try file.setPaused(true, now: now)
    let content = try file.read()
    #expect((content["global"] as? [String: Any])?["paused"] as? Bool == true)
    #expect((content["_stamps"] as? [String: Any])?["global.paused"] as? Int == 1_800_000_000_500)
  }

  @Test func resumingFlipsTheValueAndMovesTheStamp() throws {
    let file = temporaryFile()
    try file.setPaused(true, now: Date(timeIntervalSince1970: 100))
    try file.setPaused(false, now: Date(timeIntervalSince1970: 200))
    let content = try file.read()
    #expect((content["global"] as? [String: Any])?["paused"] as? Bool == false)
    #expect((content["_stamps"] as? [String: Any])?["global.paused"] as? Int == 200_000)
  }

  @Test func keepsEverythingElseTheCommandLineWrote() throws {
    let file = temporaryFile()
    let existing = #"""
      {"lanes":{"workday":{"concurrency":36}},"global":{"maxInFlight":160},
       "_stamps":{"lanes.workday.concurrency":123}}
      """#
    try Data(existing.utf8).write(to: file.url)
    try file.setPaused(true, now: Date(timeIntervalSince1970: 5))
    let content = try file.read()
    let lanes = content["lanes"] as? [String: Any]
    #expect((lanes?["workday"] as? [String: Any])?["concurrency"] as? Int == 36)
    let global = content["global"] as? [String: Any]
    #expect(global?["maxInFlight"] as? Int == 160)
    #expect(global?["paused"] as? Bool == true)
    let stamps = content["_stamps"] as? [String: Any]
    #expect(stamps?["lanes.workday.concurrency"] as? Int == 123)
  }

  @Test func aMissingFileReadsAsEmpty() throws {
    #expect(try temporaryFile().read().isEmpty)
  }

  @Test func aFileThatIsNotAnObjectIsRefusedNotOverwritten() throws {
    let file = temporaryFile()
    try Data("[1,2]".utf8).write(to: file.url)
    #expect(throws: ControlFile.ControlError.notAnObject) { try file.setPaused(true) }
    #expect(try String(contentsOf: file.url, encoding: .utf8) == "[1,2]")
  }
}
