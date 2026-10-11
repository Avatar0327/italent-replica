import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'node_modules/vitest/vitest.mjs');
const config = fileURLToPath(new URL('./support/route-policy/registry-regression.config.ts', import.meta.url));
const files = [
  'AC-PRM-FW-02-required',
  'AC-PRM-FW-02-disclosure',
  'AC-PRM-FW-02-binding',
  'AC-PRM-FW-08.discovery',
  'AC-PRM-FW-02-qualification-subset',
  'AC-PRM-FW-02-qualification',
  'AC-PRM-FW-02-survey360',
].map((name) => `tests/acceptance/${name}.test.ts`);

interface Result {
  readonly numFailedTests: number;
  readonly numPassedTests: number;
  readonly testResults: readonly { readonly status: string; readonly message: string }[];
}

async function run(omission: string, strict: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'f090b-entries-'));
  const report = join(dir, 'result.json');
  const env = { ...process.env, ROUTE_POLICY_TEST_OMISSION: omission };
  delete env['ROUTE_POLICY_UPDATE_BASELINE'];
  delete env['ROUTE_POLICY_UPDATE_DIGESTS'];
  delete env['ROUTE_POLICY_EVIDENCE_STRICT'];
  if (strict) env['ROUTE_POLICY_EVIDENCE_STRICT'] = '1';
  const args = [
    cli,
    'run',
    ...files,
    '--config',
    config,
    '--testTimeout=180000',
    '--hookTimeout=600000',
    '--disableConsoleIntercept',
    '--silent=false',
    '--reporter=json',
    '--outputFile',
    report,
  ];
  if (strict) args.push('-t', '真实声明.*(真实表|零发现)|表键.*端点');
  let exitCode = 0;
  let output = '';
  try {
    try {
      const result = await execute(process.execPath, args, { cwd: root, env, maxBuffer: 16 * 1024 * 1024 });
      output = result.stdout + result.stderr;
    } catch (error) {
      const failure = error as { code: number; stdout: string; stderr: string };
      exitCode = failure.code;
      output = failure.stdout + failure.stderr;
    }
    const result = JSON.parse(await readFile(report, 'utf8')) as Result;
    return { exitCode, output, result };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('AC-PRM-FW-F090b 真实入口漏登记：七个局部文件完整回归（DEC-416③；#248 P2-1）', () => {
  it.each(['endpoints', 'guard-inner'])(
    '%s：默认整组通过只警告，严格模式在真实入口判红',
    async (omission) => {
      const normal = await run(omission, false);
      expect(normal.exitCode, normal.output).toBe(0);
      expect(normal.result.numFailedTests, normal.output).toBe(0);
      expect(normal.result.numPassedTests).toBeGreaterThan(100);
      expect(normal.result.testResults).toHaveLength(files.length);
      expect(normal.output).toContain('[证据门禁·警告]');
      expect(normal.output).toContain(omission === 'endpoints' ? 'REQUIRED_ENTRY_MISSING' : 'GUARD_ROLE_UNBOUND');

      const strict = await run(omission, true);
      expect(strict.exitCode).toBe(1);
      expect(strict.result.numFailedTests).toBeGreaterThan(0);
      const messages = strict.result.testResults.map((result) => result.message).join('\n') + strict.output;
      expect(messages).toContain('AssertionError');
      expect(messages).toContain(omission === 'endpoints' ? 'REQUIRED_ENTRY_MISSING' : 'GUARD_ROLE_UNBOUND');
      expect(messages).not.toMatch(/Hook timed out|Test timed out/);
    },
    600_000,
  );
});
