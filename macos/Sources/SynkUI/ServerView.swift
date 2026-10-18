import SwiftUI
import SynkCore

public struct ServerView: View {
  @ObservedObject private var model: ServerModel
  @State private var showDisableBackground = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  public init(model: ServerModel) { self.model = model }
  public var body: some View {
    HStack(spacing: 0) {
      sidebar.frame(width: 224)
      Rectangle().fill(SynkTheme.border).frame(width: 1)
      VStack(alignment: .leading, spacing: 0) {
        header
        ScrollView {
          VStack(alignment: .leading, spacing: 24) {
            if let error = model.error {
              HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.circle")
                Text(error).font(SynkTheme.font(12)).fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button {
                  model.error = nil
                } label: {
                  Image(systemName: "xmark").padding(4)
                }.buttonStyle(.plain).accessibilityLabel("Dismiss message")
              }.foregroundStyle(SynkTheme.destructive).padding(16).background(
                SynkTheme.destructive.opacity(0.07)
              ).overlay(Rectangle().stroke(SynkTheme.destructive.opacity(0.3)))
                .accessibilityElement(children: .combine)
            }
            Group {
              switch model.screen {
              case .welcome: welcome
              case .network: network
              case .account: account
              case .connect: connect
              case .dashboard: dashboard
              }
            }
            .disabled(model.busy)
          }.padding(.vertical, 34)
        }
        footer
      }.padding(.horizontal, 40).padding(.top, 30).padding(.bottom, 24)
    }
    .frame(minWidth: 920, minHeight: 680)
    .background(SynkTheme.background).foregroundStyle(SynkTheme.foreground)
    .font(SynkTheme.font(14)).preferredColorScheme(.dark)
    .confirmationDialog(
      "Disable the background server?", isPresented: $showDisableBackground,
      titleVisibility: .visible
    ) {
      Button("Disable background server") { model.disableBackground() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(
        "Sync stops until you enable it again. Accounts, connection files and backups stay on this Mac."
      )
    }
    .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: model.screen)
    .task {
      repeat {
        await model.refresh()
        do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { break }
      } while !Task.isCancelled
    }
  }
  private var sidebar: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 12) {
        Image(
          nsImage: NSImage(
            contentsOf: SynkTheme.resourceDirectory?.appendingPathComponent("Synk.png")
              ?? URL(fileURLWithPath: "/nonexistent")) ?? NSImage(
              systemSymbolName: "arrow.triangle.2.circlepath", accessibilityDescription: "Synk")!
        ).resizable().interpolation(.high).antialiased(true).scaledToFit().frame(
          width: 44, height: 44)
        VStack(alignment: .leading, spacing: 2) {
          Text("Synk").font(SynkTheme.font(24, weight: .heavy))
          Text("SERVER").font(SynkTheme.mono(9)).tracking(2).foregroundStyle(SynkTheme.muted)
        }
      }.padding(.bottom, 46)
      Eyebrow(text: model.screen == .dashboard ? "YOUR SERVER" : "GET CONNECTED").padding(
        .bottom, 20)
      ForEach(
        Array(
          [
            ("Private network", "network"), ("Your account", "server.rack"),
            ("Connect browser", "link"),
          ].enumerated()), id: \.element.0
      ) { index, step in
        HStack(spacing: 12) {
          Image(systemName: model.step > index + 1 ? "checkmark" : step.1).frame(width: 18)
            .foregroundStyle(model.step >= index + 1 ? SynkTheme.primary : SynkTheme.muted)
          Text(step.0).font(SynkTheme.font(12, weight: .semibold))
          Spacer()
          Text(String(format: "%02d", index + 1)).font(SynkTheme.mono(9)).foregroundStyle(
            SynkTheme.muted)
        }.padding(12).background(
          model.step == index + 1 && model.screen != .dashboard
            ? SynkTheme.blue.opacity(0.14) : .clear
        )
        .overlay(
          Rectangle().stroke(
            model.step == index + 1 && model.screen != .dashboard
              ? SynkTheme.blue.opacity(0.4) : .clear)
        ).padding(.bottom, 8)
      }
      Spacer()
      Image(systemName: "lock.shield").font(.system(size: 22)).foregroundStyle(SynkTheme.primary)
        .padding(.bottom, 14)
      Text("Your data.\nYour server.").font(SynkTheme.font(18, weight: .bold)).lineSpacing(4)
      Text("PRIVATE BY DESIGN").font(SynkTheme.mono(9)).tracking(1.3).foregroundStyle(
        SynkTheme.muted
      ).padding(.top, 18)
    }.padding(.horizontal, 22).padding(.top, 38).padding(.bottom, 30).background(
      SynkTheme.navy.opacity(0.35))
  }
  private var header: some View {
    HStack {
      Eyebrow(text: model.screen == .dashboard ? "SERVER OVERVIEW" : "HELIUM SYNK / SETUP")
      Spacer()
      if model.busy {
        ProgressView().controlSize(.small)
        Text("Working…").font(SynkTheme.mono(10)).foregroundStyle(SynkTheme.muted)
      } else {
        Signal(
          good: model.screen == .dashboard ? model.online && !model.paused : true,
          text: model.screen == .dashboard
            ? (model.online && !model.paused
              ? "ONLINE" : model.paused ? "PAUSED" : "STARTING / OFFLINE") : "SELF-HOSTED")
      }
    }.padding(.bottom, 20).overlay(alignment: .bottom) {
      Rectangle().fill(SynkTheme.border).frame(height: 1)
    }
  }
  private var footer: some View {
    HStack(alignment: .firstTextBaseline, spacing: 20) {
      Eyebrow(text: "LOCAL FIRST")
      Text("Encrypted browser sync. No shared hosting.").font(SynkTheme.font(10)).foregroundStyle(
        SynkTheme.muted)
      Spacer()
      Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "DEV").font(
        SynkTheme.mono(9)
      ).foregroundStyle(SynkTheme.muted)
    }.padding(.top, 20).overlay(alignment: .top) {
      Rectangle().fill(SynkTheme.border).frame(height: 1)
    }
  }
  private func title(_ first: String, _ accent: String, detail: String) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      (Text(first + "\n") + Text(accent).foregroundColor(SynkTheme.primary)).font(
        SynkTheme.font(40, weight: .heavy)
      ).tracking(-1.5).lineSpacing(0).fixedSize(horizontal: false, vertical: true)
      Text(detail).font(SynkTheme.font(13)).foregroundStyle(SynkTheme.muted).lineSpacing(5)
    }
  }
  private var welcome: some View {
    VStack(alignment: .leading, spacing: 30) {
      title(
        "A home for", "your private sync.",
        detail: "Host your bookmarks, tabs and history on this Mac.")
      Panel {
        HStack(alignment: .top, spacing: 22) {
          Image(systemName: "server.rack").font(.system(size: 30)).foregroundStyle(
            SynkTheme.primary
          ).frame(width: 52, height: 60).background(SynkTheme.primary.opacity(0.06))
          VStack(alignment: .leading, spacing: 10) {
            Text("One Mac. All your devices.").font(SynkTheme.font(19, weight: .bold))
            Text(
              "A private connection, automatic backups, and a server that runs in the background."
            ).foregroundStyle(SynkTheme.muted).font(SynkTheme.font(12)).lineSpacing(5)
          }
        }
      }
      if model.legacy {
        Panel {
          VStack(alignment: .leading, spacing: 12) {
            Text("Your existing server is safe.").font(SynkTheme.font(16, weight: .bold))
            Text("Choose an empty data folder to set up this app alongside it.").font(
              SynkTheme.font(12)
            ).foregroundStyle(SynkTheme.muted)
            Button("Choose data folder") { model.chooseFolder() }.buttonStyle(ActionStyle())
          }
        }
      } else {
        Button {
          model.screen = .network
          model.checkNetwork()
        } label: {
          Label("Set up this Mac", systemImage: "arrow.right")
        }.buttonStyle(ActionStyle(primary: true)).keyboardShortcut(.defaultAction)
      }
      DisclosureGroup("Data location") {
        HStack {
          Text(model.root.path).font(SynkTheme.mono(10)).textSelection(.enabled)
          Spacer()
          Button("Change…") { model.chooseFolder() }.buttonStyle(.plain).foregroundStyle(
            SynkTheme.primary)
        }.padding(.top, 12)
      }.font(SynkTheme.font(11)).foregroundStyle(SynkTheme.muted)
    }
  }
  private var network: some View {
    VStack(alignment: .leading, spacing: 28) {
      title(
        "Your devices.", "One private network.",
        detail: "Tailscale keeps your server reachable only on your private network.")
      Panel {
        VStack(alignment: .leading, spacing: 20) {
          HStack {
            Label("Tailscale", systemImage: "network").font(SynkTheme.font(20, weight: .bold))
            Spacer()
            Signal(
              good: model.tailnet?.connected == true,
              text: model.tailnet?.connected == true
                ? "CONNECTED" : model.tailscaleInstalled ? "SIGN IN" : "NEEDED")
          }
          if let tailnet = model.tailnet, tailnet.connected {
            Text(tailnet.hostname).font(SynkTheme.mono(12)).foregroundStyle(SynkTheme.primary)
              .textSelection(.enabled)
          } else {
            Text(
              model.tailscaleInstalled
                ? "Open Tailscale and connect this Mac."
                : "Install Tailscale and sign in on this Mac."
            ).font(SynkTheme.font(13)).foregroundStyle(SynkTheme.muted)
          }
          HStack(spacing: 12) {
            Button(model.tailscaleInstalled ? "Open Tailscale" : "Get Tailscale") {
              model.openTailscale()
            }.buttonStyle(ActionStyle())
            Button {
              model.checkNetwork()
            } label: {
              Label("Check again", systemImage: "arrow.clockwise")
            }.buttonStyle(ActionStyle())
          }
        }
      }
      HStack {
        Button("Back") { model.screen = model.profiles.isEmpty ? .welcome : .dashboard }
          .buttonStyle(.plain).foregroundStyle(SynkTheme.muted)
        Spacer()
        Button {
          model.continueFromNetwork()
        } label: {
          Label("Continue", systemImage: "arrow.right")
        }.buttonStyle(ActionStyle(primary: true)).disabled(model.tailnet?.connected != true)
          .keyboardShortcut(.defaultAction)
      }
    }
  }
  private var account: some View {
    VStack(alignment: .leading, spacing: 28) {
      title(
        "Make room for", "your browser.",
        detail: "Give this account a name. We’ll handle the server settings.")
      Panel {
        VStack(alignment: .leading, spacing: 24) {
          field("Account name", placeholder: "Personal", value: $model.accountName)
          field("First browser device", placeholder: "My Mac", value: $model.deviceName)
          HStack(spacing: 24) {
            Label("Private HTTPS", systemImage: "lock")
            Label("Daily backups", systemImage: "externaldrive")
            Label("After login", systemImage: "power")
          }.font(SynkTheme.font(11)).foregroundStyle(SynkTheme.muted)
        }
      }
      HStack {
        Button("Back") { model.screen = .network }.buttonStyle(.plain).foregroundStyle(
          SynkTheme.muted)
        Spacer()
        Button {
          model.createAccount()
        } label: {
          Label("Create server", systemImage: "arrow.right")
        }.buttonStyle(ActionStyle(primary: true)).disabled(!model.canCreate).keyboardShortcut(
          .defaultAction)
      }
    }
  }
  private func field(_ label: String, placeholder: String, value: Binding<String>) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(label).font(SynkTheme.font(12, weight: .semibold))
      TextField(placeholder, text: value).textFieldStyle(.plain).font(SynkTheme.font(15)).padding(
        14
      ).background(SynkTheme.background).overlay(Rectangle().stroke(SynkTheme.border))
        .accessibilityLabel(label)
    }
  }
  private var backgroundNotice: some View {
    Panel {
      HStack(alignment: .center, spacing: 18) {
        Image(systemName: "switch.2").foregroundStyle(SynkTheme.primary).font(.system(size: 24))
        VStack(alignment: .leading, spacing: 6) {
          Text(model.needsApproval ? "Allow background access." : "Enable your background server.")
            .font(SynkTheme.font(16, weight: .bold))
          Text(
            model.needsApproval
              ? "Turn on Helium Synk Server in Login Items."
              : "Keep syncing when this window is closed."
          ).font(SynkTheme.font(12)).foregroundStyle(SynkTheme.muted)
        }
        Spacer()
        Button(model.needsApproval ? "Open Settings" : "Enable") { model.enableBackground() }
          .buttonStyle(ActionStyle(primary: true))
      }
    }
  }
  private var connect: some View {
    VStack(alignment: .leading, spacing: 24) {
      title(
        "Server created.", "Connect your browser.",
        detail: "Save a connection file for your first browser profile.")
      if !model.backgroundEnabled { backgroundNotice }
      Panel {
        VStack(alignment: .leading, spacing: 22) {
          HStack {
            Label("First device", systemImage: "doc.badge.key").font(
              SynkTheme.font(18, weight: .bold))
            Spacer()
            Signal(
              good: model.connectionSaved,
              text: model.connectionSaved ? "FILE SAVED" : "READY TO SAVE")
          }
          Text(model.current?.serverURL ?? "").font(SynkTheme.mono(11)).foregroundStyle(
            SynkTheme.primary
          ).textSelection(.enabled)
          Button {
            model.saveConnection()
          } label: {
            Label(
              model.connectionSaved ? "Save another copy" : "Save connection file",
              systemImage: "arrow.down.to.line")
          }.buttonStyle(ActionStyle(primary: true))
          Rectangle().fill(SynkTheme.border).frame(height: 1)
          Text("In the Synk extension, choose “Set up my first device” and select this file.").font(
            SynkTheme.font(12)
          ).foregroundStyle(SynkTheme.muted).lineSpacing(4)
          Text("Keep this file private. Use it once; invite other devices from the extension.")
            .font(SynkTheme.font(10))
            .foregroundStyle(SynkTheme.muted)
        }
      }
      HStack {
        Signal(
          good: model.online && model.remoteOnline,
          text: model.online && model.remoteOnline ? "PRIVATE SERVER READY" : "WAITING FOR SERVER")
        Spacer()
        Button("Open server overview") { model.screen = .dashboard }.buttonStyle(ActionStyle())
          .keyboardShortcut(.defaultAction)
      }
    }
  }
  private var dashboard: some View {
    VStack(alignment: .leading, spacing: 24) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 10) {
          Text("Your private server.").font(SynkTheme.font(32, weight: .heavy)).tracking(-1)
          Text(
            model.paused
              ? "Paused. Your data and backups are kept." : "This Mac is home to your browser sync."
          ).font(SynkTheme.font(12)).foregroundStyle(SynkTheme.muted)
        }
        Spacer()
        Button {
          Task { await model.refresh() }
        } label: {
          Image(systemName: "arrow.clockwise").padding(8)
        }.buttonStyle(.plain).accessibilityLabel("Refresh server status")
      }
      if !model.backgroundEnabled { backgroundNotice }
      if model.profiles.count > 1 {
        Picker("Account", selection: $model.selected) {
          ForEach(model.profiles) { profile in Text(profile.name.capitalized).tag(profile.name) }
        }.onChange(of: model.selected) { _ in Task { await model.refresh() } }
      }
      Panel {
        VStack(alignment: .leading, spacing: 18) {
          HStack {
            Label(model.current?.name.capitalized ?? "Server", systemImage: "server.rack").font(
              SynkTheme.font(21, weight: .bold))
            Spacer()
            Signal(
              good: model.online && !model.paused,
              text: model.online && !model.paused ? "RUNNING" : model.paused ? "PAUSED" : "OFFLINE")
          }
          Text(model.current?.serverURL ?? "").font(SynkTheme.mono(12)).foregroundStyle(
            SynkTheme.primary
          ).textSelection(.enabled)
          HStack(spacing: 24) {
            Label(
              model.remoteOnline ? "Private HTTPS ready" : "Private HTTPS unavailable",
              systemImage: model.remoteOnline ? "lock.fill" : "exclamationmark.circle")
            Label("Runs after login", systemImage: "power")
          }.font(SynkTheme.font(10)).foregroundStyle(SynkTheme.muted)
          HStack(spacing: 12) {
            Button {
              model.toggleServer()
            } label: {
              Label(
                model.paused ? "Resume server" : "Pause server",
                systemImage: model.paused ? "play" : "pause")
            }.buttonStyle(ActionStyle())
            Button("Connection file") { model.screen = .connect }.buttonStyle(ActionStyle())
          }
        }
      }
      HStack(alignment: .top, spacing: 16) {
        Panel {
          VStack(alignment: .leading, spacing: 16) {
            Eyebrow(text: "BACKUPS")
            Text(
              model.backup?.ok == true
                && Date().timeIntervalSince(model.backup!.snapshotModifiedAt) < 30 * 3600
                ? "Up to date." : "Backup needed."
            ).font(SynkTheme.font(20, weight: .bold))
            if let backup = model.backup {
              Text(backup.snapshotModifiedAt, style: .relative).font(SynkTheme.font(11))
                .foregroundStyle(SynkTheme.muted)
            }
            Button("Back up now") { model.backupNow() }.buttonStyle(ActionStyle()).disabled(
              model.current == nil)
            Button("Show backups ↗") { model.reveal("accounts/\(model.selected)/backups") }
              .buttonStyle(.plain).font(SynkTheme.font(11)).foregroundStyle(SynkTheme.muted)
          }
        }
        Panel {
          VStack(alignment: .leading, spacing: 16) {
            Eyebrow(text: "SERVER STORAGE")
            Text(
              ByteCountFormatter.string(
                fromByteCount: model.health?.databaseBytes ?? 0, countStyle: .file)
            ).font(SynkTheme.font(20, weight: .bold))
            Text("Encrypted sync records").font(SynkTheme.font(11)).foregroundStyle(SynkTheme.muted)
            Button("Show data") { model.reveal("") }.buttonStyle(ActionStyle())
            Button("Show logs ↗") { model.reveal("logs") }.buttonStyle(.plain).font(
              SynkTheme.font(11)
            ).foregroundStyle(SynkTheme.muted)
          }
        }
      }
      if let health = model.health, !health.ok {
        ForEach(health.problems, id: \.self) {
          Text($0).font(SynkTheme.font(12)).foregroundStyle(SynkTheme.destructive)
        }
      }
      HStack {
        Button {
          model.addAccount()
        } label: {
          Label("Add independent account", systemImage: "plus")
        }.buttonStyle(.plain).font(SynkTheme.font(12)).foregroundStyle(SynkTheme.primary)
        Spacer()
        Text(
          model.backgroundEnabled
            ? "Closing this app keeps the server running." : "Background operation needs approval."
        ).font(SynkTheme.font(10)).foregroundStyle(
          SynkTheme.muted)
      }
      if model.backgroundEnabled {
        Button("Disable background server…") { showDisableBackground = true }
          .buttonStyle(.plain).font(SynkTheme.font(10)).foregroundStyle(SynkTheme.muted)
      }
    }
  }
}
