import https from 'node:https';
import { readFile } from 'node:fs/promises';

export async function createDirectPhotos(directory, countries) {
  let coverage;
  try { coverage = JSON.parse(await readFile(`${directory}/direct-coverage.json`, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const sources = new Map();
  for (const entry of coverage.countries) {
    const country = countries.find(item => item.id === entry.id && item.url === entry.url && item.boundarySha256 === entry.boundarySha256);
    if (country) for (const tile of entry.tiles) sources.set(tile, country);
  }
  const agent = new https.Agent({ keepAlive: true, maxSockets: 8, maxTotalSockets: 8 });
  return {
    async get(z, x, y, signal) {
      if (z < coverage.zoom || z > 19) return undefined;
      const factor = 2 ** (z - coverage.zoom);
      const country = sources.get(`${Math.floor(x / factor)}/${Math.floor(y / factor)}`);
      if (!country || z > country.maxzoom) return undefined;
      const url = country.url.replaceAll('{z}', z).replaceAll('{x}', x).replaceAll('{y}', y);
      return new Promise((resolve, reject) => {
        const request = https.get(url, { agent, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
          headers: { 'User-Agent': 'RichiRoute/1.0 (local imagery viewer)' } }, response => {
          if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('image/jpeg')) {
            response.resume(); resolve(undefined); return;
          }
          const chunks = [];
          let size = 0;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > 2 * 1024 ** 2) { request.destroy(); resolve(undefined); }
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            const data = Buffer.concat(chunks);
            resolve(data[0] === 0xff && data[1] === 0xd8 && data.at(-2) === 0xff && data.at(-1) === 0xd9
              ? { data, sources: [country.id], errors: [] } : undefined);
          });
        });
        request.on('error', reject);
      });
    },
    close() { agent.destroy(); },
  };
}
