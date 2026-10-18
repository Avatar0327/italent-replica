/**
 * BE-15a 第 2 轮审查 P1（#400）：立即执行及其重放按操作人当前的任职数据范围裁剪回执，续跑游标不暴露员工 UUID。
 * - 系统批次仍按规则的适用组织执行（不算越权写入）；回执里的员工 / 业务 / 发起人只列操作人当前可见的员工；
 * - 同键重放同样按“当前”权限裁剪：首次可见、撤权后重放不再可见；
 * - 续跑游标是绑定租户 × 操作人 × 业务日的随机句柄，不是员工 UUID；别的操作人拿到也用不了。
 * 全部走真实授权器（tenantApi authorize: undefined），不用放行替身。
 */
import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { hire, pbWorld, type PbWorld } from './AC-PB-support.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const SERVICE = '../../apps/api/src/modules/employment/auto-regularization.js';
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

interface RunReceipt {
  readonly launched: { employeeId: string; businessId: string }[];
  readonly failed: { employeeId: string }[];
  readonly nextCursor: string | null;
}

/** 真实授权器下的租户管理员（配置管理权 = other_settings），任职数据范围为空。 */
async function realWorld(label: string) {
  const w = await pbWorld(testDb().db, `auto-reg-r3-${label}-${randomUUID()}`);
  const adminRecord = await bootstrapTenantAdmin(
    w.db,
    { tenantId: w.session.tenant.id, userId: w.session.user.id },
    cmd(),
  );
  const api = tenantApi(w.db, { authorize: undefined, clock: () => new Date('2026-10-01T01:00:00.000Z') });
  const asAdmin = { user: w.session.user.id, tenant: w.session.tenant.id };
  const admin = (method: string, path: string, options: { ifMatch?: number; body?: unknown; key?: string } = {}) =>
    api.request(method, path.startsWith('/api/') ? path : `/api/tenant/employment${path}`, {
      ...asAdmin,
      ...(options.ifMatch !== undefined ? { ifMatch: options.ifMatch } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.key ? { idempotencyKey: options.key } : {}),
    });
  const created = await admin('POST', '/auto-regularization-rules', {
    ifMatch: 0,
    body: {
      name: '到期当天自动转正',
      priority: 1,
      orgIds: [w.org.id],
      mode: 'direct',
      daysBefore: 0,
      initiatorType: 'rule_operator',
    },
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const on = await admin('PUT', '/api/tenant/settings/probation.auto_regularization_enabled', {
    ifMatch: 0,
    body: { value: true },
  });
  expect(on.status, await on.clone().text()).toBe(200);
  const run = async (body: Record<string, unknown> = {}, key?: string) => {
    const response = await admin('POST', '/auto-regularization/run', { ifMatch: 0, body, ...(key ? { key } : {}) });
    expect(response.status, await response.clone().text()).toBe(200);
    return { text: await response.clone().text(), receipt: (await response.json()) as RunReceipt };
  };
  const seed = { db: w.db, tenant: w.session.tenant, admin: w.session.user, adminRecord, api, asAdmin };
  return { w, api, admin, run, seed };
}

async function businessOf(w: PbWorld, employeeId: string): Promise<string> {
  const [row] = await withTenant(w.db, w.session.tenant.id, async (tx) =>
    rows<{ business_id: string }>(
      await tx.execute(sql`SELECT business_id::text FROM employment_auto_regularization_launches
        WHERE tenant_id=${w.session.tenant.id} AND employee_id=${employeeId}::uuid AND state='launched'`),
    ),
  );
  expect(row, '台账应有 launched 行').toBeDefined();
  return row!.business_id;
}

describe('第 2 轮 P1：立即执行回执按操作人当前范围裁剪', () => {
  it('员工数据范围为空：试用视图 403；立即执行照常发起，回执与同键重放都不含该员工 / 业务', async () => {
    const { w, admin, run } = await realWorld('empty');
    const due = await hire(w, { date: '2026-09-01', months: 1 });
    expect((await admin('GET', '/probation-views?view=all')).status).toBe(403);
    const key = randomUUID();
    const first = await run({}, key);
    const businessId = await businessOf(w, due.employee.id);
    expect(first.receipt).toMatchObject({ launched: [], failed: [], nextCursor: null });
    for (const secret of [due.employee.id, businessId]) expect(first.text).not.toContain(secret);
    const replay = await run({}, key);
    expect(replay.receipt).toEqual(first.receipt);
    for (const secret of [due.employee.id, businessId]) expect(replay.text).not.toContain(secret);
  });

  it('有范围时回执列出该员工；撤销数据范围后同键重放不再列出', async () => {
    const { w, admin, run, seed } = await realWorld('revoke');
    const due = await hire(w, { date: '2026-09-01', months: 1 });
    // 给操作人一个只读任职记录的身份，并把 TenantBase 数据范围设为本部门
    const profile = await createProfile(seed, `auto-reg-viewer-${randomUUID()}`);
    const record = MODULE_OBJECTS.employmentRecord;
    const fields = record.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false }));
    const permission = { dataOperations: { create: false, update: false, delete: false }, fields, buttons: [] };
    expect((await setObjectPermission(seed, profile, permission, record.code)).status).toBe(200);
    await makeGrantable(seed, [profile.id]);
    expect((await grant(seed, w.session.user.id, profile.id)).status).toBe(201);
    const scopePath = `/api/tenant/permission/scopes/${w.session.user.id}/TenantBase`;
    const range = await admin('PUT', scopePath, {
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId: w.org.id, includeDescendants: false }] },
    });
    expect(range.status, await range.clone().text()).toBe(200);
    const key = randomUUID();
    const first = await run({}, key);
    expect(first.receipt.launched.map((item) => item.employeeId)).toEqual([due.employee.id]);
    const revision = ((await range.json()) as { revision: number }).revision;
    const revoked = await admin('PUT', scopePath, { ifMatch: revision, body: { kind: 'default' } });
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    const replay = await run({}, key);
    expect(replay.receipt).toMatchObject({ launched: [], failed: [] });
    expect(replay.text).not.toContain(due.employee.id);
  });
});

describe('第 2 轮 P1：续跑游标不暴露员工 UUID', () => {
  type Limits = { scan: number; chunk: number };
  let restore: (() => void) | null = null;
  afterEach(() => restore?.());

  it('无办理结果但到扫描上限：游标是随机句柄（不是任何员工 ID），能续跑；别的操作人用它 400', async () => {
    const service = (await import(SERVICE)) as { AUTO_REGULARIZATION_RUN_LIMITS: Limits };
    const saved = { ...service.AUTO_REGULARIZATION_RUN_LIMITS };
    Object.assign(service.AUTO_REGULARIZATION_RUN_LIMITS, { scan: 1 });
    restore = () => Object.assign(service.AUTO_REGULARIZATION_RUN_LIMITS, saved);

    const { w, run } = await realWorld('cursor');
    const people: string[] = [];
    // 没有预计试用结束日：是候选、不是适用对象（不会有办理结果）
    for (let i = 0; i < 3; i += 1) people.push((await hire(w, { date: '2026-09-01', name: `候选${i}` })).employee.id);
    const first = await run();
    expect(first.receipt).toMatchObject({ launched: [], failed: [] });
    const handle = first.receipt.nextCursor;
    expect(handle).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(people).not.toContain(handle);
    const [employee] = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rows<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM employment_employees
          WHERE tenant_id=${w.session.tenant.id} AND id=${handle}::uuid`),
      ),
    );
    expect(employee!.n).toBe(0);
    for (const id of people) expect(first.text).not.toContain(id);

    // 同一操作人带句柄续跑：推进到下一个候选（仍无办理结果），新句柄也不是员工 ID
    const second = await run({ cursor: handle });
    expect(second.receipt.nextCursor).not.toBe(handle);
    expect(people).not.toContain(second.receipt.nextCursor);

    // 别的操作人（放行授权，只为越过配置权限）拿到句柄也用不了
    const other = await addMember({ db: w.db, tenant: w.session.tenant } as never, '另一操作人');
    const response = await tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00.000Z') }).request(
      'POST',
      '/api/tenant/employment/auto-regularization/run',
      { user: other.id, tenant: w.session.tenant.id, ifMatch: 0, body: { cursor: handle } },
    );
    expect(response.status, await response.clone().text()).toBe(400);
    expect(((await response.json()) as { error: { details?: { reason?: string } } }).error.details?.reason).toBe(
      'AUTO_RUN_CURSOR_INVALID',
    );
  });
});
