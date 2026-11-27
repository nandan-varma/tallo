import Foundation
import TalloSweepKit

/// The `tallo sweep start` child process the app owns: started from the settings, stopped the way the runner asks
/// (one interrupt drains the boards in flight, a second ends it).
final class SweepProcess {
  struct Exit: Equatable {
    var status: Int32
    /// True when the process was ended by a signal rather than exiting by itself.
    var signalled: Bool
  }

  private var process: Process?
  private(set) var interrupts = 0

  var isRunning: Bool { process?.isRunning ?? false }
  var processIdentifier: Int32? { isRunning ? process?.processIdentifier : nil }

  /// Starts the command, appending its output to `log`. `onExit` is called on the main actor when it ends.
  func start(_ command: SweepCommand, log: URL, onExit: @escaping @MainActor (Exit) -> Void) throws {
    guard !isRunning else { return }
    let process = Process()
    process.executableURL = command.executable
    process.arguments = command.arguments
    process.currentDirectoryURL = command.workingDirectory
    process.environment = command.environment
    process.standardInput = FileHandle.nullDevice
    let output = try Self.openForAppending(log)
    process.standardOutput = output
    process.standardError = output
    process.terminationHandler = { finished in
      let exit = Exit(status: finished.terminationStatus, signalled: finished.terminationReason == .uncaughtSignal)
      try? output.close()
      Task { @MainActor in onExit(exit) }
    }
    try process.run()
    self.process = process
    interrupts = 0
  }

  /// Asks the sweep to stop: the first call lets boards in flight finish, a second ends it at once.
  func interrupt() {
    guard let process, process.isRunning else { return }
    interrupts += 1
    process.interrupt()
  }

  func terminate() {
    guard let process, process.isRunning else { return }
    kill(process.processIdentifier, SIGKILL)
  }

  private static func openForAppending(_ url: URL) throws -> FileHandle {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    if !FileManager.default.fileExists(atPath: url.path) {
      FileManager.default.createFile(atPath: url.path, contents: nil)
    }
    let handle = try FileHandle(forWritingTo: url)
    try handle.seekToEnd()
    return handle
  }
}
