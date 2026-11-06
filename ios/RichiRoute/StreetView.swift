import MapKit
import SwiftUI
import WebKit

/// Street View where Apple has no Look Around (which shows full screen): Google's, through its free embed as the web
/// planner shows it, in a card over the top of the map.
struct StreetView: View {
    enum Imagery {
        case apple(MKLookAroundScene)
        /// Google's panorama, by where it was taken.
        case google([Double])
    }

    /// Where Google's panorama was taken.
    let coordinate: [Double]
    let close: () -> Void

    var body: some View {
        GoogleEmbed(coordinate: coordinate)
            .frame(height: 260)
            .overlay(alignment: .topTrailing) {
                CloseButton(label: "Street View schließen", onImage: true, action: close)
                    .padding(.trailing, 20)
                    .padding(.top, 4)
            }
            .clipShape(RoundedRectangle(cornerRadius: 24))
            .padding(.horizontal, 8)
            .padding(.top, 4)
    }

    /// The imagery nearest a point: Apple's, else Google's panorama outdoors within 50 m (its free metadata lookup);
    /// none without either, or offline.
    static func imagery(at coordinate: [Double]) async -> Imagery? {
        let point = CLLocationCoordinate2D(latitude: coordinate[1], longitude: coordinate[0])
        if let scene = try? await MKLookAroundSceneRequest(coordinate: point).scene { return .apple(scene) }
        guard !key.isEmpty, var parts = URLComponents(string: "https://maps.googleapis.com/maps/api/streetview/metadata") else { return nil }
        parts.queryItems = [URLQueryItem(name: "location", value: "\(point.latitude),\(point.longitude)"),
                            URLQueryItem(name: "radius", value: "50"), URLQueryItem(name: "source", value: "outdoor"),
                            URLQueryItem(name: "key", value: key)]
        guard let url = parts.url else { return nil }
        var request = URLRequest(url: url)
        request.setValue(origin + "/", forHTTPHeaderField: "Referer")
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let found = try? JSONDecoder().decode(Metadata.self, from: data), found.status == "OK", let at = found.location
        else { return nil }
        return .google([at.lng, at.lat])
    }

    private struct Metadata: Decodable {
        struct Location: Decodable { let lat, lng: Double }
        let status: String
        let location: Location?
    }

    /// The key for Google's embed and its lookup (Maps Embed API and Street View Static API), from `Secrets.xcconfig`;
    /// restricted to the website `origin`, which the card's page is loaded as.
    static let key = Bundle.main.object(forInfoDictionaryKey: "GoogleMapsKey") as? String ?? ""
    static let origin = "https://adamn676.github.io"
}

/// Google's Street View embed (the web planner's `StreetViewPanel`), in a page of the key's website.
private struct GoogleEmbed: UIViewRepresentable {
    let coordinate: [Double]

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView()
        view.scrollView.isScrollEnabled = false
        view.isOpaque = false
        view.backgroundColor = .black
        let source = "https://www.google.com/maps/embed/v1/streetview?key=\(StreetView.key)"
            + "&location=\(coordinate[1]),\(coordinate[0])&language=de&region=AT"
        view.loadHTMLString("""
            <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
            <style>html,body,iframe{margin:0;width:100%;height:100%;border:0;background:#000}</style>
            <iframe src="\(source)" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe>
            """, baseURL: URL(string: StreetView.origin))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}

/// Where Street View was asked for: a pin dropped there while it looks, with the answer beside it when there is none,
/// and kept after Street View closes.
struct LookPin: Equatable {
    enum State: Equatable { case looking, found, missing(String) }
    let coordinate: [Double]
    var state = State.looking
}

/// The pin, as Apple Maps' dropped pin: the planner's ink with Look Around's binoculars, on a short needle over the
/// spot, its note above it.
struct LookPinMark: View {
    let state: LookPin.State
    @State private var dropped = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 6) {
            note
            VStack(spacing: 0) {
                Circle()
                    .fill(missing ? Color(UIColor.systemGray) : Color(MapStyle.ink))
                    .frame(width: 34, height: 34)
                    .overlay {
                        Image(systemName: missing ? "eye.slash.fill" : "binoculars.fill")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                    .overlay { Circle().strokeBorder(.white, lineWidth: 2.5) }
                    .shadow(color: .black.opacity(0.25), radius: 3, y: 2)
                // light on the dark map, where the ink would vanish
                Capsule()
                    .fill(missing ? Color(UIColor.systemGray) : scheme == .dark ? .white.opacity(0.85) : Color(MapStyle.ink))
                    .frame(width: 3, height: 12)
            }
            .offset(y: dropped ? 0 : -28)
            .opacity(dropped ? 1 : 0)
            // its shadow on the ground, where it points
            Ellipse()
                .fill(.black.opacity(0.25))
                .frame(width: dropped ? 10 : 4, height: 4)
                .padding(.top, -8)
        }
        .frame(width: LookPinMark.size.width, height: LookPinMark.size.height, alignment: .bottom)
        .animation(.easeOut(duration: 0.2), value: state)
        .onAppear { withAnimation(.spring(response: 0.35, dampingFraction: 0.6)) { dropped = true } }
    }

    static let size = CGSize(width: 260, height: 100)

    private var missing: Bool { if case .missing = state { true } else { false } }

    @ViewBuilder private var note: some View {
        switch state {
        case .looking:
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Street View …")
            }
            .modifier(Note())
        case .missing(let text): Text(text).modifier(Note())
        case .found: EmptyView()
        }
    }

    private struct Note: ViewModifier {
        func body(content: Content) -> some View {
            content
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color.ink)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .glass(in: Capsule())
                .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .bottom)))
        }
    }
}
