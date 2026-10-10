#!/usr/bin/env node
// F-082 部署目标检查（契约 §6.5，DEC-386；只读，不改库、不做运行时互斥）。
// 用法：node scripts/check-deploy-target.mjs --phase=pre-enable|deploy|post-restore [--code-root=<目录>]
//       数据库连接串取环境变量 DATABASE_URL。账号要求：pre-enable / post-restore 要看到其他会话的 application_name，
//       须是超级用户或 pg_read_all_stats 成员；post-restore 还要读全部租户的数据，须能绕过行级安全（超级用户或
//       BYPASSRLS，只读使用——平台运维命令行用的迁移角色受 FORCE RLS 约束，读不全，会在“检查账号能绕过行级安全”一项失败）。
//       任一项不满足 → 退出码非零，部署 / 启动中止。
//
// 阶段：
// - pre-enable   首次打开开关前：目标库上没有任何应用连接（application_name 以 italent-api: 开头）、已应用迁移与待部署代码
//                一致、待部署代码的开关默认值为 true；
// - deploy       之后每次部署前：待部署代码的开关默认值为 true、迁移不得倒退（不检查连接：开关打开之后各版本可滚动部署）；
// - post-restore 开发期回退（恢复到启用前备份点 / 重建）之后、启动服务之前：没有应用连接、迁移与要启动的代码一致，
//                库里没有 bound 行、没有计算规则的新格式审计、没有含句柄的命令台账结果。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PHASES = ['pre-enable', 'deploy', 'post-restore'];
export const APP_NAME_PREFIX = 'italent-api:';
const SWITCH_FILE = 'apps/api/src/modules/talent-review/formula-binding-switch.ts';
const JOURNAL_FILE = 'packages/db/migrations/meta/_journal.json';
const CALC_RULE_AUDIT_TYPE = 'TalentReview.CalcRule';
const HANDLE = '@{tr-field:';
const defaultRoot = fileURLToPath(new URL('..', import.meta.url));

/** 待部署代码的开关默认值（从源码里读，不执行代码）；找不到定义视为不满足。 */
export function readSwitchDefault(codeRoot) {
  const source = readFileSync(`${codeRoot}/${SWITCH_FILE}`, 'utf8');
  const match = /export\s+const\s+FORMULA_ID_BINDING_DEFAULT\s*=\s*(true|false)\b/.exec(source);
  return match ? match[1] === 'true' : undefined;
}

/** 待部署代码的迁移：条数与最后一条的 when（drizzle 把它存进 __drizzle_migrations.created_at）。 */
export function readCodeMigrations(codeRoot) {
  const journal = JSON.parse(readFileSync(`${codeRoot}/${JOURNAL_FILE}`, 'utf8'));
  const entries = journal.entries ?? [];
  return { count: entries.length, last: entries.length > 0 ? Number(entries[entries.length - 1].when) : 0 };
}

const one = async (query, text) => (await query(text))[0] ?? {};

/**
 * 目标库上带应用前缀的连接数。看不到其他会话的 application_name（账号既不是超级用户也不是 pg_read_all_stats 成员时，
 * 他人会话的这一列是 NULL，而真实的客户端会话至少是空串）时直接失败——不能把“看不到”当成“没有”。
 */
export async function applicationSessions(query) {
  const { hidden } = await one(
    query,
    `SELECT count(*)::int AS hidden FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND backend_type = 'client backend' AND application_name IS NULL`,
  );
  if (Number(hidden) > 0)
    throw new Error('检查账号看不到其他会话的 application_name：须是超级用户或 pg_read_all_stats 成员');
  const rows = await query(
    `SELECT pid, application_name FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND application_name LIKE '${APP_NAME_PREFIX}%'`,
  );
  return rows.length;
}

async function appliedMigrations(query) {
  const exists = await one(query, `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS found`);
  if (exists.found !== true) return { count: 0, last: 0 };
  const row = await one(
    query,
    `SELECT count(*)::int AS n, coalesce(max(created_at), 0)::text AS last
    FROM drizzle.__drizzle_migrations`,
  );
  return { count: Number(row.n), last: Number(row.last) };
}

const count = async (query, text) => Number((await one(query, text)).n);

/**
 * 跑某个阶段的检查，返回 `{ ok, results: [{ name, ok, detail }] }`。
 * query：(sql 文本) => 行数组（同一个会话）；sessions：可替换的连接数探针（测试用，缺省查 pg_stat_activity）。
 */
export async function checkDeployTarget({ phase, query, codeRoot = defaultRoot, sessions = applicationSessions }) {
  if (!PHASES.includes(phase)) throw new Error(`未知阶段 ${phase}，可用：${PHASES.join(' | ')}`);
  const results = [];
  const check = async (name, run) => {
    try {
      const detail = await run();
      results.push({ name, ok: detail === undefined, detail: detail ?? '' });
    } catch (error) {
      results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  const noConnections = () =>
    check('目标库上没有应用连接', async () => {
      const n = await sessions(query);
      if (n !== 0)
        return `仍有 ${n} 个应用会话（application_name 以 ${APP_NAME_PREFIX} 开头）：先停止全部旧实例与后台写入者`;
    });
  const switchOn = () =>
    check('待部署代码的开关默认值为 true', async () => {
      const value = readSwitchDefault(codeRoot);
      if (value !== true) return `FORMULA_ID_BINDING_DEFAULT = ${String(value)}：只能部署开关默认打开的版本`;
    });
  const migrations = (mode) =>
    check(mode === 'equal' ? '已应用迁移与待部署代码一致' : '迁移不倒退', async () => {
      const applied = await appliedMigrations(query);
      const code = readCodeMigrations(codeRoot);
      const bad =
        mode === 'equal'
          ? applied.count !== code.count || applied.last !== code.last
          : code.count < applied.count || code.last < applied.last;
      if (bad)
        return `库里已应用 ${applied.count} 条（最后 ${applied.last}），代码 ${code.count} 条（最后 ${code.last}）`;
    });
  const emptyOf = (name, text, hint) =>
    check(name, async () => {
      const n = await count(query, text);
      if (n !== 0) return `${n} ${hint}`;
    });

  if (phase === 'pre-enable') {
    await noConnections();
    await migrations('equal');
    await switchOn();
  } else if (phase === 'deploy') {
    await switchOn();
    await migrations('not-behind');
  } else {
    await noConnections();
    await migrations('equal');
    await check('检查账号能绕过行级安全（读全部租户数据）', async () => {
      const { ok } = await one(
        query,
        `SELECT (rolsuper OR rolbypassrls) AS ok FROM pg_roles WHERE rolname = current_user`,
      );
      if (ok !== true) return '检查账号受行级安全约束，读不全各租户数据；请换超级用户或 BYPASSRLS 的只读账号';
    });
    await emptyOf(
      '库里没有 bound 行',
      `SELECT count(*)::int AS n FROM talent_review_calc_rule_items WHERE formula_binding = 'bound'`,
      '个计算项目是 bound',
    );
    await emptyOf(
      '没有计算规则的新格式审计',
      `SELECT count(*)::int AS n FROM audit_events WHERE object_type = '${CALC_RULE_AUDIT_TYPE}'
         AND (before::text LIKE '%"formulaBinding"%' OR after::text LIKE '%"formulaBinding"%'
              OR changes::text LIKE '%"formulaBinding"%')`,
      '条计算规则审计含新格式（formulaBinding）',
    );
    await emptyOf(
      '没有含句柄的命令台账结果',
      `SELECT count(*)::int AS n FROM command_ledger WHERE response_body::text LIKE '%${HANDLE}%'`,
      '条命令台账结果含字段句柄',
    );
  }
  return { ok: results.every((entry) => entry.ok), results };
}

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

/** postgres.js 在 packages/db 下（根目录没有这个依赖），从那里解析。 */
async function connect(url) {
  const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
  const postgres = (await import(pathToFileURL(require.resolve('postgres')).href)).default;
  const sql = postgres(url, {
    max: 1,
    onnotice: () => undefined,
    connection: { application_name: 'italent-deploy-check' },
  });
  return { query: async (text) => [...(await sql.unsafe(text))], close: () => sql.end() };
}

async function main() {
  const phase = argument('phase');
  const url = process.env.DATABASE_URL;
  if (!phase || !PHASES.includes(phase)) {
    console.error(`用法：node scripts/check-deploy-target.mjs --phase=${PHASES.join('|')} [--code-root=<目录>]`);
    process.exitCode = 2;
    return;
  }
  if (!url) {
    console.error('缺少环境变量 DATABASE_URL');
    process.exitCode = 2;
    return;
  }
  const db = await connect(url);
  try {
    const { ok, results } = await checkDeployTarget({
      phase,
      query: db.query,
      codeRoot: argument('code-root') ?? defaultRoot,
    });
    for (const entry of results)
      console.log(`${entry.ok ? '通过' : '失败'}  ${entry.name}${entry.detail ? `：${entry.detail}` : ''}`);
    console.log(ok ? `阶段 ${phase}：全部通过` : `阶段 ${phase}：未通过，部署 / 启动中止`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  });
}
