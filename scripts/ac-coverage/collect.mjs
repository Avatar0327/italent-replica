// 按配置的各档（如 pglite / pg）并行起子进程收集，再按用例身份把各档结果 join 成每个用例在各档的状态（DEC-282）。
// 身份无法确认的注册一律报 identity 并逐条列出，不合并、不推断、不计入覆盖（DEC-282 补充，#102 第 4 轮）。
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

/** 采集结果的格式版本：字段或含义变化时加一；--from-collected 只接受同一版本（#102 第 3 轮 P3）。 */
export const COLLECTED_FORMAT_VERSION = 1;

const identityKey = (test) => JSON.stringify([test.file, test.names, test.location]);
const projectOf = (registration) => (registration.project ? `（project ${registration.project}）` : '');
const ancestryOf = ({ ancestors }) =>
  Array.isArray(ancestors) ? ancestors.map((a) => a ?? '未知').join(' > ') || '顶层' : '缺失';

function describeRegistration(registration) {
  const { profile, mode, location } = registration;
  return `${profile} 档${projectOf(registration)} ${mode}，位置 ${location ?? '未知'}，祖先位置 ${ancestryOf(registration)}`;
}

/** 用例或任一祖先 suite 的注册位置未知（null / 缺失）：未知不等于相同，无法确认是同一个用例（DEC-282 补充）。 */
function unknownLocations(registrations) {
  const reasons = [];
  for (const { names, location, ancestors } of registrations) {
    if (location === null || location === undefined) reasons.push('用例注册位置未知');
    if (!Array.isArray(ancestors)) reasons.push('祖先 suite 注册位置缺失');
    else {
      ancestors.forEach((ancestor, i) => {
        if (ancestor === null || ancestor === undefined) {
          reasons.push(`祖先 suite「${names.slice(0, i + 1).join(' > ')}」注册位置未知`);
        }
      });
    }
  }
  return reasons.map((reason) => `位置未知：${reason}`);
}

/** 同一档内重复：worker 在整档范围查出的父套件 / 用例重复，以及按身份分组后同一档出现多条注册。 */
function duplicates(byProfile) {
  const reasons = [];
  for (const [profile, tests] of byProfile) {
    const conflicts = tests.filter((t) => t.conflict).map((t) => `身份冲突：${profile} 档：${t.conflict}`);
    reasons.push(...conflicts);
    if (tests.length > 1 && conflicts.length === 0) {
      reasons.push(`身份冲突：${profile} 档注册 ${tests.length} 次（位置 ${tests[0].location}）`);
    }
  }
  return reasons;
}

/**
 * 一个身份（文件 + 完整名称路径 + 位置）的各档注册无法确认是同一个用例的原因；没有原因才能跨档合并（DEC-282）：
 * 位置未知、同档重复（含跨 module）、跨 project 同名、只在部分档注册、各档祖先 suite 位置不同。
 */
function identityReasons(profiles, byProfile, registrations) {
  const reasons = [...unknownLocations(registrations), ...duplicates(byProfile)];
  const projects = [...new Set(registrations.map((r) => r.project ?? ''))];
  if (projects.length > 1) reasons.push(`跨 project 同名：${projects.map((p) => p || '（未命名）').join(' / ')}`);
  if (byProfile.size < profiles.length) reasons.push(`各档对不上：只在 ${[...byProfile.keys()].join(' / ')} 档注册`);
  if (new Set(registrations.map((r) => JSON.stringify(r.ancestors ?? null))).size > 1) {
    reasons.push('各档对不上：祖先 suite 注册位置不同');
  }
  return [...new Set(reasons)];
}

const registrationOf = (profile, test) => ({
  profile,
  project: test.project ?? '',
  file: test.file,
  names: test.names,
  location: test.location ?? null,
  ancestors: test.ancestors ?? null,
  mode: test.mode,
  only: test.only,
});

/**
 * 跨档 join（DEC-282 及补充）：用例身份 = 文件 + 完整名称路径 + 注册位置（行:列），各档按身份 join，
 * 祖先 suite 的注册位置与所属 project 也须一致。认不出同一个用例时不合并、不推断哪条对应哪条：
 * 各档注册逐条列在 identity 问题里，不计入覆盖，--check 失败。
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
    const registrations = [...byProfile].flatMap(([profile, list]) => list.map((t) => registrationOf(profile, t)));
    const reasons = identityReasons(profiles, byProfile, registrations);
    const [first] = registrations;
    if (reasons.length) {
      const title = `${first.file}：${first.names.join(' > ')}（${first.location ?? '未知位置'}）`;
      const listed = registrations.map(describeRegistration).join('；');
      const message = `${title} 身份无法确认（${reasons.join('；')}），不跨档合并、不计入覆盖。各档注册：${listed}`;
      identity.push({ file: first.file, message, registrations });
      continue;
    }
    const modes = Object.fromEntries(registrations.map((r) => [r.profile, r.mode]));
    const { profile: _profile, mode: _mode, ...record } = first;
    tests.push({ ...record, modes, only: registrations.some((r) => r.only) });
  }
  return { tests, identity };
}

/** 各档报出的同一问题（收集错误或 only 注册）合并为一条，记下出现在哪些档。 */
function mergeAcrossProfiles(profiles, results, field, keyOf) {
  const merged = new Map();
  results.forEach((result, index) => {
    for (const item of result[field] ?? []) {
      if (!merged.has(keyOf(item))) merged.set(keyOf(item), { ...item, profiles: [] });
      const { profiles: seen } = merged.get(keyOf(item));
      if (!seen.includes(profiles[index])) seen.push(profiles[index]);
    }
  });
  return [...merged.values()];
}

/** 收集统计：各档原样的注册计数，另记收集错误数与身份无法确认、不计入覆盖的注册数。 */
function profileStats(name, result, identity) {
  const excluded = identity.flatMap((item) => item.registrations).filter((r) => r.profile === name).length;
  const stats = { files: result.files, run: 0, skip: 0, todo: 0, only: (result.onlyNodes ?? []).length };
  for (const test of result.tests) stats[test.mode] += 1;
  return { ...stats, errors: (result.errors ?? []).length, excluded };
}

export async function collectProfiles(config) {
  const names = Object.keys(config.profiles);
  const dir = mkdtempSync(join(tmpdir(), 'ac-coverage-collect-'));
  try {
    const results = await Promise.all(
      names.map((name, i) => runWorker(config, name, config.profiles[name], join(dir, `${i}.json`))),
    );
    const joined = joinProfiles(names, results);
    const where = (item) => [item.file, item.project, item.names, item.location];
    return {
      formatVersion: COLLECTED_FORMAT_VERSION,
      profiles: names,
      stats: Object.fromEntries(names.map((name, i) => [name, profileStats(name, results[i], joined.identity)])),
      ...joined,
      errors: mergeAcrossProfiles(names, results, 'errors', (e) => JSON.stringify([...where(e), e.message])),
      onlyNodes: mergeAcrossProfiles(names, results, 'onlyNodes', (n) => JSON.stringify(where(n))),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
