import AppKit
import Foundation
import Observation
import TalloSweepKit

/// Everything the menu bar shows and every action it offers. It owns the sweep process when the app started it,
/// and adopts one that is already running (started from a terminal, or by the app before it was restarted).
@MainActor
@Observable
final class SweepModel {
  /// What the sweep is doing, for the icon and the headline.
  enum Phase: Equatable {
    case idle
    case starting
    case running
    case held(PauseReason)
    case draining
    case finished
    case stopped
    case unresponsive
    case failed(String)
  }

  // MARK: Observed state

  private(set) var status: SweepStatus?
  private(set) var health: SweepHealth = .notRunning
  private(set) var events: [SweepEvent] = []
  private(set) var pause = PauseCoordinator()
  private(set) var setupFailure: SetupFailure?
  /// The process could not be launched at all (the folder and Node were fine).
  private(set) var launchError: String?
  private(set) var lastExit: SweepProcess.Exit?
  private(set) var crashDetail = ""
  private(set) var isStarting = false
  private(set) var lastRead: Date?
  private(set) var loginItemError: String?

  var settings: SweepSettings {
    didSet {
      guard settings != oldValue else { return }
      store.save(settings)
      pause.rules = settings.rules
      refreshKeepAwake()
    }
  }

  let paths: SweepPaths

  // MARK: Collaborators

  private let store: SettingsStore
  private let process = SweepProcess()
  private let keepAwake = KeepAwake()
  private let notifier = Notifier()
  private let signals = SystemSignals()
  private var control: ControlFile { ControlFile(url: paths.control) }

  private var tasks: [Task<Void, Never>] = []
  private var polls = 0
  private var stoppedByUser = false
  private var adopted = false
  private var wasAlive = false
  private var announcedBudgetFor: Date?
  private var lastControlWrite: Date = .distantPast

  init(paths: SweepPaths = .standard, store: SettingsStore = SettingsStore()) {
    self.paths = paths
    self.store = store
    let loaded = store.load()
    settings = loaded
    pause = PauseCoordinator(rules: loaded.rules)
  }

  // MARK: Lifecycle

  /// Starts watching the Mac and the sweep's files. Called once, when the app opens.
  func begin() {
    guard tasks.isEmpty else { return }
    if settings.notifications.finished || settings.notifications.problems || settings.notifications.budget {
      notifier.requestPermission()
    }
    tasks.append(Task { [weak self] in await self?.pollForever() })
    tasks.append(
      Task { [weak self] in
        guard let signals = self?.signals else { return }
        for await event in signals.events() { self?.handle(event) }
      })
    registerLoginItemOnFirstRun()
    if settings.startOnLaunch {
      Task { [weak self] in
        try? await Task.sleep(for: .seconds(2))  // let the first read show whether a sweep is already running
        if self?.health == .notRunning { self?.start() }
      }
    }
  }

  func end() {
    tasks.forEach { $0.cancel() }
    tasks = []
    keepAwake.set(false)
  }

  // MARK: Derived

  var phase: Phase {
    switch health {
    case .ended(.finished): return .finished
    case .ended: return .stopped
    case .unresponsive: return .unresponsive
    case .alive:
      if status?.state == .draining { return .draining }
      if let reason = heldReason { return .held(reason) }
      return .running
    case .notRunning:
      if isStarting { return .starting }
      if let failure = launchFailureText { return .failed(failure) }
      return .idle
    }
  }

  /// Why the sweep is not starting boards, if it is not: our own reasons first, else a pause someone else set.
  var heldReason: PauseReason? {
    if let reason = pause.primaryReason { return reason }
    return status?.global.paused == true ? .user : nil
  }

  var isAlive: Bool {
    if case .alive = health { return true }
    if case .unresponsive = health { return true }
    return false
  }

  var isOwned: Bool { process.isRunning }

  /// A sweep this app can pause, stop or show: running, held, draining or starting.
  var isActive: Bool { isAlive || isStarting }

  private var launchFailureText: String? {
    if let failure = setupFailure { return failure.problems.first?.message ?? "Could not start." }
    if let launchError { return launchError }
    if let exit = lastExit, exit.status != 0, !exit.signalled, !stoppedByUser { return "Stopped with code \(exit.status)." }
    return nil
  }

  // MARK: Actions

  func start() {
    guard !isActive else { return }
    setupFailure = nil
    launchError = nil
    lastExit = nil
    crashDetail = ""
    stoppedByUser = false
    switch SweepCommand.make(settings: settings, paths: paths) {
    case .failure(let failure):
      setupFailure = failure
      if settings.notifications.problems {
        notifier.post(.problem, title: "Sweep did not start", body: failure.problems.first?.message ?? "")
      }
    case .success(let command):
      // Whatever an older run left in the control file must not decide how this one begins.
      writeControl(paused: pause.isPaused)
      do {
        try process.start(command, log: paths.processLog) { [weak self] exit in self?.processExited(exit) }
        isStarting = true
      } catch {
        launchError = error.localizedDescription
      }
    }
    refreshKeepAwake()
  }

  /// Stops starting new boards; boards running finish, and the sweep exits. A second call ends it at once.
  func stop() {
    guard isActive else { return }
    stoppedByUser = true
    if process.isRunning {
      process.interrupt()
    } else if let pid = status?.pid, pid > 0 {
      kill(pid_t(pid), SIGINT)
    }
  }

  func pauseByUser() { handle(.userPaused(true)) }
  func resumeByUser() { handle(.userPaused(false)) }

  func openLogs() { NSWorkspace.shared.open(paths.directory) }

  func setLaunchAtLogin(_ enabled: Bool) {
    do {
      try LoginItem.set(enabled)
      loginItemError = LoginItem.needsApproval ? "Approve Tallo Sweep in System Settings > General > Login Items." : nil
    } catch {
      loginItemError = error.localizedDescription
    }
  }

  // MARK: Reading the sweep

  private func pollForever() async {
    while !Task.isCancelled {
      await refresh()
      try? await Task.sleep(for: .seconds(2))
    }
  }

  /// Reads the sweep's files once and updates everything that follows from them.
  func refresh() async {
    polls += 1
    apply(await SweepReader.read(paths, includeEvents: polls % 3 == 1))
  }

  private func apply(_ snapshot: SweepSnapshot) {
    lastRead = .now
    if snapshot.status != status { status = snapshot.status }
    if let events = snapshot.events, events != self.events { self.events = events }
    let previous = health
    health = SweepHealth.evaluate(status: snapshot.status)
    if isAlive || health == .alive { isStarting = false }
    if case .alive = health { wasAlive = true }

    adoptPauseIfNeeded()
    handle(.budgetHeld(status?.cost.budgetHeld ?? false))
    handle(.clock)
    notifyOnTransitions(from: previous)
    refreshKeepAwake()
    if !isAlive { adopted = false }
  }

  /// A sweep that was already paused when we first see it stays paused: that was somebody's decision.
  private func adoptPauseIfNeeded() {
    guard case .alive = health, !adopted else { return }
    adopted = true
    if status?.global.paused == true, !pause.isPaused { handle(.userPaused(true)) }
  }

  // MARK: Pausing

  func handle(_ event: PauseCoordinator.Event) {
    let before = pause
    pause.apply(event)
    guard pause != before else { return }
    reconcileControl()
    refreshKeepAwake()
  }

  /// Makes the sweep's pause flag match what the rules say. Writing again is held back for a few seconds because the
  /// sweep reads the file every three, so the status needs time to catch up.
  private func reconcileControl() {
    guard case .alive = health, status?.global.paused != pause.isPaused else { return }
    guard Date.now.timeIntervalSince(lastControlWrite) > 4 else { return }
    writeControl(paused: pause.isPaused)
  }

  private func writeControl(paused: Bool) {
    lastControlWrite = .now
    do { try control.setPaused(paused) } catch { crashDetail = "Could not write the control file: \(error.localizedDescription)" }
  }

  private func refreshKeepAwake() {
    let busy = isActive && !pause.isPaused
    keepAwake.set(settings.keepAwake && busy)
    if case .alive = health { reconcileControl() }
  }

  // MARK: Process and notifications

  private func processExited(_ exit: SweepProcess.Exit) {
    lastExit = exit
    isStarting = false
    Task { [paths] in
      let tail = await SweepReader.processLogTail(paths)
      self.crashDetail = exit.status == 0 || stoppedByUser ? "" : tail
      if exit.status != 0, !exit.signalled, !self.stoppedByUser, self.settings.notifications.problems {
        self.notifier.post(
          .problem, title: "The sweep stopped unexpectedly", body: "Exit code \(exit.status). Open the app for details.")
      }
    }
  }

  private func notifyOnTransitions(from previous: SweepHealth) {
    if case .ended(.finished) = health, wasAlive, previous != health, settings.notifications.finished {
      let done = status?.boardsDone ?? 0
      notifier.post(.finished, title: "Sweep finished", body: "\(done) boards done in \(Format.duration(Double(status?.elapsedSec ?? 0))).")
      wasAlive = false
    }
    if case .unresponsive = health, previous != health, settings.notifications.problems {
      notifier.post(.problem, title: "The sweep stopped reporting", body: "It is running but has not updated its status for a minute.")
    }
    if let status, status.cost.budgetFraction >= 0.8, announcedBudgetFor != status.startedAt,
      settings.notifications.budget
    {
      announcedBudgetFor = status.startedAt
      notifier.post(
        .budget, title: "Sweep budget at \(Int(status.cost.budgetUsedPct))%",
        body: "\(Format.count(status.cost.rowsWritten)) of \(Format.count(status.cost.budget)) rows written.")
    }
  }

  private func registerLoginItemOnFirstRun() {
    let key = "tallo.sweep.loginItemOffered"
    guard !UserDefaults.standard.bool(forKey: key) else { return }
    UserDefaults.standard.set(true, forKey: key)
    setLaunchAtLogin(true)
  }
}
