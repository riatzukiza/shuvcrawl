import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, fstatSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

async function exchangeThroughBrowserPipes(): Promise<void> {
  const child = spawn(
    '/bin/sh',
    ['-c', 'printf ready >&3; read -r reply <&4; [ "$reply" = ack ]'],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] },
  );
  const [output, input] = [child.stdio[3], child.stdio[4]];
  if (!(output instanceof Readable) || !(input instanceof Writable)) {
    throw new Error('Chromium-style stdio pipes were not created');
  }

  child.stdout?.resume();
  child.stderr?.resume();
  const exit = once(child, 'close');
  const reply = (async () => {
    let message = '';
    for await (const chunk of output) message += chunk.toString();
    return message;
  })();
  input.end('ack\n');

  const [[code], message] = await Promise.all([exit, reply]);
  expect(code).toBe(0);
  expect(message).toBe('ready');
}

test.skipIf(process.platform !== 'linux')(
  'Chromium-style extra stdio does not close unrelated descriptors after GC',
  async () => {
    // Patchright uses extra stdio slots 3 and 4 for its Chromium DevTools pipe.
    // The retired child must release those slots without closing their next owners.
    const directory = mkdtempSync(join(tmpdir(), 'shuvcrawl-browser-pipes-'));
    let invalidated = 0;
    try {
      for (let round = 0; round < 80; round++) {
        await exchangeThroughBrowserPipes();
        await Bun.sleep(10);
        const files = Array.from({ length: 16 }, (_, index) => {
          const fd = openSync(join(directory, `${round}-${index}`), 'a');
          return { fd, inode: fstatSync(fd).ino };
        });
        Bun.gc(true);
        await Bun.sleep(10);
        Bun.gc(true);

        for (const { fd, inode } of files) {
          try {
            if (fstatSync(fd).ino === inode) closeSync(fd);
            else invalidated++;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error;
            invalidated++;
          }
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(invalidated).toBe(0);
  },
  30_000,
);
