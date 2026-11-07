import Foundation

/// A GPX track as the planner opens it (`src/domain/gpx-import.ts`): its name and segments, each point with its height
/// where the file has one.
struct Track: Sendable {
    struct Segment: Sendable {
        let coordinates: [[Double]]
        let elevations: [Double?]
        /// Metres from the segment's start at each point.
        let distances: [Double]

        init(coordinates: [[Double]], elevations: [Double?] = []) {
            self.coordinates = coordinates
            self.elevations = elevations
            var distance = 0.0
            distances = coordinates.indices.map { i in
                if i > 0 { distance += Geo.distance(coordinates[i - 1], coordinates[i]) }
                return distance
            }
        }
    }

    let name: String
    let segments: [Segment]

    /// The track cut into sections of about 5 km (`gpxSections`, `src/domain/gpx-route.ts`), with its exact path
    /// and heights, as recorded legs; segments too short for one are left out.
    var sections: [[Leg]] {
        segments.map { segment in
            // climbing is filtered along the whole segment, so the sections add up to the track's
            let climbed = Self.cumulativeAscent(segment.elevations)
            let cuts = Self.cuts(segment.distances)
            return zip(cuts, cuts.dropFirst()).map { from, to in
                let heights = segment.elevations[from...to]
                let elevations = heights.allSatisfy { $0 != nil } ? heights.map { $0! } : nil
                return Leg(coordinates: Array(segment.coordinates[from...to]), elevations: elevations,
                           distanceMeters: segment.distances[to] - segment.distances[from],
                           ascentMeters: elevations.map { _ in climbed[to] - climbed[from] }, surfaces: [], recorded: true)
            }
        }.filter { !$0.isEmpty }
    }

    private static let sectionMeters = 5000.0
    /// A rise counts once it climbs this far past the last low (`fileClimbThreshold`).
    private static let climbThreshold = 2.0

    /// Where a line of these distances is cut into sections (`sectionCuts`); no cut leaves a last section shorter than half.
    private static func cuts(_ distances: [Double]) -> [Int] {
        let last = distances.count - 1
        var cuts = [0]
        if last > 1 {
            for i in 1..<last where distances[i] - distances[cuts[cuts.count - 1]] >= sectionMeters && distances[last] - distances[i] >= sectionMeters / 2 {
                cuts.append(i)
            }
        }
        if last > 0 { cuts.append(last) }
        return cuts
    }

    /// Climbing so far at each point (`cumulativeAscent`, `src/domain/route-model.ts`): a rise counts once it climbs past
    /// the last low, and then in full; each run between missing heights on its own.
    private static func cumulativeAscent(_ elevations: [Double?]) -> [Double] {
        var ascent = [0.0]
        var low = elevations.first ?? nil, high: Double?
        for elevation in elevations.dropFirst() {
            var climbed = 0.0
            if let elevation {
                if let top = high {
                    if elevation > top {
                        climbed = elevation - top
                        high = elevation
                    } else if elevation < top - climbThreshold {
                        high = nil
                        low = elevation
                    }
                } else if low == nil || elevation < low! {
                    low = elevation
                } else if elevation > low! + climbThreshold {
                    climbed = elevation - low!
                    high = elevation
                }
            } else {
                low = nil
                high = nil
            }
            ascent.append(ascent[ascent.count - 1] + climbed)
        }
        return ascent
    }
}

/// GPX files read and written as the planner does (`src/domain/gpx-import.ts`, `src/domain/route-gpx.ts`).
enum GPX {
    static let maxBytes = 32 * 1024 * 1024
    static let tooLarge = Engine.Failure(message: "Die GPX-Datei darf höchstens 32 MB groß sein.")
    static let documentType = Engine.Failure(message: "GPX-Dateien mit Dokumenttyp-Deklarationen werden nicht unterstützt.")

    /// The track in a GPX 1.0 or 1.1 file, named as the file names it, else after the file.
    static func read(_ data: Data, fileName: String) throws -> Track {
        if data.range(of: Data("<!DOCTYPE".utf8)) != nil || data.range(of: Data("<!doctype".utf8)) != nil {
            throw documentType
        }
        let reader = Reader()
        let parser = XMLParser(data: data)
        parser.shouldProcessNamespaces = true
        parser.delegate = reader
        let parsed = parser.parse()
        if let failure = reader.failure { throw failure }
        guard parsed, reader.namespace != nil else { throw Reader.invalid }
        guard reader.points > 0 else {
            throw Engine.Failure(message: reader.routes
                ? "Diese GPX-Datei enthält nur Routenpunkte. Bitte einen GPX-Track mit aufgezeichnetem Streckenverlauf exportieren."
                : "Die GPX-Datei enthält keine Trackpunkte.")
        }
        let named = [reader.metadata ? reader.metadataName : reader.documentName, reader.tracks == 1 ? reader.trackName : nil,
                     fileName.replacing(/\.gpx$/.ignoresCase(), with: "")]
        let name = named.compactMap { $0 }.first { !$0.isEmpty } ?? "GPX-Track"
        return Track(name: String(name.prefix(120)), segments: reader.segments)
    }

    /// The route as GPX 1.1, one track in `segments` of [longitude, latitude, height where known].
    static func write(name: String, segments: [[[Double]]]) -> Data {
        var gpx = #"<?xml version="1.0" encoding="UTF-8"?>"# + "\n"
            + #"<gpx version="1.1" creator="RichiRoute" xmlns="http://www.topografix.com/GPX/1/1">"# + "\n"
            + "<metadata><name>\(xml(name))</name><desc>Geplant mit RichiRoute. Kartendaten © OpenStreetMap-Mitwirkende.</desc></metadata>\n"
            + "<trk><name>\(xml(name))</name><trkseg>"
        gpx.reserveCapacity(segments.reduce(gpx.utf8.count + 64) { $0 + $1.count * 70 })
        for (index, segment) in segments.enumerated() {
            if index > 0 { gpx += "\n</trkseg><trkseg>" }
            for point in segment {
                gpx += String(format: #"\n<trkpt lat="%.7f" lon="%.7f">"#, point[1], point[0])
                if point.count > 2 { gpx += String(format: "<ele>%.2f</ele>", point[2]) }
                gpx += "</trkpt>"
            }
        }
        gpx += "\n</trkseg></trk></gpx>"
        return Data(gpx.utf8)
    }

    /// The legs as one track (`trackSegments`): a point two legs share once, a gap where they do not meet a new segment;
    /// `stops` has the index where each leg that leaves a Zwischenstopp (`afterStop`) begins, where a long FIT course is
    /// best cut.
    static func track(_ legs: [Leg], afterStop: [Bool]) -> (segments: [[[Double]]], stops: [Int]) {
        var segments: [[[Double]]] = [[]], stops: [Int] = [], count = 0
        for (leg, afterStop) in zip(legs, afterStop) {
            for (index, coord) in leg.coordinates.enumerated() {
                let height = leg.elevations.flatMap { $0.indices.contains(index) ? $0[index] : nil }
                let point = height.map { [coord[0], coord[1], $0] } ?? [coord[0], coord[1]]
                if index == 0, let previous = segments[segments.count - 1].last {
                    let same = previous[0] == coord[0] && previous[1] == coord[1]
                    if same && (previous.count > 2 ? previous[2] : nil) == height {
                        if afterStop { stops.append(count - 1) }
                        continue
                    }
                    if !same { segments.append([]) }
                }
                if index == 0 && afterStop { stops.append(count) }
                segments[segments.count - 1].append(point)
                count += 1
            }
        }
        return (segments, stops)
    }

    private static func xml(_ text: String) -> String {
        String(String.UnicodeScalarView(text.unicodeScalars.filter { scalar in
            [9, 10, 13].contains(scalar.value) || (0x20...0xd7ff).contains(scalar.value) || (0xe000...0xfffd).contains(scalar.value) || scalar.value >= 0x10000
        }))
        .replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        .replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "'", with: "&apos;")
    }

    /// Reads the elements the planner reads and checks the rest for well-formedness only.
    private final class Reader: NSObject, XMLParserDelegate {
        static let invalid = Engine.Failure(message: "Die Datei enthält kein gültiges GPX-XML.")
        private static let namespaces: Set<String> = ["", "http://www.topografix.com/GPX/1/0", "http://www.topografix.com/GPX/1/1"]
        private static let children: [String: Set<String>] = [
            "gpx": ["metadata", "name", "trk", "rte"], "metadata": ["name"], "trk": ["name", "trkseg"], "trkseg": ["trkpt"], "trkpt": ["ele"],
        ]
        static let maxPoints = 250_000

        var failure: Engine.Failure?
        /// The root's namespace, empty for none; nil until the root is read.
        var namespace: String?
        var segments: [Track.Segment] = []
        var points = 0, tracks = 0, routes = false, metadata = false
        var documentName: String?, metadataName: String?, trackName: String?
        /// What each open element is read as, nil for one that is not.
        private var roles: [String?] = []
        private var coordinates: [[Double]] = [], elevations: [Double?] = []
        private var text: String?

        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?,
                    attributes: [String: String] = [:]) {
            let uri = namespaceURI ?? ""
            var role: String?
            if roles.isEmpty {
                guard namespace == nil, name == "gpx" else { return fail(parser, Self.invalid) }
                guard Self.namespaces.contains(uri), ["1.0", "1.1"].contains(attributes["version"]) else {
                    return fail(parser, Engine.Failure(message: "Unterstützt werden GPX-Dateien der Version 1.0 und 1.1."))
                }
                namespace = uri
                role = "gpx"
            } else if let parent = roles[roles.count - 1], uri == namespace, Self.children[parent]?.contains(name) == true {
                role = name
            }
            switch role {
            case "metadata":
                if metadata { role = nil }
                metadata = true
            case "trk":
                tracks += 1
                trackName = nil
            case "rte": routes = true
            case "trkseg": (coordinates, elevations) = ([], [])
            case "name", "ele": text = ""
            case "trkpt":
                points += 1
                if points > Self.maxPoints {
                    return fail(parser, Engine.Failure(message: "Die GPX-Datei enthält mehr als 250.000 Trackpunkte. Bitte die Datei aufteilen."))
                }
                guard let lon = decimal(attributes["lon"], "Längengrad", parser), let lat = decimal(attributes["lat"], "Breitengrad", parser) else { return }
                guard abs(lon) <= 180 && abs(lat) <= 90 else {
                    return fail(parser, Engine.Failure(message: "Eine GPX-Koordinate liegt außerhalb des gültigen Bereichs."))
                }
                coordinates.append([lon, lat])
                elevations.append(nil)
            default: break
            }
            roles.append(role)
        }

        func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
            let role = roles.popLast() ?? nil
            let parent = roles.last ?? nil
            switch role {
            case "ele":
                if elevations[elevations.count - 1] == nil {
                    guard let height = decimal(text, "Höhenwert", parser) else { return }
                    elevations[elevations.count - 1] = height
                }
            case "name":
                let name = (text ?? "").replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                switch parent {
                case "gpx": documentName = documentName ?? name
                case "metadata": metadataName = metadataName ?? name
                default: trackName = trackName ?? name
                }
            case "trkseg": if !coordinates.isEmpty { segments.append(Track.Segment(coordinates: coordinates, elevations: elevations)) }
            default: break
            }
            if role == "name" || role == "ele" { text = nil }
        }

        func parser(_ parser: XMLParser, foundCharacters string: String) { text? += string }

        // a document type in another encoding than UTF-8, which the byte check above misses
        func parser(_ parser: XMLParser, foundInternalEntityDeclarationWithName name: String, value: String?) { fail(parser, GPX.documentType) }

        func parser(_ parser: XMLParser, foundExternalEntityDeclarationWithName name: String, publicID: String?, systemID: String?) {
            fail(parser, GPX.documentType)
        }

        func parser(_ parser: XMLParser, foundCDATA block: Data) { text? += String(decoding: block, as: UTF8.self) }

        private func decimal(_ value: String?, _ label: String, _ parser: XMLParser) -> Double? {
            if let value, let number = Self.decimal(value) { return number }
            fail(parser, Engine.Failure(message: "Ungültiger \(label) im GPX-Track."))
            return nil
        }

        /// A plain decimal ("-12.5", ".5", "3."), without the exponents and names `Double` also reads; checked byte by
        /// byte, as a file has hundreds of thousands.
        private static func decimal(_ text: String) -> Double? {
            let space = { (byte: UInt8) in byte == 32 || byte == 9 || byte == 10 || byte == 13 }
            guard let first = text.utf8.firstIndex(where: { !space($0) }), let last = text.utf8.lastIndex(where: { !space($0) }) else { return nil }
            let number = text[first...last]
            var digits = 0, dots = 0
            for (index, byte) in number.utf8.enumerated() {
                switch byte {
                case 48...57: digits += 1
                case 46: dots += 1
                case 43, 45: if index > 0 { return nil }
                default: return nil
                }
            }
            guard digits > 0, dots <= 1, let value = Double(number), value.isFinite else { return nil }
            return value
        }

        private func fail(_ parser: XMLParser, _ failure: Engine.Failure) {
            self.failure = self.failure ?? failure
            parser.abortParsing()
        }
    }
}
