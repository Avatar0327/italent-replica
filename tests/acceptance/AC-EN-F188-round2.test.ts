/**
 * F-188 第 1 轮审查返工（#367，Codex Sol high）：
 * P2-1 列表响应的 probation 在真实授权提供器（字段目录裁剪）下也必须读回 true / false / null；
 * P2-2 试用期前后值进字段级审计（DEC-019）：添加待入职带值、改日期同时改试用期、改期携带。
 */
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { withLoginEmail } from './AC-EMP-support.js';
import {
  addHire,
  addPending,
  businessRevision,
  entryAction,
  entryWorld,
  hireBody,
  type EntryWorld,
} from './AC-EN-BE2a-support.js';
import { TODAY } from './AC-ORG-people-support.js';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
  type PermissionWorld,
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const clock = () => new Date(`${TODAY}T01:00:00.000Z`);
const EMPLOYMENT = MODULE_OBJECTS.employmentRecord;

describe('F-188 返工 P2-1：真实授权提供器下列表带 probation', () => {
  let world: PermissionWorld;
  beforeAll(async () => {
    const seed = await seedPermissionWorld(testDb().db);
    world = { ...seed, api: tenantApi(testDb().db, { authorize: undefined, clock }) };
  });

  it('给全部合法字段查看权：保存 true / false / 未填 三种值都能读回', async () => {
    const setup = tenantApi(world.db, { clock });
    const create = async (path: string, body: object, ifMatch = 0) => {
      const response = await setup.request('POST', `/api/tenant/${path}`, { ...world.asAdmin, ifMatch, body });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json()) as { id: string; revision: number };
    };
    const org = await create('org/organizations', {
      name: '试用期读回部门',
      establishedOn: '2025-01-01',
      parents: { admin: { parentId: world.tenant.id } },
    });
    const pending = async (name: string, date: string, extra: object) => {
      const employee = await create('employment/employees', { code: `E${uniqueSuffix()}`, name });
      await create(
        `employment/employees/${employee.id}/businesses`,
        withLoginEmail(employee.id, {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: date,
          fields: { employType: 'internal', departmentId: org.id },
          pendingEntry: true,
          ...extra,
        }),
        employee.revision,
      );
    };
    await pending('试用期是', '2026-10-10', { probation: true });
    await pending('试用期否', '2026-10-11', { probation: false });
    await pending('试用期未填', '2026-10-12', {});

    const profile = await createProfile(world, `read-${uniqueSuffix()}`);
    const permission = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: EMPLOYMENT.fields.map((field) => ({ fieldCode: field.code, view: true, edit: false })),
        buttons: [],
      },
      EMPLOYMENT.code,
    );
    expect(permission.status, await permission.clone().text()).toBe(200);
    await makeGrantable(world, [profile.id]);
    const reader = await addMember(world, 'probation-reader');
    expect((await grant(world, reader.id, profile.id)).status).toBe(201);
    // 待入职的人还没有组织归属，按组织范围裁剪看不到；这里给“看全部”，让用例只检验字段投影
    const all = await world.api.request('PUT', `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { targetKind: 'app', targetCode: '', seeAll: true },
    });
    expect(all.status, await all.clone().text()).toBe(200);
    const response = await world.api.request('GET', '/api/tenant/employment/pending-entries?view=all', {
      user: reader.id,
      tenant: world.tenant.id,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { items: Record<string, unknown>[] };
    const items = body.items;
    expect(items.map((item) => [item.effectiveDate, item.probation])).toEqual([
      ['2026-10-10', true],
      ['2026-10-11', false],
      ['2026-10-12', null],
    ]);
  });
});

async function auditRows(w: EntryWorld, action: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT object_id AS "objectId", before, after FROM audit_events
      WHERE tenant_id=${w.session.tenant.id} AND action=${action} ORDER BY occurred_at, id`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
      objectId: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }[];
  });
}

describe('F-188 返工 P2-2：试用期前后值进审计', () => {
  it('添加待入职带 probation：创建审计的 after 带 probation；不带时没有该键', async () => {
    const w = await entryWorld(testDb().db, 'f188-r2-add');
    const withValue = await w.session.employee('审计带值合成员工');
    const added = await addHire(
      w.session,
      withValue,
      hireBody(w.org.id, '2026-10-10', { pendingEntry: true, probation: true }),
    );
    expect(added.status, await added.clone().text()).toBe(201);
    const without = await w.session.employee('审计未填合成员工');
    expect((await addHire(w.session, without, hireBody(w.org.id, '2026-10-11', { pendingEntry: true }))).status).toBe(
      201,
    );
    const created = await auditRows(w, 'employment.business.create');
    expect(created.map((row) => row.after?.probation).sort()).toEqual([true, undefined]);
  });

  it('改日期同时改试用期：审计 before.probation=false、after.probation=true', async () => {
    const w = await entryWorld(testDb().db, 'f188-r2-edit');
    const { recordId } = await addPending(w, '2026-10-10');
    const first = await w.session.request('PATCH', `/pending-entries/${recordId}`, {
      ifMatch: await businessRevision(w, recordId),
      body: { effectiveDate: '2026-10-10', probation: false },
    });
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await auditRows(w, 'employment.entry.edit')).toMatchObject([
      { before: { probation: null }, after: { probation: false } },
    ]);
    const second = await w.session.request('PATCH', `/pending-entries/${recordId}`, {
      ifMatch: await businessRevision(w, recordId),
      body: { effectiveDate: '2026-10-15', probation: true },
    });
    expect(second.status, await second.clone().text()).toBe(200);
    const rows = await auditRows(w, 'employment.entry.edit');
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.before?.probation === false)).toMatchObject({ after: { probation: true } });
  });

  it('改期入职携带试用期：审计前后值相同（不丢失）', async () => {
    const w = await entryWorld(testDb().db, 'f188-r2-postpone');
    const { recordId } = await addPending(w, '2026-10-10');
    const saved = await w.session.request('PATCH', `/pending-entries/${recordId}`, {
      ifMatch: await businessRevision(w, recordId),
      body: { effectiveDate: '2026-10-10', probation: false },
    });
    expect(saved.status).toBe(200);
    expect((await entryAction(w, recordId, 'postpone', { effectiveDate: '2026-10-20' })).status).toBe(200);
    expect(await auditRows(w, 'employment.entry.postpone')).toMatchObject([
      { before: { probation: false }, after: { probation: false } },
    ]);
  });
});
