import Foundation

/// Talks to the relay the desktop app serves.
///
/// The transport is a protocol rather than a concrete `URLSessionWebSocketTask`
/// so the message handling — decode, apply, re-emit — is testable without a
/// network. A socket that cannot be exercised in a unit test is a socket that
/// gets exercised for the first time on a phone, which is the worst place.
public protocol RelayTransport: AnyObject {
    func connect() async throws
    func send(_ data: Data) async throws
    /// Messages as an async sequence, ending when the socket closes.
    func messages() -> AsyncThrowingStream<Data, Error>
    func disconnect() async
}

/// Holds the latest known state and hands changes to whoever is watching.
///
/// An actor rather than a class: the desktop pushes snapshots whenever it
/// likes, from whatever thread the agent happens to be on, and the UI reads
/// from the main thread. Sharing a mutable array between them without an actor
/// is a data race that only shows up under load.
public actor RelayStore {
    private var snapshot = RelaySnapshot(tasks: [])
    private var lastError: String?
    private var isConnected = false
    // One subscriber at a time. The UI has a single observer, and keeping a
    // registry alive across view lifetimes means needing `onTermination` to
    // prune it - which is the API this toolchain will not resolve. Replacing
    // instead of appending cannot leak, and matches how the app is used.
    private var subscriber: AsyncStream<RelaySnapshot>.Continuation?

    public init() {}

    public var current: RelaySnapshot { snapshot }
    public var connectionError: String? { lastError }
    public var connected: Bool { isConnected }

    /// Stream of snapshots for the UI to render.
    ///
    /// Replays the current state first so a view that subscribes late is never
    /// blank, then emits on every change. A second caller replaces the first:
    /// two live screens both watching one desktop is not a shape this app has.
    public func stream() -> AsyncStream<RelaySnapshot> {
        AsyncStream<RelaySnapshot> { continuation in
            self.subscriber = continuation
            continuation.yield(self.snapshot)
        }
    }

    /// Stop sending to the current subscriber. Called when the view goes away,
    /// so a finished view is not written to.
    public func endSubscription() {
        subscriber?.finish()
        subscriber = nil
    }

    /// Apply a snapshot and notify watchers.
    public func apply(_ next: RelaySnapshot) {
        // Identical state would wake every view for nothing, which on a phone
        // means visible flicker on every heartbeat.
        guard next != snapshot else { return }
        snapshot = next
        subscriber?.yield(next)
    }

    public func setConnected(_ value: Bool) {
        isConnected = value
        if !value { lastError = nil }
    }

    /// Record a connection problem. Kept separate from the snapshot because a
    /// failure to connect is not a task state and must not overwrite one.
    public func setError(_ message: String) {
        lastError = message
        isConnected = false
    }
}

/// Decodes relay messages and applies them to the store.
///
/// Split out so the exact wire format is testable without a socket, which is
/// where a mismatched field name would otherwise be found for the first time
/// on a device.
public enum RelayMessageDecoder {
    public static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        // The relay sends ISO-8601. The default is a numeric epoch, and the
        // mismatch throws on the first message and looks like "the app shows
        // nothing" rather than "the dates are wrong".
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    public static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    /// Decode a snapshot frame.
    ///
    /// - Throws: whatever `JSONDecoder` throws on malformed input, rather than
    ///   returning an empty task list. An empty list and a failed decode look
    ///   identical on a phone — "no work is running" — so collapsing them would
    ///   hide a broken connection behind a plausible-looking empty state.
    public static func snapshot(from data: Data) throws -> RelaySnapshot {
        try decoder.decode(RelaySnapshot.self, from: data)
    }

    /// Decode a command frame.
    public static func command(from data: Data) throws -> RelayCommand {
        try decoder.decode(RelayCommand.self, from: data)
    }
}