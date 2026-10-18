/**
 * BE-15b2 自动发起试用期考核（docs/02_业务建模/29 PB-R16 / R17 / R19 / R20 / R22，§4 AC-PB-06 / 11 / 12；差距表 B58；
 * DEC-533② 单条启停、DEC-539① 每日定时 + 立即执行）：
 * - 规则：考核名称*、考核类型*（试用中 / 转正）、入职后第 N 天*（1～999，0 报“请设置1至999的整数”）、优先级*、适用组织*
 *   （可取消包含下级）、发起人类型*；行操作编辑 / 复制 / 删除 / 启停；
 * - 触发（AC-PB-06）：只在“入职日 + N 天 = 当天”时发起，不补发（与自动转正“≤ 当天补发”不同）；
 * - 发起走 BE-15b1 的考核发起入口（initiation = auto、系统代发、审批发起日志 detail.systemProxy），发起人取规则配置；
 *   同一任职同一规则只发起一次（立即执行、每日批次重复执行都不重复）；
 * - 失败（PB-R20）：本任职周期已有审批中 / 通过 / 生效的转正记录，或审批中的考核；发起人找不到；台账记 failed 与原因。
 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { autoAssessmentWorld, rowsOf, type AutoAssessmentRule } from './AC-PB-BE15b2-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const TODAY_BATCH = '2026-10-01T01:00:00.000Z';
const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string; details?: { reason?: string } } }).error;

describe('AC-PB-12 自动考核规则“入职后天数”', () => {
  it('1 与 999 可保存；0、空值、负数、小数、字符串、超过 999 拒绝，提示“请设置1至999的整数”，均不写入', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'days');
    expect((await w.created(w.body({ daysAfterEntry: 1 }))).daysAfterEntry).toBe(1);
    expect((await w.created(w.body({ name: '入职满 999 天', daysAfterEntry: 999 }))).daysAfterEntry).toBe(999);
    for (const daysAfterEntry of [0, null, undefined, -1, 1.5, 1000, '3']) {
      const response = await w.create(w.body({ daysAfterEntry }));
      expect(response.status, `${String(daysAfterEntry)} → ${await response.clone().text()}`).toBe(400);
      const error = await errorOf(response);
      expect(error.message).toBe('请设置1至999的整数');
      expect(error.details?.reason).toBe('AUTO_RULE_DAYS_INVALID');
    }
    expect(await w.list()).toHaveLength(2);
  });
});

describe('PB-R16 / R17 规则字段与行操作（DEC-533②）', () => {
  it('必填与取值校验；未决字段（附加人员条件、失败通知、按职务发起）按未知字段 / 非法取值拒绝', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'fields');
    for (const name of [undefined, '', '  ']) expect((await w.create(w.body({ name }))).status).toBe(400);
    for (const extra of [
      { orgIds: [] },
      { orgIds: ['00000000-0000-4000-8000-000000000000'] },
      { assessmentType: 'other' },
      { assessmentType: undefined },
      { initiatorType: 'job_title' },
      { priority: -1 },
      { failureNotice: true },
      { extraConditions: [] },
    ]) {
      const response = await w.create(w.body(extra));
      expect(response.status, `${JSON.stringify(extra)} → ${await response.clone().text()}`).toBe(400);
    }
    expect((await w.create(w.body(), 3)).status).toBe(409);
    expect(await w.list()).toEqual([]);
  });

  it('列表按优先级；编辑 / 复制（默认停用）/ 启停 / 删除各自 revision 校验并写配置审计', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'crud');
    const later = await w.created(w.body({ name: '转正考核', priority: 5, assessmentType: 'regularization' }));
    const first = await w.created(w.body({ priority: 1 }));
    expect(first).toMatchObject({
      name: '入职满 30 天试用中考核',
      includeSubordinates: true,
      assessmentType: 'probation',
      daysAfterEntry: 30,
      initiatorType: 'rule_operator',
      enabled: true,
      revision: 1,
    });
    expect((await w.list()).map((rule) => rule.name)).toEqual(['入职满 30 天试用中考核', '转正考核']);
    const edited = await w.emp('PUT', `/auto-assessment-rules/${later.id}`, {
      ifMatch: 1,
      body: w.body({ name: '转正考核（改）', priority: 0, assessmentType: 'regularization', daysAfterEntry: 80 }),
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(await edited.json()).toMatchObject({ name: '转正考核（改）', daysAfterEntry: 80, revision: 2 });
    expect((await w.emp('PUT', `/auto-assessment-rules/${later.id}`, { ifMatch: 1, body: w.body() })).status).toBe(409);

    const copied = await w.emp('POST', `/auto-assessment-rules/${first.id}/copy`, { ifMatch: 0 });
    expect(copied.status, await copied.clone().text()).toBe(201);
    const copy = (await copied.json()) as AutoAssessmentRule;
    expect(copy).toMatchObject({ name: '入职满 30 天试用中考核（复制）', enabled: false, revision: 1, priority: 1 });
    expect(copy.id).not.toBe(first.id);

    expect((await w.setEnabled(first.id, 1, false)).enabled).toBe(false);
    expect(
      (await w.emp('PUT', `/auto-assessment-rules/${first.id}/enabled`, { ifMatch: 1, body: { enabled: true } }))
        .status,
    ).toBe(409);
    expect((await w.emp('DELETE', `/auto-assessment-rules/${copy.id}`, { ifMatch: 9 })).status).toBe(409);
    expect((await w.emp('DELETE', `/auto-assessment-rules/${copy.id}`, { ifMatch: 1 })).status).toBe(200);
    expect((await w.emp('DELETE', `/auto-assessment-rules/${copy.id}`, { ifMatch: 1 })).status).toBe(404);
    expect((await w.list()).map((rule) => rule.id)).toEqual([later.id, first.id]);
    const audits = await w.asTenant(async (tx) =>
      rowsOf<{ action: string }>(
        await tx.execute(sql`SELECT action FROM audit_events WHERE tenant_id=${w.tenant.id}
          AND object_type='auto_assessment_rule'`),
      ),
    );
    expect(audits.map((a) => a.action).sort()).toEqual(
      [
        'auto_assessment_rule.create',
        'auto_assessment_rule.create',
        'auto_assessment_rule.create',
        'auto_assessment_rule.update',
        'auto_assessment_rule.disable',
        'auto_assessment_rule.delete',
      ].sort(),
    );
  });
});

describe('AC-PB-06 只在入职后第 N 天当天发起，不补发（PB-R17）', () => {
  it('入职 09-01、今天 10-01（第 30 天）：N=30 发起；N=29（昨天已过）与 N=31（明天）都不发起', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'day-n');
    const person = await w.probationer('第三十天员工');
    await w.enableSwitch();
    const early = await w.created(w.body({ name: '第 29 天', daysAfterEntry: 29, priority: 1 }));
    const late = await w.created(w.body({ name: '第 31 天', daysAfterEntry: 31, priority: 2 }));
    expect(await w.ran()).toMatchObject({ businessDate: '2026-10-01', launched: [], failed: [] });
    expect(await w.assessmentsOf(person.employeeId)).toEqual([]);
    expect(await w.launchesOf(person.employeeId)).toEqual([]);

    // 第 30 天命中；已过的第 29 天规则不补发
    const hit = await w.created(w.body({ name: '第 30 天', daysAfterEntry: 30, priority: 3 }));
    const receipt = await w.ran();
    expect(receipt.failed).toEqual([]);
    expect(receipt.launched).toHaveLength(1);
    expect(receipt.launched[0]).toMatchObject({
      employeeId: person.employeeId,
      ruleId: hit.id,
      assessmentStatus: 'in_review',
    });
    expect([early.id, late.id]).not.toContain(receipt.launched[0]!.ruleId);
  });

  it('入职第 61 天才打开开关：规则“入职后第 60 天”不补发，次日批次也不发起', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'no-backfill');
    const person = await w.probationer('第六十一天员工', { endDate: '2026-12-31' });
    await w.created(w.body({ name: '第 60 天', daysAfterEntry: 60 }));
    await w.enableSwitch();
    // 09-01 + 60 天 = 10-31；11-01 才开开关（第 61 天）
    w.setNow('2026-11-01T01:00:00.000Z');
    expect(await w.batch('2026-11-01T01:00:00.000Z')).toMatchObject({ ran: true, launched: [], failed: [] });
    expect(await w.assessmentsOf(person.employeeId)).toEqual([]);
    expect(await w.launchesOf(person.employeeId)).toEqual([]);
  });
});

describe('发起内容、系统代发与幂等（PB-R17 / R22，DEC-539①）', () => {
  it('立即执行：总开关关闭 409；打开后按规则发起，考核带 auto / 系统代发 / 规则配置的考核名称与发起人', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'launch');
    const rule = await w.created(w.body({ name: '入职满 30 天考核', assessmentType: 'probation' }));
    const person = await w.probationer('自动考核员工');
    const closed = await w.runNow();
    expect(closed.status).toBe(409);
    expect((await errorOf(closed)).details?.reason).toBe('AUTO_ASSESSMENT_DISABLED');
    await w.enableSwitch();

    const receipt = await w.ran();
    expect(receipt.launched).toHaveLength(1);
    const [assessment] = await w.assessmentsOf(person.employeeId);
    expect(assessment).toMatchObject({
      assessment_type: 'probation',
      assessment_name: '入职满 30 天考核',
      assessment_date: '2026-10-01',
      status: 'in_review',
      initiation: 'auto',
      system_proxy: true,
      initiator_user_id: w.hr.id,
    });
    expect(receipt.launched[0]).toMatchObject({ ruleId: rule.id, assessmentId: assessment!.id });
    // 审批发起日志标“系统代发”，发起人 = 规则配置的发起人
    const [log] = await w.asTenant(async (tx) =>
      rowsOf<{ initiator: string; proxy: boolean | null }>(
        await tx.execute(sql`SELECT i.initiator_user_id::text AS initiator, (l.detail->>'systemProxy')::boolean AS proxy
          FROM approval_instances i JOIN approval_instance_logs l ON l.tenant_id=i.tenant_id AND l.instance_id=i.id
          WHERE i.tenant_id=${w.tenant.id} AND i.business_id=${assessment!.id}::uuid AND l.event='start'`),
      ),
    );
    expect(log).toEqual({ initiator: w.hr.id, proxy: true });
    expect(await w.launchesOf(person.employeeId)).toEqual([
      expect.objectContaining({
        rule_id: rule.id,
        state: 'launched',
        assessment_id: assessment!.id,
        system_proxy: true,
        initiator_user_id: w.hr.id,
      }),
    ]);
    // 员工自评节点的待办是考核对象本人（与手动发起同一审批流程）
    const view = await w.instance(assessment!.id);
    expect(w.pending(view).map((task) => task.assigneeUserId)).toEqual([person.userId]);
  });

  it('再次立即执行、同键重放、当天与次日的每日批次都不重复发起', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'idempotent');
    await w.created(w.body());
    const person = await w.probationer('幂等员工');
    await w.enableSwitch();
    expect((await w.ran()).launched).toHaveLength(1);
    expect((await w.ran()).launched).toEqual([]);
    const key = randomUUID();
    const once = await w.ran(key);
    expect(await w.ran(key)).toEqual(once);
    // 每日批次（北京 04:00 后）：当天已由立即执行发起，不重复；批次的结果不含当天已发起的人
    expect(await w.batch(TODAY_BATCH)).toMatchObject({ ran: true, launched: [], failed: [] });
    // 同一业务日只占用一次批次
    expect(await w.batch(TODAY_BATCH)).toMatchObject({ ran: false });
    // 次日：第 31 天，不再命中
    expect(await w.batch('2026-10-01T20:30:00.000Z')).toMatchObject({ ran: true, launched: [], failed: [] });
    expect(await w.assessmentsOf(person.employeeId)).toHaveLength(1);
  });

  it('每日批次：本地 04:00 前不跑、总开关关闭不占批次；打开后下一次调度即补跑当天，并发起', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'batch');
    await w.created(w.body());
    const person = await w.probationer('批次员工');
    // 北京 02:00（UTC 前一天 18:00），业务日 10-01，仍未到 04:00
    expect(await w.batch('2026-09-30T18:00:00.000Z')).toMatchObject({ ran: false });
    expect(await w.batch(TODAY_BATCH)).toMatchObject({ ran: false });
    await w.enableSwitch();
    const run = await w.batch(TODAY_BATCH);
    expect(run).toMatchObject({ ran: true, businessDate: '2026-10-01', failed: [] });
    expect(run.launched).toHaveLength(1);
    expect(await w.assessmentsOf(person.employeeId)).toHaveLength(1);
  });
});

describe('AC-PB-11 单条启停（DEC-533②）与规则变更（PB-R22）', () => {
  it('停用的规则不命中、不发起；重新启用后恢复；其他启用规则照常命中', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'toggle');
    const rule = await w.created(w.body({ name: '停用后恢复', priority: 1 }));
    const person = await w.probationer('启停员工');
    await w.enableSwitch();
    const stopped = await w.setEnabled(rule.id, rule.revision, false);
    expect(await w.ran()).toMatchObject({ launched: [], failed: [] });
    expect(await w.assessmentsOf(person.employeeId)).toEqual([]);
    await w.setEnabled(rule.id, stopped.revision, true);
    expect((await w.ran()).launched).toHaveLength(1);
  });

  it('同日多条规则到期（P2-2）：按优先级逐条办理——优先级最小者发起，其余经 PB-R20 记失败与台账，重试次数累计', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'priority');
    const low = await w.created(w.body({ name: '低优先', priority: 9, assessmentType: 'regularization' }));
    const high = await w.created(w.body({ name: '高优先', priority: 2, assessmentType: 'probation' }));
    const person = await w.probationer('优先级员工');
    await w.enableSwitch();
    const receipt = await w.ran();
    expect(receipt.launched.map((item) => item.ruleId)).toEqual([high.id]);
    expect(receipt.failed).toEqual([
      { employeeId: person.employeeId, ruleId: low.id, reason: 'AUTO_ASSESSMENT_CYCLE_CONFLICT' },
    ]);
    expect((await w.assessmentsOf(person.employeeId)).map((row) => row.assessment_name)).toEqual(['高优先']);
    const ledger = () =>
      w.launchesOf(person.employeeId).then((rows) => rows.sort((a, b) => a.state.localeCompare(b.state)));
    expect(await ledger()).toEqual([
      expect.objectContaining({ rule_id: low.id, state: 'failed', assessment_id: null, attempts: 1 }),
      expect.objectContaining({ rule_id: high.id, state: 'launched', attempts: 1 }),
    ]);
    // 同日再执行：已发起的只跳过它自己，失败的那条重试、次数累计，不重复发起
    const again = await w.ran();
    expect(again.launched).toEqual([]);
    expect(again.failed.map((item) => item.ruleId)).toEqual([low.id]);
    expect(await ledger()).toEqual([
      expect.objectContaining({ rule_id: low.id, state: 'failed', attempts: 2 }),
      expect.objectContaining({ rule_id: high.id, state: 'launched', attempts: 1 }),
    ]);
    expect(await w.assessmentsOf(person.employeeId)).toHaveLength(1);
  });

  it('删除规则不影响已发起的考核与台账（PB-R22）', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'delete-keeps');
    const rule = await w.created(w.body());
    const person = await w.probationer('删除规则员工');
    await w.enableSwitch();
    expect((await w.ran()).launched).toHaveLength(1);
    const removed = await w.emp('DELETE', `/auto-assessment-rules/${rule.id}`, { ifMatch: rule.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await w.assessmentsOf(person.employeeId)).toHaveLength(1);
    expect((await w.launchesOf(person.employeeId))[0]).toMatchObject({ state: 'launched', rule_id: rule.id });
  });

  it('适用组织：规则只命中所选组织（含下级）里的试用员工；已转正（非试用）的员工不是适用对象', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'scope');
    const other = await w.org(`其他部门-${randomUUID()}`);
    await w.created(w.body({ orgIds: [other] }));
    const outside = await w.probationer('范围外员工');
    await w.enableSwitch();
    expect(await w.ran()).toMatchObject({ launched: [], failed: [] });
    expect(await w.assessmentsOf(outside.employeeId)).toEqual([]);
  });
});

describe('PB-R20 自动考核的失败条件与发起人', () => {
  it('本周期有审批中的转正申请：失败记台账（原因、次数），不发起；转正申请被驳回不算条件', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'r20-reg');
    const rule = await w.created(w.body());
    const person = await w.probationer('有转正申请员工');
    await w.enableSwitch();
    const submitted = await w.regularizeRaw(person, 'application');
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    const receipt = await w.ran();
    expect(receipt.launched).toEqual([]);
    expect(receipt.failed).toEqual([
      { employeeId: person.employeeId, ruleId: rule.id, reason: 'AUTO_ASSESSMENT_CYCLE_CONFLICT' },
    ]);
    expect(await w.assessmentsOf(person.employeeId)).toEqual([]);
    expect(await w.launchesOf(person.employeeId)).toEqual([
      expect.objectContaining({ state: 'failed', assessment_id: null, last_reason: 'AUTO_ASSESSMENT_CYCLE_CONFLICT' }),
    ]);
    // 同一天再执行重试（DEC-052），次数累计
    expect((await w.ran()).failed).toHaveLength(1);
    expect((await w.launchesOf(person.employeeId))[0]).toMatchObject({ attempts: 2 });
  });

  it('本周期有审批中的考核（不论类型）：失败，不再发第二条', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'r20-assessment');
    await w.created(w.body({ assessmentType: 'regularization' }));
    const person = await w.probationer('有考核员工');
    await w.enableSwitch();
    await w.launch('probation', person);
    const receipt = await w.ran();
    expect(receipt.failed.map((item) => item.reason)).toEqual(['AUTO_ASSESSMENT_CYCLE_CONFLICT']);
    expect(await w.assessmentsOf(person.employeeId)).toHaveLength(1);
  });

  it('上一条考核已被驳回 / 作废不算失败条件，仍照常发起', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'r20-closed');
    await w.created(w.body());
    const person = await w.probationer('已驳回员工');
    await w.enableSwitch();
    await w.seedAssessment(person.employeeId, { type: 'probation', status: 'rejected' });
    await w.seedAssessment(person.employeeId, { type: 'regularization', status: 'cancelled' });
    expect((await w.ran()).launched).toHaveLength(1);
  });

  it('发起人（主职部门 HRBP）找不到：失败记原因 INITIATOR_NOT_FOUND，不留考核；补上 HRBP 后同日再执行成功', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'initiator');
    const rule = await w.created(w.body({ initiatorType: 'department_hrbp' }));
    const person = await w.probationer('找不到发起人员工');
    await w.enableSwitch();
    const receipt = await w.ran();
    expect(receipt.failed).toEqual([{ employeeId: person.employeeId, ruleId: rule.id, reason: 'INITIATOR_NOT_FOUND' }]);
    expect(await w.assessmentsOf(person.employeeId)).toEqual([]);
    const hrbp = await w.person('部门 HRBP', w.department);
    await w.setOrgRoles(w.department, { hrbp: hrbp.employeeId });
    const retried = await w.ran();
    expect(retried.launched).toHaveLength(1);
    expect((await w.assessmentsOf(person.employeeId))[0]).toMatchObject({ initiator_user_id: hrbp.userId });
    expect((await w.launchesOf(person.employeeId))[0]).toMatchObject({ state: 'launched', attempts: 2 });
  });
});

describe('权限与续跑游标（同自动转正立即执行）', () => {
  it('立即执行要任职设置配置写权限：无权 403，不发起；续跑游标须是本人签发的句柄', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'auth');
    await w.created(w.body());
    const person = await w.probationer('无权员工');
    await w.enableSwitch();
    const denied = tenantApi(w.db, {
      authorize: (request) => request.action !== 'tenant.employment.configuration.write',
      clock: () => new Date(TODAY_BATCH),
    });
    const forbidden = await denied.request('POST', '/api/tenant/employment/auto-assessment/run', {
      tenant: w.tenant.id,
      user: w.hr.id,
      ifMatch: 0,
      body: {},
    });
    expect(forbidden.status, await forbidden.clone().text()).toBe(403);
    const badCursor = await w.runNow(undefined, { cursor: randomUUID() });
    expect(badCursor.status).toBe(400);
    expect((await errorOf(badCursor)).details?.reason).toBe('AUTO_RUN_CURSOR_INVALID');
    expect((await w.runNow(undefined, { unknown: 1 })).status).toBe(400);
    expect(await w.assessmentsOf(person.employeeId)).toEqual([]);
  });
});
