"""Build a small local overview; retain full-resolution Sentinel URLs for close views."""
import json
import math
import shutil
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import duckdb
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT
from rasterio.warp import reproject, transform_bounds
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
CONFIG = json.loads((ROOT / 'scripts/imagery.json').read_text())
DIRECTORY = ROOT / '.cache/imagery'
CELLS = DIRECTORY / CONFIG['revision']
CELLS.mkdir(exist_ok=True)
WEST, SOUTH, EAST, NORTH = CONFIG['bounds']
ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif',
           CPL_VSIL_CURL_NON_CACHED='/vsicurl/' + CONFIG['sentinel']['baseUrl'],
           GDAL_HTTP_TIMEOUT='10', GDAL_HTTP_CONNECTTIMEOUT='5', GDAL_HTTP_MAX_RETRY='1', GDAL_HTTP_RETRY_DELAY='1',
           GDAL_HTTP_RETRY_CODES='429,500,502,503,504,520,522,524',
           GDAL_HTTP_VERSION='1.1', GDAL_CACHEMAX=32 * 1024 ** 2)


def intersects(a, b):
    return a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]


def prepare_cell(name):
    file = CELLS / (name + '.tif')
    if not file.exists():
        with rasterio.Env(**ENV):
            bands = []
            for band in ['B04', 'B03', 'B02']:
                with rasterio.open(CONFIG['sentinel']['baseUrl'] + name + '/' + band + '.tif') as src:
                    bands.append(src.read(1, out_shape=(313, 313), masked=True, resampling=Resampling.average))
                    crs, bounds = src.crs, src.bounds
            data = np.ma.stack(bands)
            rgb = (np.clip(data.filled(0).astype('float32') / 3000, 0, 1) ** (1 / 1.8) * 255).astype('uint8')
            alpha = (~np.ma.getmaskarray(data).any(axis=0)).astype('uint8') * 255
            with rasterio.open(str(file) + '.part', 'w', driver='GTiff', width=313, height=313,
                               count=4, dtype='uint8', crs=crs, transform=from_bounds(*bounds, 313, 313),
                               compress='deflate') as dst:
                dst.write(np.concatenate([rgb, alpha[None]]))
        Path(str(file) + '.part').replace(file)
    with rasterio.open(file) as src:
        return {'id': name, 'bounds': transform_bounds(src.crs, 'EPSG:4326', *src.bounds)}


def main():
    names = []
    manifest = duckdb.connect()
    rows = manifest.execute('SELECT destination_key FROM read_parquet(?) WHERE band = ?',
                            [str(DIRECTORY / 'manifest.parquet'), 'B04']).fetchall()
    manifest.close()
    for (key,) in rows:
        name = key.split('/')[-2]
        grid = name.split('_')[0]
        zone = int(grid[:2])
        if not 26 <= zone <= 38 or not 'S' <= grid[2] <= 'X':
            continue
        columns = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'][(zone - 1) % 3]
        x = (columns.index(grid[3]) + 1) * 100000
        row = ('ABCDEFGHJKLMNPQRSTUV'.index(grid[4]) - (5 if zone % 2 == 0 else 0)) % 20
        y = row * 100000
        while y < {'S': 3500000, 'T': 4400000, 'U': 5300000, 'V': 6200000, 'W': 7000000, 'X': 7900000}[grid[2]]:
            y += 2000000
        bounds = transform_bounds(32600 + zone, 4326, x - 100, y - 100, x + 110000, y + 110000)
        if intersects(bounds, CONFIG['bounds']):
            names.append(name)
    index, failed = [], []
    start = time.monotonic()
    print(f'Preparing {len(names)} European overview cells, using only the smallest image overviews.', flush=True)
    remaining = sum(not (CELLS / (name + '.tif')).exists() for name in names)
    with ThreadPoolExecutor(max_workers=12 if remaining > 100 else 4) as pool:
        pending = {pool.submit(prepare_cell, name): name for name in names}
        for task in as_completed(pending):
            try:
                index.append(task.result())
            except Exception as error:
                failed.append(pending[task])
                print(f'{pending[task]}: {error}', flush=True)
            completed = len(index) + len(failed)
            if completed % 20 == 0 or completed == len(names):
                print(f'Overview: {completed}/{len(names)} cells, {time.monotonic() - start:.0f}s, {len(failed)} failures.', flush=True)
                if shutil.disk_usage(DIRECTORY).free < CONFIG['reserveBytes']:
                    raise RuntimeError('Stopping before disk space falls below 15 GiB.')
    for attempt in range(2):
        if not failed:
            break
        retry, failed = failed, []
        print(f'Retrying {len(retry)} failed cells, pass {attempt + 1}/2.', flush=True)
        with ThreadPoolExecutor(max_workers=4) as pool:
            pending = {pool.submit(prepare_cell, name): name for name in retry}
            for task in as_completed(pending):
                try:
                    index.append(task.result())
                except Exception as error:
                    failed.append(pending[task])
                    print(f'{pending[task]}: {error}', flush=True)
    if failed:
        raise RuntimeError(f'{len(failed)} cells failed. Rerun imagery:setup to retry; completed cells are retained.')
    index.sort(key=lambda cell: cell['id'])
    (DIRECTORY / 'index.json').write_text(json.dumps(index))
    width, height = math.ceil((EAST - WEST) / .005), math.ceil((NORTH - SOUTH) / .005)
    transform = from_bounds(WEST, SOUTH, EAST, NORTH, width, height)
    mosaic = np.empty((3, height, width), dtype='uint8')
    mosaic[:] = np.array([28, 58, 74], dtype='uint8')[:, None, None]
    for cell in index:
        with rasterio.open(CELLS / (cell['id'] + '.tif')) as src:
            left, bottom, right, top = cell['bounds']
            x0, x1 = max(0, math.floor((left - WEST) / .005)), min(width, math.ceil((right - WEST) / .005))
            y0, y1 = max(0, math.floor((NORTH - top) / .005)), min(height, math.ceil((NORTH - bottom) / .005))
            if x1 <= x0 or y1 <= y0:
                continue
            data = np.zeros((4, y1 - y0, x1 - x0), dtype='uint8')
            reproject(src.read(), data, src_transform=src.transform, src_crs=src.crs,
                      dst_transform=transform * rasterio.Affine.translation(x0, y0), dst_crs='EPSG:4326',
                      src_alpha=4, dst_alpha=4, resampling=Resampling.bilinear)
            valid = data[3] > 0
            mosaic[:, y0:y1, x0:x1][:, valid] = data[:3, valid]
    target = DIRECTORY / 'overview.tif'
    with rasterio.open(str(target) + '.part', 'w', driver='GTiff', width=width, height=height,
                       count=3, dtype='uint8', crs='EPSG:4326', transform=transform,
                       tiled=True, blockxsize=256, blockysize=256, compress='jpeg', photometric='YCBCR') as dst:
        dst.write(mosaic)
        dst.build_overviews([2, 4, 8, 16, 32], Resampling.average)
    Path(str(target) + '.part').replace(target)
    print(f'Local overview: {target.stat().st_size / 1024 ** 2:.1f} MiB.', flush=True)
    extent = math.pi * 6378137
    with rasterio.open(target) as src:
        for z in range(9):
            scale = 2 ** z
            left, right = math.floor((WEST + 180) / 360 * scale), math.ceil((EAST + 180) / 360 * scale)
            top = math.floor((1 - math.asinh(math.tan(math.radians(NORTH))) / math.pi) / 2 * scale)
            bottom = math.ceil((1 - math.asinh(math.tan(math.radians(SOUTH))) / math.pi) / 2 * scale)
            span = 2 * extent / scale
            for x in range(left, right):
                folder = DIRECTORY / 'overview' / str(z) / str(x)
                folder.mkdir(parents=True, exist_ok=True)
                for y in range(top, bottom):
                    box = (-extent + x * span, extent - (y + 1) * span, -extent + (x + 1) * span, extent - y * span)
                    with WarpedVRT(src, crs='EPSG:3857', transform=from_bounds(*box, 256, 256), width=256, height=256,
                                   add_alpha=True, resampling=Resampling.bilinear) as vrt:
                        values = vrt.read()
                    rgb = np.moveaxis(values[:3], 0, -1)
                    rgb[values[3] == 0] = [28, 58, 74]
                    Image.fromarray(rgb).save(folder / f'{y}.jpg', quality=85)
            print(f'Local overview tiles: zoom {z} ready.', flush=True)


if __name__ == '__main__':
    main()
