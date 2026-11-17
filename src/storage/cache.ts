import { readFile, writeFile, readdir, unlink, stat, mkdir, rename, open } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { expandHome } from '../utils/paths.ts';
import type { ScrapeResult } from '../core/scraper.ts';

export type CacheKeyInput = {
  url: string;
  format: string;
  mobile: boolean;
  fastPath: boolean;
  bpc: boolean;
  selector?: string | null;
  proxy?: string | null;
  wait?: string | null;
  waitFor?: string | null;
  sleep?: number | null;
  headers?: Record<string, string> | null;
  onlyMainContent?: boolean | null;
  rawHtml?: boolean;
};

export type CacheEntry = {
  key: string;
  cachedAt: number;
  result: ScrapeResult;
};

const pendingCacheOperations = new Map<string, Promise<void>>();

// Serialize expiry and publication for one entry among callers in this process.
export async function withCacheEntryLock<T>(cachePath: string, operation: () => Promise<T>): Promise<T> {
  const file = path.resolve(expandHome(cachePath));
  const previous = pendingCacheOperations.get(file) ?? Promise.resolve();
  let release!: () => void;
  const lock = new Promise<void>(resolve => { release = resolve; });
  const pending = previous.then(() => lock);
  pendingCacheOperations.set(file, pending);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (pendingCacheOperations.get(file) === pending) pendingCacheOperations.delete(file);
  }
}

export async function readCacheEntry(cachePath: string): Promise<{ entry: CacheEntry; stats: Stats }> {
  const file = await open(cachePath, 'r');
  try {
    const entry = JSON.parse(await file.readFile('utf8')) as CacheEntry;
    return { entry, stats: await file.stat() };
  } finally {
    await file.close();
  }
}

export async function removeCacheEntry(cachePath: string, observed: Stats): Promise<boolean> {
  const current = await stat(cachePath);
  if (current.dev !== observed.dev || current.ino !== observed.ino ||
      current.mtimeMs !== observed.mtimeMs || current.size !== observed.size) return false;
  await unlink(cachePath);
  return true;
}

export function buildCacheKey(input: CacheKeyInput): string {
  return JSON.stringify({
    url: input.url,
    format: input.format,
    mobile: input.mobile,
    fastPath: input.fastPath,
    bpc: input.bpc,
    selector: input.selector ?? null,
    proxy: input.proxy ?? null,
    wait: input.wait ?? null,
    waitFor: input.waitFor ?? null,
    sleep: input.sleep ?? null,
    headers: input.headers ?? null,
    onlyMainContent: input.onlyMainContent ?? null,
    rawHtml: input.rawHtml ?? false,
  });
}

export function hashCacheKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export async function readCache(
  cacheDir: string,
  key: string,
  ttl: number,
): Promise<ScrapeResult | null> {
  const expandedDir = expandHome(cacheDir);
  const hash = hashCacheKey(key);
  const cachePath = path.join(expandedDir, `${hash}.json`);

  return withCacheEntryLock(cachePath, async () => {
    try {
      const { entry, stats } = await readCacheEntry(cachePath);

      // Verify key matches to detect hash collision
      if (entry.key !== key) {
        // Hash collision - treat as cache miss
        return null;
      }

      // Check TTL
      const now = Date.now();
      if (now - entry.cachedAt > ttl * 1000) {
        await removeCacheEntry(cachePath, stats);
        return null;
      }

      return entry.result;
    } catch {
      // File doesn't exist or is corrupt - cache miss
      return null;
    }
  });
}

export async function writeCache(
  cacheDir: string,
  key: string,
  result: ScrapeResult,
): Promise<void> {
  const expandedDir = expandHome(cacheDir);
  const hash = hashCacheKey(key);
  const cachePath = path.join(expandedDir, `${hash}.json`);
  return withCacheEntryLock(cachePath, async () => {
    await mkdir(expandedDir, { recursive: true });

    const entry: CacheEntry = {
      key,
      cachedAt: Date.now(),
      result,
    };

    const temporaryPath = `${cachePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(entry, null, 2), 'utf8');
      await rename(temporaryPath, cachePath);
    } finally {
      await unlink(temporaryPath).catch(() => {});
    }
  });
}

export async function listCache(cacheDir: string): Promise<Array<{ hash: string; key: string; cachedAt: number; size: number }>> {
  const expandedDir = expandHome(cacheDir);

  try {
    const entries = await readdir(expandedDir, { withFileTypes: true });
    const results: Array<{ hash: string; key: string; cachedAt: number; size: number }> = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

      const hash = entry.name.slice(0, -5); // Remove .json
      const cachePath = path.join(expandedDir, entry.name);

      try {
        const [content, stats] = await Promise.all([
          readFile(cachePath, 'utf8'),
          stat(cachePath),
        ]);

        const cacheEntry: CacheEntry = JSON.parse(content);
        results.push({
          hash,
          key: cacheEntry.key,
          cachedAt: cacheEntry.cachedAt,
          size: stats.size,
        });
      } catch {
        // Skip corrupt entries
      }
    }

    return results.sort((a, b) => b.cachedAt - a.cachedAt);
  } catch {
    return [];
  }
}

export async function clearCache(
  cacheDir: string,
  olderThan?: number,
): Promise<{ deleted: number; skipped: number }> {
  const expandedDir = expandHome(cacheDir);
  try {
    const entries = await readdir(expandedDir, { withFileTypes: true });
    let deleted = 0;
    let skipped = 0;
    const cutoff = olderThan ? Date.now() - olderThan * 1000 : 0;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        skipped++;
        continue;
      }
      const cachePath = path.join(expandedDir, entry.name);
      const removed = await withCacheEntryLock(cachePath, async () => {
        try {
          if (olderThan) {
            try {
              const cached = await readCacheEntry(cachePath);
              if (cached.entry.cachedAt >= cutoff) return false;
              return await removeCacheEntry(cachePath, cached.stats);
            } catch (error) {
              if (!(error instanceof SyntaxError)) throw error;
            }
          }
          await unlink(cachePath);
          return true;
        } catch {
          return false;
        }
      });
      if (removed) deleted++;
      else skipped++;
    }
    return { deleted, skipped };
  } catch {
    return { deleted: 0, skipped: 0 };
  }
}

export async function getCacheStats(cacheDir: string): Promise<{ entries: number; totalSize: number }> {
  const entries = await listCache(cacheDir);
  return {
    entries: entries.length,
    totalSize: entries.reduce((sum, e) => sum + e.size, 0),
  };
}
