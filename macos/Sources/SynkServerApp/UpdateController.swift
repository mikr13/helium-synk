import AppKit
import Combine
import ServiceManagement
import Sparkle
import SwiftUI
import SynkCore
import SynkUI

@MainActor final class UpdateController: NSObject, ObservableObject {
  static let shared = UpdateController()
  @Published private(set) var canCheck = false
  @Published private(set) var automaticChecks = false
  @Published private(set) var availableVersion: String?
  @Published private(set) var preparing = false
  @Published private(set) var openAtLogin = SMAppService.mainApp.status == .enabled
  @Published var error: String?
  private var installedTarget: String?
  private var handover: UUID?
  @Published private(set) var installerActive = false
  private var preparedForInstall = false
  private var started = false
  private var preparationTask: Task<Void, Never>?
  private let applicationURL: URL
  private let dataRoot: () -> URL
  init(
    applicationURL: URL = Bundle.main.bundleURL,
    dataRoot: @escaping () -> URL = { DataLocation().root }
  ) {
    self.applicationURL = applicationURL
    self.dataRoot = dataRoot
    super.init()
  }
  private var maintenance: UpdateMaintenance {
    UpdateMaintenance(
      root: dataRoot(),
      relay: applicationURL.appendingPathComponent("Contents/MacOS/synk-server"))
  }
  private lazy var driver: CoordinatedUpdateDriver = {
    let driver = CoordinatedUpdateDriver(hostBundle: .main, delegate: self)
    driver.coordinator = self
    return driver
  }()
  private lazy var updater = SPUUpdater(
    hostBundle: .main, applicationBundle: .main, userDriver: driver, delegate: self)
  func start() {
    guard !started, Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") != nil else { return }
    started = true
    updater.publisher(for: \.canCheckForUpdates).assign(to: &$canCheck)
    updater.publisher(for: \.automaticallyChecksForUpdates).assign(to: &$automaticChecks)
    do { try updater.start() } catch { self.error = error.localizedDescription }
    Task {
      do {
        let generation = try AppGeneration(app: applicationURL)
        _ = try await maintenance.verifyRestart(
          generation: generation,
          helperExpected: SMAppService.agent(plistName: "com.heliumsynk.server.agent.plist").status
            == .enabled)
      } catch { self.error = error.localizedDescription }
    }
  }
  func check() {
    guard started else {
      error = "Use the installed, signed app to check for updates."
      return
    }
    NSApp.activate(ignoringOtherApps: true)
    updater.checkForUpdates()
  }
  func setAutomaticChecks(_ enabled: Bool) { updater.automaticallyChecksForUpdates = enabled }
  func setOpenAtLogin(_ enabled: Bool) {
    do {
      if enabled {
        try SMAppService.mainApp.register()
      } else {
        try SMAppService.mainApp.unregister()
      }
      openAtLogin = SMAppService.mainApp.status == .enabled
    } catch { self.error = error.localizedDescription }
  }
  var mayQuit: Bool {
    preparedForInstall
      || (!updating && (!started || !updater.sessionInProgress))
  }
  var updating: Bool { preparing || installerActive || handover != nil }
  func offer(version: String, displayVersion: String) {
    installedTarget = version
    availableVersion = displayVersion
  }
  func noteInstaller() { installerActive = true }
  func select(
    _ choice: SPUUserUpdateChoice, requiresHandover: Bool, finalStage: Bool = true,
    reply: @escaping (SPUUserUpdateChoice) -> Void
  ) {
    // Dismissal must cancel a staged install, otherwise Sparkle installs it on ordinary app quit.
    guard choice == .install && requiresHandover else {
      reply(finalStage && choice == .dismiss ? .skip : choice)
      return
    }
    guard let target = installedTarget, !preparing else {
      reply(.skip)
      return
    }
    preparing = true
    error = nil
    let maintenance = maintenance
    preparationTask = Task {
      defer { preparing = false }
      do {
        let generation = try AppGeneration(app: applicationURL)
        if let handover, let request = try maintenance.request(),
          let status = try maintenance.status(),
          request.id == handover, status.id == handover, status.phase == .ready,
          status.generation == generation, request.targetVersion == target,
          request.action == .prepare, request.expiresAt.timeIntervalSinceNow > 30
        {
          // Recheck preparation before relaunch; a long download must not use an expired lease.
        } else {
          if let handover { try maintenance.cancel(handover) }
          handover = try await maintenance.prepare(targetVersion: target, generation: generation)
        }
        try Task.checkCancellation()
        preparedForInstall = finalStage
        reply(.install)
      } catch {
        if let handover { try? maintenance.cancel(handover) }
        handover = nil
        if !(error is CancellationError) { self.error = error.localizedDescription }
        preparedForInstall = false
        reply(.skip)
      }
    }
  }
  func finished() {
    preparationTask?.cancel()
    preparationTask = nil
    if let handover { try? maintenance.cancel(handover) }
    handover = nil
    installerActive = false
    preparedForInstall = false
  }
}
extension UpdateController: SPUUpdaterDelegate, @preconcurrency SPUStandardUserDriverDelegate {
  var supportsGentleScheduledUpdateReminders: Bool { true }
  func standardUserDriverShouldHandleShowingScheduledUpdate(
    _ update: SUAppcastItem, andInImmediateFocus immediateFocus: Bool
  ) -> Bool { false }
  func standardUserDriverWillFinishUpdateSession() {
    availableVersion = nil
    finished()
  }
  func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
    offer(version: item.versionString, displayVersion: item.displayVersionString)
  }
  func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) { noteInstaller() }
  func updater(
    _ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
    immediateInstallationBlock: @escaping () -> Void
  ) -> Bool {
    offer(version: item.versionString, displayVersion: item.displayVersionString)
    noteInstaller()
    return true  // Explicit Install is required; ordinary Quit is guarded by the app delegate.
  }
  func updater(_ updater: SPUUpdater, didAbortWithError error: Error) { finished() }
  func standardUserDriverWillHandleShowingUpdate(
    _ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState
  ) {
    installedTarget = update.versionString
    if !state.userInitiated { availableVersion = update.displayVersionString }
  }
  func standardUserDriverDidReceiveUserAttention(forUpdate update: SUAppcastItem) {
    availableVersion = nil
  }
}

/// Keep Sparkle's tested UI/installer; intercept only the choices that can replace running servers.
@MainActor final class CoordinatedUpdateDriver: SPUStandardUserDriver {
  weak var coordinator: UpdateController?
  override func showUpdateFound(
    with appcastItem: SUAppcastItem, state: SPUUserUpdateState,
    reply: @escaping (SPUUserUpdateChoice) -> Void
  ) {
    let staged = state.stage == .installing
    if staged { coordinator?.noteInstaller() }
    super.showUpdateFound(with: appcastItem, state: state) { [weak self] choice in
      guard let self, let coordinator = self.coordinator else {
        reply(.skip)
        return
      }
      coordinator.select(
        choice, requiresHandover: !appcastItem.isInformationOnlyUpdate, finalStage: staged,
        reply: reply)
    }
  }
  override func showDownloadDidStartExtractingUpdate() {
    coordinator?.noteInstaller()
    super.showDownloadDidStartExtractingUpdate()
  }
  override func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
    super.showReady { [weak self] choice in
      guard let self, let coordinator = self.coordinator else {
        reply(.skip)
        return
      }
      coordinator.select(choice, requiresHandover: true, reply: reply)
    }
  }
  override func dismissUpdateInstallation() {
    coordinator?.finished()
    super.dismissUpdateInstallation()
  }
}

@MainActor final class ServerAppDelegate: NSObject, NSApplicationDelegate {
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard UpdateController.shared.mayQuit else {
      UpdateController.shared.check()
      return .terminateCancel
    }
    return .terminateNow
  }
}

struct UpdateSettingsView: View {
  @ObservedObject var updates: UpdateController
  var body: some View {
    VStack(alignment: .leading, spacing: 22) {
      Text("Updates").font(SynkTheme.font(25, weight: .bold))
      Text("HELIUM SYNK SERVER").font(SynkTheme.mono(10)).foregroundStyle(SynkTheme.muted)
      Toggle(
        "Check for updates automatically",
        isOn: Binding(get: { updates.automaticChecks }, set: updates.setAutomaticChecks))
      Toggle(
        "Open in the menu bar at login",
        isOn: Binding(get: { updates.openAtLogin }, set: updates.setOpenAtLogin))
      Text(
        "Checks run quietly. When you choose Install, sync pauses while the update downloads and the server restarts."
      ).font(
        SynkTheme.font(12)
      ).foregroundStyle(SynkTheme.muted)
      if updates.preparing { ProgressView("Preparing your server…") }
      if let error = updates.error {
        Text(error).font(SynkTheme.font(12)).foregroundStyle(SynkTheme.destructive)
      }
      Button(updates.availableVersion.map { "Install \($0)…" } ?? "Check for Updates…") {
        updates.check()
      }
      .buttonStyle(ActionStyle(primary: true))
      .disabled(!updates.canCheck || updates.preparing)
      Text(
        "Version \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Development")"
      ).font(SynkTheme.mono(10)).foregroundStyle(SynkTheme.muted)
    }
    .font(SynkTheme.font(14)).tint(SynkTheme.primary).padding(30)
    .frame(width: 460).background(SynkTheme.background).foregroundStyle(SynkTheme.foreground)
    .preferredColorScheme(.dark)
  }
}
