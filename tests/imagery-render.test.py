"""Run after imagery:setup, using .cache/imagery-tools on PYTHONPATH."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch
from io import BytesIO

import numpy as np
from rasterio.features import rasterize
from rasterio.transform import from_bounds

spec = importlib.util.spec_from_file_location('imagery', Path(__file__).resolve().parents[1] / 'scripts/imagery/render.py')
imagery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(imagery)


class CountryMasks(unittest.TestCase):
    def test_missing_detail_tile_uses_correct_parent_quadrant(self):
        pixels = np.zeros((256, 256, 4), dtype='uint8')
        pixels[:, :, 3] = 255
        pixels[128:, 128:, 0] = 255
        data = BytesIO()
        imagery.Image.fromarray(pixels).save(data, format='PNG')
        missing, parent = MagicMock(), MagicMock()
        missing.status, missing.read.return_value = 404, b''
        parent.status, parent.read.return_value = 200, data.getvalue()
        connection = MagicMock()
        connection.getresponse.side_effect = [missing, parent]
        for response in [missing, parent]:
            response.__enter__.return_value = response
        country = {'maxzoom': 20, 'url': 'https://example.test/{z}/{x}/{y}.png'}
        with patch.dict(imagery.CONNECTIONS, {'example.test': connection}):
            result = imagery.photo(country, 20, 101, 201)
        self.assertEqual(connection.request.call_args_list[1].args[1], '/19/50/100.png')
        np.testing.assert_array_equal(result[16:-16, 16:-16], np.broadcast_to([255, 0, 0, 255], (224, 224, 4)))

    def test_parent_fallback_is_bounded_and_only_for_missing_xyz_tiles(self):
        for status, url, count in [(404, 'https://example.test/{z}/{x}/{y}.png', 3),
                                   (503, 'https://example.test/{z}/{x}/{y}.png', 1),
                                   (404, 'https://example.test/export?bbox={bbox}', 1)]:
            response = MagicMock()
            response.status, response.read.return_value = status, b''
            response.__enter__.return_value = response
            connection = MagicMock()
            connection.getresponse.return_value = response
            with patch.dict(imagery.CONNECTIONS, {'example.test': connection}):
                with self.assertRaisesRegex(ValueError, f'HTTP {status}'):
                    imagery.photo({'maxzoom': 20, 'url': url}, 20, 101, 201)
            self.assertEqual(connection.request.call_count, count)

    def test_sentinel_overviews_preserve_native_detail(self):
        self.assertIsNone(imagery.sentinel_overview(1))
        self.assertIsNone(imagery.sentinel_overview(19))
        self.assertEqual(imagery.sentinel_overview(20), 0)
        self.assertEqual(imagery.sentinel_overview(100), 2)
        self.assertEqual(imagery.sentinel_overview(1000), 4)

    def test_interior_and_border_masks_match_precise_rasterization(self):
        positions = [(15.47, 47.08, 18), (6.142, 46.213, 10), (16.1, 48.75, 14), (8.68, 47.7, 16), (13.72, 47.6, 16)]
        import math
        for lon, lat, z in positions:
            x = int((lon + 180) / 360 * 2 ** z)
            y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2 ** z)
            bounds = imagery.tile_bounds(z, x, y)
            transform = from_bounds(*bounds, 256, 256)
            for country in imagery.COUNTRIES:
                expected = rasterize(country['shapes'], out_shape=(256, 256), transform=transform, default_value=255, dtype='uint8')
                actual = imagery.country_mask(country, z, x, y, bounds, transform)
                np.testing.assert_array_equal(actual, expected, err_msg=f"{country['id']}: {lon}, {lat}, {z}")

    def test_regional_photo_priority_and_national_fallback(self):
        import math
        z = 18
        x = int((15.438 + 180) / 360 * 2 ** z)
        y = int((1 - math.asinh(math.tan(math.radians(47.071))) / math.pi) / 2 * 2 ** z)
        image = np.full((256, 256, 4), 255, dtype='uint8')
        with patch.object(imagery, 'photo', return_value=image) as photo:
            result = imagery.render(z, x, y)
            self.assertEqual(result['sources'], ['AT-GRAZ'])
            self.assertEqual(photo.call_count, 1)
        with patch.object(imagery, 'photo', return_value=image) as photo:
            result = imagery.render(z, x, y, regional=False)
            self.assertEqual(result['sources'], ['AUT'])
            self.assertEqual(photo.call_count, 1)
        with patch.object(imagery, 'photo', side_effect=[OSError('Unavailable'), image]):
            result = imagery.render(z, x, y)
            self.assertEqual(result['sources'], ['AT-STYRIA'])
            self.assertEqual(len(result['errors']), 1)
        with patch.object(imagery, 'photo', side_effect=[OSError('City unavailable'), OSError('Region unavailable'), image]):
            result = imagery.render(z, x, y)
            self.assertEqual(result['sources'], ['AUT'])
            self.assertEqual(len(result['errors']), 2)

    def test_subpixel_enclave_prevents_full_country_shortcut(self):
        box = imagery.tile_bounds(10, 550, 360)
        left, bottom, right, top = box
        outer = [[left - 10, bottom - 10], [right + 10, bottom - 10], [right + 10, top + 10], [left - 10, top + 10], [left - 10, bottom - 10]]
        cx, cy = (left + right) / 2, (bottom + top) / 2
        hole = [[cx, cy], [cx + 1, cy], [cx + 1, cy + 1], [cx, cy + 1], [cx, cy]]
        country = {'id': 'TEST', 'shapes': [{'type': 'Polygon', 'coordinates': [outer, hole]}],
                   'boundaries': [{'type': 'MultiLineString', 'coordinates': [outer, hole]}],
                   'bounds': [(left - 10, bottom - 10, right + 10, top + 10)]}
        imagery.COUNTRIES.append(country)
        try:
            self.assertIsNone(imagery.country_coverage('TEST', 10, 550, 360))
        finally:
            imagery.COUNTRIES.remove(country)
            imagery.country_coverage.cache_clear()


if __name__ == '__main__':
    unittest.main()
