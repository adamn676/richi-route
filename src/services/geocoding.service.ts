import { distanceMeters, type Coord } from '../domain/route-model.ts';

export interface Place {
  label: string;
  coord: Coord;
  kind: string;
  // The street of an address (a house, a shop), whose own position lies off the street.
  street?: string;
  components: {
    place?: string;
    region?: string;
    country?: string;
  };
}

const baseUrl = (import.meta.env?.VITE_GEOCODING_URL?.trim() || '/geocoding').replace(/\/+$/, '');
const unavailableMessage = 'Adresssuche nicht erreichbar. Bitte später erneut versuchen oder den Punkt auf der Karte setzen.';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
  const locality = [postalCode, city].filter(Boolean).join(' ');
  const label = [name, streetAddress !== name ? streetAddress : undefined, locality, region]
    .filter((part, index, parts) => part && parts.indexOf(part) === index)
    .join(', ');
  if (!label) throw new Error('Der Adressdienst lieferte keine Ortsbezeichnung.');

  return {
    label,
    coord: [coordinates[0], coordinates[1]],
    kind: optionalText(properties.osm_value) ?? 'place',
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

export async function forwardGeocode(query: string, signal: AbortSignal): Promise<Place[]> {
  if (query.trim().length < 3) throw new Error('Bitte mindestens drei Zeichen eingeben.');
  const places = (await search('/api/', new URLSearchParams({
    q: query.trim(),
    lang: 'de',
    limit: '8',
  }), signal)).map(parsePlace);
  // One name close together (a square, its street and its stops, with or without a postcode) is one place; the first,
  // best match stays.
  const key = (place: Place) => place.label.replace(/, \d{4,5} /, ', ').toLocaleLowerCase('de-AT');
  const kept: Place[] = [];
  for (const place of places) {
    if (!kept.some((other) => key(other) === key(place) && distanceMeters(other.coord, place.coord) < 200)) kept.push(place);
  }
  return kept;
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
  const city = optionalText(properties.city);
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
