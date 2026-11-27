import SwiftUI
import TalloSweepKit

struct SettingsView: View {
  @Bindable var model: SweepModel

  var body: some View {
    TabView {
      Tab("General", systemImage: "gearshape") { GeneralSettings(model: model) }
      Tab("Sweep", systemImage: "arrow.triangle.2.circlepath") { SweepSettingsTab(model: model) }
      Tab("Pausing", systemImage: "pause.circle") { PausingSettings(model: model) }
      Tab("Notifications", systemImage: "bell") { NotificationSettings(model: model) }
    }
    .scenePadding()
    .frame(width: 480, height: 420)
  }
}

private struct GeneralSettings: View {
  @Bindable var model: SweepModel
  @State private var launchAtLogin = LoginItem.isEnabled

  var body: some View {
    Form {
      Section {
        Toggle("Open at login", isOn: $launchAtLogin)
          .onChange(of: launchAtLogin) { _, enabled in
            model.setLaunchAtLogin(enabled)
            launchAtLogin = LoginItem.isEnabled
          }
        if let error = model.loginItemError { Text(error).font(.caption).foregroundStyle(.orange) }
        Toggle("Start seeding when the app opens", isOn: $model.settings.startOnLaunch)
      }
      Section {
        Toggle("Keep the Mac awake while seeding", isOn: $model.settings.keepAwake)
      } footer: {
        Text("Stops idle sleep, like caffeinate. Pausing lets the Mac sleep again. Closing the lid on battery still sleeps.")
      }
    }
    .formStyle(.grouped)
  }
}

private struct SweepSettingsTab: View {
  @Bindable var model: SweepModel

  var body: some View {
    Form {
      Section("Runner") {
        TextField("Tallo folder", text: $model.settings.repoPath, prompt: Text("~/dev/web/tallo"))
        TextField("Node", text: $model.settings.nodePath, prompt: Text("Found automatically"))
      }
      Section {
        Stepper("Skip boards done within \(model.settings.staleHours) hours", value: $model.settings.staleHours, in: 0...168)
        TextField(
          "Lanes", text: lanes, prompt: Text("All"))
      } footer: {
        Text("Lanes are separated by spaces, for example: workday oracle-icims. Empty runs all of them.")
      }
    }
    .formStyle(.grouped)
  }

  private var lanes: Binding<String> {
    Binding(
      get: { model.settings.lanes.joined(separator: " ") },
      set: { model.settings.lanes = $0.split(whereSeparator: \.isWhitespace).map(String.init) })
  }
}

private struct PausingSettings: View {
  @Bindable var model: SweepModel

  var body: some View {
    Form {
      Section {
        Toggle("Pause when the Mac sleeps", isOn: $model.settings.rules.pauseOnSleep)
        Stepper(
          "Wait \(Int(model.settings.rules.settleAfterWake)) seconds after waking",
          value: $model.settings.rules.settleAfterWake, in: 0...60, step: 5)
        .disabled(!model.settings.rules.pauseOnSleep)
        Toggle("Pause when offline", isOn: $model.settings.rules.pauseWhenOffline)
        Toggle("Pause when the Mac gets hot", isOn: $model.settings.rules.pauseWhenHot)
      } footer: {
        Text("Sleep covers closing the lid, the Apple menu and idle sleep. Turning the screen off does not pause.")
      }
      Section {
        Toggle("Pause on low battery", isOn: $model.settings.rules.pauseOnLowBattery)
        Stepper(
          "Below \(model.settings.rules.batteryFloorPercent)%", value: $model.settings.rules.batteryFloorPercent,
          in: 5...80, step: 5)
        .disabled(!model.settings.rules.pauseOnLowBattery)
      }
    }
    .formStyle(.grouped)
  }
}

private struct NotificationSettings: View {
  @Bindable var model: SweepModel

  var body: some View {
    Form {
      Section {
        Toggle("When the sweep finishes", isOn: $model.settings.notifications.finished)
        Toggle("When something goes wrong", isOn: $model.settings.notifications.problems)
        Toggle("When the budget passes 80%", isOn: $model.settings.notifications.budget)
      }
    }
    .formStyle(.grouped)
  }
}
