import Foundation
import CryptoricKit

/// The phone's half of the relay connection.
///
/// `RelayTransport` is a protocol precisely so this class could stay outside the
/// tested library: `CompanionModel`'s decode/apply/re-emit path is covered by CI
/// against `PreviewTransport`, and only the socket itself is untested — which is
/// the smallest honest gap, and it is the one that can only be closed by
/// running it on a phone.
final class WebSocketRelayTransport: RelayTransport {
    private let url: URL
    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?

    init(urlString: String) {
        // A bad URL cannot be handled here: this type has no error channel, and
        // the screen above it refuses anything that is not ws/wss before
        // constructing it.
        self.url = URL(string: urlString) ?? URL(string: "ws://127.0.0.1:8787")!
    }

    func connect() async throws {
        let session = URLSession(configuration: .default)
        self.session = session
        let socket = session.webSocketTask(with: url)
        self.socket = socket
        socket.resume()
    }

    func send(_ data: Data) async throws {
        guard let socket else {
            throw TransportError.notConnected
        }
        try await socket.send(.data(data))
    }

    func messages() -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            // One reader for the life of the socket. `receive` is
            // one-shot, so the loop is what turns a socket into a stream.
            Task {
                do {
                    while true {
                        let message = try await self.receive()
                        switch message {
                        case .data(let data):
                            continuation.yield(data)
                        case .string(let text):
                            continuation.yield(Data(text.utf8))
                        @unknown default:
                            continue
                        }
                    }
                    continuation.finish()
                } catch {
                    // Finishing with the error is how the model's `lastError`
                    // gets set; swallowing it here would leave the UI claiming
                    // it is connected while nothing is arriving.
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                Task { await self.close() }
            }
        }
    }

    func disconnect() async {
        await close()
    }

    private func receive() async throws -> URLSessionWebSocketTask.Message {
        guard let socket else { throw TransportError.notConnected }
        return try await socket.receive()
    }

    private func close() async {
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        session?.invalidateAndCancel()
        session = nil
    }

    enum TransportError: Error {
        case notConnected
    }
}
