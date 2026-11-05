/**
 * F-251（#442 P2，DEC-406 后补-权限）：撤销离职的超编确认明细按操作人的“编制”数据范围过滤。
 * 部门可见只说明能看到这个人的任职部门；超编的编制对象（ID / 峰值 / 上限）另受编制对象自己的数据范围约束，
 * 不可见的编制不返回任何明细，只计入 hiddenCount 的通用提示（docs/08_设计/R2-T03_离职管理设计.md §6B.2 / §9.1）。
 */
import './support/exit-gate-enforced.js';
import type { Authorizer } from '@italent/api';
import { sql } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { cancelWorld } from './AC-EXIT-cancel-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const TODAY = '2026-10-06';

const ALL: ModuleScope = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
const FIELDS = new Set([
  ...MODULE_OBJECTS.employmentRecord.fields.map((field) => field.code),
  ...MODULE_OBJECTS.employee.fields.map((field) => field.code),
  'id',
  'revision',
]);
const orgScope = (tenantId: string, ...orgIds: string[]): ModuleScope => ({
  ...EMPTY_SCOPE,
  hasDataPermission: true,
  terms: [
    { dimension: 'organization', orgIds, personIds: [], personQuery: { kind: 'organization', tenantId, asOf: TODAY } },
  ],
});

interface Confirmation {
  error: { details: { reason: string; warnings: Record<string, unknown>[]; hiddenCount: number } };
}

/** 任职对象看全部，编制对象只看 establishmentOrgs 下的编制（其余对象同任职）。 */
async function setup(label: string, establishmentOrgs: (x: Awaited<ReturnType<typeof cancelWorld>>) => string[]) {
  const x = await cancelWorld(database().db, label, TODAY);
  const newcomer = await x.newcomer('调入者');
  const leave = await x.directLeave('2026-10-20');
  expect((await x.transferInto(newcomer.id, x.from.id, '2026-10-10')).status).toBe(201);
  const authorize: Authorizer = () => true;
  const tenantId = x.session.tenant.id;
  registerScopeProvider(authorize, {
    scope: async (query) =>
      query.objectCode === MODULE_OBJECTS.establishment.code ? orgScope(tenantId, ...establishmentOrgs(x)) : ALL,
    authorize: async () => true,
    fields: async () => FIELDS,
  });
  const api = tenantApi(x.db, { authorize, clock: () => new Date(`${TODAY}T01:00:00Z`) });
  const cancelAs = async (body: object) =>
    api.request('POST', `/api/tenant/employment/exits/${leave.id}/cancel`, {
      user: x.session.user.id,
      tenant: tenantId,
      ifMatch: (await x.business(leave.id)).revision,
      body,
    });
  return { x, leave, cancelAs };
}

describe('F-251 撤销离职超编明细按编制数据范围过滤', () => {
  it('部门可见、编制不可见：不返回编制 ID / 峰值 / 上限，只给通用计数；确认后审计也不留明细', async () => {
    const { x, leave, cancelAs } = await setup('f251-hidden', (w) => [w.to.id]);
    const response = await cancelAs({ reason: '撤销' });
    expect(response.status).toBe(409);
    const body = (await response.json()) as Confirmation;
    expect(body.error.details).toMatchObject({ reason: 'CONFIRMATION_REQUIRED', warnings: [], hiddenCount: 1 });
    expect(JSON.stringify(body)).not.toContain('capacityId');
    expect(JSON.stringify(body)).not.toContain('peak');

    const confirmed = await cancelAs({ reason: '撤销', confirmed: true });
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    const [audit] = await x.sqlRows<{ after: unknown }>(
      sql`SELECT after FROM audit_events WHERE tenant_id=${x.session.tenant.id} AND object_id=${leave.id}
        AND action='employment.exit.over_capacity_confirmed'`,
    );
    expect(audit?.after).toMatchObject({ warnings: [], hiddenCount: 1 });
  });

  it('编制在范围内：明细照常返回（编制 ID、峰值、上限）', async () => {
    const { cancelAs } = await setup('f251-visible', (w) => [w.from.id]);
    const response = await cancelAs({ reason: '撤销' });
    expect(response.status).toBe(409);
    const { error } = (await response.json()) as Confirmation;
    expect(error.details.hiddenCount).toBe(0);
    expect(error.details.warnings).toEqual([
      expect.objectContaining({
        reason: 'ESTABLISHMENT_EXCEEDED',
        capacityId: expect.any(String),
        peak: 2,
        limit: 1,
      }),
    ]);
  });
});
