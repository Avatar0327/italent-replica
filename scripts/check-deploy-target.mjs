#!/usr/bin/env node
// F-082 部署目标检查（契约 §6.5，DEC-386；只读，不改库、不做运行时互斥）。
// 用法：node scripts/check-deploy-target.mjs --phase=pre-enable|deploy|post-restore
//       --app-role=<应用运行时数据库角色> [--code-root=<目录>]
//       pre-enable / post-restore 必须给应用数据库角色（--app-role 或环境变量 APP_DB_ROLE）：该角色名下的连接不论 application_name
//       是什么（含启用前版本的旧默认名 postgres.js）都算应用连接，与带 italent-api: 前缀的一起计数。
//       数据库连接串取环境变量 DATABASE_URL。
// 检查账号的可见性前置判定（“看不到 / 认不出不等于没有”，先判定、后计数，不满足直接失败、不出结论）：
// - 连接计数（pre-enable / post-restore）：须是超级用户或拥有 pg_read_all_stats 的权限。没有时，其他角色会话的
//   backend_type、state 等列是 NULL（application_name 仍可见），任何按这些列过滤的计数都会把应用连接漏掉；
// - 数据检查（post-restore）：须能绕过行级安全（超级用户或 BYPASSRLS）。受行级安全约束时看到的“0 行”不可信——平台运维
//   命令行用的迁移角色受 FORCE RLS 约束，就属于这种账号。
// 任一项不满足 → 对应检查判失败，退出码非零，部署 / 启动中止。
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
 * 检查账号的可见性（前置判定）：sessions = 能看全其他会话（超级用户或拥有 pg_read_all_stats 的权限，按继承判定）；
 * rows = 能看全各租户数据（超级用户或 BYPASSRLS）。连接计数与数据检查都必须先过对应一项，不满足就判失败。
 */
export async function visibility(query) {
  const row = await one(
    query,
    `SELECT r.rolsuper AS super, r.rolbypassrls AS bypass,
        pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS stats
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  return { sessions: row.super === true || row.stats === true, rows: row.super === true || row.bypass === true };
}

/**
 * 目标库上的应用连接：{ marked: 带 italent-api: 前缀的, unmarked: 应用数据库角色名下、未带前缀的 }。调用前须已通过
 * visibility().sessions。不按 backend_type 等会因权限变成 NULL 的列过滤：取本库其他全部会话，在这里按 application_name 前缀
 * 与角色名分类；同时逐行兜底——任何一行的 backend_type 或 application_name 是 NULL 都说明仍看不全，直接失败。
 */
export async function applicationSessions(query, appRole) {
  const rows = await query(
    `SELECT application_name, usename, backend_type FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`,
  );
  const hidden = rows.filter((row) => row.backend_type == null || row.application_name == null).length;
  if (hidden > 0) throw new Error(`有 ${hidden} 个会话的信息不可见：检查账号看不全其他会话，不能判定“没有应用连接”`);
  const app = rows.filter((row) => row.application_name.startsWith(APP_NAME_PREFIX) || row.usename === appRole);
  const marked = app.filter((row) => row.application_name.startsWith(APP_NAME_PREFIX)).length;
  return { marked, unmarked: app.length - marked };
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
 * post-restore 的数据检查：库里不能有启用后才会产生的数据（bound 行、新格式审计、含句柄的台账结果）。检查账号受行级安全
 * 约束时只看得到部分租户，看到的“0 行”不可信——三项都判失败、不执行计数。
 */
async function restoreDataChecks(check, query) {
  const { rows: seesAll } = await visibility(query);
  const BLIND = '未执行：检查账号受行级安全约束，看到 0 行不等于没有；请换超级用户或 BYPASSRLS 的只读账号';
  const emptyOf = (name, text, hint) =>
    check(name, async () => {
      if (!seesAll) return BLIND;
      const n = await count(query, text);
      if (n !== 0) return `${n} ${hint}`;
    });
  await check('检查账号能绕过行级安全（读全部租户数据）', async () => (seesAll ? undefined : BLIND));
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

/**
 * 跑某个阶段的检查，返回 `{ ok, results: [{ name, ok, detail }] }`。
 * query：(sql 文本) => 行数组（同一个会话）；sessions：可替换的连接数探针（测试用，缺省查 pg_stat_activity）。
 */
export async function checkDeployTarget({
  phase,
  query,
  codeRoot = defaultRoot,
  sessions = applicationSessions,
  appRole,
}) {
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
      if (!appRole) {
        return '没有指定应用数据库角色（--app-role 或环境变量 APP_DB_ROLE）：无法识别未带前缀的旧连接，不能把“认不出”当成“没有”';
      }
      // 前置判定：看不全其他会话时不计数，直接失败（计数探针可替换，判定不可跳过）
      if (!(await visibility(query)).sessions) {
        return '检查账号没有统计读取权限（须是超级用户或 pg_read_all_stats 成员）：看不全其他会话，不能判定“没有应用连接”';
      }
      const { marked, unmarked } = await sessions(query, appRole);
      if (marked + unmarked === 0) return undefined;
      const parts = [];
      if (marked > 0) parts.push(`${marked} 个带 ${APP_NAME_PREFIX} 前缀`);
      if (unmarked > 0) parts.push(`${unmarked} 个在应用角色 ${appRole} 名下但未带前缀（如旧默认连接名 postgres.js）`);
      return `仍有应用连接：${parts.join('，')}。先停止全部旧实例与后台写入者`;
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
    await restoreDataChecks(check, query);
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
    console.error(
      `用法：node scripts/check-deploy-target.mjs --phase=${PHASES.join('|')} --app-role=<应用数据库角色> [--code-root=<目录>]`,
    );
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
      appRole: argument('app-role') ?? process.env.APP_DB_ROLE,
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
