//! The route's elevation profile as the planner draws it (`app/src/domain/gpx-track.ts`, `gpx-inspection.ts`): its legs
//! one after another (`buildGpxTrack`, connected), the line smoothed over a column's width (`drawProfile`), and its
//! colours by the steepest climb held in each column (`gradientRuns`).

use std::fmt::Write;

use crate::json::{Json, push_number};
use crate::leg::{Coord, distance, path_distance};

/// The chart's columns, and its line's lowest and highest y within 0 (top) to 88 (bottom), x from 0 to 300.
pub const COLUMNS: usize = 300;
const BOTTOM: f64 = 78.0;
const HEIGHT: f64 = 68.0;

/// A routed leg's points, heights where known, and length as the engine measured it.
pub struct Segment<'a> {
    pub coordinates: &'a [Coord],
    pub elevations: &'a [Option<f64>],
    pub distance: f64,
}

#[derive(Clone, Copy)]
struct Sample {
    distance: f64,
    height: f64,
    index: usize,
    run: usize,
}

/// The legs one after another: each point's distance along them, and the points with a height, a missing height
/// breaking the line into runs.
pub struct Track {
    distances: Vec<Vec<f64>>,
    elevations: Vec<Vec<Option<f64>>>,
    samples: Vec<Sample>,
    pub distance: f64,
}

/// `buildGpxTrack(…, { connected: true })`: the legs continue one another, so the profile joins them.
pub fn track(segments: &[Segment]) -> Track {
    let (mut total, mut points, mut run) = (0.0, 0, 1);
    let mut samples = Vec::new();
    let mut distances = Vec::with_capacity(segments.len());
    for segment in segments {
        let measured = path_distance(segment.coordinates);
        let scale = if segment.distance != 0.0 {
            segment.distance / if measured != 0.0 { measured } else { segment.distance }
        } else {
            1.0
        };
        let mut along = Vec::with_capacity(segment.coordinates.len());
        for (i, &coord) in segment.coordinates.iter().enumerate() {
            if i > 0 {
                total += distance(segment.coordinates[i - 1], coord) * scale;
            }
            along.push(total);
            points += 1;
            match segment.elevations.get(i).copied().flatten() {
                Some(height) => samples.push(Sample { distance: total, height, index: points, run }),
                None => run += 1,
            }
        }
        distances.push(along);
    }
    let elevations = segments.iter().map(|segment| segment.elevations.to_vec()).collect();
    Track { distances, elevations, samples, distance: total }
}

/// `profileWindow`: the width a stretch is read at, a column's, from 100 to 500 m. Its colours hold a climb over that
/// width and its line averages the heights over it, so both show the road, not the terrain data's errors.
fn window(span: f64) -> f64 {
    (span / COLUMNS as f64).clamp(100.0, 500.0)
}

/// `profileColumn`.
fn column(at: f64, total: f64) -> usize {
    if total > 0.0 { ((at / total * COLUMNS as f64).floor() as usize).min(COLUMNS - 1) } else { 0 }
}

/// `gpxGradients`: the gradient at each point in percent, over the stretch within `half` metres to either side.
fn gradients(track: &Track, half: f64) -> Vec<Vec<Option<f64>>> {
    track
        .elevations
        .iter()
        .zip(&track.distances)
        .map(|(heights, distances)| {
            let mut result = vec![None; heights.len()];
            let mut start = 0;
            while start < heights.len() {
                if heights[start].is_none() {
                    start += 1;
                    continue;
                }
                let mut end = start;
                while end + 1 < heights.len() && heights[end + 1].is_some() {
                    end += 1;
                }
                let (mut left, mut right) = (start, start);
                for i in start..=end {
                    while left < i && distances[left + 1] <= distances[i] - half {
                        left += 1;
                    }
                    right = right.max(i);
                    while right < end && distances[right] < distances[i] + half {
                        right += 1;
                    }
                    let span = distances[right] - distances[left];
                    if span >= half * 0.4 {
                        let grade = (heights[right].unwrap() - heights[left].unwrap()) / span * 100.0;
                        if grade.is_finite() {
                            result[i] = Some(grade);
                        }
                    }
                }
                start = end + 1;
            }
            result
        })
        .collect()
}

/// `gradientBand`: < 3 %, 3 to 8 %, 8 to 15 %, ≥ 15 %; only climbs are told apart.
fn band(gradient: f64) -> usize {
    [3.0, 8.0, 15.0].iter().position(|&max| gradient < max).unwrap_or(3)
}

#[derive(Clone, Copy)]
struct ColumnPoint {
    distance: f64,
    height: f64,
    band: usize,
}

/// `gradientRuns`: colour runs, each from an offset (0 to 1) along the distance shown with its band. A column takes the
/// steepest climb in it held over about its own width; its colour fills the column only where the line does not fall,
/// from the low point before the climb to the top after it. Columns without points continue the previous run.
pub fn gradient_runs(track: &Track, from: f64, to: f64) -> Vec<(f64, usize)> {
    let span = to - from;
    let sustained = gradients(track, window(span) / 2.0);
    let mut columns: Vec<Vec<ColumnPoint>> = vec![Vec::new(); COLUMNS];
    for (s, distances) in track.distances.iter().enumerate() {
        for (i, &at) in distances.iter().enumerate() {
            let Some(gradient) = sustained[s][i] else { continue };
            if at < from || at > to {
                continue;
            }
            let height = track.elevations[s][i].unwrap();
            columns[column(at - from, span)].push(ColumnPoint { distance: at, height, band: band(gradient) });
        }
    }
    let mut runs = Vec::new();
    let mut current: Option<usize> = None;
    let mut previous: &[ColumnPoint] = &[];
    for (index, points) in columns.iter().enumerate() {
        if points.is_empty() {
            continue;
        }
        let steepest = points.iter().map(|p| p.band).max().unwrap_or(0);
        if Some(steepest) != current {
            let rising = current.is_none_or(|band| steepest > band);
            let mut at = index as f64 / COLUMNS as f64;
            if rising {
                // the low point before the climb
                let mut turn = points[0];
                let mut moved = false;
                for point in points {
                    if point.height < turn.height {
                        turn = *point;
                        moved = true;
                    }
                    if point.band == steepest {
                        break;
                    }
                }
                if moved {
                    at = (turn.distance - from) / span;
                }
            } else {
                // the top after the climb
                let band = current.unwrap();
                let last = previous.len() - 1;
                let mut turn = previous[last];
                let mut moved = false;
                for point in previous.iter().rev() {
                    if point.height > turn.height {
                        turn = *point;
                        moved = true;
                    }
                    if point.band == band {
                        break;
                    }
                }
                if moved {
                    at = (turn.distance - from) / span;
                }
            }
            runs.push((at, steepest));
            current = Some(steepest);
        }
        previous = points;
    }
    runs
}

/// The number of samples before a distance, or up to and including it.
fn samples_before(samples: &[Sample], distance: f64, including: bool) -> usize {
    samples.partition_point(|sample| if including { sample.distance <= distance } else { sample.distance < distance })
}

/// `smoothedHeights`: each sample's height averaged over `meters` around it along the line between the samples of its
/// run, from the area under the line summed along each run.
fn smoothed_heights(samples: &[Sample], first: usize, last: usize, meters: f64) -> Vec<f64> {
    let n = samples.len();
    let (mut area, mut run_start, mut run_end) = (vec![0.0; n], vec![0; n], vec![0; n]);
    for k in 1..n {
        let same = samples[k].run == samples[k - 1].run;
        area[k] = if same {
            area[k - 1]
                + (samples[k - 1].height + samples[k].height) / 2.0 * (samples[k].distance - samples[k - 1].distance)
        } else {
            0.0
        };
        run_start[k] = if same { run_start[k - 1] } else { k };
    }
    if n > 0 {
        run_end[n - 1] = n - 1;
    }
    for k in (0..n.saturating_sub(1)).rev() {
        run_end[k] = if samples[k + 1].run == samples[k].run { run_end[k + 1] } else { k };
    }
    // the area from the run's start to `x`, a distance within the run
    let area_to = |x: f64, start: usize, end: usize| {
        let (mut low, mut high) = (start, end);
        while low < high {
            let middle = (low + high).div_ceil(2);
            if samples[middle].distance <= x {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        let p = samples[low];
        let q = samples[(low + 1).min(end)];
        let height = if q.index == p.index {
            p.height
        } else {
            p.height + (q.height - p.height) * (x - p.distance) / (q.distance - p.distance)
        };
        area[low] + (p.height + height) / 2.0 * (x - p.distance)
    };
    (first..last)
        .map(|i| {
            let (start, end) = (run_start[i], run_end[i]);
            let a = (samples[i].distance - meters / 2.0).max(samples[start].distance);
            let b = (samples[i].distance + meters / 2.0).min(samples[end].distance);
            if b > a { (area_to(b, start, end) - area_to(a, start, end)) / (b - a) } else { samples[i].height }
        })
        .collect()
}

/// The drawn profile: its lowest and highest smoothed height and its line, a list of runs of [x, y] points.
pub struct Drawn {
    pub minimum: f64,
    pub maximum: f64,
    pub runs: Vec<Vec<[f64; 2]>>,
}

/// `drawProfile`: the profile between two distances in the chart's units, its heights averaged over the stretch's
/// window. The work is bounded by the chart's width, keeping each column's first, lowest, highest and last point;
/// one sample beyond each end lets the line reach the edges.
pub fn draw(track: &Track, from: f64, to: f64) -> Option<Drawn> {
    let samples = &track.samples;
    let span = to - from;
    let first = samples_before(samples, from, false).saturating_sub(1);
    let last = (samples_before(samples, to, true) + 1).min(samples.len());
    let heights = smoothed_heights(samples, first, last, window(span));
    let shown: Vec<Sample> =
        samples[first..last].iter().zip(&heights).map(|(sample, &height)| Sample { height, ..*sample }).collect();
    if shown.is_empty() {
        return None;
    }
    let minimum = shown.iter().map(|s| s.height).fold(f64::INFINITY, f64::min);
    let maximum = shown.iter().map(|s| s.height).fold(f64::NEG_INFINITY, f64::max);
    let selected: Vec<Sample> = if shown.len() <= 1200 {
        shown
    } else {
        let mut buckets: Vec<Option<[Sample; 4]>> = vec![None; COLUMNS];
        for sample in shown {
            let bucket = &mut buckets[column((sample.distance - from).max(0.0), span)];
            match bucket {
                None => *bucket = Some([sample; 4]),
                Some([_, min, max, last]) => {
                    *last = sample;
                    if sample.height < min.height {
                        *min = sample;
                    }
                    if sample.height > max.height {
                        *max = sample;
                    }
                }
            }
        }
        buckets
            .into_iter()
            .flatten()
            .flat_map(|bucket| {
                let mut kept: Vec<Sample> = Vec::with_capacity(4);
                for sample in bucket {
                    if !kept.iter().any(|k| k.index == sample.index) {
                        kept.push(sample);
                    }
                }
                kept.sort_by_key(|sample| sample.index);
                kept
            })
            .collect()
    };
    let mut runs: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut previous = None;
    for sample in selected {
        let x = if span > 0.0 { (sample.distance - from) / span * 300.0 } else { 0.0 };
        let y = BOTTOM - (sample.height - minimum) / (maximum - minimum).max(1.0) * HEIGHT;
        if previous != Some(sample.run) {
            runs.push(Vec::new());
        }
        runs.last_mut().unwrap().push([x, y]);
        previous = Some(sample.run);
    }
    Some(Drawn { minimum, maximum, runs })
}

/// `upperBound`: the number of the first `length` values not above `target`, the values ascending.
fn upper_bound(length: usize, value_at: impl Fn(usize) -> f64, target: f64) -> usize {
    let (mut low, mut high) = (0, length);
    while low < high {
        let middle = (low + high) / 2;
        if value_at(middle) <= target {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    low
}

/// The height at a distance along the track, between its points (`inspectGpxDistance`'s `elevation`).
fn elevation_at(track: &Track, requested: f64) -> Option<f64> {
    let at = requested.clamp(0.0, track.distance);
    let segment = upper_bound(track.distances.len(), |i| track.distances[i][0], at).saturating_sub(1);
    let distances = &track.distances[segment];
    let from = upper_bound(distances.len(), |i| distances[i], at).saturating_sub(1);
    let to = (from + 1).min(distances.len() - 1);
    let span = distances[to] - distances[from];
    let ratio = if span > 0.0 { (at - distances[from]) / span } else { 0.0 };
    let heights = &track.elevations[segment];
    if ratio == 0.0 {
        return heights[from];
    }
    Some(heights[from]? * (1.0 - ratio) + heights[to]? * ratio)
}

/// `cumulativeAscent(…).at(-1)` with the file threshold: climbing counted once it rises 2 m above the last low.
fn climbed(heights: &[Option<f64>]) -> f64 {
    const THRESHOLD: f64 = 2.0;
    let (mut low, mut high, mut total) = (heights.first().copied().flatten(), None::<f64>, 0.0);
    for &height in heights.iter().skip(1) {
        let Some(height) = height else {
            (low, high) = (None, None);
            continue;
        };
        if let Some(top) = high {
            if height > top {
                total += height - top;
                high = Some(height);
            } else if height < top - THRESHOLD {
                (high, low) = (None, Some(height));
            }
        } else if low.is_none_or(|low| height < low) {
            low = Some(height);
        } else if low.is_some_and(|low| height > low + THRESHOLD) {
            total += height - low.unwrap_or_default();
            high = Some(height);
        }
    }
    total
}

/// A stretch's figures (`sectionStats`): its length, climbing and descent, its mean gradient from end to end and its
/// steepest climb held over 100 m, which a single height error does not make.
pub struct Stats {
    pub distance: f64,
    pub ascent: f64,
    pub descent: f64,
    pub gradient: Option<f64>,
    pub steepest: Option<f64>,
}

pub fn section_stats(track: &Track, from: f64, to: f64) -> Stats {
    let sustained = gradients(track, 50.0);
    let (mut heights, mut steepest) = (Vec::new(), None::<f64>);
    for (s, distances) in track.distances.iter().enumerate() {
        for (i, &at) in distances.iter().enumerate() {
            if at < from || at > to {
                continue;
            }
            heights.push(track.elevations[s][i]);
            if let Some(gradient) = sustained[s][i] {
                steepest = Some(steepest.map_or(gradient, |s| s.max(gradient)));
            }
        }
    }
    let gradient = match (elevation_at(track, from), elevation_at(track, to)) {
        (Some(start), Some(end)) if to > from => Some((end - start) / (to - from) * 100.0),
        _ => None,
    };
    let ascent = climbed(&heights);
    heights.reverse();
    Stats { distance: to - from, ascent, descent: climbed(&heights), gradient, steepest }
}

/// The profile as the app reads it: `{"distance","minimum","maximum","runs":[[[x,y],…],…],"colors":[[from,band],…],
/// "along":[[…],…],"gradients":[[…],…]}` for the whole route or the stretch `range` (then with its `"stats"`), null
/// without heights. `along` and `gradients` are each point's distance and gradient (over 25 m to either side) per leg,
/// for showing a point of the profile as the planner does.
pub fn profile_json(segments: &[Segment], range: Option<(f64, f64)>) -> String {
    let track = track(segments);
    let (from, to) = range.unwrap_or((0.0, track.distance));
    let Some(drawn) = draw(&track, from, to) else { return "null".to_string() };
    let mut out = String::from("{\"distance\":");
    push_number(&mut out, track.distance);
    out.push_str(",\"minimum\":");
    push_number(&mut out, drawn.minimum);
    out.push_str(",\"maximum\":");
    push_number(&mut out, drawn.maximum);
    out.push_str(",\"runs\":[");
    for (r, run) in drawn.runs.iter().enumerate() {
        out.push_str(if r > 0 { ",[" } else { "[" });
        for (p, [x, y]) in run.iter().enumerate() {
            // a tenth of the chart's unit, as the planner's path
            let _ = write!(out, "{}[{:.1},{:.1}]", if p > 0 { "," } else { "" }, x, y);
        }
        out.push(']');
    }
    out.push_str("],\"colors\":[");
    for (c, (at, band)) in gradient_runs(&track, from, to).iter().enumerate() {
        out.push_str(if c > 0 { ",[" } else { "[" });
        push_number(&mut out, *at);
        let _ = write!(out, ",{band}]");
    }
    out.push_str("],\"along\":");
    push_lists(&mut out, track.distances.iter().map(|d| d.iter().map(|&a| Some(a))));
    out.push_str(",\"gradients\":");
    push_lists(&mut out, gradients(&track, 25.0).iter().map(|g| g.iter().copied()));
    if range.is_some() {
        let stats = section_stats(&track, from, to);
        out.push_str(",\"stats\":{\"distance\":");
        push_number(&mut out, stats.distance);
        out.push_str(",\"ascent\":");
        push_number(&mut out, stats.ascent);
        out.push_str(",\"descent\":");
        push_number(&mut out, stats.descent);
        out.push_str(",\"gradient\":");
        push_number(&mut out, stats.gradient.unwrap_or(f64::NAN));
        out.push_str(",\"steepest\":");
        push_number(&mut out, stats.steepest.unwrap_or(f64::NAN));
        out.push('}');
    }
    out.push('}');
    out
}

/// Lists of numbers, null where there is none.
fn push_lists(out: &mut String, lists: impl Iterator<Item = impl Iterator<Item = Option<f64>>>) {
    out.push('[');
    for (l, list) in lists.enumerate() {
        out.push_str(if l > 0 { ",[" } else { "[" });
        for (i, value) in list.enumerate() {
            if i > 0 {
                out.push(',');
            }
            push_number(out, value.unwrap_or(f64::NAN));
        }
        out.push(']');
    }
    out.push(']');
}

/// `profile_json` for a request `{"legs":[{"coordinates":[[lon,lat],…],"elevations":[…]|null,"distanceMeters":…},…],
/// "from"?:…,"to"?:…}`, the legs as the planner keeps them and the stretch to show, in metres along them.
pub fn profile_request(body: &str) -> Result<String, String> {
    let json = Json::parse(body)?;
    let legs = json.get("legs").and_then(Json::array).ok_or("legs missing")?;
    let mut parsed = Vec::with_capacity(legs.len());
    for leg in legs {
        let coordinates: Vec<Coord> = leg
            .get("coordinates")
            .and_then(Json::array)
            .ok_or("coordinates missing")?
            .iter()
            .map(|c| Some([c.array()?.first()?.number()?, c.array()?.get(1)?.number()?]))
            .collect::<Option<_>>()
            .ok_or("a coordinate is not [lon, lat]")?;
        let elevations: Vec<Option<f64>> = match leg.get("elevations").and_then(Json::array) {
            Some(heights) => heights.iter().map(Json::number).collect(),
            None => vec![None; coordinates.len()],
        };
        let distance = leg.get("distanceMeters").and_then(Json::number).unwrap_or(0.0);
        parsed.push((coordinates, elevations, distance));
    }
    let segments: Vec<Segment> = parsed
        .iter()
        .map(|(coordinates, elevations, distance)| Segment { coordinates, elevations, distance: *distance })
        .collect();
    let range =
        json.get("from").and_then(Json::number).zip(json.get("to").and_then(Json::number)).filter(|(f, t)| t > f);
    Ok(profile_json(&segments, range))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A straight leg north from Graz, a point every 50 m, with `heights`.
    fn leg(heights: &[Option<f64>]) -> (Vec<Coord>, Vec<Option<f64>>) {
        let coordinates = (0..heights.len()).map(|i| [15.44, 47.07 + i as f64 * 50.0 / 111_195.0]).collect();
        (coordinates, heights.to_vec())
    }

    #[test]
    fn a_climb_shows_in_its_band_from_its_foot_and_flat_ground_around_it() {
        // 2 km flat, 1 km at 10 %, 2 km flat
        let heights: Vec<Option<f64>> = (0..=100)
            .map(|i| {
                Some(match i {
                    0..=40 => 300.0,
                    41..=60 => 300.0 + (i - 40) as f64 * 5.0,
                    _ => 400.0,
                })
            })
            .collect();
        let (coordinates, elevations) = leg(&heights);
        let track = track(&[Segment { coordinates: &coordinates, elevations: &elevations, distance: 0.0 }]);
        assert!((track.distance - 5000.0).abs() < 1.0, "{}", track.distance);
        let runs = gradient_runs(&track, 0.0, track.distance);
        // flat, the climb's edge read over the window, the climb, its edge, flat again
        assert_eq!(runs.iter().map(|r| r.1).collect::<Vec<_>>(), [0, 1, 2, 1, 0], "{runs:?}");
        assert_eq!(runs[0].0, 0.0);
        assert!(runs[1..].iter().all(|r| (0.39..0.62).contains(&r.0)), "only around the climb, 2 to 3 km in: {runs:?}");
        let drawn = draw(&track, 0.0, track.distance).unwrap();
        assert_eq!((drawn.minimum.round(), drawn.maximum.round()), (300.0, 400.0));
        assert_eq!(drawn.runs.len(), 1);
        assert!((drawn.runs[0][0][1] - BOTTOM).abs() < 1e-9, "the flat start at the bottom");
    }

    #[test]
    fn a_missing_height_breaks_the_line_and_legs_join() {
        let (a, ea) = leg(&[Some(100.0), Some(110.0), None, Some(120.0)]);
        let (b, eb) = leg(&[Some(120.0), Some(130.0)]);
        let track = track(&[
            Segment { coordinates: &a, elevations: &ea, distance: 0.0 },
            Segment { coordinates: &b, elevations: &eb, distance: 0.0 },
        ]);
        let drawn = draw(&track, 0.0, track.distance).unwrap();
        assert_eq!(
            drawn.runs.iter().map(Vec::len).collect::<Vec<_>>(),
            [2, 3],
            "the second leg goes on from the first"
        );
        assert_eq!(profile_json(&[Segment { coordinates: &a[..1], elevations: &[None], distance: 0.0 }], None), "null");
    }
}
