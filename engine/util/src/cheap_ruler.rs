//! Port of `CheapRuler` and `CheapAngleMeter`.

use crate::cheap_ruler_table::SCALE_COS;
use crate::jmath;

/// From integer coordinates to degrees.
pub const ILATLNG_TO_LATLNG: f64 = 1e-6;
pub const KILOMETERS_TO_METERS: i32 = 1000;
pub const DEG_TO_RAD: f64 = std::f64::consts::PI / 180.;

const SCALE_CACHE_LENGTH: usize = 1800;
const SCALE_CACHE_INCREMENT: i32 = 100_000;

/// `[lon->meter, lat->meter]` per 0.1 degree of latitude. The cosines come from Java's `Math.cos` (see
/// `cheap_ruler_table.rs`); the rest is the same IEEE arithmetic as `calcKxKyFromILat`, evaluated at
/// compile time (const float arithmetic is IEEE-exact).
static SCALE_CACHE: [[f64; 2]; SCALE_CACHE_LENGTH] = {
    let mut cache = [[0.0; 2]; SCALE_CACHE_LENGTH];
    let km = KILOMETERS_TO_METERS as f64;
    let mut i = 0;
    while i < SCALE_CACHE_LENGTH {
        let cos = f64::from_bits(SCALE_COS[i]);
        let cos2 = 2. * cos * cos - 1.;
        let cos3 = 2. * cos * cos2 - cos;
        let cos4 = 2. * cos * cos3 - cos2;
        let cos5 = 2. * cos * cos4 - cos3;
        cache[i][0] = (111.41513 * cos - 0.09455 * cos3 + 0.00012 * cos5) * ILATLNG_TO_LATLNG * km;
        cache[i][1] = (111.13209 - 0.56605 * cos2 + 0.0012 * cos4) * ILATLNG_TO_LATLNG * km;
        i += 1;
    }
    cache
};

/// The degree->meter scales `[lon, lat]` for the given integer latitude.
pub fn get_lon_lat_to_meter_scales(ilat: i32) -> [f64; 2] {
    SCALE_CACHE[(ilat / SCALE_CACHE_INCREMENT) as usize]
}

/// Distance in meters between two integer positions (`(lon + 180) * 1e6`, `(lat + 90) * 1e6`).
pub fn distance(ilon1: i32, ilat1: i32, ilon2: i32, ilat2: i32) -> f64 {
    let kxky = get_lon_lat_to_meter_scales(ilat1.wrapping_add(ilat2) >> 1);
    let dlon = f64::from(ilon1.wrapping_sub(ilon2)) * kxky[0];
    let dlat = f64::from(ilat1.wrapping_sub(ilat2)) * kxky[1];
    (dlat * dlat + dlon * dlon).sqrt()
}

/// The position `distance` meters from `(lon1, lat1)` in direction `angle` (degrees from north).
///
/// Not bit-exact with Java: `Math.sin`/`Math.cos` are HotSpot intrinsics, and the platform functions used
/// here differ from them in the last bit for about one input in 500. The result is rounded to integer
/// coordinates, so a difference needs a value within about 1e-8 of a rounding boundary.
pub fn destination(lon1: i32, lat1: i32, distance: f64, angle: f64) -> [i32; 2] {
    let lonlat2m = get_lon_lat_to_meter_scales(lat1);
    let angle = 90. - angle;
    let st = (angle * std::f64::consts::PI / 180.).sin();
    let ct = (angle * std::f64::consts::PI / 180.).cos();
    let lon2 = (0.5 + f64::from(lon1) + ct * distance / lonlat2m[0]) as i32;
    let lat2 = (0.5 + f64::from(lat1) + st * distance / lonlat2m[1]) as i32;
    [lon2, lat2]
}

/// Port of `CheapAngleMeter`: the angle defined by three points, with its cosine on the fly.
#[derive(Clone, Default)]
pub struct CheapAngleMeter {
    cosangle: f64,
}

impl CheapAngleMeter {
    pub fn get_cos_angle(&self) -> f64 {
        self.cosangle
    }

    pub fn calc_angle(&mut self, lon0: i32, lat0: i32, lon1: i32, lat1: i32, lon2: i32, lat2: i32) -> f64 {
        let lonlat2m = get_lon_lat_to_meter_scales(lat1);
        let (lon2m, lat2m) = (lonlat2m[0], lonlat2m[1]);
        let dx10 = f64::from(lon1.wrapping_sub(lon0)) * lon2m;
        let dy10 = f64::from(lat1.wrapping_sub(lat0)) * lat2m;
        let dx21 = f64::from(lon2.wrapping_sub(lon1)) * lon2m;
        let dy21 = f64::from(lat2.wrapping_sub(lat1)) * lat2m;

        let dd = ((dx10 * dx10 + dy10 * dy10) * (dx21 * dx21 + dy21 * dy21)).sqrt();
        if dd == 0. {
            self.cosangle = 1.;
            return 0.;
        }
        let mut sinp = (dy10 * dx21 - dx10 * dy21) / dd;
        let cosp = (dy10 * dy21 + dx10 * dx21) / dd;
        self.cosangle = cosp;

        let mut offset = 0.;
        let mut s2 = sinp * sinp;
        if s2 > 0.5 {
            if sinp > 0. {
                offset = 90.;
                sinp = -cosp;
            } else {
                offset = -90.;
                sinp = cosp;
            }
            s2 = cosp * cosp;
        } else if cosp < 0. {
            sinp = -sinp;
            offset = if sinp > 0. { -180. } else { 180. };
        }
        offset + sinp * (57.4539 + s2 * (9.57565 + s2 * (4.30904 + s2 * 2.56491)))
    }

    pub fn get_angle(lon1: i32, lat1: i32, lon2: i32, lat2: i32) -> f64 {
        let xdiff = f64::from(lat2.wrapping_sub(lat1));
        let ydiff = f64::from(lon2.wrapping_sub(lon1));
        jmath::to_degrees(jmath::atan2(ydiff, xdiff))
    }

    pub fn get_direction(lon1: i32, lat1: i32, lon2: i32, lat2: i32) -> f64 {
        Self::normalize(Self::get_angle(lon1, lat1, lon2, lat2))
    }

    pub fn normalize(a: f64) -> f64 {
        if a >= 360. {
            a - f64::from(360i32.wrapping_mul((a / 360.) as i32))
        } else if a < 0. {
            a - f64::from(360i32.wrapping_mul(((a / 360.) as i32).wrapping_sub(1)))
        } else {
            a
        }
    }

    pub fn get_difference_from_direction(b1: f64, b2: f64) -> f64 {
        let mut r = (b2 - b1) % 360.0;
        if r < -180.0 {
            r += 360.0;
        }
        if r >= 180.0 {
            r -= 360.0;
        }
        r.abs()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distance_matches_java_samples() {
        // Graz to Vienna, about 145 km
        let d = distance(195_430_000, 137_070_000, 196_370_000, 138_210_000);
        assert!((d - 145_000.0).abs() < 2_000.0, "{d}");
        assert_eq!(distance(1, 2, 1, 2), 0.0);
    }

    #[test]
    fn directions() {
        assert_eq!(CheapAngleMeter::get_direction(0, 0, 0, 10), 0.0);
        assert_eq!(CheapAngleMeter::get_direction(0, 0, 10, 0), 90.0);
        assert_eq!(CheapAngleMeter::get_direction(0, 0, -10, 0), 270.0);
        assert_eq!(CheapAngleMeter::normalize(-90.0), 270.0);
        // Java quirk: exact negative multiples of 360 normalize to 360.
        assert_eq!(CheapAngleMeter::normalize(-720.0), 360.0);
        assert_eq!(CheapAngleMeter::get_difference_from_direction(350.0, 10.0), 20.0);
        assert_eq!(CheapAngleMeter::get_difference_from_direction(10.0, 190.0), 180.0);
    }
}
