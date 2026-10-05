import Foundation

/// The wire format shared with `mobile/relay` (Node) and any other companion.
///
/// This file is the contract. Two independent implementations — Swift here and
/// JavaScript in the relay — have to agree on these field names byte for byte,
/// so they are declared once and used by both. A field renamed on one side only
/// is the classic way a companion app silently shows nothing.
///
/// Every status is spelled out rather than collapsed into `String`, because an
/// unrecognised status arriving from a newer desktop build must fail loudly in
/// one place rather than render as an empty string forever.
public enum AgentStatus: String, Codable, CaseIterable, Sendable {
    case queued
    case planning
    case implementing
    case verifying
    case completed
    case failed
    case blocked
    case cancelled

    /// True only for outcomes that represent finished work.
    ///
    /// `blocked` and `failed` are *terminal* — the task stopped — but neither
    /// means success. `completed` is the only status that may drive a
    /// "done" affordance, which is why this is a separate question from
    /// `isTerminal`.
    public var isSuccess: Bool { self == .completed }

    /// True when the task has stopped moving, whatever the outcome.
    public var isTerminal: Bool {
        switch self {
        case .completed, .failed, .blocked, .cancelled: return true
        case .queued, .planning, .implementing, .verifying: return false
        }
    }

    /// What a human should read. Not a debug string — this is the whole
    /// product when a phone is the only screen.
    public var displayName: String {
        switch self {
        case .queued: return "Queued"
        case .planning: return "Planning"
        case .implementing: return "Implementing"
        case .verifying: return "Verifying"
        case .completed: return "Completed"
        case .failed: return "Failed"
        case .blocked: return "Blocked"
        case .cancelled: return "Cancelled"
        }
    }

    /// Decode leniently enough to survive a status this build has never heard
    /// of, without pretending it is a success.
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AgentStatus(rawValue: raw) ?? .blocked
    }
}

/// One agent task, as the phone sees it.
public struct AgentTask: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let status: AgentStatus
    /// The stage currently running, e.g. "verify". Empty when not yet started.
    public let stage: String
    /// The most recent human-readable note. This is the whole timeline on a
    /// phone, so it is prose on purpose rather than a raw event name.
    public let lastNote: String
    public let updatedAt: Date
    /// Files changed so far. Empty is meaningful and must not be hidden: a
    /// running task that has changed nothing is exactly what the user needs to
    /// notice.
    public let changedPaths: [String]

    public init(
        id: String,
        title: String,
        status: AgentStatus,
        stage: String = "",
        lastNote: String = "",
        updatedAt: Date = Date(),
        changedPaths: [String] = []
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.stage = stage
        self.lastNote = lastNote
        self.updatedAt = updatedAt
        self.changedPaths = changedPaths
    }

    /// A finished task that produced nothing is the failure mode this project
    /// has shipped twice, so the phone calls it out rather than showing green.
    public var finishedWithNoChanges: Bool {
        status.isTerminal && !status.isSuccess && changedPaths.isEmpty
    }
}

/// A message from the phone to the desktop.
public enum RelayCommand: Codable, Sendable {
    /// Follow-up text for a running task.
    case followUp(taskId: String, text: String)
    /// Cancel a task.
    case cancel(taskId: String)
    /// Ask for the current task list. Sent on connect, so a phone that was
    /// asleep catches up rather than showing an empty screen.
    case refresh

    private enum CodingKeys: String, CodingKey {
        case kind, taskId, text
    }

    private enum Kind: String, Codable {
        case followUp, cancel, refresh
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .followUp(taskId, text):
            try container.encode(Kind.followUp, forKey: .kind)
            try container.encode(taskId, forKey: .taskId)
            try container.encode(text, forKey: .text)
        case let .cancel(taskId):
            try container.encode(Kind.cancel, forKey: .kind)
            try container.encode(taskId, forKey: .taskId)
        case .refresh:
            try container.encode(Kind.refresh, forKey: .kind)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Kind.self, forKey: .kind) {
        case .followUp:
            self = .followUp(
                taskId: try container.decode(String.self, forKey: .taskId),
                text: try container.decode(String.self, forKey: .text)
            )
        case .cancel:
            self = .cancel(taskId: try container.decode(String.self, forKey: .taskId))
        case .refresh:
            self = .refresh
        }
    }
}

/// A message from the desktop to the phone.
public struct RelaySnapshot: Codable, Equatable, Sendable {
    public let tasks: [AgentTask]
    public let generatedAt: Date

    public init(tasks: [AgentTask], generatedAt: Date = Date()) {
        self.tasks = tasks
        self.generatedAt = generatedAt
    }
}