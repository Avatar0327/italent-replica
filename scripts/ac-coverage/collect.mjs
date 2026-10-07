// 按配置的各档（如 pglite / pg）并行起子进程收集，再按“文件 + 标题层级 + 同名序号”合并成每个用例在各档的状态。
// 真 PG 专属用例（describe.runIf(TEST_DATABASE_URL)）在 pg 档为 run、在 pglite 档为 skip；收集不执行钩子，不连库。
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./collect-worker.mjs', import.meta.url));

function profileEnv(profile) {
  const env = { ...process.env };
  for (const key of profile.unset ?? []) delete env[key];
  return { ...env, ...profile.set };
}

function runWorker(config, name, profile, out) {
  const args = JSON.stringify({ root: config.root, vitestConfig: config.vitestConfig, filters: config.filters, out });
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [WORKER, args], { cwd: config.root, env: profileEnv(profile) });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(JSON.parse(readFileSync(out, 'utf8')));
      else reject(new Error(`收集档 ${name} 失败（退出码 ${code}）：\n${output}`));
    });
  });
}

function mergeProfiles(names, results) {
  const tests = new Map();
  const errors = new Map();
  results.forEach((result, index) => {
    const seen = new Map();
    for (const test of result.tests) {
      const base = `${test.file}\u0000${JSON.stringify(test.names)}`;
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      const key = `${base}\u0000${occurrence}`;
      if (!tests.has(key)) tests.set(key, { file: test.file, names: test.names, line: test.line, modes: {} });
      tests.get(key).modes[names[index]] = test.mode;
    }
    for (const error of result.errors) {
      const key = `${error.file}\u0000${error.message}`;
      if (!errors.has(key)) errors.set(key, { ...error, profiles: [] });
      errors.get(key).profiles.push(names[index]);
    }
  });
  return { tests: [...tests.values()], errors: [...errors.values()] };
}

function profileStats(result) {
  const stats = { files: result.files, run: 0, skip: 0, todo: 0 };
  for (const test of result.tests) stats[test.mode] += 1;
  return stats;
}

export async function collectProfiles(config) {
  const names = Object.keys(config.profiles);
  const dir = mkdtempSync(join(tmpdir(), 'ac-coverage-collect-'));
  try {
    const results = await Promise.all(
      names.map((name, i) => runWorker(config, name, config.profiles[name], join(dir, `${i}.json`))),
    );
    const stats = Object.fromEntries(names.map((name, i) => [name, profileStats(results[i])]));
    return { profiles: names, stats, ...mergeProfiles(names, results) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
