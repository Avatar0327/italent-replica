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
const none = async () => 0;
const some = async () => 2;

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

const run = (phase: DeployPhase, extra: { root?: string; sessions?: (q: Query) => Promise<number> } = {}) =>
  checkDeployTarget({ phase, query, codeRoot: extra.root ?? REPO, sessions: extra.sessions ?? none });
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
    await expect(applicationSessions(blind)).rejects.toThrow(/pg_read_all_stats/);
    const result = await checkDeployTarget({
      phase: 'pre-enable',
      query: async (text) => (text.includes('IS NULL') ? [{ hidden: 1 }] : query(text)),
      codeRoot: REPO,
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

pg('AC-23 真实连接（真 PG）：application_name 以 italent-api: 开头的会话被计数', () => {
  it('应用连接存在时 pre-enable 失败，关闭后通过；连接带 application_name', async () => {
    const [{ name }] = rowsOf(await testDb().db.execute(sql`SELECT current_database() AS name`)) as [{ name: string }];
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = `/${name}`;
    const app = createPgDb(url.toString(), { max: 1, applicationName: 'italent-api:test' });
    try {
      const [row] = rowsOf(await app.db.execute(sql`SHOW application_name`)) as [{ application_name: string }];
      expect(row.application_name).toBe('italent-api:test');
      const withApp = await checkDeployTarget({ phase: 'pre-enable', query, codeRoot: REPO });
      expect(failed(withApp)).toEqual(['目标库上没有应用连接']);
    } finally {
      await app.close();
    }
    // 连接关闭后会话消失（PG 端回收是异步的，轮询到通过为止）
    let after = await checkDeployTarget({ phase: 'pre-enable', query, codeRoot: REPO });
    for (let attempt = 0; attempt < 40 && !after.ok; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      after = await checkDeployTarget({ phase: 'pre-enable', query, codeRoot: REPO });
    }
    expect(failed(after)).toEqual([]);
  });
});
