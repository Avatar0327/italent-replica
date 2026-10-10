/**
 * F-082 AC-23 部署前置条件的检查脚本（F082-5，契约 §6.5，DEC-386）：scripts/check-deploy-target.mjs 只读，三个阶段——
 * - pre-enable：仍有 italent-api:* 应用连接、迁移序号不一致、待部署代码开关默认值为 false 时失败；全部停止后通过；
 * - deploy：待部署代码开关默认值为 false 或迁移倒退时失败；
 * - post-restore：库里有 bound 行、新格式审计、含句柄的命令台账结果、仍有应用连接、迁移不一致时失败（服务不启动）；
 *   恢复到启用前数据（干净库）通过。
 * 以隔离测试库为目标（useTestDb）；连接数探针在 PGlite 下用注入替身，真 PG 下另有真实连接用例。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPgDb, insertAuditEvent, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applicationSessions,
  checkDeployTarget,
  type DeployPhase,
  type Query,
  readSwitchDefault,
  type SessionProbe,
} from '../../scripts/check-deploy-target.mjs';
import { makeBound } from './AC-TR-F082-support.js';
import { rebindWorld, type RebindWorld } from './AC-TR-F082-rebind-support.js';
import { TR_NOW } from './AC-TR-config-support.js';

const testDb = useTestDb();
const pg = describe.runIf(Boolean(process.env.TEST_DATABASE_URL));
const REPO = join(import.meta.dirname, '..', '..');
const SWITCH = 'apps/api/src/modules/talent-review/formula-binding-switch.ts';
const JOURNAL = 'packages/db/migrations/meta/_journal.json';

const rowsOf = (result: unknown) =>
  (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Record<string, unknown>[];
const query: Query = async (text) => rowsOf(await testDb().db.execute(sql.raw(text)));
const none = async () => ({ marked: 0, unmarked: 0 });
const some = async () => ({ marked: 2, unmarked: 0 });
const legacyNamed = async () => ({ marked: 0, unmarked: 3 });
const APP_ROLE = 'italent_app';

/** 待部署代码的目录：只放检查脚本读的两个文件（开关源码与迁移日志），可改写。 */
const roots: string[] = [];
function codeRoot(options: { switchDefault?: boolean; dropLast?: number; extraEntries?: number } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'f082-code-'));
  roots.push(root);
  for (const file of [SWITCH, JOURNAL]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(REPO, file), join(root, file));
  }
  if (options.switchDefault !== undefined) {
    const path = join(root, SWITCH);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(/(FORMULA_ID_BINDING_DEFAULT = )(true|false)/, `$1${options.switchDefault}`),
    );
  }
  if (options.dropLast || options.extraEntries) {
    const path = join(root, JOURNAL);
    const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: { idx: number; when: number }[] };
    if (options.dropLast) journal.entries.splice(-options.dropLast);
    const last = journal.entries[journal.entries.length - 1]!;
    for (let index = 1; index <= (options.extraEntries ?? 0); index += 1) {
      journal.entries.push({ ...last, idx: last.idx + index, when: last.when + index });
    }
    writeFileSync(path, JSON.stringify(journal));
  }
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const run = (phase: DeployPhase, extra: { root?: string; sessions?: SessionProbe; appRole?: string | null } = {}) =>
  checkDeployTarget({
    phase,
    query,
    codeRoot: extra.root ?? REPO,
    sessions: extra.sessions ?? none,
    ...(extra.appRole === null ? {} : { appRole: extra.appRole ?? APP_ROLE }),
  });
const failed = (result: Awaited<ReturnType<typeof run>>) =>
  result.results.filter((entry) => !entry.ok).map((e) => e.name);

describe('AC-23 检查脚本：代码侧', () => {
  it('仓库当前代码：开关默认值 true、迁移日志可读', () => {
    expect(readSwitchDefault(REPO)).toBe(true);
    expect(readSwitchDefault(codeRoot({ switchDefault: false }))).toBe(false);
  });
});

describe('AC-23 pre-enable', () => {
  it('没有应用连接、迁移一致、开关默认 true → 通过（退出码 0）', async () => {
    const result = await run('pre-enable');
    expect(failed(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('仍有应用连接（模拟未停止的旧实例或后台写入者）→ 失败', async () => {
    expect(failed(await run('pre-enable', { sessions: some }))).toEqual(['目标库上没有应用连接']);
  });

  it('同一应用数据库角色下、未带 italent-api: 前缀的连接（如旧默认名 postgres.js）也计数并报告', async () => {
    const result = await run('pre-enable', { sessions: legacyNamed });
    expect(failed(result)).toEqual(['目标库上没有应用连接']);
    const detail = result.results.find((entry) => !entry.ok)!.detail;
    expect(detail).toContain('3');
    expect(detail).toContain('未带');
  });

  it('没有指定应用数据库角色（--app-role）→ 失败：无法识别未带前缀的连接，不把“认不出”当成“没有”', async () => {
    const result = await run('pre-enable', { appRole: null });
    expect(failed(result)).toEqual(['目标库上没有应用连接']);
    expect(result.results.find((entry) => !entry.ok)!.detail).toContain('--app-role');
    // deploy 阶段不检查连接，不需要角色
    expect(failed(await run('deploy', { appRole: null }))).toEqual([]);
  });

  it('迁移序号不一致（代码比库多 / 少）→ 失败', async () => {
    expect(failed(await run('pre-enable', { root: codeRoot({ extraEntries: 1 }) }))).toEqual([
      '已应用迁移与待部署代码一致',
    ]);
    expect(failed(await run('pre-enable', { root: codeRoot({ dropLast: 1 }) }))).toEqual([
      '已应用迁移与待部署代码一致',
    ]);
  });

  it('待部署代码的开关默认值为 false → 失败', async () => {
    expect(failed(await run('pre-enable', { root: codeRoot({ switchDefault: false }) }))).toEqual([
      '待部署代码的开关默认值为 true',
    ]);
  });

  it('检查账号看不到其他会话（既不是超级用户也不是 pg_read_all_stats 成员）→ 失败，不把“看不到”当成“没有”', async () => {
    // 他人会话的 application_name 是 NULL（真实客户端会话至少是空串）
    const blind: Query = async (text) => (text.includes('IS NULL') ? [{ hidden: 1 }] : []);
    await expect(applicationSessions(blind, APP_ROLE)).rejects.toThrow(/pg_read_all_stats/);
    const result = await checkDeployTarget({
      phase: 'pre-enable',
      query: async (text) => (text.includes('IS NULL') ? [{ hidden: 1 }] : query(text)),
      codeRoot: REPO,
      appRole: APP_ROLE,
    });
    expect(failed(result)).toEqual(['目标库上没有应用连接']);
  });
});

describe('AC-23 deploy', () => {
  it('开关默认 true 且迁移不倒退 → 通过；连接数不检查（开关打开后各版本可滚动部署）', async () => {
    expect(failed(await run('deploy', { sessions: some }))).toEqual([]);
    // 代码比库新（多一条迁移）也通过
    expect(failed(await run('deploy', { root: codeRoot({ extraEntries: 1 }) }))).toEqual([]);
  });

  it('待部署代码开关默认值为 false → 失败；迁移倒退（代码比库少）→ 失败', async () => {
    expect(failed(await run('deploy', { root: codeRoot({ switchDefault: false }) }))).toEqual([
      '待部署代码的开关默认值为 true',
    ]);
    expect(failed(await run('deploy', { root: codeRoot({ dropLast: 1 }) }))).toEqual(['迁移不倒退']);
  });
});

// 真 PG 下测试连接的角色受行级安全约束（正是检查脚本要拒绝的账号），post-restore 的数据检查只在 PGlite（超级用户）下跑
describe.skipIf(Boolean(process.env.TEST_DATABASE_URL))('AC-23 post-restore', () => {
  let w: RebindWorld;
  beforeAll(async () => {
    w = await rebindWorld(testDb().db, 'f082-deploy');
  });

  it('恢复到启用前的数据（没有 bound、没有新格式审计与台账）→ 通过', async () => {
    const result = await run('post-restore');
    expect(failed(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('仍有应用连接 / 迁移不一致 → 失败，服务不启动', async () => {
    expect(failed(await run('post-restore', { sessions: some }))).toEqual(['目标库上没有应用连接']);
    expect(failed(await run('post-restore', { root: codeRoot({ extraEntries: 1 }) }))).toEqual([
      '已应用迁移与待部署代码一致',
    ]);
  });

  it('含句柄的命令台账结果 → 失败', async () => {
    await testDb().db
      .execute(sql`INSERT INTO command_ledger (tenant_id, command_id, request_hash, response_status, response_body)
      VALUES (${w.tenantId}, 'f082-ledger', 'h', 201,
        ${JSON.stringify({ items: [{ formula: '@{tr-field:11111111-1111-4111-8111-111111111111} + 1' }] })}::jsonb)`);
    expect(failed(await run('post-restore'))).toEqual(['没有含句柄的命令台账结果']);
  });

  it('计算规则的新格式审计（快照含 formulaBinding）→ 失败', async () => {
    await withTenant(testDb().db, w.tenantId, (tx) =>
      insertAuditEvent(tx, {
        tenantId: w.tenantId,
        actorUserId: null,
        action: 'talent-review.calc-rule.update',
        objectType: 'TalentReview.CalcRule',
        objectId: '22222222-2222-4222-8222-222222222222',
        before: null,
        after: { items: [{ formula: 'x', formulaBinding: 'bound' }] },
        commandId: 'f082-audit',
        occurredAt: TR_NOW,
      }),
    );
    expect(failed(await run('post-restore'))).toContain('没有计算规则的新格式审计');
  });

  it('库里有 bound 行 → 失败', async () => {
    const [target, source] = [await w.numberField(), await w.field('number', { name: '部署源' })];
    const { itemId } = await (async () => {
      const rule = await w.create({
        name: '部署规则',
        items: [{ targetFieldId: target.id, priority: 1, formula: '盘点对象.部署源 + 1' }],
      });
      const found = await withTenant(testDb().db, w.tenantId, (tx) =>
        tx.execute(sql`SELECT id FROM talent_review_calc_rule_items WHERE rule_id = ${rule.id}`),
      );
      return { itemId: (rowsOf(found)[0] as { id: string }).id };
    })();
    await makeBound(testDb().db, w, itemId, `@{tr-field:${source.id}} + 1`, [source.id]);
    expect(failed(await run('post-restore'))).toContain('库里没有 bound 行');
  });
});

pg('AC-23 真实连接（真 PG）：按前缀与按应用角色识别连接', () => {
  const adminUrl = () => new URL(process.env.TEST_DATABASE_URL!);
  const dbUrl = async () => {
    const [{ name }] = rowsOf(await testDb().db.execute(sql`SELECT current_database() AS name`)) as [{ name: string }];
    const url = adminUrl();
    url.pathname = `/${name}`;
    return url.toString();
  };
  const probe = (appRole: string) => checkDeployTarget({ phase: 'pre-enable', query, codeRoot: REPO, appRole });

  it('带 italent-api: 前缀的连接被计数；关闭后通过；连接带 application_name', async () => {
    const app = createPgDb(await dbUrl(), { max: 1, applicationName: 'italent-api:test' });
    try {
      const [row] = rowsOf(await app.db.execute(sql`SHOW application_name`)) as [{ application_name: string }];
      expect(row.application_name).toBe('italent-api:test');
      expect(failed(await probe('italent_no_such_role'))).toEqual(['目标库上没有应用连接']);
    } finally {
      await app.close();
    }
    // 连接关闭后会话消失（PG 端回收是异步的，轮询到通过为止）
    let after = await probe('italent_no_such_role');
    for (let attempt = 0; attempt < 40 && !after.ok; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      after = await probe('italent_no_such_role');
    }
    expect(failed(after)).toEqual([]);
  });

  it('同一应用角色下未带前缀的连接（旧版本默认连接名 postgres.js）也被识别并报告', async () => {
    // 启用前版本的连接：用测试库同一个登录角色、不设 application_name（postgres.js 的默认连接名）
    const role = decodeURIComponent(adminUrl().username);
    const legacy = createPgDb(await dbUrl(), { max: 1 });
    try {
      await legacy.db.execute(sql`SELECT 1`);
      const result = await probe(role);
      expect(failed(result)).toEqual(['目标库上没有应用连接']);
      expect(result.results.find((entry) => !entry.ok)!.detail).toContain('未带');
      // 另一个角色名下没有连接 → 不受影响
      expect(failed(await probe('italent_no_such_role'))).toEqual([]);
    } finally {
      await legacy.close();
    }
  });
});

/**
 * F082-5 第 3 轮（#236 第 2 轮审查 P2-1）：检查账号与应用账号是不同角色时，检查账号必须先证明自己“看得全”——
 * 没有统计读取权限（超级用户或 pg_read_all_stats）时，他人会话的 backend_type 等列是 NULL，不能据此算出“0 个连接”；
 * 没有绕过行级安全的权限时，post-restore 的数据检查看到的“0 行”同样不可信。两者都必须判失败，不是“通过”。
 * 需要能建角色的测试账号（CI 的 postgres 超级用户）；没有建角色权限时跳过。
 */
pg('AC-23 检查账号的可见性前置判定（真 PG，检查角色 ≠ 应用角色）', () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const checker = `f082_chk_${suffix}`;
  const appRole = `f082_app_${suffix}`;
  const password = 'f082-test-only';
  let canCreateRoles = false;
  let dbName = '';
  const admin = (text: string) => testDb().db.execute(sql.raw(text));
  const urlAs = (role: string) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.username = role;
    url.password = password;
    url.pathname = `/${dbName}`;
    return url.toString();
  };
  const open: { close: () => Promise<void> }[] = [];
  /** 以应用角色开一个在线连接（可带 / 不带 italent-api: 前缀）。 */
  const appConnection = async (applicationName?: string) => {
    const handle = createPgDb(urlAs(appRole), { max: 1, ...(applicationName ? { applicationName } : {}) });
    await handle.db.execute(sql`SELECT 1`);
    open.push(handle);
    return handle;
  };
  /** 以检查角色跑某个阶段。 */
  const checkAs = async (phase: DeployPhase) => {
    const handle = createPgDb(urlAs(checker), { max: 1, applicationName: 'italent-deploy-check' });
    try {
      const as: Query = async (text) => rowsOf(await handle.db.execute(sql.raw(text)));
      return await checkDeployTarget({ phase, query: as, codeRoot: REPO, appRole });
    } finally {
      await handle.close();
    }
  };
  const entry = (result: Awaited<ReturnType<typeof checkAs>>, name: string) =>
    result.results.find((item) => item.name === name)!;
  const CONNECTIONS = '目标库上没有应用连接';
  /** 关闭应用连接后等 PG 端回收（异步），以管理角色观察。 */
  const drain = async () => {
    for (const handle of open.splice(0)) await handle.close();
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const [row] = rowsOf(
        await admin(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = '${appRole}'`),
      ) as [{ n: number }];
      if (row.n === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('应用角色的连接没有回收');
  };

  beforeAll(async () => {
    const [me] = rowsOf(
      await admin(`SELECT current_database() AS db, (rolsuper OR rolcreaterole) AS ok
        FROM pg_roles WHERE rolname = current_user`),
    ) as [{ db: string; ok: boolean }];
    dbName = me.db;
    canCreateRoles = me.ok === true;
    if (!canCreateRoles) return;
    for (const role of [checker, appRole]) {
      await admin(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await admin(`GRANT CONNECT ON DATABASE "${dbName}" TO ${role}`);
    }
  });
  afterAll(async () => {
    for (const handle of open.splice(0)) await handle.close();
    if (!canCreateRoles) return;
    for (const role of [checker, appRole]) {
      await admin(`DROP OWNED BY ${role}`);
      await admin(`DROP ROLE ${role}`);
    }
  });

  it('检查角色没有统计读取权限、应用角色有带前缀的在线连接 → pre-enable / post-restore 的连接检查失败（不报“没有”）', async (ctx) => {
    if (!canCreateRoles) ctx.skip();
    await appConnection('italent-api:test');
    for (const phase of ['pre-enable', 'post-restore'] as const) {
      const result = await checkAs(phase);
      expect(result.ok).toBe(false);
      expect(entry(result, CONNECTIONS).ok).toBe(false);
      expect(entry(result, CONNECTIONS).detail).toContain('pg_read_all_stats');
    }
    await drain();
  });

  it('授予 pg_read_all_stats 后 → 带前缀与应用角色名下未带前缀的连接都被正确计数；全部关闭后通过', async (ctx) => {
    if (!canCreateRoles) ctx.skip();
    await drain();
    await admin(`GRANT pg_read_all_stats TO ${checker}`);
    try {
      await appConnection('italent-api:test');
      await appConnection();
      const result = await checkAs('pre-enable');
      expect(entry(result, CONNECTIONS).ok).toBe(false);
      expect(entry(result, CONNECTIONS).detail).toContain('1 个带 italent-api: 前缀');
      expect(entry(result, CONNECTIONS).detail).toContain(`1 个在应用角色 ${appRole} 名下但未带前缀`);
      await drain();
      expect(entry(await checkAs('pre-enable'), CONNECTIONS)).toMatchObject({ ok: true });
    } finally {
      await admin(`REVOKE pg_read_all_stats FROM ${checker}`);
    }
  });

  it('post-restore：检查角色能读表但受行级安全约束 → 各项数据检查判失败（看到 0 行不等于没有），不判通过', async (ctx) => {
    if (!canCreateRoles) ctx.skip();
    for (const table of ['talent_review_calc_rule_items', 'audit_events', 'command_ledger'])
      await admin(`GRANT SELECT ON ${table} TO ${checker}`);
    const result = await checkAs('post-restore');
    for (const name of ['库里没有 bound 行', '没有计算规则的新格式审计', '没有含句柄的命令台账结果']) {
      expect(entry(result, name).ok, name).toBe(false);
      expect(entry(result, name).detail, name).toContain('行级安全');
    }
  });
});
