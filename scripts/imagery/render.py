"""Persistent tile renderer, using local overviews and bounded remote image windows."""
import base64
import json
import math
import sys
from functools import lru_cache
from http.client import HTTPSConnection, RemoteDisconnected
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, wait
from io import BytesIO
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.features import bounds as geometry_bounds, rasterize
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform_bounds, transform_geom

ROOT = Path(__file__).resolve().parents[2]
CONFIG = json.loads((ROOT / 'scripts/imagery.json').read_text())
DIRECTORY = ROOT / '.cache/imagery'
SIZE = 256
EXTENT = math.pi * 6378137
DATASETS = OrderedDict()
CONNECTIONS = {}
BANDS = ThreadPoolExecutor(max_workers=3)
ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif',
           GDAL_HTTP_TIMEOUT='15', GDAL_HTTP_CONNECTTIMEOUT='5', GDAL_HTTP_MAX_RETRY='0',
           GDAL_HTTP_VERSION='1.1', GDAL_CACHEMAX=64 * 1024 ** 2)
COUNTRIES = []
for country in CONFIG['countries'] + CONFIG.get('regions', []):
    features = json.loads((DIRECTORY / (country['id'] + '.geojson')).read_text())['features']
    shapes = [transform_geom('EPSG:4326', 'EPSG:3857', feature['geometry']) for feature in features]
    boundaries = [{'type': 'MultiLineString', 'coordinates': [ring for polygon in
                   (shape['coordinates'] if shape['type'] == 'MultiPolygon' else [shape['coordinates']]) for ring in polygon]}
                  for shape in shapes]
    COUNTRIES.append({**country, 'shapes': shapes, 'boundaries': boundaries, 'bounds': [geometry_bounds(shape) for shape in shapes]})
INDEX = json.loads((DIRECTORY / 'index.json').read_text()) if (DIRECTORY / 'index.json').exists() else []


def intersects(a, b):
    return a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]


def tile_bounds(z, x, y):
    span = 2 * EXTENT / 2 ** z
    return (-EXTENT + x * span, EXTENT - (y + 1) * span, -EXTENT + (x + 1) * span, EXTENT - y * span)


@lru_cache(maxsize=512)
def country_coverage(country_id, z, x, y):
    country = next(country for country in COUNTRIES if country['id'] == country_id)
    bounds = tile_bounds(z, x, y)
    indices = [i for i, box in enumerate(country['bounds']) if intersects(box, bounds)]
    if not indices:
        return 0
    # A boundary crossing, including a tiny enclave, always keeps precise clipping.
    edges = rasterize([country['boundaries'][i] for i in indices], out_shape=(32, 32),
                      transform=from_bounds(*bounds, 32, 32), all_touched=True, dtype='uint8')
    if edges.any():
        return None
    return int(rasterize([country['shapes'][i] for i in indices], out_shape=(1, 1),
                         transform=from_bounds(*bounds, 1, 1), default_value=255, dtype='uint8')[0, 0])


def country_mask(country, z, x, y, bounds, transform):
    level = min(z, 10)
    coverage = country_coverage(country['id'], level, x >> (z - level), y >> (z - level))
    if coverage is not None:
        return np.full((SIZE, SIZE), coverage, dtype='uint8')
    shapes = [shape for shape, box in zip(country['shapes'], country['bounds']) if intersects(box, bounds)]
    if not shapes:
        return np.zeros((SIZE, SIZE), dtype='uint8')
    return rasterize(shapes, out_shape=(SIZE, SIZE), transform=transform, default_value=255, dtype='uint8')


def sentinel_overview(resolution):
    level = min(4, math.floor(math.log2(max(1, resolution / 10))) - 1)
    return level if level >= 0 else None


def dataset(url, overview=None):
    key = (url, overview)
    if key not in DATASETS:
        DATASETS[key] = rasterio.open(url, **({'overview_level': overview} if overview is not None else {}))
        if len(DATASETS) > 24:
            DATASETS.popitem(last=False)[1].close()
    DATASETS.move_to_end(key)
    return DATASETS[key]


def read_tile(src, transform, nodata=None):
    with WarpedVRT(src, crs='EPSG:3857', transform=transform, width=SIZE, height=SIZE,
                   resampling=Resampling.bilinear, nodata=nodata, warp_mem_limit=32) as vrt:
        return vrt.read(masked=True)


def read_band(url, transform, overview):
    with rasterio.Env(**ENV, CPL_VSIL_CURL_NON_CACHED='/vsicurl/' + url):
        try:
            return read_tile(dataset(url, overview), transform, -32768)
        except Exception:
            previous = DATASETS.pop((url, overview), None)
            if previous:
                previous.close()
            raise


def photo(country, z, x, y, parent_levels=2):
    level = min(z, country['maxzoom'])
    factor = 2 ** (z - level)
    url = country['url'].format(z=level, x=x // factor, y=y // factor,
                                bbox=','.join(str(value) for value in tile_bounds(level, x // factor, y // factor)))
    parsed = urlsplit(url)
    if parsed.netloc not in CONNECTIONS:
        CONNECTIONS[parsed.netloc] = HTTPSConnection(parsed.hostname, parsed.port, timeout=8)
    connection = CONNECTIONS[parsed.netloc]
    target = parsed.path + ('?' + parsed.query if parsed.query else '')
    for attempt in range(2):
        try:
            connection.request('GET', target, headers={'User-Agent': 'RichiRoute/1.0 (local imagery viewer)'})
            with connection.getresponse() as response:
                data = response.read(2 * 1024 ** 2 + 1)
                status = response.status
            # Some tiled providers publish their highest zoom only in selected areas.
            if status == 404 and parent_levels and level > country.get('minzoom', 0) and '{z}' in country['url']:
                return photo({**country, 'maxzoom': level - 1}, z, x, y, parent_levels - 1)
            if status != 200:
                raise ValueError(f'Imagery source returned HTTP {status}')
            break
        except (RemoteDisconnected, BrokenPipeError, ConnectionResetError):
            connection.close()
            if attempt:
                raise
        except Exception:
            connection.close()
            raise
    if len(data) > 2 * 1024 ** 2:
        connection.close()
        raise ValueError('Oversized imagery response')
    image = Image.open(BytesIO(data))
    if image.size != (SIZE, SIZE):
        raise ValueError('Unexpected imagery tile dimensions')
    image = image.convert('RGBA')
    if factor > 1:
        side = SIZE / factor
        left, top = x % factor * side, y % factor * side
        image = image.crop((left, top, left + side, top + side)).resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    return np.asarray(image).copy()


def render(z, x, y, offline=False, regional=True):
    bounds = tile_bounds(z, x, y)
    transform = from_bounds(*bounds, SIZE, SIZE)
    geographic = transform_bounds(3857, 4326, *bounds)
    overlays, sources, errors = [], [], []
    coverage = np.zeros((SIZE, SIZE), dtype='uint8')
    if z >= 9 and not offline:
        for country in reversed(COUNTRIES):
            if not regional and country['id'] not in {item['id'] for item in CONFIG['countries']}:
                continue
            if z < country.get('minzoom', 9):
                continue
            mask = country_mask(country, z, x, y, bounds, transform)
            if not mask.any():
                continue
            try:
                image = photo(country, z, x, y)
                image[:, :, 3] = np.minimum(mask, image[:, :, 3])
                coverage = np.maximum(coverage, image[:, :, 3])
                overlays.append(image)
                sources.append(country['id'])
                if np.all(coverage == 255):
                    break
            except Exception as error:
                errors.append(country['id'] + ': ' + str(error))
    if np.all(coverage == 255):
        result = Image.new('RGB', (SIZE, SIZE))
    else:
        base = read_tile(dataset(str(DIRECTORY / 'overview.tif')), transform).filled(0)
        sources.append('sentinel-overview')
        if z >= 10 and not offline:
            resolution = transform.a * math.cos(math.radians(geographic[3]))
            overview = sentinel_overview(resolution)
            for cell in INDEX:
                if not intersects(cell['bounds'], geographic):
                    continue
                try:
                    pending = [BANDS.submit(read_band, CONFIG['sentinel']['baseUrl'] + cell['id'] + '/' + band + '.tif',
                                            transform, overview) for band in ['B04', 'B03', 'B02']]
                    wait(pending)
                    values = np.ma.concatenate([task.result() for task in pending])
                    valid = ~np.ma.getmaskarray(values).any(axis=0)
                    rgb = (np.clip(values.filled(0).astype('float32') / 3000, 0, 1) ** (1 / 1.8) * 255).astype('uint8')
                    base[:, valid] = rgb[:, valid]
                    if valid.any() and 'sentinel' not in sources:
                        sources.append('sentinel')
                except Exception as error:
                    errors.append(cell['id'] + ': ' + str(error))
        result = Image.fromarray(np.moveaxis(base, 0, -1))
    for overlay in reversed(overlays):
        image = Image.fromarray(overlay)
        result.paste(image, mask=image.getchannel('A'))
    output = BytesIO()
    result.save(output, format='JPEG', quality=90)
    return {'data': base64.b64encode(output.getvalue()).decode(), 'sources': sources, 'errors': errors}


def main():
    with rasterio.Env(**ENV):
        for line in sys.stdin:
            request = json.loads(line)
            try:
                response = render(request['z'], request['x'], request['y'], request.get('offline', False), request.get('regional', True))
            except Exception as error:
                response = {'error': str(error)}
            print(json.dumps(response), flush=True)


def prepare_direct_coverage():
    zoom = 10
    countries = []
    for country in COUNTRIES:
        if country['id'] not in {item['id'] for item in CONFIG['countries']}:
            continue
        if not (country['url'].endswith('.jpeg') or 'FORMAT=image/jpeg' in country['url']):
            continue
        boxes = country['bounds']
        span = 2 * EXTENT / 2 ** zoom
        left = math.floor((min(box[0] for box in boxes) + EXTENT) / span)
        right = math.floor((max(box[2] for box in boxes) + EXTENT) / span)
        top = math.floor((EXTENT - max(box[3] for box in boxes)) / span)
        bottom = math.floor((EXTENT - min(box[1] for box in boxes)) / span)
        tiles = [f'{x}/{y}' for x in range(left, right + 1) for y in range(top, bottom + 1)
                 if country_coverage(country['id'], zoom, x, y) == 255]
        countries.append({key: country[key] for key in ['id', 'url', 'boundarySha256']} | {'tiles': tiles})
    target = DIRECTORY / 'direct-coverage.json'
    partial = target.with_suffix('.json.part')
    partial.write_text(json.dumps({'zoom': zoom, 'countries': countries}, ensure_ascii=False))
    partial.replace(target)


if __name__ == '__main__':
    prepare_direct_coverage() if '--prepare-direct' in sys.argv else main()
