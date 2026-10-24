"""Build a sharper local Sentinel mosaic for one region; zoomed-out tiles there render from it, evenly and fast."""
import argparse
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import rasterio
import rasterio.errors
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject

from prepare import CONFIG, DIRECTORY, ENV, intersects

STEP_X, STEP_Y = .0005, .00035  # Degrees per pixel: about 38 m by 39 m in Austria, matching the source.
LEVEL = 1  # Sentinel's 40 m overview.
MINZOOM, MAXZOOM = 8, 11  # Tile zooms served from the mosaic; from 12 aerial photos are sharper.
BACKGROUND = [28, 58, 74]  # Same sea colour as the European overview.
CELLS = DIRECTORY / 'region-cells-40m'  # Finished cells as JPEG; an interrupted build resumes from them.
NETWORK = {**ENV, 'GDAL_HTTP_TIMEOUT': '30', 'GDAL_HTTP_MAX_RETRY': '3'}


def prepare_cell(name):
    file = CELLS / (name + '.tif')
    if file.exists():
        return file
    bands = []
    with rasterio.Env(**NETWORK):
        for band in ['B04', 'B03', 'B02']:
            with rasterio.open(CONFIG['sentinel']['baseUrl'] + name + '/' + band + '.tif', overview_level=LEVEL) as src:
                bands.append(src.read(1, masked=True))
                crs, transform = src.crs, src.transform
    data = np.ma.stack(bands)
    # The same colour curve as live Sentinel tiles, so both match where they meet.
    rgb = (np.clip(data.filled(0).astype('float32') / 3000, 0, 1) ** (1 / 1.8) * 255).astype('uint8')
    alpha = (~np.ma.getmaskarray(data).any(axis=0)).astype('uint8') * 255
    with rasterio.Env(GDAL_TIFF_INTERNAL_MASK=True), rasterio.open(
            str(file) + '.part', 'w', driver='GTiff', width=rgb.shape[2], height=rgb.shape[1], count=3, dtype='uint8',
            crs=crs, transform=transform, tiled=True, compress='jpeg', photometric='YCBCR') as dst:
        dst.write(rgb)
        dst.write_mask(alpha)
    Path(str(file) + '.part').replace(file)
    return file


def prepare_cells(names):
    failed, start = [], time.monotonic()
    with ThreadPoolExecutor(max_workers=4) as pool:
        pending = {pool.submit(prepare_cell, name): name for name in names}
        for done, task in enumerate(as_completed(pending), 1):
            try:
                task.result()
            except rasterio.errors.RasterioError as error:
                failed.append(pending[task])
                print(f'{pending[task]}: {error}', flush=True)
            if done % 5 == 0 or done == len(names):
                print(f'Regional mosaic: {done}/{len(names)} cells, {time.monotonic() - start:.0f}s, {len(failed)} failures.', flush=True)
    return failed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bbox', default='8.5,45.8,18,49.5', help='west,south,east,north in degrees')
    west, south, east, north = map(float, parser.parse_args().bbox.split(','))
    if not (CONFIG['bounds'][0] <= west < east <= CONFIG['bounds'][2] and CONFIG['bounds'][1] <= south < north <= CONFIG['bounds'][3]):
        raise SystemExit('Choose a region inside the European imagery bounds.')
    cells = [cell for cell in json.loads((DIRECTORY / 'index.json').read_text()) if intersects(cell['bounds'], (west, south, east, north))]
    CELLS.mkdir(exist_ok=True)
    print(f'Preparing {len(cells)} Sentinel cells at 80 m.', flush=True)
    failed = prepare_cells([cell['id'] for cell in cells])
    for attempt in range(2):
        if failed:
            print(f'Retrying {len(failed)} cells, pass {attempt + 1}/2.', flush=True)
            failed = prepare_cells(failed)
    if failed:
        raise SystemExit(f'{len(failed)} cells failed. Run the command again; finished cells are kept.')

    width, height = math.ceil((east - west) / STEP_X), math.ceil((north - south) / STEP_Y)
    transform = from_bounds(west, south, west + width * STEP_X, south + height * STEP_Y, width, height)
    mosaic = np.empty((3, height, width), dtype='uint8')
    mosaic[:] = np.array(BACKGROUND, dtype='uint8')[:, None, None]
    for cell in cells:
        left, bottom, right, top = cell['bounds']
        x0, x1 = max(0, math.floor((left - west) / STEP_X)), min(width, math.ceil((right - west) / STEP_X))
        y0, y1 = max(0, math.floor((transform.f - top) / STEP_Y)), min(height, math.ceil((transform.f - bottom) / STEP_Y))
        if x1 <= x0 or y1 <= y0:
            continue
        data = np.zeros((4, y1 - y0, x1 - x0), dtype='uint8')
        with rasterio.open(CELLS / (cell['id'] + '.tif')) as src:
            reproject(np.concatenate([src.read(), src.read_masks(1)[None]]), data, src_transform=src.transform, src_crs=src.crs,
                      dst_transform=transform * rasterio.Affine.translation(x0, y0), dst_crs='EPSG:4326',
                      src_alpha=4, dst_alpha=4, resampling=Resampling.bilinear)
        valid = data[3] > 0
        mosaic[:, y0:y1, x0:x1][:, valid] = data[:3, valid]
    target = DIRECTORY / 'region.tif'
    with rasterio.open(str(target) + '.part', 'w', driver='GTiff', width=width, height=height, count=3, dtype='uint8',
                       crs='EPSG:4326', transform=transform, tiled=True, blockxsize=256, blockysize=256,
                       compress='jpeg', photometric='YCBCR') as dst:
        dst.write(mosaic)
        dst.build_overviews([2, 4, 8, 16], Resampling.average)
    Path(str(target) + '.part').replace(target)
    # The build time makes every rebuild a new tile version, so caches drop the previous mosaic.
    (DIRECTORY / 'region.json').write_text(json.dumps({'bounds': [west, south, east, north], 'minzoom': MINZOOM,
                                                       'maxzoom': MAXZOOM, 'built': time.time()}) + '\n')
    print(f'Regional mosaic: {target.stat().st_size / 1024 ** 2:.1f} MiB. Restart the local map service.', flush=True)


if __name__ == '__main__':
    main()
