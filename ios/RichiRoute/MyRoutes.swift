import SwiftUI

/// A route's name as the planner takes it (`routeName`, `src/domain/saved-route.ts`): 1 to 120 characters.
enum RouteName {
    static func valid(_ text: String) -> String? {
        let name = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return (1...120).contains(name.count) ? name : nil
    }
}

/// The rider's routes, as the web planner's "Meine Routen" tab: those replaced without being saved, and the saved ones,
/// each opened by a tap, renamed, duplicated or deleted by a long press, deleted by a swipe.
struct MyRoutes: View {
    let planner: Planner
    /// Shows the route tab, once a route is open.
    let opened: () -> Void

    @State private var recent: [RouteStore.Entry] = []
    @State private var saved: [RouteStore.Entry] = []
    @State private var renaming: RouteStore.Entry?
    @State private var newName = ""
    @State private var deleting: RouteStore.Entry?

    var body: some View {
        List {
            if !recent.isEmpty {
                Section {
                    heading("Zuletzt bearbeitet",
                            note: "Nicht gespeichert. Die letzten \(RouteStore.recentLimit) Routen bleiben \(RouteStore.recentDays) Tage.")
                    ForEach(recent) { entry in
                        row(entry)
                            .swipeActions { deleteButton(entry) }
                    }
                }
            }
            Section {
                heading("Gespeicherte Routen", count: saved.count,
                        note: saved.isEmpty ? "Noch keine. Gespeichert wird im Tab „Route“ über „…“." : "Auf diesem iPhone.")
                ForEach(saved) { entry in
                    row(entry)
                        .swipeActions { deleteButton(entry) }
                        .contextMenu {
                            Button("Umbenennen", systemImage: "pencil") {
                                newName = entry.name
                                renaming = entry
                            }
                            Button("Duplizieren", systemImage: "plus.square.on.square") { duplicate(entry) }
                            Button("Löschen", systemImage: "trash", role: .destructive) { deleting = entry }
                        }
                }
            }
        }
        .listStyle(.plain)
        .tint(Color.ink)
        .onAppear(perform: refresh)
        .onChange(of: planner.notice) { refresh() }
        .alert("Route umbenennen", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Neuer Routenname", text: $newName)
            Button("Abbrechen", role: .cancel) {}
            Button("Umbenennen") { rename() }.disabled(RouteName.valid(newName) == nil).keyboardShortcut(.defaultAction)
        }
        .alert("Route löschen?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { entry in
            Button("Abbrechen", role: .cancel) {}
            Button("Endgültig löschen", role: .destructive) { delete(entry) }
        } message: { entry in
            Text("„\(entry.name)“ wird endgültig aus „Meine Routen“ gelöscht.")
        }
    }

    private func heading(_ title: String, count: Int? = nil, note: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(title).font(.headline).foregroundStyle(Color.ink)
                if let count { Text("\(count)").font(.headline).foregroundStyle(.secondary) }
            }
            Text(note).font(.footnote).foregroundStyle(.secondary)
        }
        .listRowSeparator(.hidden)
        .padding(.top, 8)
    }

    private func row(_ entry: RouteStore.Entry) -> some View {
        Button {
            planner.replace(with: entry)
            opened()
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.name).foregroundStyle(Color.ink)
                Text(details(entry)).font(.footnote).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func details(_ entry: RouteStore.Entry) -> String {
        // as the planner's `formatDateTime`: 02.11.2026, 18:40
        let when = entry.updated.formatted(.dateTime.day(.twoDigits).month(.twoDigits).year().hour(.twoDigits(amPM: .omitted))
            .minute(.twoDigits).locale(Locale(identifier: "de_AT")))
        let open = entry.kind == .saved && entry.id == planner.savedID ? " · geöffnet" : ""
        return "\(Format.km(entry.distanceMeters)) km · \(when)\(open)"
    }

    private func deleteButton(_ entry: RouteStore.Entry) -> some View {
        Button("Löschen", systemImage: "trash", role: .destructive) {
            if entry.kind == .saved { deleting = entry } else { delete(entry) }
        }
    }

    private func refresh() {
        recent = RouteStore.list(.recent)
        saved = RouteStore.list(.saved)
    }

    private func rename() {
        guard let entry = renaming, let name = RouteName.valid(newName), var file = RouteStore.file(entry) else { return }
        file.name = name
        RouteStore.store(file, as: .saved, id: entry.id)
        planner.savedRouteChanged(entry.id, name: name)
        refresh()
    }

    private func duplicate(_ entry: RouteStore.Entry) {
        guard var file = RouteStore.file(entry) else { return }
        file.name = String("\(entry.name) (Kopie)".prefix(120))
        RouteStore.store(file, as: .saved)
        refresh()
    }

    private func delete(_ entry: RouteStore.Entry) {
        RouteStore.delete(entry)
        if entry.kind == .saved { planner.savedRouteChanged(entry.id, name: nil) }
        refresh()
    }
}
