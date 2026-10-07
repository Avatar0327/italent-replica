// 按配置的各档（如 pglite / pg）并行起子进程收集，再按用例身份把各档结果 join 成每个用例在各档的状态（DEC-282）。
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

const identityKey = (test) => JSON.stringify([test.file, test.names, test.location]);
const describeTest = (test) => `${test.file}：${test.names.join(' > ')}（${test.location ?? '未知位置'}）`;

/**
 * 一个身份在各档的注册无法确认是同一个用例时返回问题说明，否则返回 null：
 * - 身份冲突：任一档内该身份（或其祖先 suite）注册多次，或缺少注册位置；
 * - 各档对不上：只在部分档注册，或各档的祖先 suite 注册位置不同。
 */
function identityProblem(profiles, byProfile) {
  const registrations = [...byProfile].flatMap(([profile, tests]) => tests.map((test) => [profile, test]));
  const [, first] = registrations[0];
  const conflicts = registrations.filter(([, t]) => t.conflict).map(([profile, t]) => `${profile} 档：${t.conflict}`);
  if (first.location === null) conflicts.push('缺少注册位置');
  if (conflicts.length) return `${describeTest(first)} 身份冲突（${[...new Set(conflicts)].join('；')}），不跨档合并`;
  if (byProfile.size < profiles.length) {
    return `${describeTest(first)} 各档对不上：只在 ${[...byProfile.keys()].join(' / ')} 档注册，不跨档合并`;
  }
  const ancestries = registrations.map(([profile, t]) => `${profile} 档 ${t.ancestors.join(' > ') || '顶层'}`);
  if (new Set(registrations.map(([, t]) => JSON.stringify(t.ancestors))).size > 1) {
    return `${describeTest(first)} 各档对不上：祖先 suite 注册位置不同（${ancestries.join('；')}），不跨档合并`;
  }
  return null;
}

const recordOf = (test, modes, only) => ({
  file: test.file,
  names: test.names,
  location: test.location,
  ancestors: test.ancestors,
  modes,
  only,
});

/**
 * 跨档 join（DEC-282）：用例身份 = 文件 + 完整名称路径 + 注册位置（行:列），各档按身份 join，祖先 suite 的注册位置也须一致。
 * 认不出同一个用例时不按注册顺序或序号配对：每个注册各自计入它所在的档，并列为 identity 问题，--check 失败。
 */
function joinProfiles(profiles, results) {
  const groups = new Map();
  results.forEach((result, index) => {
    for (const test of result.tests) {
      if (!groups.has(identityKey(test))) groups.set(identityKey(test), new Map());
      const byProfile = groups.get(identityKey(test));
      byProfile.set(profiles[index], [...(byProfile.get(profiles[index]) ?? []), test]);
    }
  });
  const tests = [];
  const identity = [];
  for (const byProfile of groups.values()) {
    const problem = identityProblem(profiles, byProfile);
    const entries = [...byProfile];
    if (problem) {
      identity.push({ file: entries[0][1][0].file, message: problem });
      for (const [profile, list] of entries)
        for (const t of list) tests.push(recordOf(t, { [profile]: t.mode }, t.only));
    } else {
      const modes = Object.fromEntries(entries.map(([profile, [t]]) => [profile, t.mode]));
      tests.push(
        recordOf(
          entries[0][1][0],
          modes,
          entries.some(([, [t]]) => t.only),
        ),
      );
    }
  }
  return { tests, identity };
}

/** 各档报出的同一问题（收集错误或 only 注册）合并为一条，记下出现在哪些档。 */
function mergeAcrossProfiles(profiles, results, field, keyOf) {
  const merged = new Map();
  results.forEach((result, index) => {
    for (const item of result[field] ?? []) {
      if (!merged.has(keyOf(item))) merged.set(keyOf(item), { ...item, profiles: [] });
      merged.get(keyOf(item)).profiles.push(profiles[index]);
    }
  });
  return [...merged.values()];
}

function profileStats(result) {
  const stats = { files: result.files, run: 0, skip: 0, todo: 0, only: (result.onlyNodes ?? []).length };
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
    return {
      profiles: names,
      stats,
      ...joinProfiles(names, results),
      errors: mergeAcrossProfiles(names, results, 'errors', (e) => `${e.file}\u0000${e.message}`),
      onlyNodes: mergeAcrossProfiles(names, results, 'onlyNodes', (n) => JSON.stringify([n.file, n.names, n.location])),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
