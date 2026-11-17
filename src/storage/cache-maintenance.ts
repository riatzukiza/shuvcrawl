import { opendir, stat } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import path from 'node:path';
import type { ShuvcrawlConfig } from '../config/schema.ts';
import type { Logger } from '../utils/logger.ts';
import { expandHome } from '../utils/paths.ts';
import { withCacheEntryLock, readCacheEntry, removeCacheEntry } from './cache.ts';

export class CachePruner {
  private directory?: Dir;
  private readonly cacheDir: string;
  private pendingSweep: Promise<unknown> = Promise.resolve();

  constructor(cacheDir: string, private readonly ttl: number) {
    this.cacheDir = expandHome(cacheDir);
  }

  sweep(limit = 64): Promise<{ scanned: number; deleted: number }> {
    const sweep = this.pendingSweep.then(() => this.sweepBatch(limit));
    this.pendingSweep = sweep.catch(() => {});
    return sweep;
  }

  private async sweepBatch(limit: number): Promise<{ scanned: number; deleted: number }> {
    const result = { scanned: 0, deleted: 0 };
    try {
      this.directory ??= await opendir(this.cacheDir, { bufferSize: 32 });
      const cutoff = Date.now() - this.ttl * 1000;
      while (result.scanned < limit) {
        const entry = await this.directory.read();
        if (!entry) {
          await this.close();
          break;
        }
        result.scanned++;
        if (!entry.isFile() || !/^[a-f0-9]{16}\.json$/.test(entry.name)) continue;
        const cachePath = path.join(this.cacheDir, entry.name);
        try {
          if ((await stat(cachePath)).mtimeMs >= cutoff) continue;
          const removed = await withCacheEntryLock(cachePath, async () => {
            const cached = await readCacheEntry(cachePath);
            return cached.entry.cachedAt < cutoff && await removeCacheEntry(cachePath, cached.stats);
          });
          if (removed) result.deleted++;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
      }
    } catch (error) {
      await this.close().catch(() => {});
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return result;
  }

  async close(): Promise<void> {
    const directory = this.directory;
    this.directory = undefined;
    await directory?.close();
  }
}

export function startCacheMaintenance(config: ShuvcrawlConfig['cache'], logger: Logger): void {
  if (!config.enabled) return;
  const pruner = new CachePruner(config.dir, config.ttl);
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const result = await pruner.sweep();
      if (result.deleted > 0) logger.info('cache.expired.reclaimed', result);
    } catch (error) {
      logger.warn('cache.expired.reclaim_failed', { error: String(error) });
    } finally {
      running = false;
    }
  };
  setInterval(sweep, 30_000).unref();
  void sweep();
}
