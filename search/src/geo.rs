//! Positions: the BEV's Gauss-Krüger coordinates as WGS84, distances, and a grid to find what lies near a point.

/// Bessel 1841, the ellipsoid of Austria's MGI datum.
const BESSEL_A: f64 = 6_377_397.155;
const BESSEL_F: f64 = 1.0 / 299.152_812_8;
const WGS84_A: f64 = 6_378_137.0;
const WGS84_F: f64 = 1.0 / 298.257_223_563;

/// A point given as WGS84 longitude and latitude in degrees.
pub type Point = (f64, f64);

/// The BEV's `RW`/`HW` in one of the three Austrian Gauss-Krüger zones (EPSG 31254, 31255, 31256) as WGS84, by an
/// inverse transverse Mercator on Bessel and the MGI to WGS84 Helmert transformation (EPSG 1618), to about a metre.
pub fn gauss_krueger_to_wgs84(rw: f64, hw: f64, epsg: u32) -> Option<Point> {
    let central: f64 = match epsg {
        31254 => 10.0,
        31255 => 13.0,
        31256 => 16.0,
        _ => return None,
    } + 1.0 / 3.0;
    let n = BESSEL_F / (2.0 - BESSEL_F);
    let radius = BESSEL_A / (1.0 + n) * (1.0 + n * n / 4.0 + n.powi(4) / 64.0);
    let (xi, eta) = ((hw + 5_000_000.0) / radius, rw / radius);
    let beta = [
        n / 2.0 - 2.0 * n * n / 3.0 + 37.0 * n.powi(3) / 96.0,
        n * n / 48.0 + n.powi(3) / 15.0,
        17.0 * n.powi(3) / 480.0,
    ];
    let (mut xi_, mut eta_) = (xi, eta);
    for (j, b) in beta.iter().enumerate() {
        let k = 2.0 * (j + 1) as f64;
        xi_ -= b * (k * xi).sin() * (k * eta).cosh();
        eta_ -= b * (k * xi).cos() * (k * eta).sinh();
    }
    let chi = (xi_.sin() / eta_.cosh()).asin();
    let delta = [
        2.0 * n - 2.0 * n * n / 3.0 - 2.0 * n.powi(3),
        7.0 * n * n / 3.0 - 8.0 * n.powi(3) / 5.0,
        56.0 * n.powi(3) / 15.0,
    ];
    let lat = chi + delta.iter().enumerate().map(|(j, d)| d * (2.0 * (j + 1) as f64 * chi).sin()).sum::<f64>();
    let lon = central.to_radians() + eta_.sinh().atan2(xi_.cos());

    let e2 = BESSEL_F * (2.0 - BESSEL_F);
    let normal = BESSEL_A / (1.0 - e2 * lat.sin().powi(2)).sqrt();
    let (x, y, z) = (normal * lat.cos() * lon.cos(), normal * lat.cos() * lon.sin(), normal * (1.0 - e2) * lat.sin());
    let scale = 1.0 + 2.4232e-6;
    let arc = (1.0f64 / 3600.0).to_radians();
    let (rx, ry, rz) = (5.137 * arc, 1.474 * arc, 5.297 * arc);
    let x2 = 577.326 + scale * (x - rz * y + ry * z);
    let y2 = 90.129 + scale * (rz * x + y - rx * z);
    let z2 = 463.919 + scale * (-ry * x + rx * y + z);

    let e2 = WGS84_F * (2.0 - WGS84_F);
    let p = x2.hypot(y2);
    let mut lat = z2.atan2(p * (1.0 - e2));
    for _ in 0..5 {
        let normal = WGS84_A / (1.0 - e2 * lat.sin().powi(2)).sqrt();
        lat = (z2 + e2 * normal * lat.sin()).atan2(p);
    }
    Some((y2.atan2(x2).to_degrees(), lat.to_degrees()))
}

/// Whether `p` lies in `bbox` (west, south, east, north).
pub fn in_bbox(p: Point, [west, south, east, north]: [f64; 4]) -> bool {
    (west..=east).contains(&p.0) && (south..=north).contains(&p.1)
}

/// The mean of points, `None` for none.
pub fn mean(points: impl Iterator<Item = Point>) -> Option<Point> {
    let (mut sum, mut n) = ((0.0, 0.0), 0.0);
    for p in points {
        sum = (sum.0 + p.0, sum.1 + p.1);
        n += 1.0;
    }
    (n > 0.0).then(|| (sum.0 / n, sum.1 / n))
}

/// Distance in kilometres along the earth's surface.
pub fn distance_km(a: Point, b: Point) -> f64 {
    let (lat1, lat2) = (a.1.to_radians(), b.1.to_radians());
    let (dlat, dlon) = (lat2 - lat1, (b.0 - a.0).to_radians());
    let h = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    12_742.0 * h.sqrt().asin()
}

/// Distance in kilometres from `p` to the segment `a`–`b`, on a plane around `p` (exact enough within a few km).
pub fn distance_to_segment_km(p: Point, a: Point, b: Point) -> f64 {
    let kx = 111.32 * p.1.to_radians().cos();
    let (ax, ay, bx, by) = ((a.0 - p.0) * kx, (a.1 - p.1) * 111.32, (b.0 - p.0) * kx, (b.1 - p.1) * 111.32);
    let (dx, dy) = (bx - ax, by - ay);
    let length = dx * dx + dy * dy;
    let t = if length == 0.0 { 0.0 } else { (-(ax * dx + ay * dy) / length).clamp(0.0, 1.0) };
    (ax + t * dx).hypot(ay + t * dy)
}

/// Cells of about a kilometre, each listing the items that touch it.
#[derive(Default)]
pub struct Grid {
    /// Cell keys in order, each with the end of its items in `items`.
    pub cells: Vec<(u64, u32)>,
    pub items: Vec<u32>,
}

const CELL_DEGREES: f64 = 0.01;

fn cell(lon: f64, lat: f64) -> (i32, i32) {
    ((lon / (CELL_DEGREES * 1.5)).floor() as i32, (lat / CELL_DEGREES).floor() as i32)
}

fn key((x, y): (i32, i32)) -> u64 {
    (u64::from(x as u32) << 32) | u64::from(y as u32)
}

impl Grid {
    /// A grid of items, each touching the cells of its bounding box (`west`, `south`, `east`, `north`).
    pub fn new(boxes: impl Iterator<Item = (u32, [f64; 4])>) -> Grid {
        let mut entries = Vec::new();
        for (item, [west, south, east, north]) in boxes {
            let ((x0, y0), (x1, y1)) = (cell(west, south), cell(east, north));
            for x in x0..=x1.min(x0 + 50) {
                for y in y0..=y1.min(y0 + 50) {
                    entries.push((key((x, y)), item));
                }
            }
        }
        entries.sort_unstable();
        entries.dedup();
        let mut grid = Grid { cells: Vec::new(), items: Vec::with_capacity(entries.len()) };
        for (cell, item) in entries {
            if grid.cells.last().is_some_and(|&(last, _)| last == cell) {
                grid.cells.last_mut().unwrap().1 += 1;
            } else {
                grid.cells.push((cell, grid.items.len() as u32 + 1));
            }
            grid.items.push(item);
        }
        grid
    }

    fn cell_items(&self, at: (i32, i32)) -> &[u32] {
        let wanted = key(at);
        match self.cells.binary_search_by_key(&wanted, |&(k, _)| k) {
            Ok(i) => {
                let start = if i == 0 { 0 } else { self.cells[i - 1].1 as usize };
                &self.items[start..self.cells[i].1 as usize]
            }
            Err(_) => &[],
        }
    }

    /// A grid of points.
    pub fn points(points: impl Iterator<Item = (u32, Point)>) -> Grid {
        Grid::new(points.map(|(item, p)| (item, [p.0, p.1, p.0, p.1])))
    }

    /// The item nearest to `p` within `max_km` by `distance`, looking at rings of cells outwards.
    pub fn nearest(&self, p: Point, max_km: f64, mut distance: impl FnMut(u32) -> f64) -> Option<(u32, f64)> {
        let centre = cell(p.0, p.1);
        let mut best: Option<(u32, f64)> = None;
        // the narrower side of a cell here (its width shrinks northwards)
        let cell_km =
            (CELL_DEGREES * 111.0).min(CELL_DEGREES * 1.5 * 111.32 * (p.1.abs() + 0.5).min(89.0).to_radians().cos());
        let rings = (max_km / cell_km).ceil() as i32 + 1;
        for ring in 0..=rings {
            // a cell `ring` steps away is at least (ring - 1) cells away
            if best.is_some_and(|(_, d)| d < (ring - 1).max(0) as f64 * cell_km) {
                break;
            }
            for x in centre.0 - ring..=centre.0 + ring {
                for y in centre.1 - ring..=centre.1 + ring {
                    if (x - centre.0).abs() != ring && (y - centre.1).abs() != ring {
                        continue;
                    }
                    for &item in self.cell_items((x, y)) {
                        let d = distance(item);
                        if d <= max_km && best.is_none_or(|(_, b)| d < b) {
                            best = Some((item, d));
                        }
                    }
                }
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_gauss_krueger() {
        // Herrengasse 5, Graz, in the BEV register; the OpenStreetMap building lies 9 m away
        let (lon, lat) = gauss_krueger_to_wgs84(-67_814.24, 214_994.63, 31256).unwrap();
        assert!(distance_km((lon, lat), (15.43933, 47.07064)) < 0.03, "{lon} {lat}");
    }

    #[test]
    fn finds_the_nearest() {
        let points = [(15.44, 47.07), (15.70, 47.10), (15.45, 47.08)];
        let grid = Grid::points(points.iter().enumerate().map(|(i, &p)| (i as u32, p)));
        let near = |p| grid.nearest(p, 5.0, |i| distance_km(p, points[i as usize]));
        assert_eq!(near((15.449, 47.079)).map(|(i, _)| i), Some(2));
        assert_eq!(near((15.69, 47.1)).map(|(i, _)| i), Some(1));
        assert_eq!(near((16.5, 47.1)), None);
    }
}
