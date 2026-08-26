import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { installCompatibleChrome } from '../src';
import { runCli } from './cli-support';

const requestedExecutablePath =
  process.env.PPTR_EXECUTABLE_PATH?.trim() || undefined;
if (requestedExecutablePath && !existsSync(requestedExecutablePath)) {
  throw new Error(
    `PPTR_EXECUTABLE_PATH does not exist: ${requestedExecutablePath}`,
  );
}
const executablePath =
  process.env.PPTR_FORCE_MANAGED === 'true'
    ? undefined
    : [
        requestedExecutablePath,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
      ].find((value): value is string => Boolean(value && existsSync(value)));
const autoInstall = process.env.PPTR_AUTO_INSTALL === 'true';
const describeWithChrome =
  executablePath || autoInstall ? describe : describe.skip;
const getExecutablePath = async (): Promise<string> =>
  executablePath ??
  (await installCompatibleChrome({ cacheDir: process.env.PPTR_CACHE_DIR }))
    .executablePath;

describeWithChrome('JSON CLI with Chrome', () => {
  test('extracts structured data and returns lifecycle events', async () => {
    const chromePath = await getExecutablePath();
    const result = await runCli(
      [],
      JSON.stringify({
        action: 'extract',
        fields: {
          heading: { selector: 'h1' },
          title: { page: 'title' },
        },
        includeEvents: true,
        renderer: { executablePath: chromePath },
        task: {
          source: { html: '<title>CLI</title><h1>Extracted</h1>' },
        },
      }),
    );
    const output = JSON.parse(result.stdout) as {
      events: Array<{ type: string }>;
      result: { data: Record<string, string>; metadata: { taskId: string } };
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(output.result.data).toEqual({ heading: 'Extracted', title: 'CLI' });
    expect(output.result.metadata.taskId).toEqual(expect.any(String));
    expect(output.events.map(event => event.type)).toEqual(
      expect.arrayContaining(['task.queued', 'task.started', 'task.succeeded']),
    );
  }, 30_000);

  test('serializes batch images, output paths, and partial failures', async () => {
    const chromePath = await getExecutablePath();
    const directory = await mkdtemp(join(tmpdir(), 'pptr-helper-cli-browser-'));
    const outputPath = join(directory, 'output.png');
    const diffPath = join(directory, 'diff.png');

    try {
      const result = await runCli(
        [],
        JSON.stringify({
          action: 'batch',
          concurrency: 1,
          renderer: { executablePath: chromePath },
          tasks: [
            {
              action: 'image',
              id: 'base64-image',
              task: {
                source: { html: '<main>base64</main>' },
                viewport: { height: 80, width: 120 },
              },
            },
            {
              action: 'image',
              id: 'file-image',
              task: {
                output: { path: outputPath },
                source: { html: '<main>file</main>' },
                viewport: { height: 80, width: 120 },
              },
            },
            {
              action: 'compare',
              id: 'matching-image',
              task: {
                baseline: outputPath,
                diffPath,
                source: { html: '<main>file</main>' },
                viewport: { height: 80, width: 120 },
              },
            },
            {
              action: 'extract',
              fields: { broken: { selector: '[' } },
              id: 'failed-extract',
              task: { source: { html: '<main>failure</main>' } },
            },
          ],
        }),
      );
      const output = JSON.parse(result.stdout) as Array<{
        error?: { message: string };
        id: string;
        result?: { base64?: string; outputPath?: string };
        diffPath?: string;
        passed?: boolean;
        status: string;
      }>;

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(output).toMatchObject([
        { id: 'base64-image', status: 'fulfilled' },
        { id: 'file-image', status: 'fulfilled' },
        { id: 'matching-image', status: 'fulfilled' },
        { id: 'failed-extract', status: 'rejected' },
      ]);
      expect(
        Buffer.from(output[0].result?.base64 ?? '', 'base64').subarray(0, 8),
      ).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(output[1].result?.outputPath).toBe(outputPath);
      expect((await readFile(outputPath)).subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
      expect(output[2].result).toMatchObject({
        diffPath,
        passed: true,
      });
      expect((await readFile(diffPath)).subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
      expect(output[3].error?.message).toEqual(expect.any(String));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);
});
