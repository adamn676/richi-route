//! Loop suggestions: round trips from a start for a distance and climbing, and rides out and back where
//! the loops fall short. The numbers follow the planner's TypeScript, where this logic came from, step
//! by step and with JavaScript's operations (`jmath`'s sin, cos, asin and atan2 are V8's), so the
//! suggestions stay those of the TypeScript.

use std::collections::{HashMap, HashSet};

use brouter_util::jmath;

use crate::leg::{Coord, Leg, Span, Surface, ascent, bearing, distance, path_distance};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Target {
    pub meters: f64,
    pub ascent: f64,
}

/// `points` is how many points on its arc BRouter routes a loop through: fewer make it narrower, more
/// rounder. With one point it is a ride out and back, `direction` the bearing and `radius` the distance
/// to where it turns.
#[derive(Clone, Debug)]
pub struct Candidate {
    pub direction: f64,
    pub radius: f64,
    pub points: u32,
    pub leg: Leg,
}

/// The squares of a loop suggested before from the same start, weighted by how recent it is.
#[derive(Clone, Debug, PartialEq)]
pub struct Earlier {
    pub cells: Vec<String>,
    pub weight: f64,
}

/// A route to ask the engine for, from the start: BRouter's round trip through `points` points on an
/// arc of `radius` around the start, centred in `direction`; or there and back.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Trip {
    Round { radius: f64, direction: f64, points: u32 },
    ThereAndBack { turn: Coord },
}

/// `cells` are the squares a loop passes through, for later searches to avoid (`loop_cells`); `back`
/// marks a ride out and back; `along` are the points whose towns name it.
#[derive(Clone, Debug)]
pub struct Suggestion {
    pub leg: Leg,
    pub heading: &'static str,
    pub cells: Vec<String>,
    pub back: bool,
    pub along: Vec<Coord>,
}

/// Why no suggestions came: no loop in any direction, with the first direction's failure, or the
/// caller went away.
#[derive(Debug)]
pub enum Stop<E> {
    Failed(E),
    Aborted,
}

/// Routes in the order asked, each a leg or its failure; or why the search ends.
pub type Routed<E> = Result<Vec<Result<Leg, E>>, Stop<E>>;

/// `Math.min` and `Math.max`: NaN wins.
fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

/// The shapes a direction may get, in arc points.
const SHAPES: [u32; 3] = [5, 4, 6];

/// BRouter builds a loop through points on an arc around the start; with five it comes out about 6.2
/// times the radius.
pub fn first_radius(meters: f64) -> f64 {
    meters / 6.2
}

/// The second try in each direction scales the radius by how far the first missed the distance; the
/// third aims between both tries, as distance grows with the radius but not in proportion.
pub fn corrected_radius(candidate: &Candidate, meters: f64) -> f64 {
    candidate.radius * min(2.0, max(0.5, meters / candidate.leg.distance))
}

pub fn refined_radius(first: &Candidate, second: &Candidate, meters: f64) -> f64 {
    let slope = (second.leg.distance - first.leg.distance) / (second.radius - first.radius);
    if slope.is_nan() || slope <= 0.0 {
        return corrected_radius(second, meters);
    }
    min(second.radius * 2.0, max(second.radius / 2.0, second.radius + (meters - second.leg.distance) / slope))
}

/// A point as JavaScript's `String(coord)` names it: -0 and 0 alike.
fn key(coord: Coord) -> (u64, u64) {
    ((coord[0] + 0.0).to_bits(), (coord[1] + 0.0).to_bits())
}

/// A loop without its dead ends. BRouter snaps each of its circle points to the nearest road, and when
/// that road is a dead end the loop rides in, perhaps round a turning circle, and back out. Whenever the
/// loop returns to a point it passed less than 1 km before, the stretch in between goes; a dead end of
/// any length unwinds point by point, while the road from home that a loop starts and ends on stays.
/// Heights, surfaces, distance and climbing follow.
pub fn without_spurs(leg: Leg) -> Leg {
    let points = &leg.coordinates;
    let (mut kept, mut along, mut position) = (Vec::<usize>::new(), Vec::<f64>::new(), HashMap::new());
    for (i, &point) in points.iter().enumerate() {
        let earlier = position.get(&key(point)).copied();
        let here = kept.last().map_or(0.0, |&last| along[along.len() - 1] + distance(points[last], point));
        // the return home at the very end closes the loop; it is never a dead end
        if let Some(earlier) = earlier
            && i < points.len() - 1
            && here - along[earlier] < 1000.0
        {
            while kept.len() > earlier + 1 {
                let dropped = key(points[kept.pop().unwrap_or_default()]);
                if position.get(&dropped) == Some(&kept.len()) {
                    position.remove(&dropped);
                }
                along.pop();
            }
            continue;
        }
        position.insert(key(point), kept.len());
        kept.push(i);
        along.push(here);
    }
    if kept.len() == points.len() || kept.len() < 2 {
        return leg;
    }
    let coordinates: Vec<Coord> = kept.iter().map(|&i| points[i]).collect();
    let elevations = leg.elevations.as_ref().map(|heights| kept.iter().map(|&i| heights[i]).collect::<Vec<_>>());
    // each kept step is the original step that arrived at its end point
    let mut span_of = vec![None; points.len()];
    for span in &leg.surfaces {
        for step in span_of.iter_mut().take(span.to).skip(span.from) {
            *step = Some(span);
        }
    }
    let mut surfaces: Vec<Span> = Vec::new();
    for j in 0..kept.len() - 1 {
        let Some(span) = span_of[kept[j + 1] - 1] else { continue };
        match surfaces.last_mut() {
            Some(previous) if previous.to == j && previous.kind == span.kind && previous.osm == span.osm => {
                previous.to = j + 1;
            }
            _ => surfaces.push(Span { from: j, to: j + 1, ..span.clone() }),
        }
    }
    let distance = leg.distance * path_distance(&coordinates) / path_distance(&leg.coordinates);
    let ascent = elevations.as_deref().map_or(leg.ascent, |heights| Some(ascent(heights)));
    Leg { coordinates, elevations, distance, ascent, surfaces }
}

/// The share of a loop on roads ridden both ways, out and back.
pub fn twice_share(leg: &Leg) -> f64 {
    let steps: HashSet<_> = leg.coordinates.windows(2).map(|step| (key(step[0]), key(step[1]))).collect();
    let (mut twice, mut total) = (0.0, 0.0);
    for step in leg.coordinates.windows(2) {
        let length = distance(step[0], step[1]);
        total += length;
        if steps.contains(&(key(step[1]), key(step[0]))) {
            twice += length;
        }
    }
    if total != 0.0 { twice / total } else { 0.0 }
}

fn meters_on(leg: &Leg, kinds: &[Surface]) -> f64 {
    leg.surfaces.iter().fold(0.0, |sum, span| {
        if !kinds.contains(&span.kind.surface) {
            return sum;
        }
        let end = (span.to + 1).min(leg.coordinates.len());
        sum + path_distance(&leg.coordinates[span.from.min(end)..end])
    })
}

/// The share of a loop on unpaved roads.
pub fn unpaved_share(leg: &Leg) -> f64 {
    let total = path_distance(&leg.coordinates);
    if total != 0.0 { meters_on(leg, &[Surface::Unpaved]) / total } else { 0.0 }
}

/// A road bike stays on paved roads: a suggestion leaves them for at most 500 m, or 1 % of a long one.
/// Ways of unknown surface count as unpaved here; most are paths and tracks.
pub fn rideable(leg: &Leg) -> bool {
    meters_on(leg, &[Surface::Unpaved, Surface::Unknown]) <= max(500.0, path_distance(&leg.coordinates) * 0.01)
}

fn apart(a: f64, b: f64) -> f64 {
    min((a - b).abs(), 360.0 - (a - b).abs())
}

/// A ride out and back weighs as much as missing the distance by half: worse than a good loop, better
/// than a poor one.
const OUT_AND_BACK: f64 = 1.0;

/// Distance counts most, and a loop more than 15% off only fills in; then climbing. Roads ridden twice
/// make a loop worse, and unpaved roads, which a loop meets where BRouter snaps a circle point to a
/// track, much worse: 10 % of a loop unpaved weighs as much as missing the distance by 15 %. A ride out
/// and back counts as `OUT_AND_BACK`.
pub fn loop_quality(candidate: &Candidate, target: Target) -> f64 {
    let leg = &candidate.leg;
    let distance = (leg.distance - target.meters).abs() / target.meters;
    let shape = if candidate.points == 1 { OUT_AND_BACK } else { 4.0 * twice_share(leg) };
    2.0 * distance
        + if distance > 0.15 { 1.0 } else { 0.0 }
        + (leg.ascent.unwrap_or(0.0) - target.ascent).abs() / max(target.ascent, 200.0)
        + shape
        + 10.0 * unpaved_share(leg)
}

/// Rides out and back are worth trying where the loops found fall short of `count`.
pub fn wants_out_and_back<'a>(
    picks: impl ExactSizeIterator<Item = &'a Candidate>,
    target: Target,
    count: usize,
) -> bool {
    picks.len() < count || picks.into_iter().any(|pick| loop_quality(pick, target) > OUT_AND_BACK)
}

/// Only rideable loops within half the distance. Among those nearly as good as the best and with hardly
/// more unpaved road, those on roads suggested lately (`seen`, from 0 to 1) come last, so the
/// suggestions change from one search to the next; a worse loop never wins by being new, it only fills
/// in. Of these, loops heading at least 60° apart, so the suggestions differ; rides out and back share
/// the valley road with others, so they need only share no more than half the squares of either
/// (`cells`). The picks are indices into `candidates`.
pub fn pick_loops(
    candidates: &[Candidate],
    target: Target,
    count: usize,
    seen: impl Fn(usize) -> f64,
    cells: Option<&[Squares]>,
) -> Vec<usize> {
    let fits: Vec<usize> = (0..candidates.len())
        .filter(|&i| {
            let leg = &candidates[i].leg;
            rideable(leg) && (leg.distance - target.meters).abs() <= target.meters / 2.0
        })
        .collect();
    let quality: HashMap<usize, f64> = fits.iter().map(|&i| (i, loop_quality(&candidates[i], target))).collect();
    let Some(best) = fits.iter().copied().reduce(|a, b| if quality[&b] < quality[&a] { b } else { a }) else {
        return Vec::new();
    };
    let unpaved_at_best = unpaved_share(&candidates[best].leg);
    let score = |i: usize| {
        let own = quality[&i];
        let as_good = own <= quality[&best] + 0.25 && unpaved_share(&candidates[i].leg) <= unpaved_at_best + 0.005;
        if as_good { own + seen(i) } else { 100.0 + own }
    };
    let mut order: Vec<(usize, f64)> = fits.iter().map(|&i| (i, score(i))).collect();
    // stable, as JavaScript's sort
    order.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    let differ = |a: usize, b: usize| match cells {
        Some(cells) if candidates[a].points == 1 || candidates[b].points == 1 => {
            let shared = |x: usize, y: usize| seen_share(&cells[x].list, [(&cells[y].set, 1.0)]);
            max(shared(a, b), shared(b, a)) <= 0.5
        }
        _ => apart(candidates[a].direction, candidates[b].direction) >= 60.0,
    };
    let mut picks = Vec::new();
    for (candidate, _) in order {
        if picks.iter().all(|&pick| differ(candidate, pick)) {
            picks.push(candidate);
        }
        if picks.len() == count {
            break;
        }
    }
    picks
}

/// Where a ride out and back could turn, at most `count`: on each loop's paved way out, and its way home
/// ridden backwards, half the distance from home. Paved ways ending before that, but at least a quarter
/// of it out, turn at their end; they come last, as those rides fall short. Turns within 1 km of another
/// are one.
pub fn turn_points<'a>(legs: impl IntoIterator<Item = &'a Leg>, meters: f64, count: usize) -> Vec<Coord> {
    let (mut halfway, mut ends, half) = (Vec::new(), Vec::new(), meters / 2.0);
    for leg in legs {
        for backwards in [false, true] {
            let (points, along) = paved_way(leg, backwards);
            match along.iter().position(|&along| along >= half) {
                Some(i) if i > 0 => {
                    let share = (half - along[i - 1]) / (along[i] - along[i - 1]);
                    let (a, b) = (points[i - 1], points[i]);
                    halfway.push([a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share]);
                }
                _ if along[along.len() - 1] >= meters / 4.0 => ends.push(points[points.len() - 1]),
                _ => {}
            }
        }
    }
    let mut turns: Vec<Coord> = Vec::new();
    for turn in halfway.into_iter().chain(ends) {
        if turns.iter().all(|&other| distance(other, turn) >= 1000.0) {
            turns.push(turn);
        }
        if turns.len() == count {
            break;
        }
    }
    turns
}

/// The start of a loop, or of its way home ridden backwards, as far as it stays on paved roads: it ends
/// before the first stretch of more than 200 m unpaved or of unknown surface. Its points and the
/// distance to each.
fn paved_way(leg: &Leg, backwards: bool) -> (Vec<Coord>, Vec<f64>) {
    let all = &leg.coordinates;
    let steps = all.len() - 1;
    let mut rough = vec![false; steps];
    for span in &leg.surfaces {
        for step in rough.iter_mut().take(span.to).skip(span.from) {
            *step = matches!(span.kind.surface, Surface::Unpaved | Surface::Unknown);
        }
    }
    let (mut points, mut along) = (vec![if backwards { all[steps] } else { all[0] }], vec![0.0]);
    let (mut off, mut end) = (0.0, 1);
    for j in 0..steps {
        let k = if backwards { steps - 1 - j } else { j };
        let to = all[if backwards { k } else { k + 1 }];
        let step = distance(points[points.len() - 1], to);
        off = if rough[k] { off + step } else { 0.0 };
        if off > 200.0 {
            break;
        }
        points.push(to);
        along.push(along[along.len() - 1] + step);
        if !rough[k] {
            end = points.len();
        }
    }
    points.truncate(end);
    along.truncate(end);
    (points, along)
}

/// The squares a loop passes through: in the order first passed, and as a set.
#[derive(Clone, Debug, Default)]
pub struct Squares {
    pub list: Vec<String>,
    pub set: HashSet<String>,
}

/// The squares of about 250 m a loop passes through, counted every 100 m, leaving out those within
/// `near` metres of the start, which every loop from there shares.
pub fn loop_cells(leg: &Leg, start: Coord, near: f64) -> Squares {
    let size = 250.0;
    let north = size / 111_195.0;
    let east = size / (111_320.0 * jmath::cos(start[1] * std::f64::consts::PI / 180.0));
    let (mut cells, mut known) = (Vec::new(), HashSet::new());
    let mut visit = |point: Coord| {
        if distance(start, point) >= near {
            let cell = format!("{},{}", (point[0] / east).floor() as i64, (point[1] / north).floor() as i64);
            if known.insert(cell.clone()) {
                cells.push(cell);
            }
        }
    };
    for (i, &point) in leg.coordinates.iter().enumerate() {
        if i > 0 {
            let from = leg.coordinates[i - 1];
            let steps = (distance(from, point) / 100.0).floor();
            for k in 1..=steps as u32 {
                let k = f64::from(k);
                visit([
                    from[0] + (point[0] - from[0]) * k / (steps + 1.0),
                    from[1] + (point[1] - from[1]) * k / (steps + 1.0),
                ]);
            }
        }
        visit(point);
    }
    Squares { list: cells, set: known }
}

/// How much of a loop's squares an earlier suggestion already went through, each earlier one weighted
/// by how recent it is: the largest weighted share, from 0 to 1.
pub fn seen_share<'a>(cells: &[String], earlier: impl IntoIterator<Item = (&'a HashSet<String>, f64)>) -> f64 {
    if cells.is_empty() {
        return 0.0;
    }
    earlier.into_iter().fold(0.0, |most, (passed, weight)| {
        let shared = cells.iter().filter(|cell| passed.contains(*cell)).count();
        max(most, weight * shared as f64 / cells.len() as f64)
    })
}

pub fn farthest_point(leg: &Leg, start: Coord) -> Coord {
    leg.coordinates
        .iter()
        .fold(start, |far, &point| if distance(start, point) > distance(start, far) { point } else { far })
}

/// Points spread evenly along a loop, leaving out its start and end.
pub fn points_along(leg: &Leg, count: usize) -> Vec<Coord> {
    let points = &leg.coordinates;
    let mut distances = vec![0.0];
    for i in 1..points.len() {
        distances.push(distances[i - 1] + distance(points[i - 1], points[i]));
    }
    let total = distances[distances.len() - 1];
    let mut i = 0;
    (1..=count)
        .map(|k| {
            while i < points.len() - 1 && distances[i] < total * k as f64 / (count + 1) as f64 {
                i += 1;
            }
            points[i]
        })
        .collect()
}

const COMPASS: [&str; 8] = ["Norden", "Nordosten", "Osten", "Südosten", "Süden", "Südwesten", "Westen", "Nordwesten"];

pub fn compass_name(from: Coord, to: Coord) -> &'static str {
    COMPASS[(jmath::round(bearing(from, to) / 45.0) % 8) as usize]
}

/// One round of routes, each from `tries` (direction, radius, arc points), without dead ends; the
/// first failure is kept. A radius that is no number (after a leg of no length) is not asked for: the
/// engine refused the TypeScript's `roundTripDistance=NaN`, so the direction dropped out.
fn loops<E>(
    route: &mut impl FnMut(&[Trip]) -> Routed<E>,
    tries: &[(f64, f64, u32)],
    failure: &mut Option<E>,
) -> Result<Vec<Candidate>, Stop<E>> {
    let tries: Vec<_> = tries.iter().filter(|(_, radius, _)| radius.is_finite()).collect();
    let trips: Vec<Trip> =
        tries.iter().map(|&&(direction, radius, points)| Trip::Round { radius, direction, points }).collect();
    let legs = route(&trips)?;
    let mut found = Vec::new();
    for (&&(direction, radius, points), leg) in tries.iter().zip(legs) {
        match leg {
            Ok(leg) => found.push(Candidate { direction, radius, points, leg: without_spurs(leg) }),
            Err(e) => {
                failure.get_or_insert(e);
            }
        }
    }
    Ok(found)
}

/// Loops in twelve directions without their dead ends, each tried three times to hit the distance. Each
/// search turns the directions by a random angle and gives each a random shape (`dice`: up to 13 values
/// from 0 to 1, the turn first; missing ones are 0), and roads suggested lately count against a loop, so
/// that asking again brings other loops of the same quality. Where the loops fall short, as in a valley
/// closed by mountains, rides out and back along the paved roads the loops head out on join them. The
/// three that fit best and differ come out. A direction without a loop (no roads, no map data) is left
/// out. `route` answers trips side by side, in order, or ends the search (the caller has gone, an
/// internal error).
pub fn suggest_loops<E>(
    start: Coord,
    target: Target,
    dice: &[f64],
    earlier: &[Earlier],
    mut route: impl FnMut(&[Trip]) -> Routed<E>,
) -> Result<Vec<Suggestion>, Stop<E>> {
    let throw = |i: usize| dice.get(i).copied().unwrap_or(0.0);
    let turn = (throw(0) * 30.0).floor();
    let tries: Vec<_> = (0..12)
        .map(|i| {
            let shape = SHAPES[((throw(i + 1) * 3.0).floor() as usize).min(2)];
            (f64::from(i as u32) * 30.0 + turn, first_radius(target.meters), shape)
        })
        .collect();
    let mut failure = None;
    let first = loops(&mut route, &tries, &mut failure)?;
    // without a single loop the engine itself failed; its message says why
    if first.is_empty() {
        return Err(Stop::Failed(failure.expect("twelve failed directions")));
    }
    let tries: Vec<_> = first.iter().map(|c| (c.direction, corrected_radius(c, target.meters), c.points)).collect();
    let second = loops(&mut route, &tries, &mut failure)?;
    let tries: Vec<_> = second
        .iter()
        .map(|c| {
            let before = first.iter().find(|before| before.direction == c.direction).unwrap_or(c);
            (c.direction, refined_radius(before, c, target.meters), c.points)
        })
        .collect();
    let third = loops(&mut route, &tries, &mut failure)?;

    // the roads near home are every loop's; only those beyond tell loops apart
    let mut candidates: Vec<Candidate> = first.into_iter().chain(second).chain(third).collect();
    let near = min(3000.0, target.meters * 0.08);
    let mut cells: Vec<Squares> = candidates.iter().map(|c| loop_cells(&c.leg, start, near)).collect();
    let recent: Vec<(HashSet<String>, f64)> =
        earlier.iter().map(|e| (e.cells.iter().cloned().collect(), e.weight)).collect();
    let pick = |candidates: &[Candidate], cells: &[Squares]| {
        let seen = |i: usize| seen_share(&cells[i].list, recent.iter().map(|(set, weight)| (set, *weight)));
        pick_loops(candidates, target, 3, seen, Some(cells))
    };
    let mut picks = pick(&candidates, &cells);
    if wants_out_and_back(picks.iter().map(|&i| &candidates[i]), target, 3) {
        let turns = turn_points(candidates.iter().map(|c| &c.leg), target.meters, 24);
        let trips: Vec<Trip> = turns.iter().map(|&turn| Trip::ThereAndBack { turn }).collect();
        for (turn, leg) in turns.into_iter().zip(route(&trips)?) {
            if let Ok(leg) = leg {
                cells.push(loop_cells(&leg, start, near));
                candidates.push(Candidate {
                    direction: bearing(start, turn),
                    radius: distance(start, turn),
                    points: 1,
                    leg,
                });
            }
        }
        picks = pick(&candidates, &cells);
    }
    // a ride out and back turns halfway; in a winding valley that may lie nearer home than other points
    Ok(picks
        .into_iter()
        .map(|i| {
            let Candidate { points, ref leg, .. } = candidates[i];
            let far = if points == 1 { points_along(leg, 1)[0] } else { farthest_point(leg, start) };
            Suggestion {
                heading: compass_name(start, far),
                along: if points == 1 { vec![far] } else { points_along(leg, 8) },
                cells: cells[i].list.clone(),
                back: points == 1,
                leg: leg.clone(),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::leg::Kind;

    const START: Coord = [15.44, 47.07];
    const RAD: f64 = std::f64::consts::PI / 180.0;

    fn span(from: usize, to: usize, surface: Surface, tag: Option<&str>) -> Span {
        Span { from, to, kind: Kind { surface, tag: tag.map(str::to_string) }, osm: None }
    }

    fn line(coordinates: Vec<Coord>, surfaces: Vec<Span>, ascent: f64) -> Leg {
        Leg { distance: path_distance(&coordinates), coordinates, elevations: None, ascent: Some(ascent), surfaces }
    }

    /// A loop around a circle in the given direction, about 6.2 times the radius long, climbing more
    /// towards the north.
    fn circle(radius: f64, direction: f64, steps: usize, ascent: Option<f64>) -> Leg {
        let (kx, ky) = (111_320.0 * (START[1] * RAD).cos(), 110_540.0);
        let centre =
            [START[0] + (direction * RAD).sin() * radius / kx, START[1] + (direction * RAD).cos() * radius / ky];
        let turn = |i: usize| i as f64 / steps as f64 * 2.0 * std::f64::consts::PI;
        let coordinates: Vec<Coord> = (0..=steps)
            .map(|i| {
                let a = (direction + 180.0) * RAD + turn(i);
                if i == 0 || i == steps {
                    START
                } else {
                    [centre[0] + a.sin() * radius / kx, centre[1] + a.cos() * radius / ky]
                }
            })
            .collect();
        let climb = ascent.unwrap_or_else(|| (radius / 10.0 * (1.0 + (direction * RAD).cos())).round());
        let elevations = (0..=steps).map(|i| 300.0 + climb / 2.0 * (1.0 - turn(i).cos())).collect();
        Leg {
            elevations: Some(elevations),
            ascent: Some(climb),
            surfaces: vec![span(0, steps, Surface::Paved, Some("asphalt"))],
            ..line(coordinates, Vec::new(), 0.0)
        }
    }

    fn candidate(direction: f64, leg: Leg) -> Candidate {
        Candidate { direction, radius: 1000.0, points: 5, leg }
    }

    fn with_distance(distance: f64) -> Candidate {
        candidate(0.0, Leg { distance, ..circle(1000.0, 0.0, 20, None) })
    }

    /// Answers each round trip with `round` and each ride there and back with `back`, counting the trips.
    fn routing<'a>(
        trips: &'a mut Vec<Trip>,
        round: impl Fn(f64, f64, u32) -> Result<Leg, String> + 'a,
        back: impl Fn(Coord) -> Result<Leg, String> + 'a,
    ) -> impl FnMut(&[Trip]) -> Routed<String> + 'a {
        move |asked| {
            trips.extend_from_slice(asked);
            Ok(asked
                .iter()
                .map(|trip| match *trip {
                    Trip::Round { radius, direction, points } => round(radius, direction, points),
                    Trip::ThereAndBack { turn } => back(turn),
                })
                .collect())
        }
    }

    fn suggest(
        target: Target,
        dice: &[f64],
        earlier: &[Earlier],
        route: impl FnMut(&[Trip]) -> Routed<String>,
    ) -> Result<Vec<Suggestion>, Stop<String>> {
        suggest_loops(START, target, dice, earlier, route)
    }

    const TARGET_40: Target = Target { meters: 40_000.0, ascent: 800.0 };

    #[test]
    fn radius_guesses_home_in_on_the_distance() {
        assert!((first_radius(62_000.0) - 10_000.0).abs() < 1.0);
        let at = |radius: f64, km: f64| Candidate { radius: radius * 1000.0, ..with_distance(km * 1000.0) };
        assert_eq!(corrected_radius(&at(8.0, 40.0), 50_000.0), 10_000.0);
        assert_eq!(corrected_radius(&at(8.0, 1.0), 50_000.0), 16_000.0, "at most double");
        // 8 km gave 40 km and 10 km gave 46 km: 3 km per km of radius, so 50 km needs about 11.3 km
        assert!((refined_radius(&at(8.0, 40.0), &at(10.0, 46.0), 50_000.0) - 11_333.0).abs() < 1.0);
    }

    #[test]
    fn roads_ridden_both_ways_count_against_a_loop() {
        let out: Vec<Coord> = (0..=10).map(|i| [15.0 + f64::from(i) / 1000.0, 47.0]).collect();
        let back = out.iter().rev().skip(1).copied();
        assert_eq!(twice_share(&line(out.iter().copied().chain(back).collect(), Vec::new(), 0.0)), 1.0, "out and back");
        assert_eq!(twice_share(&circle(5000.0, 0.0, 200, None)), 0.0);
    }

    #[test]
    fn picks_fit_distance_first_then_climbing_and_head_apart() {
        let target = Target { meters: 50_000.0, ascent: 500.0 };
        let fixed = |direction: f64, km: f64, ascent: f64| {
            let leg = Leg {
                distance: km * 1000.0,
                ascent: Some(ascent),
                surfaces: Vec::new(),
                ..circle(1000.0, 0.0, 200, None)
            };
            candidate(direction, leg)
        };
        let candidates = [
            fixed(0.0, 50.0, 500.0),
            fixed(30.0, 50.0, 510.0),
            fixed(90.0, 49.0, 450.0),
            fixed(180.0, 70.0, 500.0),
            fixed(270.0, 52.0, 900.0),
            fixed(300.0, 40.0, 500.0),
        ];
        let directions = |c: &[Candidate], count| {
            pick_loops(c, target, count, |_| 0.0, None).iter().map(|&i| c[i].direction).collect::<Vec<_>>()
        };
        // 30° is too close to 0°; 70 km and 40 km miss by more than 15%
        assert_eq!(directions(&candidates, 3), [0.0, 90.0, 270.0]);
        let short = [fixed(0.0, 40.0, 500.0), fixed(180.0, 24.0, 500.0)];
        assert_eq!(directions(&short, 3), [0.0], "never a loop missing the distance by more than half");
    }

    #[test]
    fn unpaved_roads_count_heavily_against_a_loop() {
        let target = Target { meters: 30_000.0, ascent: 500.0 };
        let paved = circle(30_000.0 / 6.2, 0.0, 200, Some(400.0));
        // a better fit on distance and climbing, but with a tenth of it on a forest track
        let surfaces = vec![span(0, 180, Surface::Paved, None), span(180, 200, Surface::Unpaved, Some("ground"))];
        let dirt = Leg { surfaces, ..circle(30_000.0 / 6.2, 120.0, 200, Some(500.0)) };
        assert!((unpaved_share(&dirt) - 0.1).abs() < 0.01, "{}", unpaved_share(&dirt));
        assert_eq!(unpaved_share(&paved), 0.0);
        let both = [candidate(120.0, dirt.clone()), candidate(0.0, paved)];
        assert_eq!(pick_loops(&both, target, 1, |_| 0.0, None), [1]);
        assert!(pick_loops(&both[..1], target, 3, |_| 0.0, None).is_empty(), "never 3 km unpaved, not even to fill in");
    }

    #[test]
    fn a_suggestion_leaves_paved_roads_for_at_most_500_m_or_one_percent() {
        let leg = |km: f64, surface, steps: usize| Leg {
            surfaces: vec![span(0, 200 - steps, Surface::Paved, None), span(200 - steps, 200, surface, None)],
            ..circle(km * 1000.0 / 6.2, 0.0, 200, None)
        };
        assert!(rideable(&leg(30.0, Surface::Unpaved, 3)), "450 m");
        assert!(!rideable(&leg(30.0, Surface::Unknown, 4)), "600 m of path");
        assert!(rideable(&leg(200.0, Surface::Unpaved, 1)), "1 km of 200 km");
        assert!(!rideable(&leg(200.0, Surface::Unpaved, 3)));
    }

    /// `km` east and `north` km north of the start.
    fn east(km: f64, north: f64) -> Coord {
        [START[0] + km * 1000.0 / (111_320.0 * (START[1] * RAD).cos()), START[1] + north * 1000.0 / 110_540.0]
    }

    /// A valley closed by mountains: the loop heads out east on a paved road for 30 km, then climbs north
    /// over gravel and comes home down another gravel track.
    fn valley_loop() -> Leg {
        let mut points: Vec<Coord> = (0..=30).map(|km| east(f64::from(km), 0.0)).collect();
        points.extend([east(30.0, 5.0), east(5.0, 5.0), east(0.0, 1.0), START]);
        line(points, vec![span(0, 30, Surface::Paved, None), span(30, 34, Surface::Unpaved, None)], 2400.0)
    }

    #[test]
    fn turn_points_lie_half_the_distance_out_along_the_paved_way_or_at_its_end() {
        let turns = turn_points(&[valley_loop(), valley_loop()], 40_000.0, 24);
        assert_eq!(turns.len(), 1, "the same road gives one turn");
        assert!(distance(turns[0], east(20.0, 0.0)) < 50.0, "{turns:?}");
        let end = turn_points(&[valley_loop()], 100_000.0, 24)[0];
        assert!(distance(end, east(30.0, 0.0)) < 1.0, "a paved way shorter than half the distance turns at its end");
        assert!(turn_points(&[valley_loop()], 130_000.0, 24).is_empty(), "less than a quarter out is no turn");
        let fan: Vec<Leg> = (0..30)
            .map(|i| {
                let points = (0..=30).map(|km| east(f64::from(km), f64::from(i) * 2.0)).collect();
                line(points, vec![span(0, 30, Surface::Paved, None)], 0.0)
            })
            .collect();
        assert_eq!(turn_points(&fan, 40_000.0, 24).len(), 24, "at most 24");
    }

    #[test]
    fn where_no_loop_stays_paved_a_ride_out_and_back_along_the_valley_road() {
        let there_and_back = |turn: Coord| {
            let out: Vec<Coord> = (0..=20)
                .map(|i| {
                    let i = f64::from(i);
                    [START[0] + (turn[0] - START[0]) * i / 20.0, START[1] + (turn[1] - START[1]) * i / 20.0]
                })
                .collect();
            let points = out.iter().chain(out.iter().rev().skip(1)).copied().collect();
            Ok(line(points, vec![span(0, 40, Surface::Paved, None)], 700.0))
        };
        let mut trips = Vec::new();
        let route = routing(&mut trips, |_, _, _| Ok(valley_loop()), there_and_back);
        let loops = suggest(TARGET_40, &[], &[], route).unwrap();
        assert_eq!(trips.iter().filter(|trip| matches!(trip, Trip::ThereAndBack { .. })).count(), 1);
        assert_eq!(loops.len(), 1, "no gravel loop fills in");
        assert!(loops[0].back && (loops[0].leg.distance - 40_000.0).abs() < 100.0);
        assert_eq!(loops[0].along.len(), 1, "named by where it turns");
        assert!(distance(loops[0].along[0], east(20.0, 0.0)) < 2000.0);
    }

    #[test]
    fn points_along_a_loop_and_compass_names() {
        let points = points_along(&circle(5000.0, 90.0, 400, None), 8);
        assert_eq!(points.len(), 8);
        assert!(points.iter().all(|&point| distance(point, START) > 100.0));
        assert_eq!(compass_name(START, [15.44, 47.2]), "Norden");
        assert_eq!(compass_name(START, [15.6, 47.07]), "Osten");
        assert_eq!(compass_name(START, [15.3, 46.95]), "Südwesten");
    }

    #[test]
    fn suggestions_take_three_passes_and_leave_out_failed_directions() {
        let mut trips = Vec::new();
        let round = |radius, direction, _| {
            if direction == 150.0 {
                Err("no track found".to_string())
            } else {
                Ok(circle(radius, direction, 200, None))
            }
        };
        let route = routing(&mut trips, round, |_| panic!("good loops need no ride out and back"));
        let loops = suggest(TARGET_40, &[], &[], route).unwrap();
        assert_eq!(trips.len(), 12 + 11 + 11, "the direction without a loop is not tried again");
        assert_eq!(loops.len(), 3);
        assert!(loops.iter().all(|l| (l.leg.distance - 40_000.0).abs() < 4000.0 && !l.back && l.along.len() == 8));
        let misses: Vec<f64> = loops.iter().map(|l| (l.leg.ascent.unwrap_or_default() - 800.0).abs()).collect();
        assert_eq!(
            misses[0],
            misses.iter().copied().fold(f64::INFINITY, f64::min),
            "with distances alike, the closest climbing first"
        );
    }

    #[test]
    fn each_search_turns_the_directions_by_chance_and_gives_each_a_shape_it_keeps() {
        let dice: Vec<f64> = std::iter::once(0.5).chain((0..12).map(|i| f64::from(i % 3) / 3.0 + 0.1)).collect();
        let mut trips = Vec::new();
        let route =
            routing(&mut trips, |radius, direction, _| Ok(circle(radius, direction, 200, None)), |_| unreachable!());
        let loops = suggest(TARGET_40, &dice, &[], route).unwrap();
        assert!(loops.iter().all(|l| !l.cells.is_empty() && !l.back));
        let shapes: Vec<(f64, u32)> = trips
            .iter()
            .map(|trip| match *trip {
                Trip::Round { direction, points, .. } => (direction, points),
                Trip::ThereAndBack { .. } => unreachable!(),
            })
            .collect();
        let first: Vec<f64> = shapes[..12].iter().map(|&(direction, _)| direction).collect();
        assert_eq!(first, (0..12).map(|i| 15.0 + f64::from(i) * 30.0).collect::<Vec<_>>());
        assert_eq!(shapes[..3].iter().map(|&(_, points)| points).collect::<Vec<_>>(), [5, 4, 6]);
        // each direction keeps its shape while its distance is tried again
        assert!(shapes.iter().all(|&(direction, points)| shapes[..12].contains(&(direction, points))));
    }

    #[test]
    fn roads_suggested_lately_count_against_a_loop_so_asking_again_brings_others() {
        let ask = |earlier: &[Earlier]| {
            let mut trips = Vec::new();
            let route = routing(
                &mut trips,
                |radius, direction, _| Ok(circle(radius, direction, 200, None)),
                |_| unreachable!(),
            );
            suggest(TARGET_40, &[], earlier, route).unwrap()
        };
        let first = ask(&[]);
        let shown: Vec<Earlier> = first.iter().map(|l| Earlier { cells: l.cells.clone(), weight: 1.0 }).collect();
        let again = ask(&shown);
        // each new loop shares less than half its roads beyond home with any loop shown before
        let sets: Vec<HashSet<String>> = shown.iter().map(|e| e.cells.iter().cloned().collect()).collect();
        for suggestion in &again {
            let shared = seen_share(&suggestion.cells, sets.iter().map(|set| (set, 1.0)));
            assert!(shared < 0.5, "{shared}");
            assert!((suggestion.leg.distance - 40_000.0).abs() < 6000.0, "still about the distance");
        }
    }

    #[test]
    fn the_squares_a_loop_passes_leave_out_those_near_home_and_older_ones_weigh_less() {
        let leg = circle(5000.0, 0.0, 200, None);
        let (near, far) = (loop_cells(&leg, START, 0.0), loop_cells(&leg, START, 3000.0));
        assert!(near.list.len() > far.list.len() && far.list.len() > 50);
        assert_eq!(far.set.len(), far.list.len());
        let far_cells = &far.list;
        assert_eq!(seen_share(far_cells, [(&far.set, 1.0)]), 1.0);
        assert_eq!(seen_share(far_cells, [(&far.set, 0.5)]), 0.5);
        let half: HashSet<String> = far_cells[..far_cells.len() / 2].iter().cloned().collect();
        let share = half.len() as f64 / far_cells.len() as f64;
        assert_eq!(seen_share(far_cells, [(&half, 1.0), (&HashSet::new(), 1.0)]), share);
        assert_eq!(seen_share(far_cells, []), 0.0);
    }

    #[test]
    fn an_engine_failing_everywhere_reports_the_first_direction_and_a_client_gone_stops() {
        let mut trips = Vec::new();
        let route = routing(&mut trips, |_, direction, _| Err(format!("no track at {direction}")), |_| unreachable!());
        assert!(matches!(suggest(TARGET_40, &[], &[], route), Err(Stop::Failed(e)) if e == "no track at 0"));
        let mut asked = 0;
        let gone = |_: &[Trip]| {
            asked += 1;
            Err(Stop::Aborted)
        };
        assert!(matches!(suggest(TARGET_40, &[], &[], gone), Err(Stop::Aborted)));
        assert_eq!(asked, 1);
    }

    #[test]
    fn a_radius_that_is_no_number_is_not_asked_for() {
        // a loop of no length makes the next radius NaN: the TypeScript asked for roundTripDistance=NaN,
        // which the engine refused, so that direction dropped out
        let mut trips = Vec::new();
        let round = |radius, direction, _| {
            let leg = circle(radius, direction, 200, None);
            Ok(if direction == 60.0 { Leg { distance: f64::NAN, ..leg } } else { leg })
        };
        let loops = suggest(TARGET_40, &[], &[], routing(&mut trips, round, |_| unreachable!())).unwrap();
        assert_eq!(trips.len(), 12 + 11 + 11);
        assert!(trips.iter().all(|trip| matches!(trip, Trip::Round { radius, .. } if radius.is_finite())));
        assert!(!trips[12..].iter().any(|trip| matches!(trip, Trip::Round { direction, .. } if *direction == 60.0)));
        assert_eq!(loops.len(), 3);
    }

    #[test]
    fn dead_ends_leave_a_loop_with_or_without_a_turning_circle_and_the_road_home_stays() {
        let at = |x: f64, y: f64| [15.0 + x / 10_000.0, 47.0 + y / 10_000.0];
        // home H on a stub to junction J, round a square, with a straight dead end at A and one ending in a
        // turning circle at B
        let path: Vec<Coord> = [
            (0, 0),
            (0, 5),
            (0, 10),
            (3, 10),
            (6, 10),
            (6, 14),
            (6, 18),
            (6, 14),
            (6, 10),
            (10, 10),
            (10, 4),
            (13, 4),
            (14, 5),
            (13, 6),
            (13, 4),
            (10, 4),
            (10, 0),
            (10, -2),
            (5, -2),
            (0, -2),
            (0, 0),
        ]
        .iter()
        .map(|&(x, y)| at(f64::from(x), f64::from(y)))
        .collect();
        // steps 4 to 7 ride into dead end A and back out on gravel
        let surfaces = vec![
            span(0, 4, Surface::Paved, Some("asphalt")),
            span(4, 8, Surface::Unpaved, Some("gravel")),
            span(8, 20, Surface::Paved, Some("asphalt")),
        ];
        let elevations = Some((0..path.len()).map(|i| 300.0 + i as f64).collect());
        let leg = Leg { elevations, distance: 5000.0, ..line(path, surfaces, 20.0) };
        let clean = without_spurs(leg.clone());
        let expected: Vec<Coord> =
            [(0, 0), (0, 5), (0, 10), (3, 10), (6, 10), (10, 10), (10, 4), (10, 0), (10, -2), (5, -2), (0, -2), (0, 0)]
                .iter()
                .map(|&(x, y)| at(f64::from(x), f64::from(y)))
                .collect();
        assert_eq!(clean.coordinates, expected);
        let heights = [300, 301, 302, 303, 304, 309, 310, 316, 317, 318, 319, 320].map(f64::from);
        assert_eq!(clean.elevations.as_deref(), Some(&heights[..]), "heights stay with their points");
        assert_eq!(clean.surfaces, [span(0, 11, Surface::Paved, Some("asphalt"))], "the gravel dead end is gone");
        assert!(clean.distance < leg.distance);
        assert_eq!(twice_share(&clean), 0.0);
        let lollipop: Vec<Coord> = [(0, 0), (0, 5), (0, 10), (40, 10), (40, 60), (0, 60), (0, 10), (0, 5), (0, 0)]
            .iter()
            .map(|&(x, y)| at(f64::from(x), f64::from(y)))
            .collect();
        let lollipop = line(lollipop, Vec::new(), 0.0);
        assert_eq!(without_spurs(lollipop.clone()), lollipop, "the road home is ridden twice, but not as a dead end");
    }
}
