/**
 * F-246（#439 P2，DEC-406 后补-权限）：撤销离职的下游清单里，合同目标在合同对象查看权之外还要过合同的数据范围，
 * detail 按合同对象的字段查看权裁剪。范围外的合同不展示、不回传任何字段，只计入 hiddenCount
 * （docs/08_设计/R2-T03_离职管理设计.md §7.4 / §9.1）。
 */
import './support/exit-gate-enforced.js';
import type { Authorizer } from '@italent/api';
import { CONTRACT_OBJECT, MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { cancelWorld } from './AC-EXIT-cancel-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const TODAY = '2026-10-06';

const ALL: ModuleScope = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
const EMPLOYMENT_FIELDS = new Set([
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

interface Cancelled {
  downstream: {
    items: {
      kind: string;
      status: string;
      targets: { id: string; detail?: Record<string, unknown> }[];
      hiddenCount: number;
    }[];
  };
}

/** 任职对象看全部；合同对象的数据范围与可见字段由用例指定。 */
async function setup(
  label: string,
  contract: { scopeOrg: (x: Awaited<ReturnType<typeof cancelWorld>>) => string; fields: readonly string[] },
) {
  const x = await cancelWorld(database().db, label, TODAY);
  const labor = await x.contractType('劳动合同');
  const created = await x.createContract(labor);
  const leave = await x.createdLeave(x.employee.id, leaveBody('2026-10-05', 'direct'));
  const authorize: Authorizer = () => true;
  const tenantId = x.session.tenant.id;
  registerScopeProvider(authorize, {
    scope: async (query) => (query.objectCode === CONTRACT_OBJECT ? orgScope(tenantId, contract.scopeOrg(x)) : ALL),
    authorize: async () => true,
    fields: async (_tenant, _user, objectCode) =>
      objectCode === CONTRACT_OBJECT ? new Set(contract.fields) : EMPLOYMENT_FIELDS,
  });
  const api = tenantApi(x.db, { authorize, clock: () => new Date(`${TODAY}T01:00:00Z`) });
  const cancel = async () => {
    const response = await api.request('POST', `/api/tenant/employment/exits/${leave.id}/cancel`, {
      user: x.session.user.id,
      tenant: tenantId,
      ifMatch: (await x.business(leave.id)).revision,
      body: { reason: '撤销' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Cancelled;
  };
  return { cancel, contractId: created.id };
}

const contractItem = (body: Cancelled) => body.downstream.items.find((entry) => entry.kind === 'contract')!;
const ALL_CONTRACT_FIELDS = ['id', 'number', 'typeId', 'effectiveDate', 'endDate', 'actualTerminationDate'];

describe('F-246 撤销清单的合同目标：合同数据范围 + 字段裁剪', () => {
  it('合同在操作人合同数据范围之外：不展示、不回传任何字段，只计 hiddenCount', async () => {
    const { cancel, contractId } = await setup('f246-out-of-scope', {
      scopeOrg: (x) => x.to.id,
      fields: ALL_CONTRACT_FIELDS,
    });
    const body = await cancel();
    expect(contractItem(body)).toMatchObject({ status: 'found', targets: [], hiddenCount: 1 });
    expect(JSON.stringify(body)).not.toContain(contractId);
  });

  it('合同在范围内：展示，detail 按合同字段查看权裁剪（无权的合同字段缺席，非合同字段照常）', async () => {
    const { cancel, contractId } = await setup('f246-trimmed', {
      scopeOrg: (x) => x.from.id,
      fields: ['id', 'number', 'effectiveDate'],
    });
    const item = contractItem(await cancel());
    expect(item.hiddenCount).toBe(0);
    expect(item.targets).toHaveLength(1);
    const [target] = item.targets;
    expect(target).toMatchObject({ id: contractId });
    expect(target!.detail).toMatchObject({ effect: 'contract_terminated', effectiveDate: '2026-01-01' });
    expect(target!.detail).not.toHaveProperty('typeId');
    expect(target!.detail).not.toHaveProperty('endDate');
  });

  it('合同在范围内且有全部字段查看权：detail 完整', async () => {
    const { cancel } = await setup('f246-full', { scopeOrg: (x) => x.from.id, fields: ALL_CONTRACT_FIELDS });
    const [target] = contractItem(await cancel()).targets;
    expect(target!.detail).toMatchObject({
      effect: 'contract_terminated',
      typeId: expect.any(String),
      effectiveDate: '2026-01-01',
      endDate: '2027-12-31',
    });
  });
});
