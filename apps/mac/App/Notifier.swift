import Foundation
import UserNotifications

/// Local notifications for the few things worth leaving the menu bar for.
@MainActor
final class Notifier {
  enum Kind: String {
    case finished, problem, budget
  }

  private let center = UNUserNotificationCenter.current()

  func requestPermission() {
    center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
  }

  func post(_ kind: Kind, title: String, body: String) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = kind == .finished ? .default : nil
    content.threadIdentifier = kind.rawValue
    center.add(UNNotificationRequest(identifier: "\(kind.rawValue)-\(UUID())", content: content, trigger: nil))
  }
}
