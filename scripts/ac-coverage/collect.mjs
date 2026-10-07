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

/**
 * 跨档配对：同一注册点 = 文件 + 注册位置（行:列）+ 完整标题层级。只在某一档注册的用例只带该档状态。
 * 同一注册点在各档注册次数不同（如循环里按条件注册同名用例）时无法可靠配对，列为问题。
 */
function mergeProfiles(names, results) {
  const groups = new Map();
  results.forEach((result, index) => {
    for (const test of result.tests) {
      const key = JSON.stringify([test.file, test.location, test.names]);
      if (!groups.has(key)) groups.set(key, { file: test.file, names: test.names, location: test.location, modes: {} });
      (groups.get(key).modes[names[index]] ??= []).push(test.mode);
    }
  });
  const tests = [];
  const pairing = [];
  for (const group of groups.values()) {
    const counts = Object.entries(group.modes).map(([profile, modes]) => `${profile} ${modes.length} 次`);
    if (group.location === null || new Set(Object.values(group.modes).map((m) => m.length)).size > 1) {
      const where = group.location ?? '未知位置';
      pairing.push({
        file: group.file,
        message: `${group.names.join(' > ')}（${where}）无法跨档配对：${counts.join('、')}`,
      });
    }
    const times = Math.max(...Object.values(group.modes).map((m) => m.length));
    for (let i = 0; i < times; i++) {
      const modes = Object.entries(group.modes).filter(([, list]) => i < list.length);
      tests.push({ ...group, modes: Object.fromEntries(modes.map(([profile, list]) => [profile, list[i]])) });
    }
  }
  return { tests, pairing, errors: mergeErrors(names, results) };
}

function mergeErrors(names, results) {
  const errors = new Map();
  results.forEach((result, index) => {
    for (const error of result.errors) {
      const key = `${error.file}\u0000${error.message}`;
      if (!errors.has(key)) errors.set(key, { ...error, profiles: [] });
      errors.get(key).profiles.push(names[index]);
    }
  });
  return [...errors.values()];
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
