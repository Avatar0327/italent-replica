/**
 * R2-T03 B5 / AC-DM-19（视图部分）：离职四视图与详情（设计 §3.2 / §5.0A D-14 / §9.1；测试 B-29、B-66）。
 * 视图谓词只读申请单 / 状态事件 / 扩展行 / 撤销记录；分页前按 DEC-177 可见谓词过滤（总数不含范围外的单）；
 * 字段按查看人裁剪（无字段权的字段缺席而不是 null）；“原定”最后工作日 = 计划生效日（§5.0A）− 1 天。
 * 未实现的状态（B3 生效、B4 撤销）在本批由测试直接写状态事件 / 撤销记录造数，视图对没有数据的状态返回空集。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyButtons, gateWorld, type GateWorld } from './AC-EXIT-gate-support.js';

const database = useTestDb();
type Api = GateWorld['session']['request'];

interface ViewItem {
  id: string;
  employeeId: string;
  status: string;
  [key: string]: unknown;
}
interface ViewPage {
  items: ViewItem[];
  total: number;
  page: number;
  pageSize: number;
}

async function world(label: string) {
  const w = await gateWorld(database().db, label);
  const t = w.session.tenant.id;
  const run = (statement: ReturnType<typeof sql>) => withTenant(database().db, t, (tx) => tx.execute(statement));

  /** 经专用入口新建离职：application → draft，direct（最后工作日在今天之后或已过）→ approved。 */
  async function exit(
    name: string,
    lastWorkDate: string,
    mode: 'application' | 'direct' = 'application',
    options: { exit?: object; api?: Api; departmentId?: string } = {},
  ) {
    const { employee } = await hire(name, options.departmentId);
    const { revision } = await w.session.getEmployee(employee.id);
    const api = options.api ?? w.session.request;
    const response = await api('POST', `/exits/employees/${employee.id}`, {
      ifMatch: revision,
      body: { mode, lastWorkDate, ...(options.exit ? { exit: options.exit } : {}) },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const created = (await response.json()) as { id: string; revision: number };
    return { employee, ...created };
  }
  async function hire(name: string, departmentId?: string) {
    if (!departmentId) return w.hired(name);
    const employee = await w.session.employee(name);
    const business = await w.session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId } },
      employee.revision,
    );
    return { employee, hire: business };
  }
  /** 在最新载荷版本上追加一条状态事件（B3 / B4 前公开入口不能产生这些状态，造数直接写）。 */
  const force = (businessId: string, state: string) =>
    run(sql`INSERT INTO employment_state_events(tenant_id,employee_id,business_id,payload_version_id,state,event_no,
        command_id)
      SELECT p.tenant_id,p.employee_id,p.business_id,p.id,${state},
        (SELECT coalesce(max(e.event_no),0)+1 FROM employment_state_events e
          WHERE e.tenant_id=p.tenant_id AND e.business_id=p.business_id),${`force-${randomUUID()}`}
      FROM employment_payload_versions p WHERE p.tenant_id=${t} AND p.business_id=${businessId}::uuid
      ORDER BY p.version_no DESC LIMIT 1`);
  const cancellation = (businessId: string, employeeId: string, reason: string, createdAt: string) =>
    run(sql`INSERT INTO exit_cancellations(tenant_id,business_id,employee_id,state_before,cancel_case,reason,
        command_id,actor_user_id,created_at)
      VALUES (${t},${businessId}::uuid,${employeeId}::uuid,'approved','approved_voided',${reason},
        ${`cancel-${randomUUID()}`},${w.session.user.id}::uuid,${createdAt}::timestamptz)`);
  const attempt = (
    businessId: string,
    employeeId: string,
    outcome: 'failed' | 'suspended',
    reason: string,
    blockedBy?: string,
  ) =>
    run(sql`INSERT INTO employment_activation_attempts(tenant_id,employee_id,business_id,attempt_no,outcome,reason,
        blocked_by_business_id,business_date,trigger,command_id)
      VALUES (${t},${employeeId}::uuid,${businessId}::uuid,1,${outcome},${reason},${blockedBy ?? null},
        '2026-10-06','scheduler',${`attempt-${randomUUID()}`})`);
  async function view(name: string, query = '', api: Api = w.session.request) {
    const response = await api('GET', `/exits?view=${name}${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as ViewPage;
  }
  const ids = (page: ViewPage) => page.items.map((item) => item.id);
  return { w, run, exit, hire, force, cancellation, attempt, view, ids };
}
type World = Awaited<ReturnType<typeof world>>;

interface DetailBody {
  [key: string]: unknown;
  events: { state: string }[];
  versions: { versionNo: number }[];
  approvalInstanceId: string | null;
}

/** 八种最新状态各一单：draft / in_review / approved / rejected / disapproved / voided / deleted / effective。 */
async function allStates(x: World) {
  const draft = await x.exit('草稿员工', '2026-10-20');
  const review = await x.exit('审批中员工', '2026-10-22');
  const submitted = await x.w.session.request('POST', `/exits/${review.id}/submit`, {
    ifMatch: review.revision,
    body: {},
  });
  expect(submitted.status, await submitted.clone().text()).toBe(200);
  const approved = await x.exit('审批通过员工', '2026-10-25', 'direct');
  const rejected = await x.exit('驳回员工', '2026-10-21');
  await x.force(rejected.id, 'rejected');
  const disapproved = await x.exit('不同意员工', '2026-10-23');
  await x.force(disapproved.id, 'disapproved');
  const voided = await x.exit('作废员工', '2026-10-24');
  await x.force(voided.id, 'voided');
  await x.cancellation(voided.id, voided.employee.id, '员工撤回意向', '2026-10-05T02:00:00Z');
  const deleted = await x.exit('删除员工', '2026-10-26');
  await x.force(deleted.id, 'deleted');
  await x.cancellation(deleted.id, deleted.employee.id, '重复办理', '2026-10-06T02:00:00Z');
  const { employee } = await x.w.hired('已生效员工');
  const effective = await x.w.effectiveExit(employee.id, '2026-10-01');
  return { draft, review, approved, rejected, disapproved, voided, deleted, effective: { ...effective, employee } };
}

describe('AC-DM-19 离职视图谓词（B-29 / B-66）', () => {
  it('离职中 / 已完成 / 全部 / 撤销四个视图谓词互斥，作废与删除不在离职中，总数一致', async () => {
    const x = await world('views-predicates');
    const s = await allStates(x);
    const inProgress = await x.view('in_progress');
    expect(x.ids(inProgress).sort()).toEqual([s.draft.id, s.review.id, s.approved.id, s.rejected.id].sort());
    expect(inProgress.total).toBe(4);
    expect(inProgress.items.map((item) => item.status).sort()).toEqual(['approved', 'draft', 'in_review', 'rejected']);
    const completed = await x.view('completed');
    expect(x.ids(completed)).toEqual([s.effective.id]);
    expect(completed.total).toBe(1);
    const all = await x.view('all');
    expect(all.total).toBe(8);
    expect(x.ids(all).sort()).toEqual(
      Object.values(s)
        .map((item) => item.id)
        .sort(),
    );
    const cancelled = await x.view('cancellations');
    expect(x.ids(cancelled)).toEqual([s.deleted.id, s.voided.id]);
    // 互斥：同一单不会同时出现在离职中与已完成
    expect(x.ids(inProgress).filter((id) => x.ids(completed).includes(id))).toEqual([]);
  });

  it('默认排序：离职中按最后工作日升序，已完成按最后工作日降序，撤销按撤销时间降序，全部按创建时间降序', async () => {
    const x = await world('views-order');
    const s = await allStates(x);
    expect((await x.view('in_progress')).items.map((item) => item.lastWorkDate)).toEqual([
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-25',
    ]);
    const second = await x.w.hired('第二个已生效');
    await x.w.effectiveExit(second.employee.id, '2026-10-03');
    expect((await x.view('completed')).items.map((item) => item.lastWorkDate)).toEqual(['2026-10-03', '2026-10-01']);
    expect(x.ids(await x.view('cancellations'))).toEqual([s.deleted.id, s.voided.id]);
  });

  it('全部离职记录按创建时间降序', async () => {
    const x = await world('views-order-all');
    const early = await x.exit('先创建', '2026-10-20');
    x.w.setNow('2026-10-06T05:00:00.000Z');
    const late = await x.exit('后创建', '2026-10-19');
    expect(x.ids(await x.view('all'))).toEqual([late.id, early.id]);
  });

  it('生效失败 / 挂起仍为审批通过的单留在离职中并带标记；其余状态没有标记', async () => {
    const x = await world('views-activation');
    const failed = await x.exit('失败员工', '2026-10-25', 'direct');
    await x.attempt(failed.id, failed.employee.id, 'failed', 'REBUILD_REQUIRED');
    const suspended = await x.exit('挂起员工', '2026-10-26', 'direct');
    const blocker = await x.w.synthetic(suspended.employee.id, {
      kind: 'transfer',
      state: 'approved',
      effectiveDate: '2026-10-10',
    });
    await x.attempt(suspended.id, suspended.employee.id, 'suspended', 'PREDECESSOR_FAILED', blocker);
    const plain = await x.exit('正常员工', '2026-10-27', 'direct');
    const items = new Map((await x.view('in_progress')).items.map((item) => [item.id, item]));
    expect(items.get(failed.id)).toMatchObject({
      status: 'approved',
      activation: { status: 'failed', reason: 'REBUILD_REQUIRED' },
    });
    expect(items.get(suspended.id)).toMatchObject({
      activation: { status: 'suspended', reason: 'PREDECESSOR_FAILED', blockedByBusinessId: blocker },
    });
    expect(items.get(plain.id)!.activation).toBeNull();
  });

  it('撤销视图带撤销信息，可按撤销时间排序；未实现的状态对应的视图返回空集而不是报错', async () => {
    const x = await world('views-cancel');
    const empty = await x.view('completed');
    expect(empty).toMatchObject({ items: [], total: 0 });
    const s = await allStates(x);
    const cancelled = await x.view('cancellations');
    expect(cancelled.items[0]).toMatchObject({
      id: s.deleted.id,
      status: 'deleted',
      cancellation: { reason: '重复办理', case: 'approved_voided', stateBefore: 'approved', revision: 1 },
    });
    expect(cancelled.items[1]).toMatchObject({ id: s.voided.id, cancellation: { reason: '员工撤回意向' } });
    expect((await x.view('in_progress')).items.every((item) => item.cancellation === null)).toBe(true);
  });
});

describe('AC-DM-19 离职视图筛选（B-66）', () => {
  it('关键字（姓名 / 工号）、部门含下级、最后工作日区间、类型 / 原因 / 去向、审批状态、发起方式各一例', async () => {
    const x = await world('views-filters');
    const child = await x.w.session.org('子部门', {
      establishedOn: '2026-01-01',
      parents: { admin: { parentId: x.w.from.id } },
    });
    const first = await x.exit('张筛选', '2026-10-20', 'application', {
      exit: { exitTypeCode: 'voluntary', reasonCode: 'personal', whereaboutsCode: 'startup' },
    });
    const second = await x.exit('李筛选', '2026-10-28', 'direct', {
      departmentId: child.id,
      exit: { exitTypeCode: 'involuntary', reasonCode: 'family', whereaboutsCode: 'same_industry' },
    });
    const query = async (text: string) => x.ids(await x.view('all', text));
    expect(await query('&keyword=张筛')).toEqual([first.id]);
    const code = (await x.w.session.getEmployee(second.employee.id)).code;
    expect(await query(`&keyword=${encodeURIComponent(code.toLowerCase())}`)).toEqual([second.id]);
    expect(await query('&keyword=%25')).toEqual([]);
    // 部门默认含下级：选父部门两人都在，选子部门只有李；includeChildren=false 只看本部门
    expect((await query(`&departmentId=${x.w.from.id}`)).sort()).toEqual([first.id, second.id].sort());
    expect(await query(`&departmentId=${child.id}`)).toEqual([second.id]);
    expect(await query(`&departmentId=${x.w.from.id}&includeChildren=false`)).toEqual([first.id]);
    expect(await query('&lastWorkDateFrom=2026-10-25')).toEqual([second.id]);
    expect(await query('&lastWorkDateTo=2026-10-25')).toEqual([first.id]);
    expect(await query('&exitTypeCode=voluntary')).toEqual([first.id]);
    expect(await query('&reasonCode=family')).toEqual([second.id]);
    expect(await query('&whereaboutsCode=startup')).toEqual([first.id]);
    expect(await query('&status=approved')).toEqual([second.id]);
    expect(await query('&status=draft')).toEqual([first.id]);
    expect(await query('&initiation=direct')).toEqual([second.id]);
    expect(await query('&initiation=hr')).toEqual([first.id]);
    expect((await x.view('all', '&keyword=张筛&status=approved')).total).toBe(0);
  });

  it('非法参数 400：未知视图、非法日期、审批状态只用于离职中 / 全部视图、分页越界', async () => {
    const x = await world('views-invalid');
    const status = async (path: string) => (await x.w.session.request('GET', path)).status;
    expect(await status('/exits')).toBe(400);
    expect(await status('/exits?view=unknown')).toBe(400);
    expect(await status('/exits?view=all&lastWorkDateFrom=2026-13-40')).toBe(400);
    expect(await status('/exits?view=all&lastWorkDateFrom=2026-10-30&lastWorkDateTo=2026-10-01')).toBe(400);
    expect(await status('/exits?view=completed&status=approved')).toBe(400);
    expect(await status('/exits?view=cancellations&status=approved')).toBe(400);
    expect(await status('/exits?view=all&status=effectivee')).toBe(400);
    expect(await status('/exits?view=all&initiation=robot')).toBe(400);
    expect(await status('/exits?view=all&departmentId=not-a-uuid')).toBe(400);
    expect(await status('/exits?view=all&pageSize=0')).toBe(400);
  });

  it('分页：total 是过滤后的总数，翻页不重不漏，越界页返回空 items 与同一 total', async () => {
    const x = await world('views-paging');
    const made = [];
    for (const day of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'])
      made.push(await x.exit(`分页${day}`, day));
    const pages = [
      await x.view('in_progress', '&pageSize=2&page=1'),
      await x.view('in_progress', '&pageSize=2&page=2'),
      await x.view('in_progress', '&pageSize=2&page=3'),
    ];
    expect(pages.map((page) => page.total)).toEqual([5, 5, 5]);
    expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1]);
    expect(pages.flatMap((page) => x.ids(page))).toEqual(made.map((item) => item.id));
    const beyond = await x.view('in_progress', '&pageSize=2&page=9');
    expect(beyond).toMatchObject({ items: [], total: 5, page: 9, pageSize: 2 });
  });
});

describe('AC-DM-19 离职视图权限与范围', () => {
  it('分页前按可见范围过滤：范围外的单不出现、总数不含，详情范围外 404；看全部的人两单都见', async () => {
    const x = await world('views-scope');
    const mine = await x.exit('本人创建', '2026-10-20');
    const other = await x.w.otherUser();
    const theirs = await x.exit('他人创建', '2026-10-21', 'application', { api: x.w.asUser(other.id) });
    const hr = x.w.restricted(denyButtons(), other.id);
    const seen = await x.view('all', '', hr);
    expect(x.ids(seen)).toEqual([theirs.id]);
    expect(seen.total).toBe(1);
    expect((await hr('GET', `/exits/${theirs.id}`)).status).toBe(200);
    const outside = await hr('GET', `/exits/${mine.id}`);
    expect(outside.status).toBe(404);
    expect(await outside.clone().text()).not.toContain('本人创建');
    expect((await x.view('all')).total).toBe(2);
  });

  it('没有任职记录查看权 403；不同租户的离职单互不可见', async () => {
    const x = await world('views-perm');
    const mine = await x.exit('租户甲员工', '2026-10-20');
    const deny: Authorizer = (request) => request.action !== 'object.view';
    const none = x.w.restricted(deny);
    expect((await none('GET', '/exits?view=all')).status).toBe(403);
    expect((await none('GET', `/exits/${mine.id}`)).status).toBe(403);
    const other = await world('views-perm-other');
    const theirs = await other.exit('租户乙员工', '2026-10-20');
    expect(x.ids(await x.view('all'))).toEqual([mine.id]);
    expect(other.ids(await other.view('all'))).toEqual([theirs.id]);
    expect((await x.w.session.request('GET', `/exits/${theirs.id}`)).status).toBe(404);
  });

  it('字段裁剪：无补偿金 / 竞业金字段权 → 两字段缺席（不是 null）；无姓名 / 部门权 → 缺席，且不能按它们筛选（403）', async () => {
    const x = await world('views-fields');
    const made = await x.exit('裁剪员工', '2026-10-20', 'direct', {
      exit: { compensationAmount: 1000, nonCompeteAmount: 500, reasonCode: 'personal', exitTypeCode: 'voluntary' },
    });
    const base = ['id', 'employeeId', 'effectiveDate', 'status', 'revision', 'lastWorkDate', 'name', 'code'];
    const full = x.w.restricted(denyButtons(), undefined, [
      ...base,
      'departmentId',
      'reasonCode',
      'exitTypeCode',
      'compensationAmount',
      'nonCompeteAmount',
    ]);
    const detail = (await (await full('GET', `/exits/${made.id}`)).json()) as Record<string, unknown>;
    expect(detail).toMatchObject({ compensationAmount: 1000, nonCompeteAmount: 500, reasonCode: 'personal' });
    const trimmed = x.w.restricted(denyButtons(), undefined, [...base, 'reasonCode', 'exitTypeCode']);
    const slim = (await (await trimmed('GET', `/exits/${made.id}`)).json()) as Record<string, unknown>;
    expect(slim).toMatchObject({ id: made.id, reasonCode: 'personal', lastWorkDate: '2026-10-20' });
    expect(slim).not.toHaveProperty('compensationAmount');
    expect(slim).not.toHaveProperty('nonCompeteAmount');
    expect(slim).not.toHaveProperty('departmentId');
    const row = (await x.view('all', '', trimmed)).items[0]!;
    expect(row).not.toHaveProperty('departmentId');
    expect(row).toHaveProperty('name');
    const noName = x.w.restricted(denyButtons(), undefined, ['id', 'employeeId', 'status', 'revision', 'lastWorkDate']);
    const bare = (await x.view('all', '', noName)).items[0]!;
    expect(bare).not.toHaveProperty('name');
    expect(bare).not.toHaveProperty('code');
    expect(bare).not.toHaveProperty('reasonCode');
    expect((await noName('GET', '/exits?view=all&keyword=裁剪')).status).toBe(403);
    expect((await noName('GET', `/exits?view=all&departmentId=${x.w.from.id}`)).status).toBe(403);
    expect((await noName('GET', '/exits?view=all&reasonCode=personal')).status).toBe(403);
  });
});

describe('AC-DM-19 离职详情（B13）与原定日期（§5.0A，D-14）', () => {
  it('详情含扩展字段、状态事件、审批实例、原定与最终日期；调动单与不存在的单 404', async () => {
    const x = await world('views-detail');
    const made = await x.exit('详情员工', '2026-10-22', 'application', {
      exit: { exitTypeCode: 'voluntary', reasonCode: 'family', compensationAmount: 1200.5, employerName: '合成公司' },
    });
    const submitted = await x.w.session.request('POST', `/exits/${made.id}/submit`, {
      ifMatch: made.revision,
      body: {},
    });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    const detail = (await (await x.w.session.request('GET', `/exits/${made.id}`)).json()) as DetailBody;
    expect(detail).toMatchObject({
      id: made.id,
      status: 'in_review',
      mode: 'application',
      initiator: 'hr',
      lastWorkDate: '2026-10-22',
      plannedLastWorkDate: '2026-10-22',
      effectiveDate: '2026-10-23',
      exitTypeCode: 'voluntary',
      exitTypeName: '主动离职',
      reasonCode: 'family',
      reasonName: '家庭原因',
      employerName: '合成公司',
      dutyTransferTiming: 'business_effective',
    });
    expect(Number(detail.compensationAmount)).toBe(1200.5);
    expect(detail.events.map((event: { state: string }) => event.state)).toEqual(['draft', 'in_review']);
    expect(detail.versions).toHaveLength(1);
    expect(detail.approvalInstanceId).toEqual(expect.any(String));
    expect(detail.effects).toEqual([]);
    const transfer = await x.w.synthetic(made.employee.id, {
      kind: 'transfer',
      state: 'draft',
      effectiveDate: '2026-10-30',
    });
    expect((await x.w.session.request('GET', `/exits/${transfer}`)).status).toBe(404);
    expect((await x.w.session.request('GET', `/exits/${randomUUID()}`)).status).toBe(404);
    expect((await x.w.session.request('GET', '/exits/not-a-uuid')).status).toBe(400);
  });

  it('迟到顺延后：最终最后工作日 / 生效日用最新值，原定最后工作日 = 计划生效日（首次顺延前）− 1 天，不另算', async () => {
    const x = await world('views-planned');
    const made = await x.exit('顺延员工', '2026-10-10', 'direct');
    await x.run(sql`INSERT INTO employment_payload_versions(id,tenant_id,employee_id,business_id,version_no,
        previous_version_id,trigger_business_id,command_id,kind,mode,effective_date,last_work_date,form_id,
        selected_staff_id,employ_type)
      SELECT gen_random_uuid(),p.tenant_id,p.employee_id,p.business_id,p.version_no+1,p.id,p.business_id,
        ${`postpone-${randomUUID()}`},p.kind,p.mode,'2026-10-16'::date,'2026-10-15'::date,p.form_id,
        p.selected_staff_id,p.employ_type
      FROM employment_payload_versions p WHERE p.tenant_id=${x.w.session.tenant.id} AND p.business_id=${made.id}::uuid
      ORDER BY p.version_no DESC LIMIT 1`);
    const [row] = (await x.view('in_progress')).items;
    expect(row).toMatchObject({
      lastWorkDate: '2026-10-15',
      effectiveDate: '2026-10-16',
      plannedLastWorkDate: '2026-10-10',
    });
    const detail = (await (await x.w.session.request('GET', `/exits/${made.id}`)).json()) as DetailBody;
    expect(detail.dates).toEqual({
      planned: { lastWorkDate: '2026-10-10', effectiveDate: '2026-10-11' },
      final: { lastWorkDate: '2026-10-15', effectiveDate: '2026-10-16' },
    });
    expect(detail.versions.map((version: { versionNo: number }) => version.versionNo)).toEqual([1, 2]);
  });

  it('详情的效果台账与职责转交只给汇总件数，不带目标 ID；撤销记录出现在详情里', async () => {
    const x = await world('views-effects');
    const made = await x.exit('效果员工', '2026-10-20');
    const t = x.w.session.tenant.id;
    for (const [phase, kind, target] of [
      ['confirmed', 'establishment_pre_released', 'establishment'],
      ['confirmed', 'duty_transferred', 'employment_record'],
      ['confirmed', 'duty_transferred', 'employment_record'],
      ['confirmed', 'duty_failed', 'employment_record'],
    ] as const)
      await x.run(sql`INSERT INTO exit_effects(tenant_id,business_id,employee_id,phase,kind,target_type,target_id,
          command_id)
        VALUES (${t},${made.id}::uuid,${made.employee.id}::uuid,${phase},${kind},${target},gen_random_uuid(),'fx')`);
    await x.force(made.id, 'voided');
    await x.cancellation(made.id, made.employee.id, '细节', '2026-10-06T03:00:00Z');
    const detail = (await (await x.w.session.request('GET', `/exits/${made.id}`)).json()) as DetailBody;
    expect(detail.effects).toEqual([
      { phase: 'confirmed', kind: 'duty_failed', count: 1 },
      { phase: 'confirmed', kind: 'duty_transferred', count: 2 },
      { phase: 'confirmed', kind: 'establishment_pre_released', count: 1 },
    ]);
    expect(detail.dutyTransfer).toEqual({ timing: 'business_effective', transferred: 2, failed: 1 });
    expect(JSON.stringify(detail)).not.toMatch(/targetId|target_id/);
    expect(detail.cancellation).toMatchObject({ reason: '细节', case: 'approved_voided' });
  });
});

// ---- 第 2 轮（#409 审查 P2-1 / P2-2）：每个响应键按自己的字段编码裁剪；默认排序不泄露隐藏日期的先后 ----------------------------

const CATALOG = MODULE_OBJECTS.employmentRecord.fields.map((field) => field.code);
/** 全字段权：任职记录对象的整份字段目录 + 人员对象的姓名 / 工号。 */
const FULL = [...CATALOG, 'name', 'code'];
/** 响应键与字段目录的对应：派生的显示名跟随编码；这些结构 / 汇总键没有自己的字段编码，行可见即可见。 */
const DERIVED = ['plannedLastWorkDate', 'exitTypeName', 'reasonName', 'whereaboutsName'];
const STRUCTURES = ['cancellation', 'events', 'versions', 'effects', 'approvalInstanceId', 'dutyTransfer', 'dates'];
const keysOf = (value: object) => Object.keys(value).sort();

describe('AC-DM-19 系统字段按各自字段权裁剪（第 2 轮 P2-1，设计 §9.1）', () => {
  it('响应里每个键都是字段目录里的字段、派生显示名或结构键（新增键必须先登记，不能默认放行）', async () => {
    const x = await world('views-catalog');
    const made = await x.exit('目录员工', '2026-10-20', 'direct', { exit: { exitTypeCode: 'voluntary' } });
    const detail = (await (await x.w.session.request('GET', `/exits/${made.id}`)).json()) as DetailBody;
    const row = (await x.view('all')).items[0]!;
    const known = new Set([...FULL, ...DERIVED, ...STRUCTURES]);
    expect(keysOf(detail).filter((key) => !known.has(key))).toEqual([]);
    expect(keysOf(row).filter((key) => !known.has(key))).toEqual([]);
  });

  it('真实角色逐字段撤权：列表与详情里对应的键缺席（含嵌套副本），其余键原样保留', async () => {
    const x = await world('views-revoke');
    const made = await x.exit('撤权员工', '2026-10-20', 'direct', {
      exit: { exitTypeCode: 'voluntary', reasonCode: 'family', whereaboutsCode: 'startup' },
    });
    const get = (api: Api, path: string) => api('GET', path).then((response) => response.json() as Promise<DetailBody>);
    const full = x.w.restricted(denyButtons(), undefined, FULL);
    const fullDetail = await get(full, `/exits/${made.id}`);
    const fullRow = ((await (await full('GET', '/exits?view=all')).json()) as ViewPage).items[0]!;
    expect(fullDetail).toMatchObject({
      initiatorUserId: x.w.session.user.id,
      dutyTransferTiming: 'business_effective',
    });
    expect(fullDetail.preReleaseDate).toEqual(expect.any(String));
    expect(fullDetail.dutyTransfer).toMatchObject({ timing: 'business_effective' });
    const cases: [string, string[]][] = [
      ['initiatorUserId', ['initiatorUserId']],
      ['initiator', ['initiator']],
      ['batchId', ['batchId']],
      ['preReleaseDate', ['preReleaseDate']],
      ['dutyTransferTiming', ['dutyTransferTiming']],
      ['createdAt', ['createdAt']],
      ['activation', ['activation']],
      ['revision', ['revision']],
      ['status', ['status']],
      ['exitTypeCode', ['exitTypeCode', 'exitTypeName']],
      ['reasonCode', ['reasonCode', 'reasonName']],
      ['whereaboutsCode', ['whereaboutsCode', 'whereaboutsName']],
      ['positionId', ['positionId']],
    ];
    for (const [field, absent] of cases) {
      const viewer = x.w.restricted(
        denyButtons(),
        undefined,
        FULL.filter((code) => code !== field),
      );
      const detail = await get(viewer, `/exits/${made.id}`);
      const row = ((await (await viewer('GET', '/exits?view=all')).json()) as ViewPage).items[0]!;
      const label = `撤掉 ${field}`;
      expect(keysOf(detail), label).toEqual(keysOf(fullDetail).filter((key) => !absent.includes(key)));
      expect(keysOf(row), label).toEqual(keysOf(fullRow).filter((key) => !absent.includes(key)));
      if (field === 'dutyTransferTiming') expect(detail.dutyTransfer, label).toEqual({ transferred: 0, failed: 0 });
      if (field === 'status')
        expect(
          detail.events.every((event) => !('state' in event)),
          label,
        ).toBe(true);
      if (field === 'createdAt')
        expect(JSON.stringify([detail.events, detail.versions]), label).not.toContain('createdAt');
    }
  });
});

/** 造到“按 id 升序的顺序”既不等于日期升序也不等于日期降序为止（id 是随机 UUID，保证参照记录能区分两种排序）。 */
async function distinguishable(
  make: (day: string) => Promise<{ id: string }>,
  days: string[],
  datesOf: (id: string) => string,
) {
  const made: { id: string }[] = [];
  for (let index = 0; index < 12; index += 1) {
    made.push(await make(days[index % days.length]!));
    if (made.length < 3) continue;
    const byId = made.map((item) => item.id).sort();
    const asc = [...made].sort((a, b) => datesOf(a.id).localeCompare(datesOf(b.id))).map((item) => item.id);
    if (JSON.stringify(byId) !== JSON.stringify(asc) && JSON.stringify(byId) !== JSON.stringify(asc.toReversed()))
      return made.map((item) => item.id);
  }
  throw new Error('造不出可区分的排序样本');
}

describe('AC-DM-19 默认排序不泄露隐藏字段的先后（第 2 轮 P2-2）', () => {
  it('没有最后工作日 / 生效日查看权：离职中按 id 稳定排序，有任一权限保留按日期升序（含一条已知日期的参照记录）', async () => {
    const x = await world('views-sort');
    const dates = new Map<string, string>();
    let counter = 0;
    const ids = await distinguishable(
      async (day) => {
        const made = await x.exit(`排序${counter++}`, day);
        dates.set(made.id, day);
        return made;
      },
      ['2026-10-20', '2026-10-28', '2026-10-24'],
      (id) => dates.get(id)!,
    );
    const without = (...fields: string[]) =>
      x.w.restricted(
        denyButtons(),
        undefined,
        FULL.filter((code) => !fields.includes(code)),
      );
    const order = async (viewer: Api) => (await x.view('in_progress', '&pageSize=50', viewer)).items.map((i) => i.id);
    const byDate = [...ids].sort((a, b) => dates.get(a)!.localeCompare(dates.get(b)!) || a.localeCompare(b));
    // 看不到任何日期：不能按日期排，响应里也没有日期键
    const blind = without('lastWorkDate', 'effectiveDate');
    expect(await order(blind)).toEqual([...ids].sort());
    expect((await x.view('in_progress', '', blind)).items.some((item) => 'lastWorkDate' in item)).toBe(false);
    // 只要能看到其中一个日期（二者相差一天、先后一致），设计的默认排序保留
    expect(await order(without('effectiveDate'))).toEqual(byDate);
    expect(await order(without('lastWorkDate'))).toEqual(byDate);
    expect(await order(x.w.session.request)).toEqual(byDate);
  });

  it('已完成视图同理：没有日期查看权不按最后工作日降序', async () => {
    const x = await world('views-sort-done');
    const dates = new Map<string, string>();
    let counter = 0;
    const ids = await distinguishable(
      async (day) => {
        const { employee } = await x.w.hired(`已完成${counter++}`);
        const made = await x.w.effectiveExit(employee.id, day);
        dates.set(made.id, day);
        return made;
      },
      ['2026-10-01', '2026-10-03', '2026-10-02'],
      (id) => dates.get(id)!,
    );
    const blind = x.w.restricted(
      denyButtons(),
      undefined,
      FULL.filter((c) => c !== 'lastWorkDate' && c !== 'effectiveDate'),
    );
    const seen = async (viewer: Api) => (await x.view('completed', '&pageSize=50', viewer)).items.map((i) => i.id);
    expect(await seen(blind)).toEqual([...ids].sort());
    expect(await seen(x.w.session.request)).toEqual(
      [...ids].sort((a, b) => dates.get(b)!.localeCompare(dates.get(a)!) || a.localeCompare(b)),
    );
  });

  it('全部离职记录：没有创建时间查看权时不按创建时间排序', async () => {
    const x = await world('views-sort-all');
    const created = new Map<string, number>();
    let counter = 0;
    const ids = await distinguishable(
      async () => {
        x.w.setNow(`2026-10-06T0${(counter % 8) + 1}:00:00.000Z`);
        const made = await x.exit(`创建序${counter}`, '2026-10-20');
        created.set(made.id, counter++);
        return made;
      },
      ['2026-10-20'],
      (id) => String(created.get(id)).padStart(3, '0'),
    );
    const blind = x.w.restricted(
      denyButtons(),
      undefined,
      FULL.filter((code) => code !== 'createdAt'),
    );
    const seen = (await x.view('all', '&pageSize=50', blind)).items.map((item) => item.id);
    expect(seen).toEqual([...ids].sort());
  });
});
