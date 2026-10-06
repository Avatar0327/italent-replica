/** F-023 / DEC-197：真实联动写入，读取走受控权限提供器与统一范围 SQL。 */
import { randomUUID } from 'node:crypto';
import { auditEvents, sql, withTenant } from '@italent/db';
import { CONTRACT_OBJECT, MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { controlledApi, everyField, linkageWorld, type ControlledGrants } from './AC-LNK-support.js';
import type { DataChangeDetail, DataChangeLog } from './AC-AUD-support.js';

const database = useTestDb();
const EMP = MODULE_OBJECTS.employmentRecord.code;
const ORG = MODULE_OBJECTS.organization.code;
const NOW = '2026-10-10T02:00:00Z';
const ALL = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
const SECRET = randomUUID();
const PUBLIC = randomUUID();

async function fixture() {
  const w = await linkageWorld(database().db, 'aud-linkage');
  const manager = await w.hire('联动审计经理');
  const receiver = await w.hire('联动接收人');
  const subordinate = await w.hire('联动下属', { directManagerId: manager.employee.id });
  await w.setHead(w.from, manager.employee.id);
  const contract = await w.contract(manager.employee.id);
  const business = await w.saved(
    await w.transfer(manager, {
      mode: 'direct',
      submit: false,
      linkage: {
        adjustSalary: true,
        onTrial: { months: 3 },
        contract: { targetId: contract.id, fields: { endDate: '2029-10-09' } },
        dutyTransfer: {
          subordinates: [{ employeeId: subordinate.employee.id, relation: 'direct', receiverId: receiver.employee.id }],
          orgRoles: [{ orgId: w.from.id, role: 'person_in_charge', receiverId: receiver.employee.id }],
        },
      },
    }),
  );
  expect((await w.runScheduler('2026-10-10T01:00:00Z')).failed).toEqual([]);
  const other = await linkageWorld(database().db, 'aud-linkage-other');
  // 兼容历史日志：原格式 contract.fields 是 changes 中的聚合对象，不能整块放行。
  const historicalId = randomUUID();
  const hiddenOnlyId = randomUUID();
  const before = {
    contract: {
      targetId: contract.id,
      fields: {
        endDate: '2028-08-31',
        signingDate: '2026-08-25',
        customFields: { [SECRET]: '隐藏旧值', [PUBLIC]: '公开旧值' },
      },
    },
    onTrial: { months: 2, startDate: '2026-10-10' },
  };
  const after = {
    contract: {
      targetId: contract.id,
      fields: {
        endDate: '2029-10-09',
        signingDate: '2026-08-26',
        customFields: { [SECRET]: '隐藏新值', [PUBLIC]: '公开新值' },
      },
    },
    onTrial: { months: 3, startDate: '2026-10-10' },
  };
  await withTenant(w.db, w.as.tenant, async (tx) => {
    for (const [id, old, next] of [
      [historicalId, before, after],
      [
        hiddenOnlyId,
        before,
        {
          ...before,
          contract: { ...before.contract, fields: { ...before.contract.fields, signingDate: '2026-08-27' } },
        },
      ],
    ] as const) {
      await tx.insert(auditEvents).values({
        id,
        tenantId: w.as.tenant,
        actorUserId: null,
        action: 'transfer.linkage.save',
        objectType: 'transfer-linkage',
        objectId: business.id.toUpperCase(),
        before: old,
        after: next,
        commandId: randomUUID(),
        occurredAt: new Date(NOW),
      });
    }
  });
  const logs = await withTenant(w.db, w.as.tenant, async (tx) => {
    const result = await tx.execute(sql`SELECT id,action FROM audit_events
      WHERE object_type='transfer-linkage' AND object_id=${business.id}`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { id: string; action: string }[];
  });
  const own: ModuleScope = {
    ...EMPTY_SCOPE,
    hasDataPermission: true,
    terms: [
      {
        dimension: 'organization',
        orgIds: [w.to.id],
        personIds: [],
        personQuery: { kind: 'organization', tenantId: w.as.tenant, asOf: '2026-10-10' },
      },
    ],
  };
  return { w, business, contract, manager, subordinate, other, logs, own, historicalId, hiddenOnlyId };
}

describe('F-023 调动联动审计可见性 AC-AUD-07～14', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    f = await fixture();
  });
  function reader(grants: ControlledGrants = {}, otherTenant = false) {
    const as = otherTenant ? f.other.as : f.w.as;
    const request = controlledApi(f.w.db, as.tenant, as.user, grants, NOW);
    return {
      get: (id: string) => request('GET', `/api/tenant/audit/data-changes/${id}`),
      async list(query: Record<string, string> = {}) {
        const response = await request(
          'GET',
          `/api/tenant/audit/data-changes?${new URLSearchParams({
            objectType: 'transfer-linkage',
            objectId: f.business.id,
            limit: '100',
            ...query,
          })}`,
        );
        expect(response.status, await response.clone().text()).toBe(200);
        return (await response.json()) as { items: DataChangeLog[]; nextCursor: string | null };
      },
    };
  }
  const ids = (rows: DataChangeLog[]) => rows.map((row) => row.id);

  it('AC-AUD-07 有对象查看权且当前员工在范围内，保存与执行事件可见；旧日志未存归属也能解析', async () => {
    const r = reader({ scopes: { [EMP]: f.own } });
    const page = await r.list();
    expect(page.items.some((row) => row.action === 'transfer.linkage.executed')).toBe(true);
    expect(ids(page.items)).toContain(f.historicalId);
    expect((await r.get(f.historicalId)).status).toBe(200);
    expect((await reader({ deny: (q) => q.action === 'object.view' && q.resource === EMP }).list()).items).toEqual([]);
  });

  it('AC-AUD-08 范围外列表为空、详情 404；缺失业务即使看全部也不可见', async () => {
    const r = reader({ scopes: { [EMP]: EMPTY_SCOPE } });
    expect((await r.list()).items).toEqual([]);
    expect((await r.get(f.historicalId)).status).toBe(404);
    const orphan = randomUUID();
    await withTenant(f.w.db, f.w.as.tenant, (tx) =>
      tx.insert(auditEvents).values({
        id: orphan,
        tenantId: f.w.as.tenant,
        actorUserId: null,
        action: 'transfer.linkage.save',
        objectType: 'transfer-linkage',
        objectId: randomUUID(),
        before: null,
        after: { adjustSalary: true },
        occurredAt: new Date(NOW),
      }),
    );
    expect((await reader().get(orphan)).status).toBe(404);
  });

  it('AC-AUD-09 嵌套合同/自定义字段逐项裁剪，列表、详情、差异、文本及字段筛选一致', async () => {
    const r = reader({
      fields: {
        [EMP]: ['onTrialMonths', 'signingDate', 'contractChange'],
        [CONTRACT_OBJECT]: ['endDate', `custom:${PUBLIC}`],
      },
    });
    const page = await r.list();
    expect(ids(page.items)).toContain(f.historicalId);
    expect(ids(page.items)).not.toContain(f.hiddenOnlyId);
    const detail = (await (await r.get(f.historicalId)).json()) as DataChangeDetail;
    expect(detail.after).toEqual({
      onTrial: { months: 3 },
      contract: {
        fields: {
          endDate: '2029-10-09',
          customFields: { [PUBLIC]: '公开新值' },
        },
      },
    });
    expect(detail.before).toEqual({
      onTrial: { months: 2 },
      contract: {
        fields: {
          endDate: '2028-08-31',
          customFields: { [PUBLIC]: '公开旧值' },
        },
      },
    });
    expect(JSON.stringify(detail)).not.toContain('隐藏');
    expect(JSON.stringify(detail)).not.toContain('signingDate');
    expect(detail.changes.map((c) => c.field)).toContain('contract.fields.endDate');
    expect((await r.list({ field: 'contract.fields.endDate' })).items.map((row) => row.id)).toContain(f.historicalId);
    for (const field of ['signingDate', 'contract.fields.signingDate', `contract.fields.customFields.${SECRET}`])
      expect((await r.list({ field })).items).toEqual([]);
    expect((await r.get(f.hiddenOnlyId)).status).toBe(404);
  });

  it('AC-AUD-09 合同另验对象权与范围；仅任职看全部不放行合同字段', async () => {
    for (const grants of [
      {
        deny: (q: { action: string; resource?: string }) =>
          q.action === 'object.view' && q.resource === CONTRACT_OBJECT,
      },
      { scopes: { [CONTRACT_OBJECT]: EMPTY_SCOPE } },
    ]) {
      const r = reader(grants);
      const response = await r.get(f.historicalId);
      expect(response.status).toBe(200);
      const body = (await response.json()) as DataChangeDetail;
      expect(body.after).not.toHaveProperty('contract');
      expect((await r.list({ field: 'endDate' })).items).toEqual([]);
    }
  });

  it('AC-AUD-10 创建人取调动业务，系统写入仍可见；合同按自己的创建人裁剪', async () => {
    const created = (creatorId: string): ModuleScope => ({
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      terms: [{ dimension: 'using_user', creatorId, orgIds: [], personIds: [] }],
    });
    const r = reader({ scopes: { [EMP]: created(f.w.as.user), [CONTRACT_OBJECT]: created(randomUUID()) } });
    expect(ids((await r.list()).items)).toContain(f.historicalId);
    expect((await r.list({ field: 'endDate' })).items).toEqual([]);
    expect((await reader({ scopes: { [EMP]: created(randomUUID()) } }).list()).items).toEqual([]);
    expect(
      (
        await reader({ scopes: { [EMP]: created(f.w.as.user), [CONTRACT_OBJECT]: created(f.w.as.user) } }).list({
          field: 'endDate',
        })
      ).items.length,
    ).toBeGreaterThan(0);
  });

  it('AC-AUD-11 待调薪只给有范围、Transfer.Hr 权限与 adjustSalary 字段的 HR', async () => {
    const salary = f.logs.find((log) => log.action === 'transfer.linkage.salary_reminder')!;
    expect(salary).toBeDefined();
    expect((await reader().get(salary.id)).status).toBe(200);
    for (const grants of [
      { deny: (q: { resource?: string }) => !!q.resource?.includes('Transfer.Hr') },
      { scopes: { [EMP]: EMPTY_SCOPE } },
      { fields: { [EMP]: everyField(EMP).filter((field) => field !== 'adjustSalary') } },
    ]) {
      const r = reader(grants);
      expect((await r.list({ action: salary.action })).items).toEqual([]);
      expect((await r.get(salary.id)).status).toBe(404);
    }
  });

  it('AC-AUD-12 大写业务/日志 UUID 正规化，仍按同一归属及字段筛选', async () => {
    expect(ids((await reader().list({ objectId: f.business.id.toUpperCase() })).items)).toContain(f.historicalId);
    expect((await reader().get(f.historicalId.toUpperCase())).status).toBe(200);
  });

  it('AC-AUD-13 跨租户同样看全部也不能读列表/详情/字段筛选', async () => {
    const r = reader({}, true);
    expect((await r.list()).items).toEqual([]);
    expect((await r.list({ field: 'endDate' })).items).toEqual([]);
    expect((await r.get(f.historicalId)).status).toBe(404);
  });

  it('AC-AUD-14 下属与组织角色子项额外验目标范围和字段，无权整条隐藏且分页不留空洞', async () => {
    const action = 'transfer.linkage.item.succeeded';
    const full = await reader().list({ action });
    expect(full.items).toHaveLength(2);
    for (const grants of [
      { scopes: { [EMP]: f.own, [ORG]: EMPTY_SCOPE } },
      { fields: { [EMP]: everyField(EMP).filter((v) => v !== 'directManagerId'), [ORG]: [] } },
      {
        deny: (q: { action: string; resource?: string }) => q.action === 'object.view' && q.resource === ORG,
        fields: { [EMP]: everyField(EMP).filter((v) => v !== 'directManagerId') },
      },
    ]) {
      const r = reader(grants);
      expect((await r.list({ action, limit: '1' })).items).toEqual([]);
      for (const log of full.items) expect((await r.get(log.id)).status).toBe(404);
    }
    const page = await reader({ scopes: { [ORG]: EMPTY_SCOPE, [EMP]: ALL } }).list({ action, limit: '1' });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });
});
