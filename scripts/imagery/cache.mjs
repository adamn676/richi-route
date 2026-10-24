import { Database } from 'node:sqlite';
import { createHash } from 'node:crypto';

export class ImageryCache {
  constructor(file, limit, revision) {
    this.limit = limit;
    this.db = new Database(file);
    this.db.exec(`PRAGMA auto_vacuum=INCREMENTAL;
      PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS tiles (
        key TEXT PRIMARY KEY, data BLOB NOT NULL, sources TEXT NOT NULL,
        etag TEXT NOT NULL, created INTEGER NOT NULL, accessed INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tiles_accessed ON tiles(accessed);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (this.db.prepare('SELECT value FROM state WHERE key = ?').get('revision')?.value !== revision) {
      this.db.exec('DELETE FROM tiles');
      this.db.prepare('INSERT OR REPLACE INTO state VALUES (?, ?)').run('revision', revision);
    }
    this.size = this.db.prepare('SELECT COALESCE(SUM(length(data)), 0) AS size FROM tiles').get().size;
    this.select = this.db.prepare('SELECT * FROM tiles WHERE key = ?');
    this.touch = this.db.prepare('UPDATE tiles SET accessed = ? WHERE key = ?');
    this.insert = this.db.prepare('INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?, ?, ?)');
    this.remove = this.db.prepare('DELETE FROM tiles WHERE key = ?');
    this.oldest = this.db.prepare('SELECT key, length(data) AS size FROM tiles ORDER BY accessed LIMIT 1');
  }
  get(key, now = Date.now()) {
    const tile = this.select.get(key);
    if (!tile) return undefined;
    if (now - tile.accessed > 60000) this.touch.run(now, key);
    return { data: Buffer.from(tile.data), sources: JSON.parse(tile.sources), etag: tile.etag,
      stale: now - tile.created > 7 * 86400000 };
  }
  put(key, data, sources, now = Date.now()) {
    const etag = `"${createHash('sha256').update(data).digest('hex')}"`;
    if (data.length > this.limit) return { data, sources, etag };
    const previous = this.select.get(key);
    if (previous) { this.remove.run(key); this.size -= previous.data.length; }
    while (this.size + data.length > this.limit) {
      const oldest = this.oldest.get();
      if (!oldest) break;
      this.remove.run(oldest.key); this.size -= oldest.size;
    }
    this.insert.run(key, data, JSON.stringify(sources), etag, now, now);
    this.size += data.length;
    this.db.exec('PRAGMA incremental_vacuum(64)');
    return { data, sources, etag };
  }
  invalidateSwiss(update) {
    const previous = this.db.prepare('SELECT value FROM state WHERE key = ?').get('swiss-update')?.value;
    if (previous && previous !== update) {
      this.db.exec(`DELETE FROM tiles WHERE sources LIKE '%"CHE"%'`);
      this.size = this.db.prepare('SELECT COALESCE(SUM(length(data)), 0) AS size FROM tiles').get().size;
    }
    this.db.prepare('INSERT OR REPLACE INTO state VALUES (?, ?)').run('swiss-update', update);
  }
  close() { this.db.close(); }
}
