/**
 * PR #74 第三轮（astra 第二轮审查）：同类路径一次查全。
 * P1-1 审批详情与盲审按合同对象 / 范围 / 字段判断嵌套合同字段；P1-2 清空 / 删除类联动修改按新旧差异授权（含幂等重放）；
 * P2-1 结果区与选项区逐字段投影；P2-2 合同候选不泄露隐藏编号；另查 DEC-183 拒绝详情、子项重试响应。
 */
import { randomUUID } from 'node:crypto';
import { createUser, grantMembership } from '@italent/db';
import { CONTRACT_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { Authorizer } from '@italent/api';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { approvalWorld, transferScene, type InstanceView } from './AC-APV-support.js';
import { controlledApi, D, everyField, linkageWorld, type LinkageWorld } from './AC-LNK-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const EMPLOYMENT = 'TenantBase.EmploymentRecord';
const AT = '2026-10-01T01:00:00Z';
type Request = Parameters<Authorizer>[0];
const contractView = (r: Request) => r.action === 'object.view' && r.resource === CONTRACT_OBJECT;
const writes = (object: string, field: string) => (r: Request) =>
  r.action === 'object.update' && r.resource === object && !!r.fields?.includes(field);

describe('P1-1 审批详情与盲审：嵌套合同字段按合同对象、范围、字段判断', () => {
  async function scene(label: string) {
    const w = await approvalWorld(database().db, label);
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [
        {
          key: 'review',
          approver: 'latest_record_department_head',
          formFields: ['departmentId', 'effectiveDate', 'isChangeContract', 'contractChange'],
          editableFields: [],
        },
      ],
    });
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
          linkage: {
            contract: { targetId: contract.id, fields: { endDate: '2029-10-09', probationSalary: '98765.00' } },
          },
        },
      }),
      201,
    );
    const instance = await w.submit(draft);
    const task = instance.tasks.find((t) => t.status === 'pending')!;
    const approver = (grants: Parameters<typeof controlledApi>[3]) =>
      controlledApi(w.db, w.tenant.id, s.outHead.userId, grants, AT);
    return { w, s, instance, task, contract, approver };
  }

  it('无合同查看权：审批详情不返回合同字段与合同 ID；同意被盲审拦下', async () => {
    const { instance, task, contract, approver } = await scene('lnk3-apv-hidden');
    const request = approver({ deny: contractView });
    const detail = await request('GET', `/api/tenant/approval/instances/${instance.id}`);
    expect(detail.status).toBe(200);
    const text = await detail.text();
    expect(text).not.toContain('98765');
    expect(text).not.toContain(contract.id);
    expect(text).not.toContain('2029-10-09');
    const view = JSON.parse(text) as InstanceView;
    expect(view.form.values).toMatchObject({ isChangeContract: true });
    expect(view.actions).not.toContain('approve');
    const approve = await request('POST', `/api/tenant/approval/tasks/${task.id}/approve`, {
      ifMatch: instance.revision,
      body: {},
    });
    expect(approve.status).toBe(403);
    expect(await approve.json()).toMatchObject({ error: { details: { reason: 'APPROVAL_BLIND_REVIEW' } } });
  });

  it('有合同查看权但看不到试用期工资：只披露可见合同字段，变化的隐藏字段仍触发盲审', async () => {
    const { instance, task, approver } = await scene('lnk3-apv-partial');
    const request = approver({ fields: { [CONTRACT_OBJECT]: ['id', 'endDate', 'typeId'] } });
    const view = (await (await request('GET', `/api/tenant/approval/instances/${instance.id}`)).json()) as InstanceView;
    expect(view.form.values).toMatchObject({ 'contractChange.endDate': '2029-10-09' });
    expect(JSON.stringify(view)).not.toContain('98765');
    const approve = await request('POST', `/api/tenant/approval/tasks/${task.id}/approve`, {
      ifMatch: instance.revision,
      body: {},
    });
    expect(approve.status).toBe(403);
  });

  it('合同范围外（我创建的范围、目标合同由他人创建）：同样不披露并盲审拦截', async () => {
    const { s, instance, task, approver } = await scene('lnk3-apv-scope');
    const mine: ModuleScope = {
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      terms: [{ dimension: 'using_user', orgIds: [], personIds: [], creatorId: s.outHead.userId }],
    };
    const request = approver({ scopes: { [CONTRACT_OBJECT]: mine } });
    const text = await (await request('GET', `/api/tenant/approval/instances/${instance.id}`)).text();
    expect(text).not.toContain('98765');
    const approve = await request('POST', `/api/tenant/approval/tasks/${task.id}/approve`, {
      ifMatch: instance.revision,
      body: {},
    });
    expect(approve.status).toBe(403);
  });

  it('合同对象、范围、字段都可见：详情展示合同变更字段，可以同意', async () => {
    const { instance, task, approver } = await scene('lnk3-apv-visible');
    const request = approver({});
    const view = (await (await request('GET', `/api/tenant/approval/instances/${instance.id}`)).json()) as InstanceView;
    expect(view.form.values).toMatchObject({
      'contractChange.probationSalary': '98765.00',
      'contractChange.endDate': '2029-10-09',
    });
    const approve = await request('POST', `/api/tenant/approval/tasks/${task.id}/approve`, {
      ifMatch: instance.revision,
      body: {},
    });
    expect(approve.status, await approve.clone().text()).toBe(200);
  });
});

describe('P1-2 清空 / 删除类联动修改按新旧差异授权', () => {
  async function draftWith(w: LinkageWorld, linkage: object) {
    const person = await w.hire('改联动员工');
    return { person, draft: await w.saved(await w.transfer(person, { submit: false, linkage })) };
  }
  const put = (request: ReturnType<typeof controlledApi>, id: string, revision: number, body: object, key?: string) =>
    request('PUT', `/api/tenant/employment/transfers/${id}/linkage`, { body, ifMatch: revision, key });

  it('无调薪 / 试岗编辑权：PUT {} 清空已有联动 403，联动不变', async () => {
    const w = await linkageWorld(database().db, 'lnk3-clear');
    const { draft } = await draftWith(w, { adjustSalary: true, onTrial: { months: 2 } });
    const denied = controlledApi(
      w.db,
      w.session.tenant.id,
      w.session.user.id,
      {
        deny: (r) => writes(EMPLOYMENT, 'adjustSalary')(r) || writes(EMPLOYMENT, 'onTrialMonths')(r),
      },
      AT,
    );
    expect((await put(denied, draft.id, draft.revision, {})).status).toBe(403);
    expect((await w.linkage(draft.id)).options).toMatchObject({ adjustSalary: true, onTrial: { months: 2 } });
  });

  it('幂等重放同样按差异授权：撤权后用原命令 ID 重放清空请求 403', async () => {
    const w = await linkageWorld(database().db, 'lnk3-replay');
    const { draft } = await draftWith(w, { adjustSalary: true });
    const key = randomUUID();
    const allowed = controlledApi(w.db, w.session.tenant.id, w.session.user.id, {}, AT);
    expect((await put(allowed, draft.id, draft.revision, {}, key)).status).toBe(200);
    const revoked = controlledApi(
      w.db,
      w.session.tenant.id,
      w.session.user.id,
      {
        deny: writes(EMPLOYMENT, 'adjustSalary'),
      },
      AT,
    );
    expect((await put(revoked, draft.id, draft.revision, {}, key)).status).toBe(403);
  });

  it('删除合同联动或其中的合同字段：须有原合同的范围与被删字段的编辑权', async () => {
    const w = await linkageWorld(database().db, 'lnk3-contract-removal');
    const person = await w.hire('合同员工');
    const contract = await w.contract(person.employee.id);
    const draft = await w.saved(
      await w.transfer(person, {
        submit: false,
        linkage: { contract: { targetId: contract.id, fields: { endDate: '2029-01-01', probationSalary: '1.00' } } },
      }),
    );
    const noSalary = controlledApi(
      w.db,
      w.session.tenant.id,
      w.session.user.id,
      {
        deny: writes(CONTRACT_OBJECT, 'probationSalary'),
      },
      AT,
    );
    const dropField = { contract: { targetId: contract.id, fields: { endDate: '2029-01-01' } } };
    expect((await put(noSalary, draft.id, draft.revision, dropField)).status).toBe(403);
    const hr = await createUser(w.db, { email: `lnk3-${randomUUID()}@example.com`, displayName: '合成 HR' }, cmd());
    await grantMembership(w.db, { tenantId: w.session.tenant.id, userId: hr.id, expectedRevision: 0 }, cmd());
    const mine: ModuleScope = {
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      terms: [{ dimension: 'using_user', orgIds: [], personIds: [], creatorId: hr.id }],
    };
    const other = controlledApi(w.db, w.session.tenant.id, hr.id, { scopes: { [CONTRACT_OBJECT]: mine } }, AT);
    expect((await put(other, draft.id, draft.revision, { adjustSalary: true })).status).toBe(404);
    expect((await w.linkage(draft.id)).options).toMatchObject({
      contract: { targetId: contract.id, fields: { probationSalary: '1.00' } },
    });
  });
});

describe('P2-1 结果区与选项区逐字段投影', () => {
  it('看不到试岗开始日期：已执行的试岗结果不返回开始日，也不返回能反推开始日的预计结束日', async () => {
    const w = await linkageWorld(database().db, 'lnk3-trial-view');
    const person = await w.hire('试岗员工');
    const business = await w.saved(
      await w.transfer(person, { linkage: { onTrial: { months: 2, startDate: '2026-10-12' } } }),
    );
    await w.approve(business, '2026-10-02T01:00:00Z');
    await w.runScheduler('2026-10-10T01:00:00Z');
    const fields = everyField(EMPLOYMENT).filter((field) => field !== 'onTrialStartDate');
    const request = controlledApi(
      w.db,
      w.session.tenant.id,
      w.session.user.id,
      { fields: { [EMPLOYMENT]: fields } },
      AT,
    );
    const text = await (await request('GET', `/api/tenant/employment/transfers/${business.id}/linkage`)).text();
    expect(text).not.toContain('2026-10-12');
    expect(text).not.toContain('2026-12-11');
    expect(JSON.parse(text)).toMatchObject({ onTrial: { months: 2 }, options: { onTrial: { months: 2 } } });
  });
});

describe('P2-2 合同候选不泄露隐藏的合同编号', () => {
  it('合同字段只可见 id：候选显示值不含合同编号', async () => {
    const w = await linkageWorld(database().db, 'lnk3-candidates');
    const person = await w.hire('候选员工');
    const contract = await w.contract(person.employee.id, { number: 'CT-HIDDEN-0001' });
    const request = controlledApi(
      w.db,
      w.session.tenant.id,
      w.session.user.id,
      {
        fields: { [CONTRACT_OBJECT]: ['id'] },
      },
      AT,
    );
    const response = await request('GET', `/api/tenant/employment/transfers/employees/${person.employee.id}/contracts`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('CT-HIDDEN-0001');
    expect(JSON.parse(text)).toMatchObject({ items: [{ id: contract.id }] });
  });
});

describe('同类出口：拒绝详情与子项重试响应', () => {
  it('DEC-183 拒绝详情不暴露在途合同申请的标识', async () => {
    const w = await linkageWorld(database().db, 'lnk3-dec183-detail');
    const person = await w.hire('在途员工');
    const current = await w.contract(person.employee.id);
    await w.contract(person.employee.id, { effectiveDate: '2026-12-01', endDate: '2027-11-30', termMonths: 12 });
    const blocked = await w.transfer(person, { linkage: { contract: { targetId: current.id } } });
    expect(blocked.status).toBe(409);
    const body = (await blocked.json()) as { error: { details: Record<string, unknown> } };
    expect(body.error.details).toEqual({ reason: 'TRANSFER_CONTRACT_IN_FLIGHT' });
  });

  it('子项重试响应按字段裁剪：看不到职责转交时不返回下属与接收人', async () => {
    const w = await linkageWorld(database().db, 'lnk3-retry-view');
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
    const fields = everyField(EMPLOYMENT).filter((field) => field !== 'dutyTransfer');
    const request = controlledApi(
      w.db,
      w.session.tenant.id,
      w.session.user.id,
      { fields: { [EMPLOYMENT]: fields } },
      AT,
    );
    const response = await request('POST', `/api/tenant/employment/transfers/linkage-items/${item!.id}/retry`, {
      body: {},
      ifMatch: item!.revision,
    });
    const text = await response.text();
    expect(text).not.toContain(subordinate.employee.id);
    expect(text).not.toContain(receiver.employee.id);
  });
});
