import { Database } from 'node:sqlite';

export function cyclingPoint(element) {
  const tags = element.tags ?? {}, location = element.center ?? element;
  if (!['node', 'way', 'relation'].includes(element.type) || !Number.isSafeInteger(element.id)
    || !Number.isFinite(location.lon) || !Number.isFinite(location.lat)) return null;
  if (['no', 'private', 'military'].includes(tags.access) || tags.disused === 'yes' || tags.abandoned === 'yes') return null;
  const water = tags.drinking_water === 'yes' || tags.amenity === 'drinking_water' && tags.drinking_water === undefined;
  const kind = water ? 'water' : tags.amenity === 'bicycle_repair_station' ? 'repair' : tags.shop === 'bicycle' ? 'shop'
    : ['station', 'halt'].includes(tags.railway) ? 'station' : null;
  if (!kind) return null;
  const properties = { kind, osmType: element.type, osmId: String(element.id) };
  for (const key of ['name', 'operator', 'opening_hours', 'seasonal', 'access', 'fee', 'description', 'check_date']) {
    if (typeof tags[key] === 'string') properties[key] = tags[key].slice(0, 500);
  }
  return { type: 'Feature', id: `${element.type}/${element.id}`, properties,
    geometry: { type: 'Point', coordinates: [location.lon, location.lat] } };
}

export function openCyclingPoints(file) {
  const db = new Database(file, { readOnly: true });
  const metadata = JSON.parse(db.prepare('SELECT value FROM metadata').get().value);
  const query = db.prepare(`SELECT p.feature FROM positions b JOIN points p ON p.id = b.id
    WHERE b.maxlon >= ? AND b.minlon <= ? AND b.maxlat >= ? AND b.minlat <= ? LIMIT 2001`);
  const within = db.prepare(`SELECT p.feature FROM positions b JOIN points p ON p.id = b.id
    WHERE b.maxlon >= ? AND b.minlon <= ? AND b.maxlat >= ? AND b.minlat <= ?`);
  return {
    close: () => db.close(),
    // Every point in the bounds, for an offline area.
    all: ([west, south, east, north]) => ({ type: 'FeatureCollection', features: within.all(west, east, south, north).map(row => JSON.parse(row.feature)),
      updated: metadata.updated, coverage: metadata.coverage }),
    get(bbox) {
      const values = bbox?.split(',').map(Number);
      if (!values || values.length !== 4 || !values.every(Number.isFinite)) throw new RangeError('Invalid cycling bounds');
      const [west, south, east, north] = values;
      if (west < -180 || east > 180 || south < -90 || north > 90 || east <= west || north <= south
        || (east - west) * (north - south) > 4) throw new RangeError('Cycling bounds too large');
      const rows = query.all(west, east, south, north);
      return { type: 'FeatureCollection', features: rows.slice(0, 2000).map(row => JSON.parse(row.feature)),
        truncated: rows.length > 2000, updated: metadata.updated, coverage: metadata.coverage };
    },
  };
}
