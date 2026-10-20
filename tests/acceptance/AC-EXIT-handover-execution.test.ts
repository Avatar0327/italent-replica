/**
 * R2 BE-8b2 / DM-R11 / DM-R13 / DM-R14 / DM-R16、B64 B65、DEC-632、B-59：离职交接执行。
 * - 自动发起：订阅 exitPostEffectHooks.onConfirmed（只对离职申请审批通过；直接离职不发起），按 exit.handover_trigger
 *   （开关、“包含最后工作日早于审批通过日的人员”）判断；发起人 = 员工本人、系统代发；同一离职最多一张进行中 / 已完成的交接申请。
 * - 事项快照：发起时把交接事项设置的当时全部事项带进本单，之后改设置不影响；“交接人”只读、不随负责人回填。
 * - 办理：勾选“办理完成”即自动保存（不点同意也生效、不推进节点）；只能改本节点负责的类别；“本人事项办完”只统计本节点。
 * - 四节点：工作交接 → 其他事项交接 → 员工确认 → HRBP 办离职证明；没有“跳过”；不同意 = 已终止。
 * - 交接未完成不阻止离职生效；撤销离职终止进行中的交接（已完成的不动）；租户隔离。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { PRESET_PROCESSES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  FUTURE_EFFECTIVE_DATE,
  FUTURE_LAST_WORK_DATE,
  handoverWorld,
  SETTING_ITEMS,
  TODAY,
} from './AC-EXIT-handover-support.js';

const database = useTestDb();
const world = async (
  label: string,
  options: { hrAdmin?: boolean; fallbackWork?: readonly string[]; fallbackOther?: readonly string[] } = {},
) => {
  const x = await handoverWorld(database().db, label, { hrAdmin: options.hrAdmin ?? true });
  await x.addSettingItems();
  // 兜底处理人是流程定义里的用户（须是本租户成员），所以先建人再发布流程；默认不预置，三者都空必须真实为空
  const people = new Map<string, { employeeId: string; userId: string }>();
  for (const name of [...(options.fallbackWork ?? []), ...(options.fallbackOther ?? [])])
    people.set(name, await x.person(name));
  const ids = (names: readonly string[] | undefined) => (names ?? []).map((name) => people.get(name)!.userId);
  await x.publishHandoverProcess({ work: ids(options.fallbackWork), other: ids(options.fallbackOther) });
  return Object.assign(x, { people });
};

/** 离职申请：提交并批准，不带交接人（该员工没有直线经理）；返回批准结果与交接单。 */
async function approveWithoutHandler(x: Awaited<ReturnType<typeof world>>, employeeId = x.employee.id) {
  const draft = await x.createdExit(employeeId, FUTURE_LAST_WORK_DATE, 'application', { exitTypeCode: 'voluntary' });
  const sent = await x.session.request('POST', `/businesses/${draft.id}/submit`, {
    ifMatch: draft.revision,
    body: {},
  });
  expect(sent.status).toBe(200);
  const approved = await x.tryApprove(draft, `${TODAY}T02:00:00Z`);
  return { draft, approved, rows: await x.requestRows(draft.id) };
}

describe('预置流程：四节点、只有同意 / 不同意（B64，R2f2）', () => {
  it('节点 工作交接 → 其他事项交接 → 员工确认 → HRBP办离职证明；没有驳回 / 跳转 / 加签 / 转交', () => {
    const preset = PRESET_PROCESSES.find((candidate) => candidate.approvalType === 'exit_handover')!;
    expect(preset.definition.nodes.map((node) => node.key)).toEqual([
      'work_handover',
      'other_handover',
      'employee_confirm',
      'hrbp_certificate',
    ]);
    expect(preset.definition.nodes.map((node) => node.name)).toEqual([
      '工作交接',
      '其他事项交接',
      '员工确认',
      'HRBP办离职证明',
    ]);
    for (const node of preset.definition.nodes)
      expect(node.actions, node.key).toMatchObject({ reject: false, jump: false, addSign: false, transfer: false });
  });
});

describe('自动发起（DM-R13 / DM-R14、B64 B65）', () => {
  it('离职申请审批通过：自动发起一张，发起人 = 员工本人，事项为设置当时全部，首节点待办是工作交接人', async () => {
    const x = await world('launch-ok');
    const { request, exitId } = await x.launched();
    expect(request).toMatchObject({ state: 'in_progress', employeeId: x.employee.id, initiatorUserId: x.leaverUserId });
    expect(await x.requestRows(exitId)).toHaveLength(1);
    expect((await x.itemRows(request.id)).map((item) => item.title)).toEqual(SETTING_ITEMS.map((item) => item.title));
    expect(await x.itemRows(request.id)).toEqual(
      SETTING_ITEMS.map((item) =>
        expect.objectContaining({ todoType: item.todoType, done: false, handoverPerson: null }),
      ),
    );
    expect(await x.pendingNode(request.instanceId!)).toMatchObject({
      nodeKey: 'work_handover',
      userId: x.workOwner.userId,
    });
    expect((await x.statusOf(exitId)).status).toBe('in_progress');
    // 系统代发：审计操作人记系统（空），不冒用员工或 HR
    const [created] = await x.auditActions(request.id, 'exit_handover.launch');
    expect(created).toBeTruthy();
    const [actor] = await x.sqlRows<{ actor: string | null }>(
      sql`SELECT actor_user_id AS actor FROM audit_events WHERE tenant_id=${x.tenantId}
        AND object_id=${request.id} AND action='exit_handover.launch'`,
    );
    expect(actor?.actor).toBeNull();
  });

  it('重放不重复发起：同一离职再次进入发起入口返回已有的一张', async () => {
    const x = await world('launch-replay');
    const { exitId, request } = await x.launched();
    const { launchExitHandover } = await import('../../apps/api/src/modules/employment/exit-handover.js');
    const again = await withTenant(x.db, x.tenantId, (tx) =>
      launchExitHandover(
        tx,
        {
          tenantId: x.tenantId,
          userId: x.session.user.id,
          timezone: x.session.tenant.timezone,
          now: new Date(`${TODAY}T03:00:00Z`),
          commandId: randomUUID(),
          expectedRevision: 0,
        },
        { businessId: exitId, employeeId: x.employee.id, mode: 'application', kind: 'leave', reEmployed: false },
      ),
    );
    expect(again).toMatchObject({ outcome: 'exists', requestId: request.id });
    expect(await x.requestRows(exitId)).toHaveLength(1);
  });

  it('开关关闭 → 不发起，离职详情显示“未发起”', async () => {
    const x = await world('launch-off');
    await x.setTrigger({ enabled: false });
    const { approved } = await x.approvedApplication(x.employee.id);
    expect(await x.requestRows(approved.id)).toEqual([]);
    expect(await x.statusOf(approved.id)).toEqual({ status: 'not_started', request: null });
  });

  it('“包含最后工作日早于审批通过日的人员”：关闭时晚审批不发起，开启时发起', async () => {
    const off = await world('launch-past-off');
    await off.setTrigger({ includePastLastWorkDate: false });
    const late = await off.approvedApplication(off.employee.id, { at: '2026-10-20T02:00:00Z' });
    expect(await off.requestRows(late.approved.id)).toEqual([]);
    // 未晚于最后工作日的照常发起（关闭只排除“最后工作日早于审批通过日”的人）
    const onTime = await world('launch-past-ontime');
    await onTime.setTrigger({ includePastLastWorkDate: false });
    const early = await onTime.approvedApplication(onTime.employee.id);
    expect(await onTime.requestRows(early.approved.id)).toHaveLength(1);
    const on = await world('launch-past-on');
    const lateOn = await on.approvedApplication(on.employee.id, { at: '2026-10-20T02:00:00Z' });
    expect(await on.requestRows(lateOn.approved.id)).toHaveLength(1);
  });

  it('直接离职不发起（DM-R14 / B-59），离职详情显示“未发起”', async () => {
    const x = await world('launch-direct');
    const leave = await x.createdExit(x.employee.id, FUTURE_LAST_WORK_DATE, 'direct', { exitTypeCode: 'voluntary' });
    expect(await x.requestRows(leave.id)).toEqual([]);
    expect(await x.statusOf(leave.id)).toEqual({ status: 'not_started', request: null });
  });

  it('员工没有可用账号（无法作为发起人）：跳过并留痕，离职审批照常通过', async () => {
    const x = await world('launch-no-account');
    const lone = await x.colleague('无账号员工');
    await x.unbindAccount(lone.id);
    const { approved } = await x.approvedApplication(lone.id);
    expect(approved.status).toBe('approved');
    expect(await x.requestRows(approved.id)).toEqual([]);
    expect(await x.auditActions(approved.id, 'exit_handover.skipped')).toEqual([
      { after: expect.objectContaining({ reason: 'NO_INITIATOR_ACCOUNT' }) },
    ]);
  });

  it('兜底处理人（DEC-663 ②）：交接人、直线经理都空 → 取本节点兜底列表（多人），任一人同意即通过', async () => {
    const x = await world('launch-fallback', { fallbackWork: ['兜底甲', '兜底乙'] });
    const { approved, rows } = await approveWithoutHandler(x);
    expect(approved).toMatchObject({ ok: true });
    expect(rows).toHaveLength(1);
    const pending = await x.pendingTasks(rows[0]!.instanceId!);
    expect(pending.map((task) => [task.nodeKey, task.userId]).sort()).toEqual(
      [
        ['work_handover', x.people.get('兜底甲')!.userId],
        ['work_handover', x.people.get('兜底乙')!.userId],
      ].sort(),
    );
    // 会签任一人同意：甲同意后进入下一节点，乙的待办随之结束
    const task = pending.find((candidate) => candidate.userId === x.people.get('兜底甲')!.userId)!;
    const response = await x.api.request('POST', `/api/tenant/approval/tasks/${task.taskId}/approve`, {
      ...x.tenantAs(task.userId),
      ifMatch: (await x.pendingNode(rows[0]!.instanceId!))!.revision,
      body: {},
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await x.pendingTasks(rows[0]!.instanceId!)).map((candidate) => candidate.nodeKey)).toEqual([
      'other_handover',
    ]);
  });

  it('有交接人 / 直线经理时不用兜底；兜底里没有审批资格的人被跳过（DEC-663 ⑤）', async () => {
    const x = await world('launch-fallback-skip', { fallbackWork: ['已失效兜底', '有效兜底'] });
    // 已失效兜底人：定义保存时是本租户成员，之后被移出租户
    await withTenant(x.db, x.tenantId, (tx) =>
      tx.execute(sql`UPDATE tenant_memberships SET status='revoked' WHERE tenant_id=${x.tenantId}
        AND user_id=${x.people.get('已失效兜底')!.userId}::uuid`),
    );
    const { rows } = await approveWithoutHandler(x);
    expect(rows).toHaveLength(1);
    expect((await x.pendingTasks(rows[0]!.instanceId!)).map((task) => task.userId)).toEqual([
      x.people.get('有效兜底')!.userId,
    ]);
    // 有交接人时兜底不参与
    const other = await world('launch-fallback-unused', { fallbackWork: ['不该出现的兜底'] });
    const launched = await other.launched();
    expect((await other.pendingTasks(launched.instanceId)).map((task) => task.userId)).toEqual([
      other.workOwner.userId,
    ]);
  });

  it('三者都空（DEC-663 ③）：离职照常批准，不发起交接，落“交接未发起”记录并带 HR 提示，审计在，不回滚', async () => {
    const x = await world('launch-all-empty');
    const { draft, approved, rows } = await approveWithoutHandler(x);
    expect(approved).toMatchObject({ ok: true });
    expect((await x.business(draft.id)).status).toBe('approved');
    expect(await x.preReleaseDate(draft.id)).not.toBeNull();
    expect(await x.handoverInstanceCount()).toBe(0);
    expect(rows).toEqual([
      expect.objectContaining({ state: 'not_launched', employeeId: x.employee.id, instanceId: null }),
    ]);
    expect(await x.itemRows(rows[0]!.id)).toEqual([]);
    expect(await x.statusOf(draft.id)).toMatchObject({
      status: 'not_launched',
      request: {
        id: rows[0]!.id,
        notLaunchedReason: 'NO_HANDLER',
        hint: '工作交接未发起：交接人、直线经理与兜底处理人均为空，请补充后处理',
      },
    });
    const [audit] = await x.auditActions(rows[0]!.id, 'exit_handover.not_launched');
    expect(audit?.after).toMatchObject({ reason: 'NO_HANDLER' });
    // 重放不重复落记录
    expect(await x.requestRows(draft.id)).toHaveLength(1);
  });

  it('三者都空后撤销离职：未发起记录一并置已终止', async () => {
    const x = await world('launch-all-empty-cancel');
    const { draft } = await approveWithoutHandler(x);
    await x.cancelExit(draft.id);
    expect((await x.requestRows(draft.id))[0]).toMatchObject({ state: 'terminated', endReason: 'exit_cancelled' });
  });

  it('其他事项交接取不到人（DEC-663 ④）：转给流程的异常管理员', async () => {
    const x = await world('launch-other-admin', { hrAdmin: false });
    const { instanceId } = await x.launched();
    expect((await x.decide(instanceId)).status).toBe(200);
    expect(await x.pendingTasks(instanceId)).toEqual([
      expect.objectContaining({ nodeKey: 'other_handover', userId: x.exceptionAdmin.id, isExceptionAdmin: true }),
    ]);
  });

  it('审计归属（P2-2）：系统代发的审批发起 / 冻结主体操作人为系统，员工仍是发起人', async () => {
    const x = await world('launch-actor');
    const { request, instanceId } = await x.launched();
    const audits = await x.sqlRows<{ action: string; actor: string | null }>(sql`
      SELECT action, actor_user_id AS actor FROM audit_events WHERE tenant_id=${x.tenantId}
        AND object_id=${instanceId} AND action IN ('approval.instance.start', 'approval.instance.subjects_freeze')
      ORDER BY action`);
    expect(audits).toEqual([
      { action: 'approval.instance.start', actor: null },
      { action: 'approval.instance.subjects_freeze', actor: null },
    ]);
    const [log] = await x.sqlRows<{ actor: string | null; initiator: string }>(sql`
      SELECT l.actor_user_id AS actor, i.initiator_user_id AS initiator FROM approval_instance_logs l
      JOIN approval_instances i ON i.tenant_id=l.tenant_id AND i.id=l.instance_id
      WHERE l.tenant_id=${x.tenantId} AND l.instance_id=${instanceId}::uuid AND l.event='start'`);
    expect(log).toEqual({ actor: null, initiator: x.leaverUserId });
    expect(request.initiatorUserId).toBe(x.leaverUserId);
  });

  it('事项快照：发起后再改设置（改名、新增、删除）不影响已发起的交接', async () => {
    const x = await world('launch-snapshot');
    const { request } = await x.launched();
    const list = await x.session.request('GET', '/exit-handover-items');
    const items = ((await list.json()) as { items: { id: string; revision: number }[] }).items;
    const renamed = await x.session.request('PUT', `/exit-handover-items/${items[0]!.id}`, {
      ifMatch: items[0]!.revision,
      body: { ...SETTING_ITEMS[0], title: '改名后的事项' },
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    const removed = await x.session.request('DELETE', `/exit-handover-items/${items[1]!.id}`, {
      ifMatch: items[1]!.revision,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    await x.addSettingItems([{ category: '人力', sequenceNo: 9, todoType: 'other', title: '新增事项' }]);
    expect((await x.itemRows(request.id)).map((item) => item.title)).toEqual(SETTING_ITEMS.map((item) => item.title));
  });

  it('工作交接节点：离职申请填了交接人取交接人；没填取直线经理', async () => {
    const x = await world('launch-approver');
    const { instanceId } = await x.launched(x.employee.id, { handoverEmployeeId: x.workOwner.employeeId });
    expect((await x.pendingNode(instanceId))?.userId).toBe(x.workOwner.userId);
    const manager = await x.person('直线经理');
    const subordinate = await x.session.employee('有经理的离职者');
    await x.session.business(
      subordinate.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: x.from.id, directManagerId: manager.employeeId },
      },
      subordinate.revision,
    );
    await x.person('有经理的离职者', subordinate.id);
    const second = await x.launched(subordinate.id, { handoverEmployeeId: undefined });
    expect((await x.pendingNode(second.instanceId))?.userId).toBe(manager.userId);
  });
});

describe('办理：勾选即自动保存、只改本节点负责的类别（R2f2）', () => {
  it('工作交接人勾选“工作交接”类事项：立即保存，不点同意；节点仍在工作交接；本人事项统计只算本节点', async () => {
    const x = await world('tick-work');
    const { request, instanceId } = await x.launched();
    const detail = await x.detailAs(x.workOwner.userId, request.id);
    expect(detail.status).toBe(200);
    expect(detail.body.items.map((item) => [item.title, item.editable])).toEqual([
      ['工作文档交接', true],
      ['归还办公电脑', false],
      ['清理借款', false],
    ]);
    const work = detail.body.items[0]!;
    const saved = await x.tick(x.workOwner.userId, request.id, work, true);
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await saved.json()).toMatchObject({
      item: { id: work.id, done: true },
      mine: { nodeKey: 'work_handover', total: 1, done: 1, allDone: true },
    });
    expect((await x.itemRows(request.id)).map((item) => item.done)).toEqual([true, false, false]);
    expect(await x.pendingNode(instanceId)).toMatchObject({ nodeKey: 'work_handover' });
    // 可取消勾选
    const refreshed = (await x.detailAs(x.workOwner.userId, request.id)).body.items[0]!;
    const undone = await x.tick(x.workOwner.userId, request.id, refreshed, false);
    expect(undone.status).toBe(200);
    expect((await x.itemRows(request.id))[0]!.done).toBe(false);
  });

  it('非本节点负责的事项 / 非当前办理人 / 旧 revision 都被拒绝', async () => {
    const x = await world('tick-denied');
    const { request } = await x.launched();
    const items = (await x.detailAs(x.workOwner.userId, request.id)).body.items;
    // 工作交接人改“其他”类事项：403
    const other = await x.tick(x.workOwner.userId, request.id, items[1]!, true);
    expect(other.status).toBe(403);
    // 人事管理员的节点还没到：还不是这张交接的参与人，读不到 404
    const early = await x.tick(x.hrAdmin.id, request.id, items[1]!, true);
    expect(early.status).toBe(404);
    // 无关用户：看不到这张交接 404
    const stranger = await x.otherUser();
    expect((await x.tick(stranger.id, request.id, items[0]!, true)).status).toBe(404);
    // 旧 revision：先勾选一次，再用旧 revision 取消 → 409
    expect((await x.tick(x.workOwner.userId, request.id, items[0]!, true)).status).toBe(200);
    expect((await x.tick(x.workOwner.userId, request.id, items[0]!, false)).status).toBe(409);
  });

  it('同意工作交接后进入“其他事项交接”：人事管理员办“其他”类，统计只算其他类；工作交接人不能再改', async () => {
    const x = await world('tick-other');
    const { request, instanceId } = await x.launched();
    const approve = await x.decide(instanceId);
    expect(approve.status, await approve.clone().text()).toBe(200);
    expect(await x.pendingNode(instanceId)).toMatchObject({ nodeKey: 'other_handover', userId: x.hrAdmin.id });
    const items = (await x.detailAs(x.hrAdmin.id, request.id)).body.items;
    expect(items.map((item) => item.editable)).toEqual([false, true, true]);
    const first = await x.tick(x.hrAdmin.id, request.id, items[1]!, true);
    expect(await first.json()).toMatchObject({
      mine: { nodeKey: 'other_handover', total: 2, done: 1, allDone: false },
    });
    const second = await x.tick(x.hrAdmin.id, request.id, items[2]!, true);
    expect(await second.json()).toMatchObject({ mine: { total: 2, done: 2, allDone: true } });
    expect((await x.tick(x.workOwner.userId, request.id, items[0]!, true)).status).toBe(403);
  });

  it('已终止 / 已完成的交接不能再改（409）', async () => {
    const x = await world('tick-closed');
    const { request, instanceId } = await x.launched();
    const items = (await x.detailAs(x.workOwner.userId, request.id)).body.items;
    expect((await x.decide(instanceId, 'disagree')).status).toBe(200);
    expect((await x.tick(x.workOwner.userId, request.id, items[0]!, true)).status).toBe(409);
  });
});

describe('四节点走完 / 不同意（B64）', () => {
  it('依次：工作交接人 → 人事管理员 → 员工本人 → 部门 HRBP；全部同意后“已完成”', async () => {
    const x = await world('flow-complete');
    const { exitId, request, instanceId } = await x.launched();
    const seen: [string, string][] = [];
    for (let step = 0; step < 4; step++) {
      const node = (await x.pendingNode(instanceId))!;
      seen.push([node.nodeKey, node.userId]);
      expect((await x.decide(instanceId)).status).toBe(200);
    }
    expect(seen).toEqual([
      ['work_handover', x.workOwner.userId],
      ['other_handover', x.hrAdmin.id],
      ['employee_confirm', x.leaverUserId],
      ['hrbp_certificate', x.hrbp.userId],
    ]);
    expect((await x.requestRows(exitId))[0]).toMatchObject({ id: request.id, state: 'completed' });
    expect((await x.statusOf(exitId)).status).toBe('completed');
  });

  it('任一节点不同意：交接“已终止”，离职本身不受影响', async () => {
    const x = await world('flow-disagree');
    const { exitId, instanceId } = await x.launched();
    expect((await x.decide(instanceId, 'disagree')).status).toBe(200);
    expect((await x.requestRows(exitId))[0]).toMatchObject({ state: 'terminated', endReason: 'disapproved' });
    expect((await x.statusOf(exitId)).status).toBe('terminated');
    expect((await x.business(exitId)).status).toBe('approved');
  });

  it('没有“跳过”：办理页不接受 jump / reject', async () => {
    const x = await world('flow-no-skip');
    const { instanceId } = await x.launched();
    expect((await x.decide(instanceId, 'jump')).status).toBeGreaterThanOrEqual(400);
    expect((await x.decide(instanceId, 'reject')).status).toBeGreaterThanOrEqual(400);
    expect(await x.pendingNode(instanceId)).toMatchObject({ nodeKey: 'work_handover' });
  });
});

describe('与离职生效 / 撤销离职的关系', () => {
  it('交接未完成不阻止离职生效：调度落地离职，交接继续进行中', async () => {
    const x = await world('exit-effective');
    const { exitId, request } = await x.launched();
    expect(await x.runScheduler(`${FUTURE_EFFECTIVE_DATE}T01:00:00Z`)).toMatchObject({ activated: [exitId] });
    expect((await x.business(exitId)).status).toBe('effective');
    expect((await x.requestRows(exitId))[0]).toMatchObject({ id: request.id, state: 'in_progress' });
  });

  it('撤销离职：进行中的交接置“已终止”（操作人记系统、理由“离职撤销终止交接”），审批实例一并终止', async () => {
    const x = await world('exit-cancel');
    const { exitId, request, instanceId } = await x.launched();
    await x.cancelExit(exitId);
    expect((await x.requestRows(exitId))[0]).toMatchObject({ state: 'terminated', endReason: 'exit_cancelled' });
    expect(await x.instanceStatus(instanceId)).toBe('cancelled');
    expect((await x.statusOf(exitId)).status).toBe('terminated');
    const [audit] = await x.auditActions(request.id, 'exit_handover.terminate');
    expect(audit?.after).toMatchObject({ reason: '离职撤销终止交接' });
  });

  it('撤销离职不动已完成的交接', async () => {
    const x = await world('exit-cancel-completed');
    const { exitId, instanceId } = await x.launched();
    await x.approveAll(instanceId);
    await x.cancelExit(exitId);
    expect((await x.requestRows(exitId))[0]).toMatchObject({ state: 'completed', endReason: null });
  });
});

describe('兜底处理人配置（流程定义节点，DEC-663 ⑥）', () => {
  const processBody = (x: Awaited<ReturnType<typeof world>>, fallback: unknown) => ({
    code: 'FALLBACK_API',
    approvalType: 'exit_handover',
    name: '兜底配置',
    exceptionAdminUserId: x.exceptionAdmin.id,
    isFallback: true,
    conditions: { items: [] },
    nodes: [
      {
        key: 'work_handover',
        kind: 'countersign',
        approvers: ['handover_work_owner'],
        transitionRule: { type: 'any' },
        fallbackUserIds: fallback,
      },
    ],
  });
  const post = (x: Awaited<ReturnType<typeof world>>, body: unknown) =>
    x.api.request('POST', '/api/tenant/approval/processes', { ...x.tenantAs(x.processAdmin.id), ifMatch: 0, body });

  it('流程定义接口能写入并读回兜底列表；预置定义默认为空', async () => {
    const x = await world('fallback-api', { fallbackWork: ['配置兜底'] });
    const user = x.people.get('配置兜底')!.userId;
    const created = await post(x, processBody(x, [user]));
    expect(created.status, await created.clone().text()).toBe(201);
    const view = (await created.json()) as { id: string; latestVersion: { nodes: Record<string, unknown>[] } };
    expect(view.latestVersion.nodes[0]).toMatchObject({ key: 'work_handover', fallbackUserIds: [user] });
    const read = await x.api.request('GET', `/api/tenant/approval/processes/${view.id}`, x.tenantAs(x.processAdmin.id));
    expect(((await read.json()) as typeof view).latestVersion.nodes[0]).toMatchObject({ fallbackUserIds: [user] });
    // 预置定义默认不带兜底
    const preset = PRESET_PROCESSES.find((candidate) => candidate.approvalType === 'exit_handover')!;
    expect(preset.definition.nodes.every((node) => !node.fallbackUserIds?.length)).toBe(true);
  });

  it('非法 userId 被拒：非 UUID 400；不是本租户成员 400 APPROVAL_FALLBACK_USER_INVALID；重复 / 配在不支持的节点上 400', async () => {
    const x = await world('fallback-api-invalid');
    const stranger = await handoverWorld(database().db, 'fallback-api-stranger');
    const reasonOf = async (response: Response) => {
      const body = (await response.json()) as { error?: { code?: string; details?: { reason?: string } } };
      return { status: response.status, code: body.error?.code, reason: body.error?.details?.reason };
    };
    expect(await reasonOf(await post(x, processBody(x, ['not-a-uuid'])))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    expect(await reasonOf(await post(x, processBody(x, [stranger.hrAdmin.id])))).toMatchObject({
      status: 400,
      reason: 'APPROVAL_FALLBACK_USER_INVALID',
    });
    const member = x.hrAdmin.id;
    expect(await reasonOf(await post(x, processBody(x, [member, member])))).toMatchObject({ status: 400 });
    // 兜底只对离职交接申请的交接节点有意义：转调动流程上配置被拒
    const wrongType = { ...processBody(x, [member]), approvalType: 'transfer' };
    expect((await post(x, { ...wrongType, nodes: [{ ...wrongType.nodes[0], approvers: ['owner'] }] })).status).toBe(
      400,
    );
  });
});

describe('租户隔离与读口权限', () => {
  it('其他租户的用户读不到 / 改不了这张交接（404）；无关的本租户成员读不到', async () => {
    const x = await world('isolation');
    const other = await world('isolation-other');
    const { request } = await x.launched();
    const foreign = await other.detailAs(other.workOwner.userId, request.id);
    expect(foreign.status).toBe(404);
    const stranger = await x.otherUser();
    expect((await x.detailAs(stranger.id, request.id)).status).toBe(404);
  });

  it('HR 在离职详情读到完整事项与每项办理状态；员工本人（发起人）可读但全部只读', async () => {
    const x = await world('read-views');
    const { exitId, request } = await x.launched();
    const status = await x.statusOf(exitId);
    expect(status.request?.items.map((item) => [item.title, item.done])).toEqual(
      SETTING_ITEMS.map((item) => [item.title, false]),
    );
    const self = await x.detailAs(x.leaverUserId, request.id);
    expect(self.status).toBe(200);
    expect(self.body.items.every((item) => !item.editable)).toBe(true);
  });
});
