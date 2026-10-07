/**
 * F-024 R1 端到端验收 · 主线（DEC-221③，路线图 R1 出口标准）：
 * 员工本人发起调动申请（R1-T13，DEC-209 候选）→ 审批中心逐节点审批（R1-T07）→ 审批通过 ≠ 生效（DEC-125）
 * → 调动日由定时生效任务按租户时区落地（R1-T08，DEC-056）→ 任职版本链新增一条、字段继承正确（R1-T05）
 * → HR 补录触发向后更新，同日业务按操作先后排序（R1-T06，DEC-108）→ 员工自助、经理工作台（R1-T14）、HR 列表都能
 * 看到变更，范围外的人看不到（employment/visibility.ts，DEC-177）→ 审计日志按查看人权限可查（R1-T16，DEC-197）。
 * 全程真实授权器、真实身份；每步断言业务结果，AC 编号写在各步标题里：
 * AC-TRF-01/06/32/37/38/42/45/46、AC-APV-01/02、AC-EMP-01/05/11/13、AC-FWD-01/02/03/14、AC-PRM-04/26/29、AC-AUD-04。
 */
import { tenantLocalDate } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import type { InstanceView } from './AC-APV-support.js';
import { chain, e2eWorld, type Actor, type E2EWorld, type EmploymentRecordView } from './AC-R1-E2E-support.js';

const database = useTestDb();
const SELF = '/api/tenant/self-service';
const TRANSFER_DATE = '2026-10-15';

let w: E2EWorld;
let self: Actor;
let employeeId: string;
let hireRecordId: string;
let applicationId: string;
let instanceView: InstanceView;
let backfillId: string;
let sameDayId: string;

beforeAll(async () => {
  w = await e2eWorld(database().db, 'r1-e2e-main');
  const subject = await w.person('主线调动员工', w.from, { place: '原地点' });
  self = w.as(subject);
  employeeId = subject.employeeId;
  const [hire] = await w.records(w.hr, employeeId);
  hireRecordId = hire!.id;
});

describe('E2E-01 员工发起调动 → 审批 → 定时生效 → 版本链 / 向后更新 → 各侧可见 → 审计', () => {
  it('步骤 1（R1-T13，AC-TRF-01/37/45）：员工本人发起调动申请，新经理随新部门带出；提交即匹配流程并禁止自审', async () => {
    const preview = await w.json<{ form: { id: string }; fields: Record<string, unknown> }>(
      await w.request(self, 'POST', `${SELF}/transfer/preview`, {
        body: { effectiveDate: TRANSFER_DATE, fields: { departmentId: w.to } },
      }),
    );
    // DEC-205 / 209：与 HR 同一张表单，新部门带出新直线经理（调入部门负责人），员工可改。
    expect(preview.form.id).toBe('TenantBase.TransferMultiFormView');
    expect(preview.fields).toMatchObject({ departmentId: w.to, directManagerId: w.inHead.employeeId });

    const profile = await w.json<{ employee: { id: string; revision: number } }>(
      await w.request(self, 'GET', `${SELF}/profile`),
    );
    expect(profile.employee.id).toBe(employeeId);
    const saved = await w.json<{ id: string; status: string }>(
      await w.request(self, 'POST', `${SELF}/transfer`, {
        ifMatch: profile.employee.revision,
        body: { effectiveDate: TRANSFER_DATE, fields: { departmentId: w.to } },
      }),
      201,
    );
    applicationId = saved.id;
    expect(saved.status).toBe('in_review');

    instanceView = await w.instanceOf(self, applicationId);
    expect(instanceView).toMatchObject({ status: 'running', processId: w.process.id, currentNodeKey: 'out_head' });
    const [task] = w.pending(instanceView);
    expect(task).toMatchObject({ nodeKey: 'out_head', assigneeUserId: w.outHead.userId, isExceptionAdmin: false });
    expect(task!.assigneeUserId).not.toBe(self.user);
    // 员工侧“我的申请”：审批中，当前处理人为调出负责人。
    const mine = await w.json<{ items: { businessId: string; status: string; currentHandlers: string[] }[] }>(
      await w.request(self, 'GET', `${SELF}/applications`),
    );
    expect(mine.items).toEqual([expect.objectContaining({ businessId: applicationId, status: '审批中' })]);
    expect(mine.items[0]!.currentHandlers).not.toHaveLength(0);
    // DEC-125：审批期间只有申请单，任职版本链不新增记录。
    expect(await w.records(w.hr, employeeId)).toHaveLength(1);
  });

  it('步骤 2（R1-T07，AC-APV-01/02、AC-PRM-29、AC-TRF-06/38）：调出负责人 → 调入 HRBP → 调入负责人逐节点同意；审批人不因审批获得员工数据范围', async () => {
    const todos = await w.json<{ items: { instanceId: string; nodeKey: string }[] }>(
      await w.request(w.as(w.outHead), 'GET', '/api/tenant/approval/todos'),
    );
    expect(todos.items).toEqual([expect.objectContaining({ instanceId: instanceView.id, nodeKey: 'out_head' })]);
    // DEC-057 / AC-PRM-29：审批人只看本单，不能借审批读员工任职。
    const peek = await w.request(w.as(w.inHrbp), 'GET', `/api/tenant/employment/employees/${employeeId}/records`);
    expect(peek.status).toBe(404);
    expect(await peek.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const { steps, view } = await w.approveAll(instanceView);
    expect(steps).toEqual([
      { nodeKey: 'out_head', by: w.outHead.userId },
      { nodeKey: 'in_hrbp', by: w.inHrbp.userId },
      { nodeKey: 'in_head', by: w.inHead.userId },
    ]);
    instanceView = view;
    expect(view).toMatchObject({ status: 'approved', currentNodeKey: null });
    expect(view.logs.filter((log) => log.event === 'approve')).toHaveLength(3);

    // AC-TRF-06：审批通过日 < 调动日 → 申请单停在「审批通过」，不新增任职记录，生效结果待定时任务。
    const approved = await w.business(w.hr, applicationId);
    expect(approved).toMatchObject({ status: 'approved', record: null, activation: { status: 'pending' } });
    expect(await w.records(w.hr, employeeId)).toHaveLength(1);
    const mine = await w.json<{ items: { status: string; currentHandlers: string[] }[] }>(
      await w.request(self, 'GET', `${SELF}/applications`),
    );
    expect(mine.items).toEqual([expect.objectContaining({ status: '通过', currentHandlers: [] })]);
    // 员工侧任职列表：在途行（审批通过）与入职记录并存，入职记录结束日不被提前截断（AC-TRF-38）。
    const selfRecords = await w.json<{ items: { id: string; stopDate: string | null }[] }>(
      await w.request(self, 'GET', `${SELF}/employees/${employeeId}/records`),
    );
    expect(selfRecords.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: applicationId, stopDate: null }),
        expect.objectContaining({ id: hireRecordId, stopDate: '9999-12-31' }),
      ]),
    );
  });

  it('步骤 3（R1-T08，AC-TRF-06/32、AC-EMP-01/05/11）：调动日前不生效；北京时间调动日 01:15（UTC 前一天）定时任务落地，前一条止于前一天', async () => {
    // 北京时间 10-14 23:30：业务日仍是 10-14，不生效。
    expect((await w.runScheduler('2026-10-14T15:30:00Z')).activated).toEqual([]);
    expect(await w.business(w.hr, applicationId)).toMatchObject({ status: 'approved', record: null });

    // 北京时间 10-15 01:15（UTC 10-14 17:15）：按租户时区判定已到调动日（DEC-056，AC-TRF-32）。
    const run = await w.runScheduler('2026-10-14T17:15:00Z');
    expect(run).toMatchObject({ businessDate: TRANSFER_DATE, activated: [applicationId], failed: [], suspended: [] });
    w.setNow(`${TRANSFER_DATE}T02:00:00Z`);

    const effective = await w.business(w.hr, applicationId);
    expect(effective).toMatchObject({
      status: 'effective',
      effectiveDate: TRANSFER_DATE,
      activation: { status: 'effective', failureCount: 0 },
      record: {
        effectiveDate: TRANSFER_DATE,
        previousRecordId: hireRecordId,
        fields: { departmentId: w.to, directManagerId: w.inHead.employeeId, place: '原地点' },
      },
    });
    // R1-T05：版本链 +1，字段继承——未改的 place 来自上一条；恰有一条当前生效（AC-EMP-01 / 05 / 11）。
    const records = await w.records(w.hr, employeeId, TRANSFER_DATE);
    expect(chain(records)).toEqual([
      {
        id: hireRecordId,
        effectiveDate: '2020-01-01',
        stopDate: '2026-10-14',
        departmentId: w.from,
        previousRecordId: null,
        isCurrent: false,
      },
      {
        id: applicationId,
        effectiveDate: TRANSFER_DATE,
        stopDate: '9999-12-31',
        departmentId: w.to,
        previousRecordId: hireRecordId,
        isCurrent: true,
      },
    ]);
    // 「变更前」从版本链上一条取，不单独建列（硬规则 3）。
    const detail = await w.json<{ before: { fields: Record<string, unknown> } | null }>(
      await w.request(w.hr, 'GET', `/api/tenant/employment/records/${applicationId}?asOf=${TRANSFER_DATE}`),
    );
    expect(detail.before).toMatchObject({ fields: { departmentId: w.from } });
    // 重复运行不重复生效。
    expect((await w.runScheduler('2026-10-14T17:20:00Z')).activated).toEqual([]);
    expect(await w.records(w.hr, employeeId, TRANSFER_DATE)).toHaveLength(2);
  });

  it('步骤 4（R1-T06，AC-FWD-01/02/03/14、AC-EMP-13）：HR 补录 10-10 调动改地点，10-15 记录按值匹配向后更新且“变更前”重链；同日业务按操作先后', async () => {
    const input = {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-10',
      fields: { departmentId: w.from, place: '新地点' },
    };
    // 预览无写入，列出会被改写的后续记录（AC-FWD-01 / 14）。
    const plan = await w.json<{
      changes: { businessId: string; fields: { field: string; before: unknown; after: unknown }[] }[];
    }>(
      await w.request(w.hr, 'POST', `/api/tenant/employment/employees/${employeeId}/forward-update-preview`, {
        body: input,
      }),
    );
    expect(plan.changes).toEqual([
      expect.objectContaining({
        businessId: applicationId,
        fields: [{ field: 'place', before: '原地点', after: '新地点' }],
      }),
    ]);
    expect((await w.business(w.hr, applicationId)).record?.fields.place).toBe('原地点');

    const backfill = await w.directBusiness(w.hr, employeeId, input);
    backfillId = backfill.id;
    expect(backfill).toMatchObject({ status: 'effective', record: { effectiveDate: '2026-10-10', isInserted: true } });
    const updated = await w.business(w.hr, applicationId);
    // 部门与变动前值不同（调入部门 ≠ 调出部门）不替换；地点与变动前值相同 → 替换（AC-FWD-01 / 02 / 03）。
    expect(updated.record).toMatchObject({
      previousRecordId: backfillId,
      fields: { departmentId: w.to, place: '新地点' },
    });

    // DEC-108：同日再保存一条直接业务（转正），排在调动之后，当前任职取后操作的那条，变更前取同日前一条。
    const sameDay = await w.directBusiness(w.hr, employeeId, {
      kind: 'regularization',
      mode: 'direct',
      effectiveDate: TRANSFER_DATE,
      fields: { remarks: '同日转正' },
    });
    sameDayId = sameDay.id;
    expect(sameDay.record).toMatchObject({
      effectiveDate: TRANSFER_DATE,
      previousRecordId: applicationId,
      fields: { departmentId: w.to, place: '新地点', remarks: '同日转正' },
    });
    const records = await w.records(w.hr, employeeId, TRANSFER_DATE);
    expect(chain(records)).toEqual([
      expect.objectContaining({ id: hireRecordId, stopDate: '2026-10-09', isCurrent: false }),
      expect.objectContaining({
        id: backfillId,
        effectiveDate: '2026-10-10',
        stopDate: '2026-10-14',
        isCurrent: false,
      }),
      expect.objectContaining({ id: applicationId, effectiveDate: TRANSFER_DATE, isCurrent: false }),
      expect.objectContaining({ id: sameDayId, effectiveDate: TRANSFER_DATE, stopDate: '9999-12-31', isCurrent: true }),
    ]);
    expect(records.filter((record: EmploymentRecordView) => record.isCurrent)).toHaveLength(1);
  });

  it('步骤 5（R1-T13 / T14 / T02，AC-TRF-38/42、AC-PRM-04/26）：员工自助、调入部门经理工作台、范围内 HR 都看到变更；调出经理与范围外 HR 看不到', async () => {
    // 员工自助：任职列表含补录与同日业务；我的申请仍只列本人发起的那一单。
    type SelfRecord = { id: string; approvalStatus: string; fields: Record<string, unknown> };
    const selfRecords = await w.json<{ items: SelfRecord[] }>(
      await w.request(self, 'GET', `${SELF}/employees/${employeeId}/records`),
    );
    expect(selfRecords.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([hireRecordId, backfillId, applicationId, sameDayId]),
    );
    // 员工看到的是变更后的值（DEC-205 默认可见字段：新部门、新直线经理）；地点不在员工默认可见字段内，不返回。
    const byId = new Map(selfRecords.items.map((item) => [item.id, item]));
    expect(byId.get(applicationId)).toMatchObject({
      approvalStatus: '通过',
      fields: { departmentId: w.to, directManagerId: w.inHead.employeeId },
    });
    expect(byId.get(applicationId)!.fields).not.toHaveProperty('place');
    expect(byId.get(backfillId)!.fields).toMatchObject({ departmentId: w.from });
    expect(byId.get(sameDayId)!.fields).toMatchObject({ departmentId: w.to });
    expect(byId.get(hireRecordId)!.fields).toMatchObject({ departmentId: w.from });
    const mine = await w.json<{ items: { businessId: string; status: string }[] }>(
      await w.request(self, 'GET', `${SELF}/applications`),
    );
    expect(mine.items).toEqual([expect.objectContaining({ businessId: applicationId, status: '通过' })]);

    // 经理工作台（R1-T14）：调入部门负责人的团队成员含该员工，且显示其变更后的部门与经理；调出部门负责人的团队不再含。
    type TeamRow = { id: string; departmentId?: string; directManagerId?: string };
    const team = async (manager: Actor) =>
      (
        await w.json<{ items: TeamRow[] }>(
          await w.request(manager, 'GET', '/api/tenant/employment/transfers/manager/team?category=active'),
        )
      ).items;
    const seenByInHead = (await team(w.as(w.inHead))).find((row) => row.id === employeeId);
    expect(seenByInHead).toMatchObject({ departmentId: w.to, directManagerId: w.inHead.employeeId });
    // 经理默认身份只含任职记录与员工两个对象：人员信息里的邮箱、手机号被裁剪，不出现在行里。
    expect(seenByInHead).not.toHaveProperty('email');
    expect(seenByInHead).not.toHaveProperty('mobilePhone');
    expect((await team(w.as(w.outHead))).map((row) => row.id)).not.toContain(employeeId);

    // HR 列表（AC-PRM-04 / 12）：范围内 HR 可见员工与整条版本链；范围外 HR 一律不可见且不泄露存在。
    const listed = await w.json<{ items: { id: string }[]; hasDataPermission: boolean }>(
      await w.request(w.hr, 'GET', '/api/tenant/employment/employees?pageSize=200'),
    );
    expect(listed.hasDataPermission).toBe(true);
    expect(listed.items.map((item) => item.id)).toContain(employeeId);
    const current = (await w.records(w.hr, employeeId)).find((record) => record.isCurrent)!;
    expect(current.fields).toMatchObject({ departmentId: w.to, directManagerId: w.inHead.employeeId, place: '新地点' });
    // AC-PRM-26：范围外 HR 有数据范围、只是范围内没有员工 → “无数据”（hasDataPermission 为真）；
    // “无数据权限”的另一半见 AC-PRM-30（未配置范围 → hasDataPermission 为假）。
    const hidden = await w.json<{ items: { id: string }[]; hasDataPermission: boolean }>(
      await w.request(w.outsider, 'GET', '/api/tenant/employment/employees?pageSize=200'),
    );
    expect(hidden).toEqual(expect.objectContaining({ items: [], hasDataPermission: true }));
    for (const path of [
      `/api/tenant/employment/employees/${employeeId}`,
      `/api/tenant/employment/employees/${employeeId}/records`,
      `/api/tenant/employment/businesses/${applicationId}`,
      `/api/tenant/employment/records/${applicationId}`,
    ])
      expect((await w.request(w.outsider, 'GET', path)).status, path).toBe(404);
    // 范围外 HR 也不能借调动入口写该员工：用有权 HR 取到有效 revision，再以范围外身份直接 POST，被拒且不留业务数据。
    const revision = await w.employeeRevision(w.hr, employeeId);
    const before = chain(await w.records(w.hr, employeeId));
    const denied = await w.hrTransfer(w.outsider, employeeId, { effectiveDate: '2026-11-01' }, revision);
    expect(denied.status, await denied.clone().text()).toBe(404);
    expect(await denied.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(chain(await w.records(w.hr, employeeId))).toEqual(before);
    expect(await w.employeeRevision(w.hr, employeeId)).toBe(revision);
    const applications = await w.json<{ items: unknown[] }>(
      await w.request(w.outsider, 'GET', '/api/tenant/approval/instances?role=initiated'),
    );
    expect(applications.items).toEqual([]);
  });

  it('步骤 6（R1-T16，AC-AUD-04、AC-TRF-46）：审计员按范围看到员工发起、系统生效与向后更新的日志；范围外审计员看不到', async () => {
    const created = await w.dataChanges(w.auditor, { objectId: applicationId, action: 'employment.business.create' });
    expect(created).toEqual([expect.objectContaining({ operator: expect.objectContaining({ userId: self.user }) })]);
    const activated = await w.dataChanges(w.auditor, { objectId: applicationId, action: 'employment.record.create' });
    expect(activated).toHaveLength(1);
    // AC-AUD-04：定时任务写入的记录操作人为“系统”；事件时间存 UTC，按租户时区即调动日。
    expect(activated[0]!.operator.userId).toBeNull();
    expect(activated[0]!.occurredAt).toBe('2026-10-14T17:15:00.000Z');
    expect(tenantLocalDate(new Date(activated[0]!.occurredAt), 'Asia/Shanghai')).toBe(TRANSFER_DATE);
    const raw = await w.rawAudit(applicationId);
    expect(raw.map((event) => event.action)).toEqual(
      expect.arrayContaining(['employment.business.state.effective', 'employment.forward-update']),
    );
    const forwarded = await w.dataChanges(w.auditor, { objectId: applicationId, action: 'employment.forward-update' });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.changes.some((change) => change.field.endsWith('place') && change.to === '新地点')).toBe(true);
    // 范围外审计员：列表为空，已知日志 ID 的详情也 404（DEC-197）。
    expect(await w.dataChanges(w.outsideAuditor, { objectId: applicationId })).toEqual([]);
    expect((await w.audit.get(`/data-changes/${activated[0]!.id}`, w.outsideAuditor)).status).toBe(404);
  });
});
