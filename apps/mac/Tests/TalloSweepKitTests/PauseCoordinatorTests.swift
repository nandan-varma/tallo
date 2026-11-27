import Foundation
import Testing

@testable import TalloSweepKit

struct PauseCoordinatorTests {
  private let t0 = Date(timeIntervalSince1970: 1_000_000)

  @Test func startsRunning() {
    #expect(!PauseCoordinator().isPaused)
  }

  @Test func theUserButtonPausesAndResumes() {
    var c = PauseCoordinator()
    c.apply(.userPaused(true), now: t0)
    #expect(c.isPaused && c.primaryReason == .user)
    c.apply(.userPaused(false), now: t0)
    #expect(!c.isPaused)
  }

  @Test func sleepPausesAndWakeResumesAfterTheSettleDelay() {
    var c = PauseCoordinator()
    c.apply(.willSleep, now: t0)
    #expect(c.primaryReason == .sleeping)
    c.apply(.didWake, now: t0.addingTimeInterval(3600))
    #expect(c.primaryReason == .settling)
    c.apply(.clock, now: t0.addingTimeInterval(3605))
    #expect(c.isPaused)
    c.apply(.clock, now: t0.addingTimeInterval(3611))
    #expect(!c.isPaused)
  }

  @Test func aWakeDelayOfZeroResumesAtOnce() {
    var rules = PauseRules()
    rules.settleAfterWake = 0
    var c = PauseCoordinator(rules: rules)
    c.apply(.willSleep, now: t0)
    c.apply(.didWake, now: t0)
    #expect(!c.isPaused)
  }

  @Test func sleepingAgainDuringTheSettleDelayStartsOver() {
    var c = PauseCoordinator()
    c.apply(.willSleep, now: t0)
    c.apply(.didWake, now: t0)
    c.apply(.willSleep, now: t0.addingTimeInterval(2))
    #expect(c.primaryReason == .sleeping)
    c.apply(.didWake, now: t0.addingTimeInterval(100))
    c.apply(.clock, now: t0.addingTimeInterval(105))
    #expect(c.isPaused)
    c.apply(.clock, now: t0.addingTimeInterval(111))
    #expect(!c.isPaused)
  }

  @Test func wakeWithoutAPriorSleepDoesNothing() {
    var c = PauseCoordinator()
    c.apply(.didWake, now: t0)
    #expect(!c.isPaused)
  }

  @Test func sleepIsIgnoredWhenTheRuleIsOff() {
    var rules = PauseRules()
    rules.pauseOnSleep = false
    var c = PauseCoordinator(rules: rules)
    c.apply(.willSleep, now: t0)
    #expect(!c.isPaused)
  }

  @Test func theUserPauseSurvivesSleepAndWake() {
    var c = PauseCoordinator()
    c.apply(.userPaused(true), now: t0)
    c.apply(.willSleep, now: t0)
    c.apply(.didWake, now: t0)
    c.apply(.clock, now: t0.addingTimeInterval(60))
    #expect(c.isPaused && c.primaryReason == .user)
  }

  @Test func offlinePausesUntilTheNetworkReturns() {
    var c = PauseCoordinator()
    c.apply(.network(online: false), now: t0)
    #expect(c.primaryReason == .offline)
    c.apply(.network(online: true), now: t0)
    #expect(!c.isPaused)
  }

  @Test func wakingOfflineStaysPausedUntilTheNetworkIsBack() {
    var c = PauseCoordinator()
    c.apply(.willSleep, now: t0)
    c.apply(.network(online: false), now: t0)
    c.apply(.didWake, now: t0.addingTimeInterval(60))
    c.apply(.clock, now: t0.addingTimeInterval(80))
    #expect(c.primaryReason == .offline)
    c.apply(.network(online: true), now: t0.addingTimeInterval(81))
    #expect(!c.isPaused)
  }

  @Test func lowBatteryHasHysteresis() {
    var rules = PauseRules()
    rules.pauseOnLowBattery = true
    rules.batteryFloorPercent = 20
    var c = PauseCoordinator(rules: rules)
    c.apply(.battery(percent: 19, onPower: false), now: t0)
    #expect(c.primaryReason == .lowBattery)
    c.apply(.battery(percent: 23, onPower: false), now: t0)
    #expect(c.isPaused)
    c.apply(.battery(percent: 25, onPower: false), now: t0)
    #expect(!c.isPaused)
  }

  @Test func powerEndsALowBatteryPauseAtOnce() {
    var rules = PauseRules()
    rules.pauseOnLowBattery = true
    var c = PauseCoordinator(rules: rules)
    c.apply(.battery(percent: 5, onPower: false), now: t0)
    c.apply(.battery(percent: 5, onPower: true), now: t0)
    #expect(!c.isPaused)
  }

  @Test func batteryIsIgnoredUnlessTheRuleIsOn() {
    var c = PauseCoordinator()
    c.apply(.battery(percent: 3, onPower: false), now: t0)
    #expect(!c.isPaused)
  }

  @Test func aHotMacPausesAndCoolsBack() {
    var c = PauseCoordinator()
    c.apply(.thermal(hot: true), now: t0)
    #expect(c.primaryReason == .hot)
    c.apply(.thermal(hot: false), now: t0)
    #expect(!c.isPaused)
  }

  @Test func theBudgetHoldIsAReasonToo() {
    var c = PauseCoordinator()
    c.apply(.budgetHeld(true), now: t0)
    #expect(c.primaryReason == .budget)
  }

  @Test func theMostSpecificReasonIsShown() {
    var c = PauseCoordinator()
    c.apply(.userPaused(true), now: t0)
    c.apply(.network(online: false), now: t0)
    #expect(c.primaryReason == .offline)
    c.apply(.willSleep, now: t0)
    #expect(c.primaryReason == .sleeping)
    #expect(c.reasons == [.user, .offline, .sleeping])
  }
}
