import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createDirectPhotos } from '../scripts/imagery/direct.mjs';
import { createImagery } from '../scripts/imagery/service.mjs';
import config from '../scripts/imagery.json' with { type: 'json' };

const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'richiroute-direct-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '.cache/imagery');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'direct-coverage.json'), JSON.stringify({ zoom: 10,
    countries: [{ ...config.countries[0], tiles: ['550/360'] }] }));
  return { root, directory };
}
function transport(t, { status = 200, type = 'image/jpeg', body = jpeg, delay = 0 } = {}) {
  return t.mock.method(https, 'get', (url, options, callback) => {
    const request = new EventEmitter();
    const abort = () => { clearTimeout(timer); request.emit('error', new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => {
      options.signal.removeEventListener('abort', abort);
      const response = Readable.from([body]);
      response.statusCode = status; response.headers = { 'content-type': type };
      callback(response);
    }, delay);
    options.signal.addEventListener('abort', abort, { once: true });
    request.destroy = () => { clearTimeout(timer); };
    return request;
  });
}

test('direct imagery preserves JPEG bytes and skips borders, high zooms and stale coverage', async t => {
  const { directory } = await fixture(t);
  const request = transport(t);
  const direct = await createDirectPhotos(directory, config.countries);
  t.after(() => direct.close());
  const signal = new AbortController().signal;
  const result = await direct.get(12, 2201, 1441, signal);
  assert.deepEqual(result.data, jpeg);
  assert.deepEqual(result.sources, ['AUT']);
  assert.ok(request.mock.calls[0].arguments[0].endsWith('/12/1441/2201.jpeg'));
  for (const tile of [[9, 275, 180], [20, 563200, 368640], [12, 2204, 1441]]) {
    assert.equal(await direct.get(...tile, signal), undefined);
  }
  const stale = await createDirectPhotos(directory, [{ ...config.countries[0], boundarySha256: 'changed' }]);
  t.after(() => stale.close());
  assert.equal(await stale.get(12, 2201, 1441, signal), undefined);
  assert.equal(request.mock.callCount(), 1);
});

test('missing, non-JPEG, oversized and invalid upstream responses use the existing renderer', async t => {
  const { directory } = await fixture(t);
  const direct = await createDirectPhotos(directory, config.countries);
  t.after(() => direct.close());
  for (const response of [{ status: 404 }, { type: 'image/png' }, { body: Buffer.alloc(2 * 1024 ** 2 + 1) }, { body: Buffer.from('not a JPEG') }]) {
    const request = transport(t, response);
    assert.equal(await direct.get(10, 550, 360, new AbortController().signal), undefined);
    request.mock.restore();
  }
});

test('cancelling an old viewport does not cancel a new request for the same tile', async t => {
  const { root, directory } = await fixture(t);
  await Promise.all(['overview.tif', 'index.json'].map(name => writeFile(path.join(directory, name), '')));
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false }));
  const request = transport(t, { delay: 30 });
  const service = await createImagery(root);
  t.after(() => service.close());
  const old = new AbortController(), current = new AbortController();
  const cancelled = assert.rejects(service.getTile(10, 550, 360, old.signal, { regional: false }), { name: 'AbortError' });
  old.abort();
  const result = await service.getTile(10, 550, 360, current.signal, { regional: false });
  await cancelled;
  assert.deepEqual(result.data, jpeg);
  assert.equal(request.mock.callCount(), 2);
});

test('a shared tile keeps loading while another viewport still needs it', async t => {
  const { root, directory } = await fixture(t);
  await Promise.all(['overview.tif', 'index.json'].map(name => writeFile(path.join(directory, name), '')));
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false }));
  const request = transport(t, { delay: 30 });
  const service = await createImagery(root);
  t.after(() => service.close());
  const first = new AbortController(), second = new AbortController();
  const one = service.getTile(10, 550, 360, first.signal, { regional: false });
  const two = service.getTile(10, 550, 360, second.signal, { regional: false });
  first.abort();
  assert.deepEqual((await one).data, jpeg);
  assert.deepEqual((await two).data, jpeg);
  assert.equal(request.mock.callCount(), 1);
});
