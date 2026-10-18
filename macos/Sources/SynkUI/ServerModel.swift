import AppKit
import Foundation
import ServiceManagement
import SwiftUI
import SynkCore
import UniformTypeIdentifiers

public enum Screen: String, CaseIterable { case welcome, network, account, connect, dashboard }
@MainActor public final class ServerModel: ObservableObject {
  @Published public var screen: Screen = .welcome
  @Published var busy = false
  @Published var error: String?
  @Published var tailnet: Tailnet?
  @Published var tailscaleInstalled = Tailscale.discover() != nil
  @Published var accountName = "Personal"
  @Published var deviceName = Host.current().localizedName ?? "My Mac"
  @Published var profiles: [Profile] = []
  @Published var selected = ""
  @Published public private(set) var online = false
  @Published var remoteOnline = false
  @Published var backgroundEnabled = false
  @Published var needsApproval = false
  @Published var backup: BackupStatus?
  @Published var health: HealthStatus?
  @Published public private(set) var paused = false
  @Published var connectionSaved = false
  @Published var legacy = false
  @Published var root: URL
  private var route: RouteChoice?
  private let preview: Bool
  private let service = SMAppService.agent(plistName: "com.heliumsynk.server.agent.plist")
  public static var savedRoot: URL { DataLocation().root }
  public init(previewScreen: Screen? = nil) {
    preview = previewScreen != nil
    root = previewScreen == nil ? Self.savedRoot : URL(fileURLWithPath: "/tmp/synk-preview-data")
    if let screen = previewScreen {
      self.screen = screen
      tailnet = Tailnet(state: "Running", hostname: "sync-host.example.ts.net")
      tailscaleInstalled = true
      backgroundEnabled = true
      online = true
      remoteOnline = true
      let profile = Profile(
        name: "personal", port: 4318, serverURL: "https://sync-host.example.ts.net",
        deviceName: "My Mac")
      profiles = [profile]
      selected = profile.name
      route = RouteChoice(
        httpsPort: 443, localPort: 4318, origin: profile.serverURL, alreadyConfigured: false)
      backup = BackupStatus(
        ok: true, checkedAt: Date(), snapshot: "daily-today.sqlite", snapshotModifiedAt: Date())
      health = HealthStatus(
        ok: true, checkedAt: Date(), problems: [], databaseBytes: 2_400_000,
        freeBytes: 30_000_000_000, backupAgeHours: 0)
    }
  }
  var current: Profile? { profiles.first { $0.name == selected } }
  var relay: URL { Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/synk-server") }
  var operations: Operations { Operations(root: root, relay: relay) }
  var canCreate: Bool {
    !accountName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !deviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && route != nil
  }
  var step: Int {
    switch screen {
    case .welcome: return 0
    case .network: return 1
    case .account: return 2
    case .connect, .dashboard: return 3
    }
  }
  func perform(_ action: @escaping @MainActor () async throws -> Void) {
    guard !busy else { return }
    busy = true
    error = nil
    Task {
      defer { busy = false }
      do { try await action() } catch { self.error = error.localizedDescription }
    }
  }
  public func refresh() async {
    guard !preview else { return }
    do {
      let installation = Installation(root: root, relay: relay)
      legacy = installation.legacy
      if installation.exists {
        let config = try Deployment.load(root: root)
        profiles = config.profiles.values.sorted { $0.name < $1.name }
        if current == nil { selected = profiles.first?.name ?? "" }
        if screen == .welcome && !legacy { screen = .dashboard }
      }
      backgroundEnabled = service.status == .enabled
      needsApproval = service.status == .requiresApproval
      if let profile = current {
        online = await Supervisor.readiness(port: profile.port)
        backup = try? StatusFiles.load(
          BackupStatus.self,
          at: root.appendingPathComponent("accounts/\(profile.name)/backup-status.json"))
        health = try? StatusFiles.load(
          HealthStatus.self,
          at: root.appendingPathComponent("accounts/\(profile.name)/health-status.json"))
        let runtime = try? StatusFiles.load(
          RuntimeSettings.self, at: root.appendingPathComponent("runtime.json"))
        paused = runtime?.paused.contains(profile.name) == true
        remoteOnline = await checkPrivateEndpoint(profile)
      }
    } catch { self.error = error.localizedDescription }
  }
  private func checkPrivateEndpoint(_ profile: Profile) async -> Bool {
    var request = URLRequest(url: URL(string: profile.serverURL + "/health/ready")!)
    request.timeoutInterval = 4
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      let value = try JSONSerialization.jsonObject(with: data) as? [String: Any]
      return (response as? HTTPURLResponse)?.statusCode == 200
        && value?["status"] as? String == "ready"
    } catch { return false }
  }
  func checkNetwork() {
    perform {
      if self.preview {
        self.screen = .network
        return
      }
      guard let executable = Tailscale.discover() else {
        self.tailscaleInstalled = false
        throw SynkError.message("Install Tailscale, then check again.")
      }
      self.tailscaleInstalled = true
      self.tailnet = try await Task.detached { try Tailscale(executable: executable).status() }
        .value
    }
  }
  func continueFromNetwork() {
    perform {
      if self.preview {
        self.screen = .account
        return
      }
      guard let tailnet = self.tailnet, tailnet.connected, let executable = Tailscale.discover()
      else { throw SynkError.message("Connect Tailscale first.") }
      let installation = Installation(root: self.root, relay: self.relay)
      guard !installation.legacy else {
        throw SynkError.message("Choose another data folder to keep your existing server running.")
      }
      let excluded = Set(self.profiles.map(\.port))
      let usedRemote = Set(
        self.profiles.compactMap { URLComponents(string: $0.serverURL)?.port ?? 443 })
      self.route = try await Task.detached {
        let localPort = try installation.availableLocalPort(excluding: excluded)
        return try Tailscale.chooseRoute(
          host: tailnet.hostname, localPort: localPort,
          config: Tailscale(executable: executable).routes(), excluded: usedRemote)
      }.value
      self.screen = .account
    }
  }
  func createAccount() {
    perform {
      if self.preview {
        self.screen = .connect
        return
      }
      let applicationPaths = [
        "/Applications/",
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path
          + "/",
      ]
      guard applicationPaths.contains(where: { Bundle.main.bundleURL.path.hasPrefix($0) }) else {
        throw SynkError.message("Move Helium Synk Server into Applications, then open it again.")
      }
      guard let route = self.route, let tailnet = self.tailnet,
        let executable = Tailscale.discover()
      else { throw SynkError.message("Check Tailscale again.") }
      let name = self.accountName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        .replacingOccurrences(of: " ", with: "-")
      let profile = Profile(
        name: name, port: route.localPort, serverURL: route.origin, deviceName: self.deviceName)
      _ = try Deployment(profiles: [name: profile]).validated()
      let installation = Installation(root: self.root, relay: self.relay)
      try await Task.detached {
        try Tailscale(executable: executable).configure(route, host: tailnet.hostname)
        try installation.create(profile)
      }.value
      try DataLocation().save(self.root)
      self.selected = name
      self.connectionSaved = false
      self.screen = .connect
      do { if self.service.status != .enabled { try self.service.register() } } catch {
        self.error = "Account created. Enable background access to start your server."
      }
      await self.refresh()
      for _ in 0..<10 where !self.online && self.backgroundEnabled {
        try await Task.sleep(nanoseconds: 300_000_000)
        await self.refresh()
      }
    }
  }
  func enableBackground() {
    perform {
      guard !self.preview else {
        self.backgroundEnabled = true
        return
      }
      if self.service.status == .requiresApproval {
        SMAppService.openSystemSettingsLoginItems()
      } else {
        try self.service.register()
      }
      await self.refresh()
    }
  }
  func disableBackground() {
    perform {
      if !self.preview { try await self.service.unregister() }
      self.backgroundEnabled = false
      await self.refresh()
    }
  }
  func toggleServer() {
    let name = selected
    let operations = operations
    let shouldPause = !paused
    perform {
      if !self.preview {
        try await Task.detached { try operations.setPaused(name, paused: shouldPause) }.value
      }
      self.paused = shouldPause
      if self.preview { self.online = !shouldPause } else { await self.refresh() }
    }
  }
  func backupNow() {
    let operations = operations
    let name = selected
    perform {
      if !self.preview {
        self.backup = try await Task.detached { try operations.backup(name) }.value
      }
      await self.refresh()
    }
  }
  func saveConnection() {
    guard !preview, let current else {
      if preview { connectionSaved = true }
      return
    }
    let source = root.appendingPathComponent("accounts/\(current.name)/connection.json")
    let panel = NSSavePanel()
    panel.nameFieldStringValue = "helium-synk-\(current.name)-connection.json"
    panel.allowedContentTypes = [.json]
    panel.title = "Save your first-device connection"
    guard panel.runModal() == .OK, let destination = panel.url else { return }
    do {
      try PrivateFiles.write(Data(contentsOf: source), to: destination)
      connectionSaved = true
    } catch { self.error = error.localizedDescription }
  }
  func openTailscale() {
    if tailscaleInstalled {
      NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/Tailscale.app"))
    } else {
      NSWorkspace.shared.open(URL(string: "https://tailscale.com/download/mac")!)
    }
  }
  func chooseFolder() {
    guard !preview else { return }
    let panel = NSOpenPanel()
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.canCreateDirectories = true
    panel.allowsMultipleSelection = false
    panel.title = "Choose an empty server data folder"
    guard panel.runModal() == .OK, let chosen = panel.url else { return }
    root = chosen
    profiles = []
    selected = ""
    legacy = false
    error = nil
    Task { await refresh() }
  }
  func reveal(_ component: String) {
    if !preview { NSWorkspace.shared.open(root.appendingPathComponent(component)) }
  }
  func addAccount() {
    error = nil
    accountName = ""
    route = nil
    screen = .network
    checkNetwork()
  }
}
