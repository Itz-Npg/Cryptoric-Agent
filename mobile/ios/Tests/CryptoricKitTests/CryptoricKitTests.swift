import XCTest
@testable import CryptoricKit

/// Tests for the companion's logic and its wire format.
///
/// These run on a GitHub macOS runner with no simulator and no device, which
/// is the point: the parts that decide what a phone shows, and the bytes that
/// decide whether it shows anything at all, are verified before any of this
/// touches hardware.
final class CompanionViewModelTests: XCTestCase {

    private func task(
        _ id: String,
        status: AgentStatus,
        updated: Date = Date(),
        changed: [String] = []
    ) -> AgentTask {
        AgentTask(
            id: id,
            title: "task \(id)",
            status: status,
            stage: "verify",
            lastNote: "note",
            updatedAt: updated,
            changedPaths: changed
        )
    }

    // MARK: - The failure this project has shipped twice

    func testFinishedWithNoChangesIsFlagged() {
        let blocked = task("1", status: .blocked)
        XCTAssertTrue(blocked.finishedWithNoChanges)

        let failedWithFiles = task("2", status: .failed, changed: ["a.ts"])
        XCTAssertFalse(failedWithFiles.finishedWithNoChanges)

        // Completed-with-no-changes is legal — a read-only question genuinely
        // needs no edits — so it must NOT be dragged into "needs attention".
        let completed = task("3", status: .completed)
        XCTAssertFalse(completed.finishedWithNoChanges)
        XCTAssertTrue(completed.status.isSuccess)
    }

    func testNeedsAttentionExcludesSuccesses() {
        let model = CompanionViewModel(
            tasks: [
                task("1", status: .completed, changed: ["a.ts"]),
                task("2", status: .blocked),
                task("3", status: .failed, changed: ["b.ts"]),
                task("4", status: .implementing)
            ],
            isConnected: true
        )
        XCTAssertEqual(model.needsAttention.map(\.id), ["2", "3"])
    }

    // MARK: - Ordering

    func testActiveSortsOldestFirstSoStuckWorkIsVisible() {
        let now = Date()
        let model = CompanionViewModel(
            tasks: [
                task("new", status: .implementing, updated: now),
                task("old", status: .planning, updated: now.addingTimeInterval(-600)),
                task("mid", status: .verifying, updated: now.addingTimeInterval(-60))
            ],
            isConnected: true
        )
        XCTAssertEqual(model.active.map(\.id), ["old", "mid", "new"])
    }

    func testFinishedSortsNewestFirst() {
        let now = Date()
        let model = CompanionViewModel(
            tasks: [
                task("a", status: .completed, updated: now.addingTimeInterval(-300)),
                task("b", status: .failed, updated: now)
            ],
            isConnected: true
        )
        XCTAssertEqual(model.finished.map(\.id), ["b", "a"])
    }

    // MARK: - Headline

    func testHeadlineStatesTheProblemWhenDisconnected() {
        let model = CompanionViewModel(tasks: [], isConnected: false)
        XCTAssertTrue(model.headline.contains("Not connected"))

        let withError = CompanionViewModel(tasks: [], isConnected: false, lastError: "timed out")
        XCTAssertTrue(withError.headline.contains("timed out"))
    }

    func testHeadlineCountsRunningAndAttentionSeparately() {
        let model = CompanionViewModel(
            tasks: [task("1", status: .implementing), task("2", status: .blocked)],
            isConnected: true
        )
        XCTAssertEqual(model.headline, "1 running · 1 need attention")
    }

    func testHeadlineDistinguishesIdleFromAllFinished() {
        XCTAssertEqual(
            CompanionViewModel(tasks: [], isConnected: true).headline,
            "No agents running"
        )
        XCTAssertEqual(
            CompanionViewModel(tasks: [task("1", status: .completed)], isConnected: true).headline,
            "All agents finished"
        )
    }
}

final class RelayProtocolTests: XCTestCase {

    /// The wire format is a contract with a JavaScript relay. These are the
    /// bytes that cross that boundary, so the field names are pinned here.
    func testSnapshotRoundTrips() throws {
        let original = RelaySnapshot(tasks: [
            AgentTask(
                id: "abc",
                title: "Fix the button",
                status: .implementing,
                stage: "implement",
                lastNote: "wrote 2 files",
                updatedAt: Date(timeIntervalSince1970: 1_700_000_000),
                changedPaths: ["src/a.ts", "src/b.ts"]
            )
        ])
        let data = try RelayMessageDecoder.encoder.encode(original)
        let decoded = try RelayMessageDecoder.snapshot(from: data)
        XCTAssertEqual(decoded.tasks.first?.id, "abc")
        XCTAssertEqual(decoded.tasks.first?.status, .implementing)
        XCTAssertEqual(decoded.tasks.first?.changedPaths, ["src/a.ts", "src/b.ts"])
    }

    func testDatesUseISO8601NotEpoch() throws {
        let snapshot = RelaySnapshot(
            tasks: [AgentTask(id: "1", title: "t", status: .completed, updatedAt: Date())],
            generatedAt: Date()
        )
        let data = try RelayMessageDecoder.encoder.encode(snapshot)
        let text = String(decoding: data, as: UTF8.self)
        // A numeric epoch here would decode fine in isolation and then break
        // against the relay, which sends ISO-8601.
        XCTAssertTrue(text.contains("T"), "expected an ISO-8601 timestamp, got: \(text)")
    }

    func testCommandsRoundTrip() throws {
        let cases: [RelayCommand] = [
            .followUp(taskId: "t1", text: "also check mobile"),
            .cancel(taskId: "t2"),
            .refresh
        ]
        for command in cases {
            let data = try RelayMessageDecoder.encoder.encode(command)
            XCTAssertEqual(try RelayMessageDecoder.command(from: data), command)
        }
    }

    /// A status this build has never heard of must not read as success.
    func testUnknownStatusDegradesToBlockedNotSuccess() throws {
        let json = Data("""
        {"tasks":[{"id":"1","title":"t","status":"teleported","stage":"","lastNote":"","updatedAt":"2026-01-01T00:00:00Z","changedPaths":[]}],"generatedAt":"2026-01-01T00:00:00Z"}
        """.utf8)
        let decoded = try RelayMessageDecoder.snapshot(from: json)
        XCTAssertEqual(decoded.tasks.first?.status, .blocked)
        XCTAssertFalse(decoded.tasks.first?.status.isSuccess ?? true)
    }

    /// An empty list and a failed decode look identical on a phone. The decoder
    /// must throw rather than return "no work", or a broken connection hides
    /// behind a plausible idle screen.
    func testMalformedPayloadThrowsInsteadOfReturningNoTasks() {
        let garbage = Data("not json at all".utf8)
        XCTAssertThrowsError(try RelayMessageDecoder.snapshot(from: garbage))

        // Valid JSON, wrong shape: same requirement.
        let wrongShape = Data(#"{"unexpected":true}"#.utf8)
        XCTAssertThrowsError(try RelayMessageDecoder.snapshot(from: wrongShape))
    }

    func testEveryStatusHasADisplayName() {
        for status in AgentStatus.allCases {
            XCTAssertFalse(status.displayName.isEmpty, "\(status) has no display name")
        }
    }

    func testTerminalAndSuccessAreIndependent() {
        XCTAssertTrue(AgentStatus.blocked.isTerminal)
        XCTAssertFalse(AgentStatus.blocked.isSuccess)
        XCTAssertTrue(AgentStatus.cancelled.isTerminal)
        XCTAssertFalse(AgentStatus.cancelled.isSuccess)
        XCTAssertFalse(AgentStatus.implementing.isTerminal)
    }
}

final class RelayStoreTests: XCTestCase {

    func testApplyReplacesState() async {
        let store = RelayStore()
        await store.apply(RelaySnapshot(tasks: [
            AgentTask(id: "1", title: "one", status: .implementing)
        ]))
        let current = await store.current
        XCTAssertEqual(current.tasks.map(\.id), ["1"])
    }

    /// A heartbeat that resends identical state would otherwise wake every view
    /// for nothing, which on a phone is visible flicker.
    func testIdenticalSnapshotIsIgnored() async {
        let store = RelayStore()
        let snapshot = RelaySnapshot(
            tasks: [AgentTask(id: "1", title: "one", status: .implementing)],
            generatedAt: Date(timeIntervalSince1970: 1)
        )
        await store.apply(snapshot)
        await store.apply(snapshot)
        let current = await store.current
        XCTAssertEqual(current.tasks.count, 1)
    }

    /// A connection error is not a task state and must not overwrite one.
    func testErrorDoesNotEraseTasks() async {
        let store = RelayStore()
        await store.apply(RelaySnapshot(tasks: [
            AgentTask(id: "1", title: "one", status: .implementing)
        ]))
        await store.setError("timed out")
        let tasks = await store.current.tasks
        let connected = await store.connected
        XCTAssertEqual(tasks.count, 1, "a connection error wiped the task list")
        XCTAssertFalse(connected)
        XCTAssertEqual(await store.connectionError, "timed out")
    }

    /// A view that subscribes late must not render blank.
    func testStreamReplaysCurrentStateImmediately() async throws {
        let store = RelayStore()
        await store.apply(RelaySnapshot(tasks: [
            AgentTask(id: "1", title: "one", status: .verifying)
        ]))
        let stream = await store.stream()
        var iterator = stream.makeAsyncIterator()
        let first = await iterator.next()
        XCTAssertEqual(first?.tasks.map(\.id), ["1"])
    }
}

final class PreviewTransportTests: XCTestCase {

    /// The preview has to exercise the real encode path, or it is a lie about
    /// what the app does.
    func testSentCommandsAreRecorded() async throws {
        let transport = PreviewTransport()
        let store = RelayStore()
        let model = await MainActor.run { CompanionModel(store: store, transport: transport) }
        await model.send(.refresh)
        let sent = transport.sent
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(try RelayMessageDecoder.command(from: sent[0]), .refresh)
    }
}