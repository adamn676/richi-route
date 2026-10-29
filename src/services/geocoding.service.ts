import { distanceMeters, type Coord } from '../domain/route-model.ts';
import { ROUTING_BOUNDS } from '../config/map.config.ts';

// What a place is, as its suggestion shows it.
export type PlaceCategory = 'address' | 'street' | 'town' | 'mountain' | 'station' | 'water' | 'place';

export interface Place {
  // The full name a stop takes; a suggestion shows it in two lines, what (title) and where (detail).
  label: string;
  title: string;
  detail?: string;
  category: PlaceCategory;
  coord: Coord;
  // The street of an address (a house, a shop), whose own position lies off the street.
  street?: string;
  components: {
    place?: string;
    region?: string;
    country?: string;
  };
}

const baseUrl = (import.meta.env?.VITE_GEOCODING_URL?.trim() || '/geocoding').replace(/\/+$/, '');

// Where the map looks: searches prefer places near it. The map reports its centre after each move.
let mapCenter: Coord | null = null;
export const setSearchFocus = (center: Coord) => { mapCenter = center; };

// Objects no one plans a ride to: stops and platforms (a station is one place), railway works, shelters, parts of
// buildings, signposts and land registry areas. A building counts only as an address.
const clutter = /^(highway=(bus_stop|platform)|railway=(stop|halt|platform|signal_box|car_shuttle|switch|crossing|level_crossing|subway_entrance|train_station_entrance|buffer_stop)|public_transport=.*|amenity=shelter|building=roof|information=.*|landuse=.*)$/;
const isClutter = (properties: Record<string, unknown>) => clutter.test(`${properties.osm_key}=${properties.osm_value}`) ||
  (properties.osm_key === 'building' && !properties.housenumber) || /^Katastralgemeinde /.test(String(properties.name ?? ''));

// The written-out form of common abbreviations, searched alongside what was typed: Hbf, Str., St., Gr.
export function expandAbbreviations(query: string): string {
  return query
    .replace(/\bhbf\b\.?/gi, 'Hauptbahnhof')
    .replace(/(\p{L})str(\.|\b)/giu, '$1straße')
    .replace(/\bstr(\.|\b)/gi, 'Straße')
    .replace(/\b[Ss]t\.?\s+(?=\p{Lu})/gu, 'Sankt ')
    .replace(/\b[Gg]r\.\s*(?=\p{Lu})/gu, 'Groß ')
    .replace(/\s+/g, ' ').trim();
}
const unavailableMessage = 'Adresssuche nicht erreichbar. Bitte später erneut versuchen oder den Punkt auf der Karte setzen.';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function categoryOf(properties: Record<string, unknown>): PlaceCategory {
  const tag = `${properties.osm_key}=${properties.osm_value}`;
  if (properties.housenumber && !properties.name) return 'address';
  if (properties.type === 'street' || /^highway=|^place=square$/.test(tag)) return 'street';
  if (/^place=(city|town|village|hamlet|suburb|quarter|neighbourhood|locality|isolated_dwelling|municipality|farm)$/.test(tag)) return 'town';
  if (/^(natural=(peak|volcano|ridge|saddle|mountain_range)|mountain_pass=)/.test(tag)) return 'mountain';
  if (/^(railway=station|building=train_station|amenity=bus_station)$/.test(tag)) return 'station';
  if (/^(natural=water|water=|waterway=|natural=(lake|bay))/.test(tag)) return 'water';
  return 'place';
}

function parsePlace(value: unknown): Place {
  const feature = record(value);
  const geometry = record(feature?.geometry);
  const properties = record(feature?.properties);
  const coordinates = geometry?.coordinates;
  if (
    !properties ||
    geometry?.type !== 'Point' ||
    !Array.isArray(coordinates) ||
    typeof coordinates[0] !== 'number' ||
    typeof coordinates[1] !== 'number' ||
    !Number.isFinite(coordinates[0]) ||
    !Number.isFinite(coordinates[1]) ||
    Math.abs(coordinates[0]) > 180 ||
    Math.abs(coordinates[1]) > 90
  ) {
    throw new Error('Der Adressdienst lieferte ungültige Ortsdaten.');
  }

  const name = optionalText(properties.name);
  const street = optionalText(properties.street);
  const house = optionalText(properties.housenumber);
  const city = optionalText(properties.city);
  const postalCode = optionalText(properties.postcode);
  const region = optionalText(properties.state);
  const country = optionalText(properties.country);
  const streetAddress = [street, house].filter(Boolean).join(' ');
  // A postcode without its town (a town's own entry) says nothing on its own.
  const locality = city ? [postalCode, city].filter(Boolean).join(' ') : undefined;
  const label = [name, streetAddress !== name ? streetAddress : undefined, locality, region]
    .filter((part, index, parts) => part && parts.indexOf(part) === index)
    .join(', ');
  if (!label) throw new Error('Der Adressdienst lieferte keine Ortsbezeichnung.');
  const category = categoryOf(properties);
  const title = category === 'address' && !name ? streetAddress : name ?? streetAddress ?? label;
  // Where it is: a town's region (and country abroad); an address's or street's postcode and town; a station's town (its
  // street is often a platform or tunnel); anything else's town first, then its street, so a narrow list still shows the town.
  const detail = category === 'town' ? [region, country !== 'Österreich' ? country : undefined].filter(Boolean).join(', ')
    : category === 'address' || category === 'street' ? locality ?? region
      : category === 'station' ? city ?? region
      : [city ?? region, streetAddress !== title ? streetAddress : undefined].filter(Boolean).join(' · ');

  return {
    label,
    title,
    ...(detail ? { detail } : {}),
    category,
    coord: [coordinates[0], coordinates[1]],
    ...(street && properties.type !== 'street' ? { street } : {}),
    components: { place: city, region, country },
  };
}

async function search(path: string, params: URLSearchParams, signal: AbortSignal): Promise<unknown[]> {
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}?${params}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      referrerPolicy: 'no-referrer',
      credentials: 'omit',
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(error instanceof Error && error.name === 'TimeoutError'
      ? 'Die Adresssuche dauert zu lange. Bitte erneut versuchen.' : unavailableMessage, { cause: error });
  }
  if (response.status === 429) throw new Error('Zu viele Suchanfragen. Bitte kurz warten und erneut suchen.');
  if (!response.ok) throw new Error(unavailableMessage);
  const data: unknown = await response.json();
  const features = record(data)?.features;
  if (!Array.isArray(features)) throw new Error('Der Adressdienst lieferte keine gültige Ergebnisliste.');
  return features;
}

// Text as compared for an exact match: case, ß, umlauts written out, hyphens and dots aside, and the words in any order
// or run together ("Graz Hauptbahnhof", "Hauptbahnhof Graz"; "Stubenbergsee", "Stubenberg See").
const words = (text: string) => text.toLocaleLowerCase('de-AT').replace(/ß/g, 'ss').replace(/ae/g, 'ä').replace(/oe/g, 'ö')
  .replace(/ue/g, 'ü').split(/[\s.\-]+/).filter(Boolean);
const comparable = (text: string) => [words(text).join(''), [...words(text)].sort().join(' ')];

export async function forwardGeocode(query: string, signal: AbortSignal, focus = mapCenter): Promise<Place[]> {
  const typed = query.trim();
  if (typed.length < 3) throw new Error('Bitte mindestens drei Zeichen eingeben.');
  // Nearby places rank higher; 0.5 balances the distance against a place's importance (tests/search-quality.mjs).
  const near: Record<string, string> = focus ? { lat: String(focus[1]), lon: String(focus[0]), location_bias_scale: '0.5' } : {};
  // What was typed and, if it differs, its written-out form; their answers merge in that order.
  const queries = [...new Set([typed, expandAbbreviations(typed)])];
  const bbox = ROUTING_BOUNDS.flat().join(',');
  const answers = await Promise.all(queries.map(q => search('/api/', new URLSearchParams({ q, lang: 'de', limit: '20', bbox, ...near }), signal)));
  const features = answers.flat().filter(feature => !isClutter(record(record(feature)?.properties) ?? {}));
  // A place named exactly as typed (a town, a house number) comes first; otherwise the service's order stands.
  const typedForms = new Set(queries.flatMap(comparable));
  const exact = (feature: unknown) => {
    const properties = record(record(feature)?.properties) ?? {};
    const names = [properties.name, [properties.street, properties.housenumber].filter(Boolean).join(' ')];
    return names.some(name => typeof name === 'string' && name && comparable(name).some(form => typedForms.has(form)));
  };
  // One entry per address: the shops and offices at a house give way to the address itself.
  const address = (feature: unknown) => {
    const properties = record(record(feature)?.properties) ?? {};
    return properties.housenumber ? [properties.street, properties.housenumber, properties.city].join('|') : null;
  };
  const ordered = [...features.filter(exact), ...features.filter(feature => !exact(feature))];
  const unnamed = new Set(ordered.filter(feature => !record(record(feature)?.properties)?.name).map(address));
  const places = ordered.filter((feature, index) => {
    const at = address(feature);
    if (!at) return true;
    if (unnamed.has(at)) return !record(record(feature)?.properties)?.name;
    return ordered.findIndex(other => address(other) === at) === index;
  }).map(parsePlace);
  // One name in one town (a square and its street segments, a place found by both queries) is one place; the first,
  // best match stays. Without a town, only a repeat nearby counts as the same.
  const key = (place: Place) => place.label.replace(/, \d{4,5} /, ', ').toLocaleLowerCase('de-AT');
  const kept: Place[] = [];
  for (const place of places) {
    if (!kept.some(other => key(other) === key(place) && (place.components.place || distanceMeters(other.coord, place.coord) < 200))) kept.push(place);
  }
  return kept.slice(0, 8);
}

// The street at a point set on the map, with the house number only when that house is right there,
// and its town; null when nothing lies within 300 m.
export async function reverseGeocode(coord: Coord, signal: AbortSignal): Promise<string | null> {
  const [feature] = await search('/reverse', new URLSearchParams({
    lat: String(coord[1]),
    lon: String(coord[0]),
    lang: 'de',
    limit: '1',
    radius: '0.3',
  }), signal);
  const properties = record(record(feature)?.properties);
  const found = record(record(feature)?.geometry)?.coordinates;
  if (!properties) return null;
  const near = Array.isArray(found) && typeof found[0] === 'number' && typeof found[1] === 'number' &&
    distanceMeters(coord, [found[0], found[1]]) <= 30;
  const street = optionalText(properties.type === 'street' ? properties.name : properties.street);
  // A town's own entry names the town itself.
  const city = optionalText(properties.city) ?? (street ? undefined : optionalText(properties.name));
  const first = street ? [street, near ? optionalText(properties.housenumber) : undefined].filter(Boolean).join(' ') : optionalText(properties.name);
  // Village addresses repeat the town as the street name ("Mortantsch 21, 8160 Mortantsch").
  const label = [first !== city ? first : undefined, [optionalText(properties.postcode), city].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
  return label || null;
}

// The town at a point, for naming a loop by where it leads.
export async function townAt(coord: Coord, signal: AbortSignal): Promise<string | undefined> {
  const [feature] = await search('/reverse', new URLSearchParams([
    ['lat', String(coord[1])], ['lon', String(coord[0])], ['lang', 'de'], ['limit', '1'], ['radius', '3'],
    ['layer', 'city'], ['layer', 'locality'], ['layer', 'district'],
  ]), signal);
  const properties = record(record(feature)?.properties);
  return optionalText(properties?.city) ?? (properties?.type === 'city' ? optionalText(properties.name) : undefined);
}
