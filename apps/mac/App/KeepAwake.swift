import Foundation
import IOKit.pwr_mgt

/// Holds the Mac awake while seeding, the way `caffeinate -i` does: it stops idle sleep. Closing the lid still
/// sleeps a Mac that is on battery, and the app pauses the sweep for it.
final class KeepAwake {
  private var assertion: IOPMAssertionID = 0

  var isHeld: Bool { assertion != 0 }

  func set(_ held: Bool, reason: String = "Tallo Sweep is collecting job postings") {
    if held, assertion == 0 {
      var id: IOPMAssertionID = 0
      let result = IOPMAssertionCreateWithName(
        kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
        IOPMAssertionLevel(kIOPMAssertionLevelOn), reason as CFString, &id)
      if result == kIOReturnSuccess { assertion = id }
    } else if !held, assertion != 0 {
      IOPMAssertionRelease(assertion)
      assertion = 0
    }
  }

  deinit { if assertion != 0 { IOPMAssertionRelease(assertion) } }
}
