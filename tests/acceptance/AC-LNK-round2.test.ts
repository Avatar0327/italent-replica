/**
 * PR #74 第二轮（astra 首审）：职责转交 / 合同联动的事务内授权（P1-1、P1-2、P1-5），联动详情按权限裁剪（P1-3），
 * 联动进入审批快照与盲审（P1-6），接收人按联动日判定在职（P2-1），迟到执行按实际执行日（P2-2，DEC-186）。
 * 权限用测试替身注入（授权、范围、可见字段分别可控），真实授权器复用同一套 requireObjectWrite / 范围谓词。
 */
import { randomUUID } from 'node:crypto';
import { createUser, grantMembership, sql, withTenant } from '@italent/db';
import { CONTRACT_OBJECT, MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { Authorizer } from '@italent/api';
import { ADAPTERS } from '../../apps/api/src/modules/approval/adapters.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import { D, linkageWorld, type LinkageWorld } from './AC-LNK-support.js';

const database = useTestDb();
const ORG = 'TenantBase.Organization';
const EMPLOYMENT = 'TenantBase.EmploymentRecord';
const ALL: ModuleScope = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };

interface Grants {
  readonly deny?: (request: Parameters<Authorizer>[0]) => boolean;
  readonly scopes?: Readonly<Record<string, ModuleScope>>;
  readonly fields?: Readonly<Record<string, readonly string[]>>;
}

/** 受控权限的 HR 会话：用户可另建成员（验“我创建的”合同范围）。 */
async function scopedSession(w: LinkageWorld, grants: Grants, userId = w.session.user.id) {
  const authorize: Authorizer = (request) => !grants.deny?.(request);
  registerScopeProvider(authorize, {
    scope: async (query) => grants.scopes?.[query.objectCode ?? ''] ?? ALL,
    authorize: async (request) => authorize(request),
    fields: async (_tenantId, _userId, objectCode) => {
      const allowed = grants.fields?.[objectCode];
      return new Set(allowed ?? everyField(objectCode));
    },
  });
  const api = tenantApi(w.db, { authorize, clock: () => new Date('2026-10-01T01:00:00Z') });
  return (method: string, path: string, body?: object, ifMatch?: number) =>
    api.request(method, `/api/tenant/employment${path}`, {
      user: userId,
      tenant: w.session.tenant.id,
      ...(ifMatch === undefined ? {} : { ifMatch }),
      ...(body ? { body } : {}),
    });
}

/** 未限制时返回对象登记的全部字段（替身没有“全部可见”的哨兵值）。 */
function everyField(objectCode: string): string[] {
  const definition = Object.values(MODULE_OBJECTS).find((object) => object.code === objectCode);
  return definition ? definition.fields.map((field) => field.code) : [];
}

const orgScope = (orgIds: string[]): ModuleScope => ({
  ...EMPTY_SCOPE,
  orgIds,
  hasDataPermission: true,
  terms: [{ dimension: 'organization', orgIds, personIds: [] }],
});

function transferBody(w: LinkageWorld, linkage: object, extra: object = {}) {
  return {
    initiator: 'hr',
    transferTypeCode: 'cross_department',
    mode: 'application',
    submit: false,
    effectiveDate: D,
    fields: { departmentId: w.to.id },
    linkage,
    ...extra,
  };
}

function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

describe('P1-1 职责转交改写范围外组织', () => {
  it('调动人兼任范围外组织负责人：转交该角色整单拒绝，组织负责人不变', async () => {
    const w = await linkageWorld(database().db, 'r2-org-scope');
    const outside = await w.session.org('范围外组织', { establishedOn: '2026-01-01' });
    const person = await w.hire('兼任负责人');
    const receiver = await w.hire('接收人');
    await w.setHead(outside, person.employee.id);
    const request = await scopedSession(w, { scopes: { [ORG]: orgScope([w.from.id, w.to.id]) } });
    const employee = await w.session.getEmployee(person.employee.id);
    const response = await request(
      'POST',
      `/transfers/employees/${person.employee.id}`,
      transferBody(w, {
        dutyTransfer: { orgRoles: [{ orgId: outside.id, role: 'person_in_charge', receiverId: receiver.employee.id }] },
      }),
      employee.revision,
    );
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'LINKED_RECORD_OUT_OF_SCOPE' } });
    expect((await w.orgPeople(outside.id)).head).toBe(person.employee.id);
    expect((await w.session.getEmployee(person.employee.id)).revision).toBe(employee.revision);
  });
});

describe('P1-2 合同联动按目标合同的对象范围授权', () => {
  it('只有“我创建的”合同范围：联动变更他人创建的合同 404，新建与修改联动一致', async () => {
    const w = await linkageWorld(database().db, 'r2-contract-creator');
    const person = await w.hire('合同员工');
    const others = await w.contract(person.employee.id);
    const hr = await createUser(w.db, { email: `r2-${randomUUID()}@example.com`, displayName: '合成 HR' }, cmd());
    await grantMembership(w.db, { tenantId: w.session.tenant.id, userId: hr.id, expectedRevision: 0 }, cmd());
    const mine: ModuleScope = {
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      terms: [{ dimension: 'using_user', orgIds: [], personIds: [], creatorId: hr.id }],
    };
    const request = await scopedSession(w, { scopes: { [CONTRACT_OBJECT]: mine } }, hr.id);
    const employee = await w.session.getEmployee(person.employee.id);
    const created = await request(
      'POST',
      `/transfers/employees/${person.employee.id}`,
      transferBody(w, { contract: { targetId: others.id, fields: { endDate: '2029-01-01' } } }),
      employee.revision,
    );
    expect(created.status, await created.clone().text()).toBe(404);
    const draft = await w.saved(await w.transfer(person, { submit: false, linkage: { adjustSalary: true } }));
    const edited = await request(
      'PUT',
      `/transfers/${draft.id}/linkage`,
      { contract: { targetId: others.id, fields: { endDate: '2029-01-01' } } },
      draft.revision,
    );
    expect(edited.status, await edited.clone().text()).toBe(404);
    expect((await w.linkage(draft.id)).options).toMatchObject({ contract: null, adjustSalary: true });
  });
});

describe('P1-5 职责转交按真实字段编辑权限', () => {
  it('无直线经理编辑权：经调动转交下属 403，不留下调动；无组织负责人编辑权：转交组织角色 403', async () => {
    const w = await linkageWorld(database().db, 'r2-fields');
    const manager = await w.hire('调动人');
    await w.setHead(w.from, manager.employee.id);
    const subordinate = await w.hire('下属', { directManagerId: manager.employee.id });
    const receiver = await w.hire('接收人');
    const deniedField = (object: string, field: string) => (request: Parameters<Authorizer>[0]) =>
      request.action === 'object.update' && request.resource === object && !!request.fields?.includes(field);
    const employee = await w.session.getEmployee(manager.employee.id);
    const subordinates = [
      { employeeId: subordinate.employee.id, receiverId: receiver.employee.id, relation: 'direct' },
    ];
    const bySubordinate = await (
      await scopedSession(w, { deny: deniedField(EMPLOYMENT, 'directManagerId') })
    )(
      'POST',
      `/transfers/employees/${manager.employee.id}`,
      transferBody(w, { dutyTransfer: { subordinates } }),
      employee.revision,
    );
    expect(bySubordinate.status, await bySubordinate.clone().text()).toBe(403);
    const byRole = await (
      await scopedSession(w, { deny: deniedField(ORG, 'personInChargeId') })
    )(
      'POST',
      `/transfers/employees/${manager.employee.id}`,
      transferBody(w, {
        dutyTransfer: { orgRoles: [{ orgId: w.from.id, role: 'person_in_charge', receiverId: receiver.employee.id }] },
      }),
      employee.revision,
    );
    expect(byRole.status, await byRole.clone().text()).toBe(403);
    expect((await w.session.getEmployee(manager.employee.id)).revision).toBe(employee.revision);
  });

  it('失败子项的重试同样检查字段编辑权', async () => {
    const w = await linkageWorld(database().db, 'r2-fields-retry');
    const manager = await w.hire('调动人');
    const subordinate = await w.hire('下属', { directManagerId: manager.employee.id });
    const receiver = await w.hire('接收人', { directManagerId: subordinate.employee.id });
    const business = await w.saved(
      await w.transfer(manager, {
        linkage: {
          dutyTransfer: {
            subordinates: [
              { employeeId: subordinate.employee.id, receiverId: receiver.employee.id, relation: 'direct' },
            ],
          },
        },
      }),
    );
    await w.approve(business, '2026-10-02T01:00:00Z');
    await w.runScheduler('2026-10-10T01:00:00Z');
    const [item] = (await w.linkage(business.id)).dutyTransfer!.items;
    const request = await scopedSession(w, {
      deny: (r) => r.action === 'object.update' && r.resource === EMPLOYMENT && !!r.fields?.includes('directManagerId'),
    });
    const response = await request('POST', `/transfers/linkage-items/${item!.id}/retry`, {}, item!.revision);
    expect(response.status).toBe(403);
    expect((await w.linkage(business.id)).dutyTransfer!.items[0]).toMatchObject({ attemptCount: 1 });
  });
});

describe('P1-3 联动详情按对象与字段权限裁剪', () => {
  it('无合同查看权：不返回合同字段；任职联动字段按字段查看权裁剪', async () => {
    const w = await linkageWorld(database().db, 'r2-view');
    const person = await w.hire('详情员工');
    const contract = await w.contract(person.employee.id);
    const draft = await w.saved(
      await w.transfer(person, {
        submit: false,
        linkage: {
          contract: { targetId: contract.id, fields: { probationSalary: '98765.00' } },
          adjustSalary: true,
          onTrial: { months: 2 },
        },
      }),
    );
    const hidden = await scopedSession(w, {
      deny: (r) => r.action === 'object.view' && r.resource === CONTRACT_OBJECT,
      fields: { [EMPLOYMENT]: ['id', 'revision', 'status'] },
    });
    const response = await hidden('GET', `/transfers/${draft.id}/linkage`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('98765');
    expect(text).not.toContain(contract.id);
    const body = JSON.parse(text) as { options: Record<string, unknown> };
    expect(body.options).not.toHaveProperty('adjustSalary');
    expect(body.options).not.toHaveProperty('onTrial');
    const partial = await scopedSession(w, {
      fields: { [CONTRACT_OBJECT]: ['endDate', 'typeId'], [EMPLOYMENT]: ['contractChange', 'adjustSalary'] },
    });
    const visible = (await (await partial('GET', `/transfers/${draft.id}/linkage`)).json()) as {
      options: { contract: { targetId: string; fields: Record<string, unknown> }; adjustSalary: boolean };
    };
    expect(visible.options.contract.targetId).toBe(contract.id);
    expect(visible.options.contract.fields).not.toHaveProperty('probationSalary');
    expect(visible.options.adjustSalary).toBe(true);
    expect(visible.options).not.toHaveProperty('onTrial');
  });
});

describe('P1-6 联动进入审批快照与盲审检查', () => {
  it('审批载荷与变化字段包含合同变更、调薪、试岗、交接与职责转交', async () => {
    const w = await linkageWorld(database().db, 'r2-snapshot');
    const person = await w.hire('审批员工');
    const handover = await w.hire('交接人');
    const contract = await w.contract(person.employee.id);
    const business = await w.saved(
      await w.transfer(person, {
        linkage: {
          contract: { targetId: contract.id, fields: { endDate: '2029-10-09' } },
          adjustSalary: true,
          onTrial: { months: 3 },
          handover: { handoverPersonId: handover.employee.id },
        },
      }),
    );
    const snapshot = await withTenant(w.db, w.session.tenant.id, (tx) =>
      ADAPTERS.employment.snapshot(
        tx,
        {
          tenantId: w.session.tenant.id,
          userId: w.session.user.id,
          timezone: w.session.tenant.timezone,
          now: new Date('2026-10-02T01:00:00Z'),
          commandId: randomUUID(),
          expectedRevision: 0,
        },
        business.id,
      ),
    );
    expect(snapshot.changedFields).toEqual(
      expect.arrayContaining([
        'isChangeContract',
        'contractChange',
        'adjustSalary',
        'onTrialMonths',
        'handoverPersonId',
      ]),
    );
    expect(snapshot.values).toMatchObject({
      isChangeContract: true,
      contractChange: { targetId: contract.id, endDate: '2029-10-09' },
      adjustSalary: true,
      onTrialMonths: 3,
      handoverPersonId: handover.employee.id,
    });
  });
});

describe('P2-1 / P2-2 联动日期', () => {
  it('接收人在下属任职开始后才入职：按联动生效日判定在职，转交成功', async () => {
    const w = await linkageWorld(database().db, 'r2-receiver-date');
    const manager = await w.hire('调动人');
    const subordinate = await w.hire('下属', { directManagerId: manager.employee.id });
    const employee = await w.session.employee('晚入职接收人');
    await w.session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-15', fields: { departmentId: w.from.id } },
      employee.revision,
    );
    const business = await w.saved(
      await w.transfer(manager, {
        linkage: {
          dutyTransfer: {
            subordinates: [{ employeeId: subordinate.employee.id, receiverId: employee.id, relation: 'direct' }],
          },
        },
      }),
    );
    await w.approve(business, '2026-10-02T01:00:00Z');
    await w.runScheduler('2026-10-10T01:00:00Z');
    expect((await w.linkage(business.id)).dutyTransfer).toMatchObject({ failedCount: 0 });
    expect(await w.managerOf(subordinate.hire.id)).toBe(employee.id);
  });

  it('DEC-186 迟到执行：合同、试岗、职责转交、兼职按实际执行日；审计保留原计划日', async () => {
    const w = await linkageWorld(database().db, 'r2-late');
    const manager = await w.hire('迟到调动人');
    const subordinate = await w.hire('下属', { directManagerId: manager.employee.id });
    const receiver = await w.hire('接收人');
    const contract = await w.contract(manager.employee.id);
    const business = await w.saved(
      await w.transfer(manager, {
        linkage: {
          contract: { targetId: contract.id },
          onTrial: { months: 1 },
          dutyTransfer: {
            subordinates: [
              { employeeId: subordinate.employee.id, receiverId: receiver.employee.id, relation: 'direct' },
            ],
          },
        },
      }),
    );
    await w.approve(business, '2026-10-02T01:00:00Z');
    // 计划 10-10，调度到 10-11 才运行。
    expect((await w.runScheduler('2026-10-11T01:00:00Z')).errors).toEqual([]);
    const view = await w.linkage(business.id);
    expect(view.onTrial).toMatchObject({ startDate: '2026-10-11', expectedEndDate: '2026-11-10' });
    expect(view.dutyTransfer!.items[0]).toMatchObject({ effectiveDate: '2026-10-11', status: 'succeeded' });
    const changed = (await w.contracts(manager.employee.id)).find((c) => c.previousContractId === contract.id);
    expect(changed).toMatchObject({ effectiveDate: '2026-10-11' });
    const executed = (await w.auditEvents(business.id)).find((e) => e.action === 'transfer.linkage.executed');
    expect(executed?.after).toMatchObject({ plannedEffectiveDate: D, effectiveDate: '2026-10-11' });
  });
});

describe('P3 联动子项只能推进执行状态', () => {
  it('应用角色不能改写子项的业务键（列级授权）', async () => {
    const w = await linkageWorld(database().db, 'r2-p3');
    const manager = await w.hire('调动人');
    const subordinate = await w.hire('下属', { directManagerId: manager.employee.id });
    const receiver = await w.hire('接收人');
    const business = await w.saved(
      await w.transfer(manager, {
        mode: 'direct',
        effectiveDate: '2026-10-01',
        linkage: {
          dutyTransfer: {
            subordinates: [
              { employeeId: subordinate.employee.id, receiverId: receiver.employee.id, relation: 'direct' },
            ],
          },
        },
      }),
    );
    const [item] = (await w.linkage(business.id)).dutyTransfer!.items;
    const attempt = withTenant(w.db, w.session.tenant.id, async (tx) =>
      rows(
        await tx.execute(sql`UPDATE transfer_linkage_items SET receiver_id=${manager.employee.id}::uuid
          WHERE tenant_id=${w.session.tenant.id} AND id=${item!.id}::uuid`),
      ),
    );
    await expect(attempt).rejects.toThrow();
  });
});
