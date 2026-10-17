/**
 * BE-3 数据范围与字段裁剪：视图按任职记录数据范围裁剪；批量转正范围外的人只在本人回执里 404；
 * 同键重放按当前范围复核每一张回执；详情的任职字段按可见字段裁剪，试用信息是控制项照常返回。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { employeeRevision, hire, pbWorld, type PbWorld } from './AC-PB-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

const FIELDS = ['id', 'employeeId', 'revision', 'employeeStatus', 'departmentId', 'postId', 'kind', 'effectiveDate'];

/** 只看 orgIds 组织（及其中的 personIds）的操作人：授权放行，范围按组织维度，字段只给 fields。 */
function scopedApi(w: PbWorld, scope: { orgIds: string[]; personIds: string[] }, fields: readonly string[] = FIELDS) {
  const { orgIds, personIds } = scope;
  const authorize: Authorizer = () => true;
  registerScopeProvider(authorize, {
    scope: async () => ({
      ...EMPTY_SCOPE,
      orgIds,
      hasDataPermission: orgIds.length > 0,
      terms: [{ dimension: 'organization' as const, orgIds, personIds }],
    }),
    authorize: async () => true,
    fields: async () => new Set(fields),
  });
  const api = tenantApi(w.db, { authorize, clock: () => new Date('2026-10-01T01:00:00.000Z') });
  return (method: string, path: string, options: { body?: unknown; idempotencyKey?: string } = {}) =>
    api.request(method, `/api/tenant/employment${path}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ...options,
    });
}

async function twoOrgs(label: string) {
  const w = await pbWorld(testDb().db, label);
  const inside = await hire(w, { months: 3, name: '范围内' });
  const otherOrg = await w.session.org('范围外部门', { establishedOn: '2026-01-01' });
  const outside = await hire({ ...w, org: otherOrg }, { months: 3, name: '范围外' });
  return { w, inside, outside };
}

describe('BE-3 数据范围与字段裁剪', () => {
  it('视图只列范围内的人；批量转正范围外的人只在本人回执里 404，其余照常办理', async () => {
    const { w, inside, outside } = await twoOrgs('pb-scope-view');
    const request = scopedApi(w, { orgIds: [w.org.id], personIds: [inside.employee.id] });
    const view = await request('GET', '/probation-views?view=all');
    expect(view.status, await view.clone().text()).toBe(200);
    const items = ((await view.json()) as { items: { employeeId: string }[] }).items;
    expect(items.map((item) => item.employeeId)).toEqual([inside.employee.id]);

    const response = await request('POST', '/regularizations', {
      body: {
        mode: 'direct',
        probationResult: 'normal',
        effectiveDate: '2026-10-20',
        items: [
          { employeeId: inside.employee.id, revision: await employeeRevision(w, inside.employee.id) },
          { employeeId: outside.employee.id, revision: await employeeRevision(w, outside.employee.id) },
        ],
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const receipt = (await response.json()) as { items: { status: string; error: { code: string } | null }[] };
    expect(receipt.items.map((item) => item.status)).toEqual(['succeeded', 'failed']);
    expect(receipt.items[1]!.error!.code).toBe('NOT_FOUND');
  });

  it('同键重放：回执里有范围外的人 → 404，拿不到原回执', async () => {
    const { w, inside } = await twoOrgs('pb-scope-replay');
    const key = randomUUID();
    const body = {
      mode: 'direct',
      probationResult: 'normal',
      effectiveDate: '2026-10-20',
      items: [{ employeeId: inside.employee.id, revision: await employeeRevision(w, inside.employee.id) }],
    };
    const first = await w.session.request('POST', '/regularizations', { body, idempotencyKey: key });
    expect(first.status, await first.clone().text()).toBe(200);
    const other = await w.session.org('另一部门', { establishedOn: '2026-01-01' });
    const replay = await scopedApi(w, { orgIds: [other.id], personIds: [] })('POST', '/regularizations', {
      body,
      idempotencyKey: key,
    });
    expect(replay.status).toBe(404);
  });

  it('详情：入职日期等任职字段按可见字段裁剪，试用信息照常返回', async () => {
    const { w, inside } = await twoOrgs('pb-scope-fields');
    const request = scopedApi(w, { orgIds: [w.org.id], personIds: [inside.employee.id] }, [
      'id',
      'employeeId',
      'revision',
      'kind',
      'effectiveDate',
    ]);
    const response = await request('GET', `/employees/${inside.employee.id}/probation?asOf=2026-10-01`);
    expect(response.status, await response.clone().text()).toBe(200);
    const detail = (await response.json()) as Record<string, unknown> & { records: Record<string, unknown>[] };
    expect(detail).not.toHaveProperty('entryDate');
    expect(detail).toMatchObject({ employeeId: inside.employee.id, hasProbation: true, expectedEndDate: '2026-11-30' });
    expect(detail.records[0]).toEqual({
      id: expect.any(String),
      kind: 'hire',
      effectiveDate: '2026-09-01',
      regularizationDate: null,
    });
  });
});
