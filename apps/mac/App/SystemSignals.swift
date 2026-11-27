import AppKit
import Foundation
import IOKit.ps
import Network
import TalloSweepKit

/// What the Mac reports that can pause the sweep: sleep and wake, the network, the battery and the heat, as one
/// stream of `PauseCoordinator` events. Nothing here decides anything.
final class SystemSignals {
  /// All events, until the consuming task is cancelled.
  func events() -> AsyncStream<PauseCoordinator.Event> {
    AsyncStream { continuation in
      let workspace = NSWorkspace.shared.notificationCenter
      let watchers: [Task<Void, Never>] = [
        Task {
          for await _ in workspace.notifications(named: NSWorkspace.willSleepNotification) {
            continuation.yield(.willSleep)
          }
        },
        Task {
          for await _ in workspace.notifications(named: NSWorkspace.didWakeNotification) {
            continuation.yield(.didWake)
            if let battery = Self.battery() { continuation.yield(battery) }
            continuation.yield(Self.thermal())
          }
        },
        Task {
          for await _ in NotificationCenter.default.notifications(named: ProcessInfo.thermalStateDidChangeNotification) {
            continuation.yield(Self.thermal())
          }
        },
        Task {
          for await path in NWPathMonitor() { continuation.yield(.network(online: path.status == .satisfied)) }
        },
        // The battery has no change notification worth the plumbing; a minute is fine for a pause floor.
        Task {
          while !Task.isCancelled {
            if let battery = Self.battery() { continuation.yield(battery) }
            try? await Task.sleep(for: .seconds(60))
          }
        },
      ]
      continuation.yield(Self.thermal())
      continuation.onTermination = { _ in watchers.forEach { $0.cancel() } }
    }
  }

  private static func thermal() -> PauseCoordinator.Event {
    let state = ProcessInfo.processInfo.thermalState
    return .thermal(hot: state == .serious || state == .critical)
  }

  /// The internal battery's charge and whether the Mac is on power; nil on a Mac without a battery.
  private static func battery() -> PauseCoordinator.Event? {
    guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
      let sources = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef]
    else { return nil }
    for source in sources {
      guard let description = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue() as? [String: Any],
        description[kIOPSTypeKey] as? String == kIOPSInternalBatteryType,
        let current = description[kIOPSCurrentCapacityKey] as? Int,
        let maximum = description[kIOPSMaxCapacityKey] as? Int, maximum > 0
      else { continue }
      let onPower = description[kIOPSPowerSourceStateKey] as? String == kIOPSACPowerValue
      return .battery(percent: current * 100 / maximum, onPower: onPower)
    }
    return nil
  }
}
