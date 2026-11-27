import SwiftUI
import TalloSweepKit

/// How each state of the sweep looks: its symbol, colour and words.
extension SweepModel.Phase {
  var symbol: String {
    switch self {
    case .idle: "circle.dotted"
    case .starting: "hourglass"
    case .running: "arrow.triangle.2.circlepath"
    case .held(let reason): reason.symbol
    case .draining: "stop.circle"
    case .finished: "checkmark.circle.fill"
    case .stopped: "stop.circle.fill"
    case .unresponsive, .failed: "exclamationmark.triangle.fill"
    }
  }

  var tint: Color {
    switch self {
    case .idle, .stopped: .secondary
    case .starting: .blue
    case .running: .green
    case .held(let reason): reason == .user ? .yellow : .orange
    case .draining: .orange
    case .finished: .blue
    case .unresponsive, .failed: .red
    }
  }

  var title: String {
    switch self {
    case .idle: "Not running"
    case .starting: "Starting"
    case .running: "Seeding"
    case .held(let reason): reason.title
    case .draining: "Stopping"
    case .finished: "Finished"
    case .stopped: "Stopped"
    case .unresponsive: "Not responding"
    case .failed: "Could not run"
    }
  }
}

extension PauseReason {
  var symbol: String {
    switch self {
    case .user: "pause.circle.fill"
    case .sleeping: "moon.zzz.fill"
    case .settling: "sunrise.fill"
    case .offline: "wifi.slash"
    case .lowBattery: "battery.25percent"
    case .hot: "thermometer.high"
    case .budget: "gauge.with.dots.needle.100percent"
    }
  }

  var title: String {
    switch self {
    case .user: "Paused"
    case .sleeping: "Mac asleep"
    case .settling: "Waking up"
    case .offline: "Offline"
    case .lowBattery: "Battery low"
    case .hot: "Mac is hot"
    case .budget: "At budget"
    }
  }

  var explanation: String {
    switch self {
    case .user: "You paused it. Boards already running finish first."
    case .sleeping: "It resumes when the Mac wakes."
    case .settling: "Waiting a moment for the network to settle."
    case .offline: "It resumes when the network is back."
    case .lowBattery: "It resumes on power, or when the battery recovers."
    case .hot: "It resumes when the Mac cools down."
    case .budget: "The sweep hit its row budget. Raise it from the terminal to continue."
    }
  }
}

/// Friendlier names for the runner's lane ids.
func laneTitle(_ name: String) -> String {
  switch name {
  case "smartrecruiters": "SmartRecruiters"
  case "oracle-icims": "Oracle / iCIMS"
  case "small-ats": "Small ATS"
  case "big-sites": "Big sites"
  default: name.prefix(1).uppercased() + name.dropFirst()
  }
}
