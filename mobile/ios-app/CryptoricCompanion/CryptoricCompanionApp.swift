import SwiftUI
import CryptoricKit

/// The app.
///
/// It is deliberately almost nothing: a relay address, and the tested
/// `CompanionRootView` from `CryptoricKit`. All the logic worth testing lives
/// in the library, where CI runs it on every push; this target exists so that
/// logic can be shipped in a bundle a phone can install.
@main
struct CryptoricCompanionApp: App {
    @State private var relayURL = "ws://127.0.0.1:8787"

    var body: some Scene {
        WindowGroup {
            RelayPicker(relayURL: $relayURL)
        }
    }
}

/// Asks for the relay, then shows the tasks.
///
/// A separate first screen rather than a hidden default, because a companion
/// pointed at the wrong relay would show an empty task list, and an empty task
/// list looks exactly like an idle desktop.
private struct RelayPicker: View {
    @Binding var relayURL: String
    @State private var connected = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Relay") {
                    TextField("ws://127.0.0.1:8787", text: $relayURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    if let error {
                        Text(error).foregroundStyle(.red)
                    }
                    Button("Connect") { connect() }
                }
            }
            .navigationTitle("Cryptoric")
            .fullScreenCover(isPresented: $connected) {
                CompanionSession(relayURL: relayURL)
            }
        }
    }

    private func connect() {
        guard let url = URL(string: relayURL.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            error = "That is not a URL. It starts with ws:// or wss://."
            return
        }
        guard url.scheme?.hasPrefix("ws") == true else {
            error = "The relay speaks WebSocket. Use ws:// or wss://."
            return
        }
        error = nil
        connected = true
    }
}

/// One live session against the relay.
private struct CompanionSession: View {
    let relayURL: String

    var body: some View {
        // A fresh model per session: the actor store and the socket belong to
        // the session, and reusing one across connections is how a stale task
        // list outlives the desktop it came from.
        CompanionRootView(model: CompanionModel(transport: WebSocketRelayTransport(urlString: relayURL)))
    }
}
