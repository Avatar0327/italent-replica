/**
 * R3-T02 PR-B 配置字典写入的“命令事务内当前权限复核”（B1b 第 1 轮 P2-01，审查含 B1a 活动类型的同一包装器；DEC-317① 信息
 * 泄露例外；AGENTS §10 权限、DEC-067）：路由层检查之后、命令事务之前撤权，
 * - 首次执行：POST / PATCH / DELETE 按**事务内**当前授权拒绝（范围撤销 404、字段编辑权撤销 403），业务写 / 审计 / 命令台账
 *   都不提交；
 * - 幂等重放：同键重放按当前授权拒绝，不返回首次结果，也不因“失败后回查台账”绕过复核。
 * 确定性交错：mock `runCommand`，在它开事务前执行测试注入的钩子（路由层检查此时已全部通过）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { EV_NOW, type EvaluationKey, ok, operator, type Operator } from './AC-EV-support.js';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

const hooks = vi.hoisted(() => ({ beforeCommand: undefined as undefined | (() => Promise<void>) }));
vi.mock('../../apps/api/src/commands.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../apps/api/src/commands.js')>();
  return {
    ...original,
    runCommand: async (...args: Parameters<typeof original.runCommand>) => {
      const hook = hooks.beforeCommand;
      hooks.beforeCommand = undefined;
      await hook?.();
      return original.runCommand(...args);
    },
  };
});

const testDb = useTestDb();
const name = (label = '复核') => `${label}${randomUUID().slice(0, 6)}`;

interface Row {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly description?: string | null;
}
interface Subject {
  readonly key: EvaluationKey;
  readonly label: string;
  readonly path: string;
  readonly objectType: string;
  /** 撤销编辑权的字段，及一个会触发该字段检查的修改载荷。 */
  readonly field: string;
  readonly fieldPatch: Record<string, unknown>;
  readonly extra: Record<string, unknown>;
}
const SUBJECTS: readonly Subject[] = [
  {
    key: 'activityType',
    label: '活动类型（B1a）',
    path: '/activity-types',
    objectType: 'TEvaluation.ActivityType',
    field: 'syncQualification',
    fieldPatch: { syncQualification: true },
    extra: {},
  },
  {
    key: 'activityCycle',
    label: '活动周期',
    path: '/activity-cycles',
    objectType: 'TEvaluation.ActivityCycle',
    field: 'enabled',
    fieldPatch: { enabled: false },
    extra: {},
  },
  {
    key: 'generalScoreItem',
    label: '通用评分项',
    path: '/general-score-items',
    objectType: 'TEvaluation.GeneralScoreItem',
    field: 'description',
    fieldPatch: { description: null },
    extra: { description: '现场表现' },
  },
];

describe.each(SUBJECTS)('AC-EV-config-dicts 命令事务内权限复核 $label', (s) => {
  let world: PermissionWorld;
  beforeAll(async () => {
    const seeded = await seedPermissionWorld(testDb().db);
    world = { ...seeded, api: tenantApi(seeded.db, { authorize: undefined, clock: () => EV_NOW }) };
  });
  const seeAll = (auditor = false) => operator(world, { seeAll: true, auditor });
  const create = (op: Operator, extra: Record<string, unknown> = {}, key: string = randomUUID()) =>
    op.request('POST', s.path, { ifMatch: 0, idempotencyKey: key, body: { name: name(), ...s.extra, ...extra } });
  const created = (op: Operator) => create(op).then((r) => ok<Row>(r, 201));
  const read = (op: Operator, id: string) => op.request('GET', `${s.path}/${id}`);
  const ledger = async (key: string) =>
    withTenant(testDb().db, world.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT count(*)::int AS n FROM command_ledger WHERE command_id = ${key}`);
      const rows = (Array.isArray(result) ? result : (result as { rows: { n: number }[] }).rows) as { n: number }[];
      return Number(rows[0]?.n);
    });
  const auditCount = async (admin: Operator) => {
    const audit = auditApi(testDb().db, EV_NOW.toISOString(), { authorize: undefined });
    return (await audit.dataChanges(admin.as, { objectType: s.objectType, limit: '100' })).items.length;
  };

  it('新建：检查后撤销看全部 → 404，没有落库、没有审计、没有台账', async () => {
    const admin = await seeAll(true);
    const op = await seeAll();
    const label = name('新建');
    const key = randomUUID();
    const before = await auditCount(admin);
    hooks.beforeCommand = () => op.revokeSeeAll();
    const response = await create(op, { name: label }, key);
    expect(response.status, await response.clone().text()).toBe(404);
    const listed = await ok<{ items: Row[] }>(await admin.request('GET', `${s.path}?pageSize=100`));
    expect(listed.items.some((item) => item.name === label)).toBe(false);
    expect(await auditCount(admin)).toBe(before);
    expect(await ledger(key)).toBe(0);
  });

  it('修改：检查后撤销看全部 → 404，数据不变；检查后撤销字段编辑权 → 403，数据不变（含显式清空）', async () => {
    const admin = await seeAll();
    const row = await created(admin);
    const op = await seeAll();
    hooks.beforeCommand = () => op.revokeSeeAll();
    const gone = await op.request('PATCH', `${s.path}/${row.id}`, {
      ifMatch: row.revision,
      body: { name: name('越权') },
    });
    expect(gone.status, await gone.clone().text()).toBe(404);
    expect(await ok<Row>(await read(admin, row.id))).toEqual(row);

    const writer = await seeAll();
    hooks.beforeCommand = () => writer.hide(s.key, [s.field]);
    const key = randomUUID();
    const fieldless = await writer.request('PATCH', `${s.path}/${row.id}`, {
      ifMatch: row.revision,
      idempotencyKey: key,
      body: s.fieldPatch,
    });
    expect(fieldless.status, await fieldless.clone().text()).toBe(403);
    expect(await ok<Row>(await read(admin, row.id))).toEqual(row);
    expect(await ledger(key)).toBe(0);
  });

  it('删除：检查后撤销看全部 → 404，对象仍在、审计与台账不变', async () => {
    const admin = await seeAll(true);
    const row = await created(admin);
    const op = await seeAll();
    const key = randomUUID();
    const before = await auditCount(admin);
    hooks.beforeCommand = () => op.revokeSeeAll();
    const response = await op.request('DELETE', `${s.path}/${row.id}`, {
      ifMatch: row.revision,
      idempotencyKey: key,
    });
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await ok<Row>(await read(admin, row.id))).toEqual(row);
    expect(await auditCount(admin)).toBe(before);
    expect(await ledger(key)).toBe(0);
  });

  it('重放：首次成功后、同键重放前撤销看全部 → 404，不返回首次结果；撤销字段编辑权 → 403', async () => {
    const op = await seeAll();
    const key = randomUUID();
    const body = { name: name('重放'), ...s.extra };
    const first = await ok<Row>(await op.request('POST', s.path, { ifMatch: 0, idempotencyKey: key, body }), 201);
    hooks.beforeCommand = () => op.revokeSeeAll();
    const replay = await op.request('POST', s.path, { ifMatch: 0, idempotencyKey: key, body });
    expect(replay.status, await replay.clone().text()).toBe(404);
    expect(await replay.clone().text()).not.toContain(first.id);

    const admin = await seeAll();
    const row = await created(admin);
    const writer = await seeAll();
    const patchKey = randomUUID();
    const patch = () =>
      writer.request('PATCH', `${s.path}/${row.id}`, {
        ifMatch: row.revision,
        idempotencyKey: patchKey,
        body: s.fieldPatch,
      });
    await ok(await patch());
    hooks.beforeCommand = () => writer.hide(s.key, [s.field]);
    const denied = await patch();
    expect(denied.status, await denied.clone().text()).toBe(403);
  });
});
