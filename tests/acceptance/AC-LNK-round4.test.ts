/**
 * PR #74 第四轮（astra 第三轮审查）：同类路径一次查全。
 * P1 合同变更里显式清空 / 置 false 的隐藏合同字段同样是变化字段，人工审批与自动跳过都要盲审（DEC-057 / 058）；
 * P2 合同变更、职责转交（直线 / 虚线下属、组织角色）的联动结果仍在时拒绝删除调动（DEC-012），走生产登记的探针与真实端口。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { CONTRACT_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type InstanceView, type NodeInput } from './AC-APV-support.js';
import { controlledApi, D, everyField, linkageWorld, type LinkageWorld } from './AC-LNK-support.js';

const database = useTestDb();
const AT = '2026-10-01T01:00:00Z';
/** 三类“清空”：清空薪资、清空可空日期、布尔自定义字段置 false；hidden 为审批人看不到的合同字段。 */
const CLEARINGS = [
  { name: '清空试用期工资', clear: () => ({ probationSalary: null }), hidden: () => 'probationSalary' },
  { name: '清空试用期结束日期', clear: () => ({ probationEndDate: null }), hidden: () => 'probationEndDate' },
  {
    name: '布尔自定义字段置 false',
    clear: (custom: string) => ({ customFields: { [custom]: false } }),
    hidden: (custom: string) => `custom:${custom}`,
  },
] as const;

const visibleExcept = (custom: string, hidden: string) =>
  [...everyField(CONTRACT_OBJECT), `custom:${custom}`].filter((field) => field !== hidden);

async function approvalScene(label: string, clearing: (typeof CLEARINGS)[number], nodes: NodeInput[]) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await w.publishedProcess({ nodes });
  const custom = await w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', '/api/tenant/employment/custom-fields', {
      ifMatch: 0,
      body: { name: '合同是否续签意向', objectType: 'contract', valueType: 'boolean' },
    }),
    201,
  );
  const master = async (kind: string) =>
    w.json<{ id: string }>(
      await w.request(w.hr.id, 'POST', `/api/tenant/contracts/master-data/${kind}`, {
        ifMatch: 0,
        body: { code: randomUUID(), name: `合成${kind}` },
      }),
      201,
    );
  const [type, company] = [await master('types'), await master('companies')];
  const contract = await w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', '/api/tenant/contracts/commands', {
      ifMatch: 0,
      body: {
        operation: 'create',
        mode: 'direct',
        employeeId: s.subject.employeeId,
        fields: {
          typeId: type.id,
          companyId: company.id,
          effectiveDate: '2026-01-01',
          endDate: '2027-12-31',
          termType: 'fixed',
          termMonths: 24,
          probationEndDate: '2026-03-31',
          probationSalary: '50000.00',
          customFields: { [custom.id]: true },
        },
      },
    }),
    201,
  );
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.subject.employeeId}`),
  );
  const draft = await w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', `/api/tenant/employment/transfers/employees/${s.subject.employeeId}`, {
      ifMatch: employee.revision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'application',
        effectiveDate: D,
        fields: { departmentId: s.to },
        linkage: { contract: { targetId: contract.id, fields: clearing.clear(custom.id) } },
      },
    }),
    201,
  );
  const instance = await w.submit(draft);
  return { w, s, instance, hidden: clearing.hidden(custom.id), custom: custom.id };
}

const FORM = ['departmentId', 'effectiveDate', 'isChangeContract', 'contractChange'];

describe('P1 显式清空隐藏合同字段：人工审批被盲审拦下', () => {
  it.each(CLEARINGS)('$name：审批人看得到合同但看不到该字段，同意返回 403', async (clearing) => {
    const { w, s, instance, hidden, custom } = await approvalScene(`lnk4-manual-${clearing.name}`, clearing, [
      { key: 'review', approver: 'latest_record_department_head', formFields: FORM, editableFields: [] },
    ]);
    const task = instance.tasks.find((t) => t.status === 'pending')!;
    const request = controlledApi(
      w.db,
      w.tenant.id,
      s.outHead.userId,
      { fields: { [CONTRACT_OBJECT]: visibleExcept(custom, hidden) } },
      AT,
    );
    const view = (await (await request('GET', `/api/tenant/approval/instances/${instance.id}`)).json()) as InstanceView;
    expect(Object.keys(view.form.values)).not.toContain(`contractChange.${hidden}`);
    expect(view.actions).not.toContain('approve');
    const approve = await request('POST', `/api/tenant/approval/tasks/${task.id}/approve`, {
      ifMatch: instance.revision,
      body: {},
    });
    expect(approve.status).toBe(403);
    expect(await approve.json()).toMatchObject({ error: { details: { reason: 'APPROVAL_BLIND_REVIEW' } } });
  });
});

describe('P1 显式清空隐藏合同字段：同人自动跳过前也做盲审', () => {
  it.each(CLEARINGS)('$name：被跳过的审批人看不到该字段时不自动同意，转异常管理员', async (clearing) => {
    const { w, s, instance, hidden, custom } = await approvalScene(`lnk4-auto-${clearing.name}`, clearing, [
      { key: 'out_head', approver: 'latest_record_department_head', formFields: FORM },
      { key: 'in_hrbp', approver: 'record_department_hrbp', formFields: FORM },
      { key: 'recheck', approver: 'latest_record_department_head', historySameAssigneeSkip: true },
    ]);
    const all = { [CONTRACT_OBJECT]: visibleExcept(custom, '') };
    const first = controlledApi(w.db, w.tenant.id, s.outHead.userId, { fields: all }, AT);
    const outTask = instance.tasks.find((t) => t.status === 'pending')!;
    const approved = await first('POST', `/api/tenant/approval/tasks/${outTask.id}/approve`, {
      ifMatch: instance.revision,
      body: {},
    });
    expect(approved.status, await approved.clone().text()).toBe(200);
    // 第二节点通过时第三节点按 outHead 判定自动跳过；此时 outHead 已看不到该合同字段。
    const current = await w.detail(instance.id);
    const hrbpTask = current.tasks.find((t) => t.status === 'pending')!;
    const second = controlledApi(
      w.db,
      w.tenant.id,
      s.inHrbp.userId,
      { fields: all, userFields: { [s.outHead.userId]: { [CONTRACT_OBJECT]: visibleExcept(custom, hidden) } } },
      AT,
    );
    const response = await second('POST', `/api/tenant/approval/tasks/${hrbpTask.id}/approve`, {
      ifMatch: current.revision,
      body: {},
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const after = await w.detail(instance.id);
    expect(after.status).toBe('running');
    expect(after.tasks.find((t) => t.status === 'pending')).toMatchObject({
      nodeKey: 'recheck',
      assigneeUserId: w.exceptionAdmin,
      origin: 'blind_review',
    });
  });
});

/** 删除被拒绝时整单无副作用：业务 revision 与状态、租户内审计与 outbox 条数都不变。 */
async function sideEffects(w: LinkageWorld, businessId: string) {
  const business = await w.business(businessId);
  const counts = await withTenant(w.db, w.session.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT
      (SELECT count(*)::int FROM audit_events WHERE tenant_id=${w.session.tenant.id}) AS audits,
      (SELECT count(*)::int FROM employment_outbox WHERE tenant_id=${w.session.tenant.id}) AS outbox`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows)[0];
  });
  return { revision: business.revision, status: business.status, counts };
}

function remove(w: LinkageWorld, id: string, revision: number) {
  return w.session.request('DELETE', `/businesses/${id}`, { ifMatch: revision });
}

async function refused(w: LinkageWorld, businessId: string, kinds: string[]) {
  const before = await sideEffects(w, businessId);
  const response = await remove(w, businessId, before.revision);
  expect(response.status, await response.clone().text()).toBe(409);
  const body = (await response.json()) as { error: { details: { reason: string; linkages: { kind: string }[] } } };
  expect(body.error.details.reason).toBe('EMPLOYMENT_LINKED_CHANGES_EXIST');
  expect(body.error.details.linkages.map((item) => item.kind).sort()).toEqual([...kinds].sort());
  expect(await sideEffects(w, businessId)).toEqual(before);
  return before;
}

/** 补录过去日期的直接调动：保存即生效，联动同事务执行。 */
async function executedTransfer(w: LinkageWorld, person: { employee: { id: string } }, linkage: object) {
  return w.saved(await w.transfer(person, { mode: 'direct', submit: undefined, effectiveDate: '2026-09-20', linkage }));
}

describe('P2 合同联动仍在时拒绝删除调动（DEC-012，真实合同端口）', () => {
  it('合同变更执行后删除 409 且无副作用；HR 再次变更该合同后可以删除', async () => {
    const w = await linkageWorld(database().db, 'lnk4-delete-contract');
    const person = await w.hire('合同员工');
    const original = await w.contract(person.employee.id);
    const business = await executedTransfer(w, person, {
      contract: { targetId: original.id, fields: { endDate: '2029-08-31' } },
    });
    const [change] = await w.contractChanges(person.employee.id);
    expect(change).toMatchObject({ beforeContractId: original.id });
    await refused(w, business.id, ['contract']);

    const linked = (await w.contracts(person.employee.id)).find((row) => row.id === change!.afterContractId)!;
    const adjust = await w.contractRequest('POST', '/commands', {
      ifMatch: linked.revision,
      body: {
        operation: 'change',
        mode: 'direct',
        employeeId: person.employee.id,
        targetId: linked.id,
        fields: { effectiveDate: '2026-09-25', endDate: '2029-12-31' },
      },
    });
    expect(adjust.status, await adjust.clone().text()).toBe(201);
    const current = await w.business(business.id);
    expect((await remove(w, business.id, current.revision)).status).toBe(200);
  });
});

describe('P2 职责转交仍在时拒绝删除调动（DEC-012，真实任职 / 组织端口）', () => {
  it('直线、虚线下属与组织负责人转交执行后删除 409 且无副作用；HR 逐项调整后可以删除', async () => {
    const w = await linkageWorld(database().db, 'lnk4-delete-duty');
    const manager = await w.hire('调动人');
    const receiver = await w.hire('接收人');
    const other = await w.hire('其他经理');
    const direct = await w.hire('直线下属', { directManagerId: manager.employee.id });
    const dotted = await w.hire('虚线下属', { dottedManagerId: manager.employee.id });
    await w.setHead(w.from, manager.employee.id);
    const business = await executedTransfer(w, manager, {
      dutyTransfer: {
        subordinates: [
          { employeeId: direct.employee.id, receiverId: receiver.employee.id, relation: 'direct' },
          { employeeId: dotted.employee.id, receiverId: receiver.employee.id, relation: 'dotted' },
        ],
        orgRoles: [{ orgId: w.from.id, role: 'person_in_charge', receiverId: receiver.employee.id }],
      },
    });
    const items = (await w.linkage(business.id)).dutyTransfer!.items;
    expect(items.map((item) => item.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    await refused(w, business.id, ['dutyOrgRole', 'dutySubordinate', 'dutySubordinate']);

    // HR 手工调整后的不再拦截：组织负责人换人、两名下属的经理改掉，逐项解除。
    const org = await w.api.request('GET', `/api/tenant/org/organizations/${w.from.id}`, w.as);
    const head = await w.api.request('PATCH', `/api/tenant/org/organizations/${w.from.id}`, {
      ...w.as,
      ifMatch: ((await org.json()) as { revision: number }).revision,
      body: { effectiveDate: '2026-10-01', personInChargeId: other.employee.id },
    });
    expect(head.status, await head.clone().text()).toBe(200);
    await refused(w, business.id, ['dutySubordinate', 'dutySubordinate']);
    const edit = async (record: { id: string }, fields: object) => {
      const current = await w.business(record.id);
      const response = await w.session.request('PATCH', `/records/${record.id}`, {
        ifMatch: current.revision,
        body: { fields },
      });
      expect(response.status, await response.clone().text()).toBe(200);
    };
    await edit(direct.hire, { directManagerId: other.employee.id });
    await refused(w, business.id, ['dutySubordinate']);
    await edit(dotted.hire, { dottedManagerId: other.employee.id });
    const current = await w.business(business.id);
    expect((await remove(w, business.id, current.revision)).status).toBe(200);
  });
});

describe('DEC-194：PUT 联动入口接入 F-017 的 UUID 规范化与本人护栏', () => {
  const put = (w: LinkageWorld, id: string, revision: number, body: object) =>
    w.session.request('PUT', `/transfers/${id}/linkage`, { ifMatch: revision, body });

  it('大写调动 ID 与小写同样定位单据；操作人绑定为调动本人后，大小写 ID 都拒绝修改联动', async () => {
    const w = await linkageWorld(database().db, 'lnk4-self-put');
    const person = await w.hire('本人调动员工');
    const draft = await w.saved(await w.transfer(person, { submit: false, linkage: { adjustSalary: true } }));
    const upper = await put(w, draft.id.toUpperCase(), draft.revision, { adjustSalary: true, onTrial: { months: 1 } });
    expect(upper.status, await upper.clone().text()).toBe(200);
    const { revision } = (await upper.json()) as { revision: number };

    await withTenant(w.db, w.session.tenant.id, async (tx) => {
      await tx.execute(sql`DELETE FROM permission_user_person_links WHERE tenant_id=${w.session.tenant.id}
        AND (user_id=${w.session.user.id}::uuid OR employee_id=${person.employee.id}::uuid)`);
      await tx.execute(sql`INSERT INTO permission_user_person_links (tenant_id, user_id, employee_id)
        VALUES (${w.session.tenant.id}, ${w.session.user.id}::uuid, ${person.employee.id}::uuid)`);
    });
    for (const id of [draft.id, draft.id.toUpperCase()]) {
      const response = await put(w, id, revision, {});
      expect(response.status, await response.clone().text()).toBe(403);
    }
    expect((await w.linkage(draft.id)).options).toMatchObject({ adjustSalary: true, onTrial: { months: 1 } });
  });
});
