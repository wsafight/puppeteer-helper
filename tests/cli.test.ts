import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { runCli } from './cli-support';

describe('JSON CLI', () => {
  test('prints help without reading stdin', async () => {
    const result = await runCli(['--help']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      'Actions: image, pdf, extract, compare, batch',
    );
  });

  test('prints the CLI request schema', async () => {
    const result = await runCli(['schema']);
    const schema = JSON.parse(result.stdout) as {
      $id: string;
      oneOf: unknown[];
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(schema.$id).toContain('cli-request.json');
    expect(schema.oneOf.length).toBeGreaterThan(0);
  });

  test('accepts stdin and serializes an empty batch with events', async () => {
    const result = await runCli(
      [],
      JSON.stringify({ action: 'batch', includeEvents: true, tasks: [] }),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ events: [], result: [] });
  });

  test('accepts file input and returns a structured error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pptr-helper-cli-'));
    const inputPath = join(directory, 'request.json');

    try {
      await writeFile(inputPath, JSON.stringify({ action: 'unsupported' }));
      const result = await runCli(['--input', inputPath]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: {
          code: 'CLI_VALIDATION',
          issues: expect.any(Array),
          name: 'CliValidationError',
        },
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('reports malformed JSON through the same error protocol', async () => {
    const result = await runCli([], '{');

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { name: 'SyntaxError' },
    });
  });

  test('streams NDJSON results and continues after a rejected line', async () => {
    const result = await runCli(
      ['--ndjson'],
      [
        JSON.stringify({ action: 'batch', tasks: [] }),
        JSON.stringify({ action: 'unsupported' }),
        '',
        JSON.stringify({ action: 'batch', tasks: [] }),
      ].join('\n'),
    );
    const lines = result.stdout
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));

    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    expect(lines).toMatchObject([
      { line: 1, result: [], status: 'fulfilled' },
      {
        error: { code: 'CLI_VALIDATION' },
        line: 2,
        status: 'rejected',
      },
      { line: 4, result: [], status: 'fulfilled' },
    ]);
  });
});
