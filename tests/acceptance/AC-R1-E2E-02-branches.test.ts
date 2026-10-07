/**
 * F-024 R1 端到端验收 · 分支（DEC-221③）：经理发起他人调动（R1-T14）；带联动的调动（R1-T10 下属转交 / R1-T09 新增下属）；
 * 驳回后撤回再提交（R1-T07 / R1-T11）；撤销与删除任职（R1-T11）；迟到执行与迟到审批按实际执行日（DEC-186 / 195）；
 * 跨租户隔离（R1-T00）。全程真实授权器、真实身份；前置数据经可信夹具建立。
 * 涉及 AC：AC-TRF-02/40/41、AC-TRF-13/15、AC-LNK-03、AC-TRF-07/08/28/36、AC-APV-15/16、AC-TEN-01/02、AC-TRF-44。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Person } from './AC-APV-support.js';
import { chain, e2eWorld, type E2EWorld } from './AC-R1-E2E-support.js';

const database = useTestDb();
const TRANSFERS = '/api/tenant/employment/transfers';
const BUSINESSES = '/api/tenant/employment/businesses';

let w: E2EWorld;
beforeAll(async () => {
  w = await e2eWorld(database().db, 'r1-e2e-branch');
});

async function errorBody(response: Response) {
  const body = (await response.json()) as { error: { code: string; details?: Record<string, unknown> } };
  return { status: response.status, code: body.error.code, reason: body.error.details?.reason };
}

describe('E2E-02 分支一：经理发起他人调动（R1-T14）', () => {
  it('纯经理为负责组织内员工发起调往下级组织；本人节点自审跳过、不能审批自己的单；生效后仍在其团队内', async () => {
    w.setNow('2026-10-01T01:00:00Z');
    const child = await w.org('调出部门下级组', w.from);
    const childHead = await w.person('下级组负责人', child);
    await w.setOrgRoles(child, { head: childHead.employeeId });
    await w.grantVisible(childHead.userId);
    const subject = await w.person('经理发起的员工', w.from);
    const manager = w.as(w.outHead);
    // 经理身份即时派生（Q-M0-71）：负责组织含下级的在职员工是候选。
    const candidates = await w.json<{ items: { id: string }[] }>(
      await w.request(manager, 'GET', `${TRANSFERS}/manager/employees?search=经理发起`),
    );
    expect(candidates.items.map((item) => item.id)).toContain(subject.employeeId);
    const saved = await w.json<{ id: string; status: string }>(
      await w.request(manager, 'POST', `${TRANSFERS}/employees/${subject.employeeId}`, {
        ifMatch: await w.employeeRevision(w.hr, subject.employeeId),
        body: {
          initiator: 'manager',
          transferTypeCode: 'in_department',
          formId: 'TenantBase.TransferMultiFormView',
          mode: 'application',
          submit: true,
          effectiveDate: '2026-10-20',
          fields: { departmentId: child },
        },
      }),
      201,
    );
    expect(saved.status).toBe('in_review');
    let view = await w.instanceOf(manager, saved.id);
    // DEC-058 / 068：首节点“调出部门负责人”解析为发起人本人 → 自审跳过（不计同意）；无直线经理 → 转异常管理员。
    expect(view.tasks.some((task) => task.assigneeUserId === manager.user && task.origin === 'self_skip')).toBe(true);
    expect(w.pending(view).every((task) => task.assigneeUserId !== manager.user)).toBe(true);
    expect(w.pending(view)[0]).toMatchObject({ nodeKey: 'out_head', isExceptionAdmin: true });
    const applied = await w.json<{ items: { id: string }[] }>(
      await w.request(manager, 'GET', `${TRANSFERS}/manager/todos?tab=initiated`),
    );
    expect(applied.items.map((item) => item.id)).toContain(view.id);

    const { steps, view: done } = await w.approveAll(view);
    view = done;
    // 调入组织无 HRBP → 异常管理员（AC-APV-04）；调入负责人 = 下级组负责人。
    expect(steps.map((step) => step.nodeKey)).toEqual(['out_head', 'in_hrbp', 'in_head']);
    expect(steps[0]!.by).toBe(w.exceptionAdmin);
    expect(steps[2]!.by).toBe(childHead.userId);
    expect(view.status).toBe('approved');
    expect(await w.business(w.hr, saved.id)).toMatchObject({ status: 'approved', record: null });

    const run = await w.runScheduler('2026-10-19T17:15:00Z');
    expect(run.activated).toEqual([saved.id]);
    w.setNow('2026-10-20T02:00:00Z');
    expect(await w.business(w.hr, saved.id)).toMatchObject({
      status: 'effective',
      record: { effectiveDate: '2026-10-20', fields: { departmentId: child } },
    });
    const team = await w.json<{ items: { id: string }[] }>(
      await w.request(manager, 'GET', `${TRANSFERS}/manager/team?category=active`),
    );
    expect(team.items.map((item) => item.id)).toContain(subject.employeeId);
    expect(await w.business(w.hr, saved.id)).toMatchObject({
      record: { fields: { directManagerId: childHead.employeeId } },
    });
  });
});

describe('E2E-02 分支二：带联动的调动（R1-T09 / R1-T10）', () => {
  it('HR 发起带下属转交与新增下属的调动：审批通过不联动，到期生效时同事务改写下属直线经理', async () => {
    w.setNow('2026-10-01T01:00:00Z');
    const mover = await w.person('带联动调动员工', w.from);
    const oldReport = await w.person('原下属', w.from, { directManagerId: mover.employeeId });
    const receiver = await w.person('接收人', w.from);
    const newReport = await w.person('新增下属', w.to);
    const response = await w.hrTransfer(w.hr, mover.employeeId, {
      effectiveDate: '2026-10-20',
      fields: { departmentId: w.to, addedSubordinateIds: [newReport.employeeId] },
      linkage: {
        dutyTransfer: {
          subordinates: [{ employeeId: oldReport.employeeId, receiverId: receiver.employeeId, relation: 'direct' }],
          orgRoles: [],
        },
      },
    });
    const saved = await w.json<{ id: string; status: string }>(response, 201);
    expect(saved.status).toBe('in_review');
    const { view } = await w.approveAll(await w.instanceOf(w.hr, saved.id));
    expect(view.status).toBe('approved');
    // AC-LNK-01 口径：审批通过 ≠ 生效，联动尚未执行。
    const managerOf = async (person: Person) =>
      (await w.records(w.hr, person.employeeId, '2026-10-20')).find((record) => record.isCurrent)?.fields
        .directManagerId;
    expect(await managerOf(oldReport)).toBe(mover.employeeId);
    expect((await managerOf(newReport)) ?? null).toBeNull();
    const linkage = await w.json<{
      executedAt: string | null;
      dutyTransfer: unknown;
      options: Record<string, unknown>;
    }>(await w.request(w.hr, 'GET', `${TRANSFERS}/${saved.id}/linkage`));
    // 生效前只有联动选项，没有转交记录（转交记录在生效时生成）。
    expect(linkage).toMatchObject({ executedAt: null, dutyTransfer: null });
    expect(JSON.stringify(linkage.options)).toContain(oldReport.employeeId);

    const run = await w.runScheduler('2026-10-19T17:15:00Z');
    expect(run).toMatchObject({ activated: [saved.id], failed: [] });
    w.setNow('2026-10-20T02:00:00Z');
    // AC-LNK-03：下属转交落地——原下属的直线经理改为接收人；AC-TRF-15：新增下属的直线上级变为调动人。
    expect(await managerOf(oldReport)).toBe(receiver.employeeId);
    expect(await managerOf(newReport)).toBe(mover.employeeId);
    const executed = await w.json<{
      executedAt: string | null;
      dutyTransfer: { total: number; failedCount: number; items: { status: string; subordinateId: string | null }[] };
    }>(await w.request(w.hr, 'GET', `${TRANSFERS}/${saved.id}/linkage`));
    expect(executed.executedAt).not.toBeNull();
    expect(executed.dutyTransfer).toMatchObject({ total: 1, failedCount: 0 });
    expect(executed.dutyTransfer.items).toEqual([
      expect.objectContaining({ status: 'succeeded', subordinateId: oldReport.employeeId }),
    ]);
    // 联动日志（R1-T16 / F-023）对范围内审计员可见。
    const logs = await w.dataChanges(w.auditor, { objectId: saved.id });
    expect(logs.map((log) => log.action)).toEqual(expect.arrayContaining(['employment.record.create']));
    // DEC-012 / 172：有联动变更时拒绝删除任职。
    const current = await w.business(w.hr, saved.id);
    const blocked = await w.request(w.hr, 'DELETE', `${BUSINESSES}/${saved.id}`, { ifMatch: current.revision });
    expect(blocked.status).toBe(409);
    expect(await w.records(w.hr, mover.employeeId, '2026-10-20')).toHaveLength(2);
  });
});

describe('E2E-02 分支三：驳回后撤回、修改再提交（R1-T07 / R1-T11）', () => {
  it('调入负责人驳回 → 申请退回；HR 撤回到草稿、修改后再提交生成新实例，重新走完审批', async () => {
    w.setNow('2026-10-01T01:00:00Z');
    const subject = await w.person('被驳回员工', w.from, { place: '原地点' });
    const saved = await w.json<{ id: string }>(
      await w.hrTransfer(w.hr, subject.employeeId, { effectiveDate: '2026-10-25' }),
      201,
    );
    let view = await w.instanceOf(w.hr, saved.id);
    view = await w.act(view, 'approve');
    view = await w.act(view, 'approve');
    expect(w.pending(view)[0]).toMatchObject({ nodeKey: 'in_head', assigneeUserId: w.inHead.userId });
    view = await w.act(view, 'reject', { comment: '请先补充调动原因' });
    expect(view).toMatchObject({ status: 'returned' });
    expect(view.logs.find((log) => log.event === 'reject')).toMatchObject({ actorUserId: w.inHead.userId });
    let business = await w.business(w.hr, saved.id);
    expect(business).toMatchObject({ status: 'rejected', record: null });

    // AC-TRF-28：发起人撤回 → 草稿，员工当前任职不变。
    const withdrawn = await w.json<{ status: string; revision: number }>(
      await w.request(w.hr, 'POST', `${BUSINESSES}/${saved.id}/withdraw`, { ifMatch: business.revision, body: {} }),
    );
    expect(withdrawn.status).toBe('draft');
    expect(await w.records(w.hr, subject.employeeId)).toHaveLength(1);
    const patched = await w.json<{ revision: number; fields: Record<string, unknown> }>(
      await w.request(w.hr, 'PATCH', `${BUSINESSES}/${saved.id}`, {
        ifMatch: withdrawn.revision,
        body: { fields: { place: '调整后地点' } },
      }),
    );
    expect(patched.fields.place).toBe('调整后地点');
    const resubmitted = await w.json<{ status: string }>(
      await w.request(w.hr, 'POST', `${BUSINESSES}/${saved.id}/submit`, { ifMatch: patched.revision, body: {} }),
    );
    expect(resubmitted.status).toBe('in_review');
    // DEC-053：驳回后同单重提——撤回再提交仍是同一实例，从首节点重新流转；驳回与撤回都留在实例日志里。
    const fresh = await w.instanceOf(w.hr, saved.id);
    expect(fresh).toMatchObject({ id: view.id, status: 'running', currentNodeKey: 'out_head' });
    expect(fresh.logs.map((log) => log.event)).toEqual(expect.arrayContaining(['reject', 'withdraw']));
    expect(w.pending(fresh)).toEqual([expect.objectContaining({ assigneeUserId: w.outHead.userId })]);
    const { steps, view: done } = await w.approveAll(fresh);
    expect(steps.map((step) => step.by)).toEqual([w.outHead.userId, w.inHrbp.userId, w.inHead.userId]);
    expect(done.status).toBe('approved');
    business = await w.business(w.hr, saved.id);
    expect(business).toMatchObject({ status: 'approved', fields: { place: '调整后地点' } });
  });
});

describe('E2E-02 分支四：撤销与删除任职（R1-T11）', () => {
  it('AC-TRF-07：HR 撤销审批中的申请 → 作废、流程取消、不生成任职；作废后只能删除', async () => {
    w.setNow('2026-10-01T01:00:00Z');
    const subject = await w.person('被撤销员工', w.from);
    const saved = await w.json<{ id: string }>(
      await w.hrTransfer(w.hr, subject.employeeId, { effectiveDate: '2026-10-25' }),
      201,
    );
    const view = await w.instanceOf(w.hr, saved.id);
    const before = chain(await w.records(w.hr, subject.employeeId));
    const revoked = await w.json<{ status: string; record: unknown; revision: number }>(
      await w.request(w.hr, 'POST', `${BUSINESSES}/${saved.id}/revoke`, {
        ifMatch: (await w.business(w.hr, saved.id)).revision,
        body: {},
      }),
    );
    expect(revoked).toMatchObject({ status: 'voided', record: null });
    expect((await w.instance(w.hr, view.id)).status).toBe('cancelled');
    expect(chain(await w.records(w.hr, subject.employeeId))).toEqual(before);
    // 作废的申请不再被定时任务落地（本租户其他用例的到期业务不受影响）。
    expect((await w.runScheduler('2026-10-24T17:15:00Z')).activated).not.toContain(saved.id);
    expect(
      await errorBody(
        await w.request(w.hr, 'POST', `${BUSINESSES}/${saved.id}/revoke`, { ifMatch: revoked.revision, body: {} }),
      ),
    ).toMatchObject({ status: 409 });
    const deleted = await w.json<{ status: string }>(
      await w.request(w.hr, 'DELETE', `${BUSINESSES}/${saved.id}`, { ifMatch: revoked.revision }),
    );
    expect(deleted.status).toBe('deleted');
    // 范围外 HR 不能撤销 / 删除范围内员工的业务。
    expect((await w.request(w.outsider, 'DELETE', `${BUSINESSES}/${saved.id}`, { ifMatch: 1 })).status).toBe(404);
  });

  it('AC-TRF-08 / 36：已生效的调动可删除并恢复前一条；其后有在途申请时拒绝删除（DEC-126）', async () => {
    w.setNow('2026-10-01T01:00:00Z');
    const subject = await w.person('被删除员工', w.from, { place: '原地点' });
    const [hire] = await w.records(w.hr, subject.employeeId);
    const moved = await w.directBusiness(w.hr, subject.employeeId, {
      kind: 'transfer',
      effectiveDate: '2026-09-20',
      fields: { departmentId: w.to },
    });
    expect(moved.status).toBe('effective');
    expect(chain(await w.records(w.hr, subject.employeeId))).toEqual([
      expect.objectContaining({ id: hire!.id, stopDate: '2026-09-19', isCurrent: false }),
      expect.objectContaining({ id: moved.id, departmentId: w.to, isCurrent: true }),
    ]);
    // 其后有审批中的申请 → 拒绝删除，提示先撤销或驳回。
    const pending = await w.json<{ id: string }>(
      await w.hrTransfer(w.hr, subject.employeeId, { effectiveDate: '2026-10-25', fields: { departmentId: w.from } }),
      201,
    );
    const blocked = await w.request(w.hr, 'DELETE', `${BUSINESSES}/${moved.id}`, {
      ifMatch: (await w.business(w.hr, moved.id)).revision,
    });
    expect(await errorBody(blocked)).toMatchObject({ status: 409 });
    await w.json(
      await w.request(w.hr, 'POST', `${BUSINESSES}/${pending.id}/revoke`, {
        ifMatch: (await w.business(w.hr, pending.id)).revision,
        body: {},
      }),
    );
    const deleted = await w.json<{ status: string }>(
      await w.request(w.hr, 'DELETE', `${BUSINESSES}/${moved.id}`, {
        ifMatch: (await w.business(w.hr, moved.id)).revision,
      }),
    );
    expect(deleted.status).toBe('deleted');
    // 前一条结束日恢复“至今”，员工当前部门回到调出部门（AC-TRF-08 原站实测口径）。
    expect(chain(await w.records(w.hr, subject.employeeId))).toEqual([
      expect.objectContaining({ id: hire!.id, stopDate: '9999-12-31', departmentId: w.from, isCurrent: true }),
    ]);
    // 删除留痕（AC-AUD-02）：审计员可见删除日志且带快照。
    const logs = await w.dataChanges(w.auditor, { objectId: moved.id, action: 'employment.business.delete' });
    expect(logs).toHaveLength(1);
    const detail = await w.audit.dataChange(w.auditor, logs[0]!.id);
    expect(detail.operation).toBe('delete');
    expect(detail.snapshot ?? detail.before).toBeTruthy();
  });
});

describe('E2E-02 分支五：迟到执行与迟到审批按实际执行日（DEC-186 / 195）', () => {
  it('定时任务迟到：任职生效日改为实际执行日，原计划日保留在审计中', async () => {
    w.setNow('2026-10-01T01:00:00Z');
    const subject = await w.person('迟到执行员工', w.from);
    const saved = await w.json<{ id: string }>(
      await w.hrTransfer(w.hr, subject.employeeId, { effectiveDate: '2026-10-20' }),
      201,
    );
    expect((await w.approveAll(await w.instanceOf(w.hr, saved.id))).view.status).toBe('approved');
    // 10-20、10-21 都没跑；10-23 才执行。
    const run = await w.runScheduler('2026-10-22T17:15:00Z');
    expect(run).toMatchObject({ businessDate: '2026-10-23', activated: [saved.id], failed: [] });
    w.setNow('2026-10-23T02:00:00Z');
    const business = await w.business(w.hr, saved.id);
    expect(business).toMatchObject({
      status: 'effective',
      effectiveDate: '2026-10-23',
      record: { effectiveDate: '2026-10-23' },
    });
    const records = await w.records(w.hr, subject.employeeId, '2026-10-23');
    expect(chain(records)).toEqual([
      expect.objectContaining({ stopDate: '2026-10-22', isCurrent: false }),
      expect.objectContaining({ id: saved.id, effectiveDate: '2026-10-23', isCurrent: true }),
    ]);
    const audit = await w.rawAudit(saved.id);
    expect(audit.some((event) => event.after?.originalEffectiveDate === '2026-10-20')).toBe(true);
  });

  it('审批迟到：审批通过时已过计划生效日，当天即生效且生效日 = 批准日，不倒签', async () => {
    w.setNow('2026-10-01T01:00:00Z');
    const subject = await w.person('迟到审批员工', w.from);
    const saved = await w.json<{ id: string }>(
      await w.hrTransfer(w.hr, subject.employeeId, { effectiveDate: '2026-10-05' }),
      201,
    );
    w.setNow('2026-10-08T01:00:00Z');
    expect((await w.approveAll(await w.instanceOf(w.hr, saved.id))).view.status).toBe('approved');
    const business = await w.business(w.hr, saved.id);
    expect(business).toMatchObject({
      status: 'effective',
      effectiveDate: '2026-10-08',
      record: { effectiveDate: '2026-10-08' },
    });
    expect((await w.records(w.hr, subject.employeeId, '2026-10-06')).find((record) => record.isCurrent)?.id).not.toBe(
      saved.id,
    );
    expect((await w.runScheduler('2026-10-08T02:00:00Z')).activated).toEqual([]);
  });
});

describe('E2E-02 待补跑：验收基线不含在途 PR（编排窗口 2026-10-07 补充）', () => {
  // 基线 main 0dd7af5 未包含 #79 F-018（带编调动，DEC-181）与 #83 F-007（组织改名 / 改行政上级联动任职，DEC-137）。
  it.todo('待 #79 合并后补跑：带编调动保存即执行，调入方组织 +1 / 调出方 −1，审批与定时生效路径一致（F-018）');
  it.todo('待 #83 合并后补跑：组织改名 / 改行政上级时联动任职全称与版本，员工与经理侧可见（F-007）');
});

describe('E2E-02 分支六：跨租户隔离（R1-T00，AC-TEN-01 / 02，AC-TRF-44）', () => {
  it('另一租户的 HR 与员工用本租户的 ID 请求一律被拒；本租户成员带错租户头 403；定时任务按租户分别运行', async () => {
    w.setNow('2026-10-01T01:00:00Z');
    const subject = await w.person('本租户员工', w.from);
    const saved = await w.json<{ id: string }>(
      await w.hrTransfer(w.hr, subject.employeeId, { effectiveDate: '2026-10-20' }),
      201,
    );
    const view = await w.instanceOf(w.hr, saved.id);
    const foreign = await e2eWorld(database().db, 'r1-e2e-foreign');
    const foreignSubject = await foreign.person('外租户员工', foreign.from);
    // 外租户 HR（范围 = 外租户全部组织）读本租户员工、业务、实例、审计：404 / 403，不泄露存在。
    for (const path of [
      `/api/tenant/employment/employees/${subject.employeeId}`,
      `/api/tenant/employment/employees/${subject.employeeId}/records`,
      `${BUSINESSES}/${saved.id}`,
      `/api/tenant/approval/instances/${view.id}`,
    ]) {
      const response = await foreign.request(foreign.hr, 'GET', path);
      expect([403, 404], path).toContain(response.status);
    }
    expect(await foreign.dataChanges(foreign.auditor, { objectId: saved.id })).toEqual([]);
    expect((await foreign.request(foreign.hr, 'DELETE', `${BUSINESSES}/${saved.id}`, { ifMatch: 1 })).status).toBe(404);
    // 外租户员工用自助入口读本租户员工：403；本租户员工带外租户的租户头：403（非成员）。
    expect(
      (
        await foreign.request(
          foreign.as(foreignSubject),
          'GET',
          `/api/tenant/self-service/employees/${subject.employeeId}/records`,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await w.api.request('GET', '/api/tenant/self-service/profile', {
          user: subject.userId,
          tenant: foreign.tenant.id,
        })
      ).status,
    ).toBe(403);
    // 本租户的组织列表不含外租户同名组织（AC-TEN-01）。
    const orgs = await w.json<{ items: { id: string }[] }>(
      await w.request(w.hr, 'GET', '/api/tenant/org/organizations?pageSize=200'),
    );
    expect(orgs.items.map((item) => item.id)).not.toContain(foreign.from);
    // 定时任务只处理本租户：外租户运行不触碰本租户的待生效业务。
    expect((await w.approveAll(view)).view.status).toBe('approved');
    expect((await foreign.runScheduler('2026-10-19T17:15:00Z')).activated).toEqual([]);
    expect(await w.business(w.hr, saved.id)).toMatchObject({ status: 'approved', record: null });
    expect((await w.runScheduler('2026-10-19T17:15:00Z')).activated).toEqual([saved.id]);
  });
});
