import Foundation
import SwiftUI

/// What the phone shows.
///
/// Kept apart from the views so the interesting part — sorting, grouping and
/// deciding what deserves attention — is plain logic that a unit test can
/// drive, instead of being buried in a `body` nobody can call.
public struct CompanionViewModel: Equatable, Sendable {
    public let tasks: [AgentTask]
    public let isConnected: Bool
    public let lastError: String?

    public init(tasks: [AgentTask], isConnected: Bool, lastError: String? = nil) {
        self.tasks = tasks
        self.isConnected = isConnected
        self.lastError = lastError
    }

    /// Still moving, oldest first — the queue a user is waiting on.
    ///
    /// Sorted by `updatedAt` ascending so the task that has been stuck longest
    /// is at the top. Sorting newest-first buries the thing that is actually
    /// wedged, which is the one you opened the app to look at.
    public var active: [AgentTask] {
        tasks.filter { !$0.status.isTerminal }.sorted { $0.updatedAt < $1.updatedAt }
    }

    /// Finished, newest first.
    public var finished: [AgentTask] {
        tasks.filter { $0.status.isTerminal }.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Tasks that stopped without producing anything.
    ///
    /// This is the specific failure this project has shipped twice, so the
    /// phone refuses to show it as a quiet success.
    public var needsAttention: [AgentTask] {
        tasks.filter { task in
            task.finishedWithNoChanges || (task.status.isTerminal && !task.status.isSuccess)
        }
    }

    /// One line for the home screen.
    public var headline: String {
        if !isConnected {
            return lastError.map { "Not connected — \($0)" } ?? "Not connected"
        }
        let running = active.count
        let attention = needsAttention.count
        if running == 0 && attention == 0 {
            return tasks.isEmpty ? "No agents running" : "All agents finished"
        }
        var parts: [String] = []
        if running > 0 { parts.append("\(running) running") }
        if attention > 0 { parts.append("\(attention) need attention") }
        return parts.joined(separator: " · ")
    }
}

/// The home screen.
public struct CompanionRootView: View {
    @StateObject private var model: CompanionModel
    @State private var showingComposer = false
    @State private var draftTaskId: String?

    public init(model: CompanionModel) {
        _model = StateObject(wrappedValue: model)
    }

    public var body: some View {
        NavigationStack {
            List {
                if !model.needsAttention.isEmpty {
                    Section {
                        ForEach(model.needsAttention) { task in
                            NavigationLink(value: task.id) {
                                TaskRow(task: task, emphasise: true)
                            }
                        }
                    } header: {
                        Text("Needs attention")
                            .foregroundStyle(.red)
                    } footer: {
                        Text("Stopped without completing. These are not successes.")
                    }
                }

                Section("Running") {
                    if model.active.isEmpty {
                        Text("Nothing running").foregroundStyle(.secondary)
                    } else {
                        ForEach(model.active) { task in
                            NavigationLink(value: task.id) {
                                TaskRow(task: task, emphasise: false)
                            }
                        }
                    }
                }

                if !model.finished.isEmpty {
                    Section("Finished") {
                        ForEach(model.finished) { task in
                            NavigationLink(value: task.id) {
                                TaskRow(task: task, emphasise: false)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Agents")
            .navigationDestination(for: String.self) { id in
                TaskDetailView(task: model.task(id: id), onFollowUp: { text in
                    model.send(.followUp(taskId: id, text: text))
                })
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        model.send(.refresh)
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh")
                }
            }
        }
    }
}

/// One row in the list.
public struct TaskRow: View {
    let task: AgentTask
    let emphasise: Bool

    public init(task: AgentTask, emphasise: Bool) {
        self.task = task
        self.emphasise = emphasise
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(task.title).font(.headline)
            HStack(spacing: 6) {
                Text(task.status.displayName)
                if !task.stage.isEmpty {
                    Text("· \(task.stage)")
                }
            }
            .font(.caption)
            .foregroundStyle(emphasise ? .red : .secondary)

            if !task.lastNote.isEmpty {
                Text(task.lastNote)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            // A terminal task with no files changed is called out even when the
            // status itself is technically terminal.
            if task.finishedWithNoChanges {
                Text("No files were changed.")
                    .font(.caption2)
                    .foregroundStyle(.red)
            }
        }
    }
}

/// One task, with a way to send a follow-up.
public struct TaskDetailView: View {
    let task: AgentTask?
    let onFollowUp: (String) -> Void

    @State private var draft = ""

    public init(task: AgentTask?, onFollowUp: @escaping (String) -> Void) {
        self.task = task
        self.onFollowUp = onFollowUp
    }

    public var body: some View {
        Form {
            if let task {
                Section("State") {
                    LabeledContent("Status", value: task.status.displayName)
                    if !task.stage.isEmpty {
                        LabeledContent("Stage", value: task.stage)
                    }
                    LabeledContent("Files changed", value: "\(task.changedPaths.count)")
                }

                if !task.lastNote.isEmpty {
                    Section("Latest") {
                        Text(task.lastNote)
                    }
                }

                if !task.changedPaths.isEmpty {
                    Section("Changed") {
                        ForEach(task.changedPaths, id: \.self) { path in
                            Text(path).font(.caption.monospaced())
                        }
                    }
                }

                if !task.status.isTerminal {
                    Section("Follow up") {
                        TextField("Add context for the agent", text: $draft, axis: .vertical)
                        Button("Send") {
                            let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                            guard !text.isEmpty else { return }
                            onFollowUp(text)
                            draft = ""
                        }
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            } else {
                Section {
                    Text("This task is no longer known to the desktop.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Task")
    }
}