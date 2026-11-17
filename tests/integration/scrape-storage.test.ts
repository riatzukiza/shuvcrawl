import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApi } from '../../src/api/routes.ts';
import { defaultConfig } from '../../src/config/defaults.ts';
import { Engine } from '../../src/core/engine.ts';
import { createLogger } from '../../src/utils/logger.ts';
import type { ShuvcrawlConfig } from '../../src/config/schema.ts';

let directory: string;
let fixture: ReturnType<typeof Bun.serve>;
let engine: Engine;
let app: ReturnType<typeof buildApi>;
let config: ShuvcrawlConfig;
const html = '<html><head><title>Stored Article</title></head><body><h1>Stored Article</h1><p>Durable Markdown with a useful page.</p><a href="/next">Next page</a></body></html>';

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'shuvcrawl-storage-'));
  fixture = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
  config = structuredClone(defaultConfig);
  config.cache.enabled = false;
  config.crawl.delay = 0;
  config.crawl.respectRobots = false;
  config.fastPath.minContentLength = 0;
  config.output.dir = path.join(directory, 'output');
  config.artifacts.dir = path.join(directory, 'artifacts');
  config.browser.runtimeProfile = path.join(directory, 'browser');
  config.storage.jobDbPath = ':memory:';
  config.telemetry.exporter = 'none';
  engine = new Engine(config, createLogger('error'));
  app = buildApi(engine, config);
});

afterEach(async () => {
  fixture.stop(true);
  await rm(directory, { recursive: true, force: true });
});

async function scrape(options: Record<string, boolean>) {
  const response = await app.request('http://localhost/scrape', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: `http://127.0.0.1:${fixture.port}/article`,
      options: { rawHtml: true, onlyMainContent: false, ...options },
    }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

test('existing API defaults persist Markdown, JSON, metadata and artifacts', async () => {
  const body = await scrape({});
  expect(await Bun.file(body.output.jsonPath).exists()).toBe(true);
  expect(await Bun.file(body.output.markdownPath).text()).toContain('# Stored Article');
  expect(await Bun.file(body.output.metaPath).text()).toContain(body.meta.requestId);
  expect(await Bun.file(path.join(body.data.artifacts.dir, 'raw.html')).text()).toBe(html);
});

test('batch API callers receive Markdown, raw HTML and links with persistence disabled', async () => {
  const body = await scrape({ persistOutput: false, artifacts: false });
  expect(body.success).toBe(true);
  expect(body.output).toEqual({});
  expect(body.data.content).toContain('# Stored Article');
  expect(body.data.rawHtml).toBe(html);
  expect(body.data.links).toContain(`http://127.0.0.1:${fixture.port}/next`);
  expect(body.data.artifacts).toBeUndefined();
  expect(await Bun.file(path.join(directory, 'output')).exists()).toBe(false);
  expect(await Bun.file(path.join(directory, 'artifacts')).exists()).toBe(false);
});

test('explicit debug artifacts remain available with routine persistence disabled', async () => {
  config.artifacts.enabled = false;
  const body = await scrape({ persistOutput: false, artifacts: false, debugArtifacts: true });
  expect(body.output).toEqual({});
  expect(await Bun.file(path.join(body.data.artifacts.dir, 'raw.html')).text()).toBe(html);
  expect(await Bun.file(path.join(body.data.artifacts.dir, 'clean.html')).text()).toContain('Stored Article');
});

test('the artifacts option preserves a deployment with globally disabled diagnostics', async () => {
  config.artifacts.enabled = false;
  const body = await scrape({ persistOutput: false, artifacts: true });
  expect(body.data.artifacts).toBeUndefined();
  expect(await Bun.file(path.join(directory, 'artifacts')).exists()).toBe(false);
});
