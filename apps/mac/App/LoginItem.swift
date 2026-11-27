import ServiceManagement

/// "Open at login", through the system's login-item list (System Settings > General > Login Items).
enum LoginItem {
  static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

  /// True when the system wants you to approve the item in Settings first.
  static var needsApproval: Bool { SMAppService.mainApp.status == .requiresApproval }

  static func set(_ enabled: Bool) throws {
    if enabled {
      if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
    } else if SMAppService.mainApp.status == .enabled || SMAppService.mainApp.status == .requiresApproval {
      try SMAppService.mainApp.unregister()
    }
  }
}
