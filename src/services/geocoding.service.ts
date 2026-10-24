import type { Coord } from '../domain/route-model.ts';

export interface Place {
  label: string;
  coord: Coord;
  kind: string;
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
    components: { place: city, region, country },
  };
}

async function search(params: URLSearchParams, signal: AbortSignal): Promise<Place[]> {
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/?${params}`, {
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
  return features.map(parsePlace);
}

export async function forwardGeocode(query: string, signal: AbortSignal): Promise<Place[]> {
  if (query.trim().length < 3) throw new Error('Bitte mindestens drei Zeichen eingeben.');
  const places = await search(new URLSearchParams({
    q: query.trim(),
    lang: 'de',
    limit: '8',
  }), signal);
  const seen = new Set<string>();
  return places.filter((place) => {
    const key = `${place.label.toLocaleLowerCase('de-AT')}|${place.coord.join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
