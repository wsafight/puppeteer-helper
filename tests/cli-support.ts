import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export interface CliResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

export const runCli = async (
  args: readonly string[] = [],
  input?: string,
): Promise<CliResult> =>
  new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [resolve('bin/pptr-helper.mjs'), ...args],
      {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', code => {
      resolveResult({
        code,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      });
    });
    child.stdin.end(input);
  });
