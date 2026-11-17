import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CachePruner } from '../../src/storage/cache-maintenance.ts';
import { hashCacheKey, readCache, writeCache, withCacheEntryLock, readCacheEntry, removeCacheEntry } from '../../src/storage/cache.ts';
import type { ScrapeResult } from '../../src/core/scraper.ts';

describe('cache expiry reclamation', () => {
  let directory: string;
  let pruner: CachePruner;
  const result = { content: '# Fresh' } as ScrapeResult;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'shuvcrawl-expiry-'));
    pruner = new CachePruner(directory, 3600);
  });

  afterEach(async () => {
    await pruner.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function seedExpired(key: string) {
    const file = path.join(directory, `${hashCacheKey(key)}.json`);
    await writeFile(file, JSON.stringify({ key, cachedAt: Date.now() - 7200_000, result }));
    await utimes(file, new Date(Date.now() - 7200_000), new Date(Date.now() - 7200_000));
    return file;
  }

  it('unlinks an expired legacy entry when it is read', async () => {
    const file = await seedExpired('old');
    expect(await readCache(directory, 'old', 3600)).toBeNull();
    expect(await Bun.file(file).exists()).toBe(false);
  });

  it('bounds every sweep and advances through entries it has not examined', async () => {
    for (let index = 0; index < 9; index++) await seedExpired(`old-${index}`);
    await writeCache(directory, 'fresh', result);
    await writeFile(path.join(directory, 'keep.txt'), 'unrelated');
    await writeFile(path.join(directory, 'unfinished.tmp'), 'incomplete cache write');
    let deleted = 0;
    for (let batch = 0; batch < 8; batch++) {
      const stats = await pruner.sweep(2);
      expect(stats.scanned).toBeLessThanOrEqual(2);
      deleted += stats.deleted;
    }
    expect(deleted).toBe(9);
    expect(await readCache(directory, 'fresh', 3600)).toEqual(result);
    expect(await readFile(path.join(directory, 'keep.txt'), 'utf8')).toBe('unrelated');
    expect(await Bun.file(path.join(directory, 'unfinished.tmp')).exists()).toBe(true);
  });

  it('serializes refresh and expiry so a refreshed entry survives', async () => {
    await seedExpired('same-key');
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const held = withCacheEntryLock(path.join(directory, `${hashCacheKey("same-key")}.json`), async () => { entered(); await barrier; });
    await ready;
    const refresh = writeCache(directory, 'same-key', result);
    const expire = pruner.sweep();
    const read = readCache(directory, 'same-key', 3600);
    release();
    await Promise.all([held, refresh, expire]);
    expect(await read).toEqual(result);
    expect(await readCache(directory, 'same-key', 3600)).toEqual(result);
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('allows concurrent publication after stale deletion', async () => {
    await seedExpired('same-key');
    await Promise.all([pruner.sweep(), writeCache(directory, 'same-key', result)]);
    expect(await readCache(directory, 'same-key', 3600)).toEqual(result);
  });

  it('keeps a replacement whose identity changed after an expiry read', async () => {
    const file = await seedExpired('same-key');
    const observed = await readCacheEntry(file);
    await writeCache(directory, 'same-key', result);
    expect(await removeCacheEntry(file, observed.stats)).toBe(false);
    expect(await readCache(directory, 'same-key', 3600)).toEqual(result);
  });

  it('skips recently written files before inspecting expired cache data', async () => {
    const file = await seedExpired('recent-copy');
    await utimes(file, new Date(), new Date());
    expect((await pruner.sweep()).deleted).toBe(0);
    expect(await Bun.file(file).exists()).toBe(true);
    expect(await readCache(directory, 'recent-copy', 3600)).toBeNull();
    expect(await Bun.file(file).exists()).toBe(false);
  });

  it('allows other entries to be published while a sweep waits for one entry', async () => {
    const file = await seedExpired('blocked');
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const held = withCacheEntryLock(file, async () => { entered(); await barrier; });
    await ready;
    const sweep = pruner.sweep();
    try {
      await writeCache(directory, 'independent', result);
      expect(await readCache(directory, 'independent', 3600)).toEqual(result);
    } finally {
      release();
      await Promise.all([held, sweep]);
    }
  });

  it('handles an absent cache directory and a directory created later', async () => {
    await rm(directory, { recursive: true });
    expect(await pruner.sweep()).toEqual({ scanned: 0, deleted: 0 });
    await writeCache(directory, 'fresh', result);
    expect((await pruner.sweep()).scanned).toBe(1);
  });
});
