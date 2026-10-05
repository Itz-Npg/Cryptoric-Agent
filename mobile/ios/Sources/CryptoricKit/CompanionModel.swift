import Foundation
import SwiftUI

/// Drives the UI from the relay store.
///
/// The view model exposes plain, synchronous properties and the observation is
/// done here, once. That split is what lets `CompanionViewModel` — where the
/// sorting and the "needs attention" rules live — be a `struct` a test can
/// build in a line, instead of something only reachable by launching a phone.
@MainActor
public final class CompanionModel: ObservableObject {
    @Published public private(set) var snapshot = RelaySnapshot(tasks: [])
    @Published public private(set) var isConnected = false
    @Published public private(set) var lastError: String?

    private let store: RelayStore
    private let transport: RelayTransport
    private var task: Task<Void, Never>?

    public init(store: RelayStore = RelayStore(), transport: RelayTransport) {
        self.store = store
        self.transport = transport
    }

    /// The view model the UI renders.
    public var viewModel: CompanionViewModel {
        CompanionViewModel(tasks: snapshot.tasks, isConnected: isConnected, lastError: lastError)
    }

    public var tasks: [AgentTask] { snapshot.tasks }

    public func task(id: String) -> AgentTask? {
        snapshot.tasks.first { $0.id == id }
    }

    public var needsAttention: [AgentTask] { viewModel.needsAttention }
    public var active: [AgentTask] { viewModel.active }
    public var finished: [AgentTask] { viewModel.finished }

    /// Connect, then follow the store until cancelled.
    public func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            guard let self else { return }
            await observe()
            await run()
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
        Task { await transport.disconnect() }
    }

    private func observe() async {
        let stream = await store.stream()
        for await next in stream {
            snapshot = next
            isConnected = await store.connected
            lastError = await store.connectionError
        }
    }

    private func run() async {
        do {
            try await transport.connect()
            await store.setConnected(true)
            // Sent on connect so a phone that was asleep catches up instead of
            // showing an empty list that looks like an idle desktop.
            await send(.refresh)
            // `messages()` is synchronous and returns a stream; the `await` here was
            // flagged as unnecessary by the compiler, which is the signal that
            // the protocol and the call site disagree about the shape.
            for try await data in transport.messages() {
                try Task.checkCancellation()
                do {
                    let decoded = try RelayMessageDecoder.snapshot(from: data)
                    await store.apply(decoded)
                } catch {
                    // A frame that will not decode is reported, not swallowed:
                    // silently dropping it would leave the phone showing stale
                    // tasks with no indication anything is wrong.
                    await store.setError("Unreadable message from the desktop")
                }
            }
            await store.setConnected(false)
        } catch is CancellationError {
            // Expected on stop.
        } catch {
            await store.setError(error.localizedDescription)
        }
    }

    /// Send a command. Failures surface in `lastError` rather than throwing,
    /// because the caller is a button, and a button that throws does nothing.
    public func send(_ command: RelayCommand) async {
        do {
            let data = try RelayMessageDecoder.encoder.encode(command)
            try await transport.send(data)
        } catch {
            await store.setError("Could not reach the desktop: \(error.localizedDescription)")
        }
    }
}

/// An in-memory transport, for previews and tests.
///
/// It holds real state and exercises the real decode path, so a preview shows
/// what the app actually does rather than a hand-written approximation of it.
public final class PreviewTransport: RelayTransport {
    private var continuation: AsyncThrowingStream<Data, Error>.Continuation?
    private var buffer: [Data] = []

    public var sent: [Data] = []

    public init() {}

    public func connect() async throws {
        var captured: AsyncThrowingStream<Data, Error>.Continuation?
        let stream = AsyncThrowingStream<Data, Error> { continuation in
            captured = continuation
        }
        continuation = captured
        _ = stream
    }

    public func send(_ data: Data) async throws {
        sent.append(data)
    }

    public func messages() -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            for item in buffer {
                continuation.yield(item)
            }
            self.continuation = continuation
        }
    }

    public func disconnect() async {
        continuation?.finish()
        continuation = nil
    }

    /// Push a snapshot to whoever is listening.
    public func emit(_ snapshot: RelaySnapshot) throws {
        continuation?.yield(try RelayMessageDecoder.encoder.encode(snapshot))
    }
}