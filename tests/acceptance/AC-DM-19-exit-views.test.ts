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
import {
  EXIT_FILTER_DEPENDENCIES,
  EXIT_RESPONSE_DEPENDENCIES,
  EXIT_SORT_DEPENDENCIES,
  EXIT_VIEWS,
  exitDetailPayload,
  type ExitDetailPayload,
  listExitView,
  loadExitDetail,
  trimExit,
  type ExitItem,
} from '../../apps/api/src/modules/employment/exit-queries.js';
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

type Row = { id: string };
/** 与 SQL 一致的完整比较器：主键 + id 次序键（in_progress 升序 / completed 降序 / all 创建时间降序）。 */
const byId = (a: Row, b: Row) => a.id.localeCompare(b.id);
const ascending = (keyOf: (id: string) => string) => (a: Row, b: Row) =>
  keyOf(a.id).localeCompare(keyOf(b.id)) || byId(a, b);
const descending = (keyOf: (id: string) => string) => (a: Row, b: Row) =>
  keyOf(b.id).localeCompare(keyOf(a.id)) || byId(a, b);
const descendingThenIdDesc = (keyOf: (id: string) => string) => (a: Row, b: Row) =>
  keyOf(b.id).localeCompare(keyOf(a.id)) || byId(b, a);

/**
 * 造到“id 升序的顺序”不等于任何有权用户会看到的完整顺序为止（id 是随机 UUID，保证参照记录能区分两种排序）；
 * 判断用与 SQL 一致的完整比较器（含 id 次序键），不是只比主键。
 */
async function distinguishable(
  make: (day: string) => Promise<Row>,
  days: string[],
  designed: (a: Row, b: Row) => number,
) {
  const made: Row[] = [];
  for (let index = 0; index < 12; index += 1) {
    made.push(await make(days[index % days.length]!));
    if (made.length < 3) continue;
    const blind = [...made].sort(byId).map((item) => item.id);
    const sighted = [...made].sort(designed).map((item) => item.id);
    if (JSON.stringify(blind) !== JSON.stringify(sighted)) return made.map((item) => item.id);
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
      ascending((id) => dates.get(id)!),
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
      descending((id) => dates.get(id)!),
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
      descendingThenIdDesc((id) => String(created.get(id)).padStart(3, '0')),
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

// ---- 第 3 轮（#409 审查 P2-A / P2-B）：嵌套字段按路径裁剪；status 筛选纳入筛选字段查看权 --------------------------------

/** 叶子路径（数组元素用 [] 合并）；null 也是叶子。 */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap((item) => leafPaths(item, `${prefix}[]`)))];
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([key, item]) => leafPaths(item, prefix ? `${prefix}.${key}` : key));
  return [prefix];
}
const isNested = (path: string) => /[.[]/.test(path);

/** 嵌套叶子路径 → 它自己的字段编码（任职记录字段目录）。 */
const NESTED: [string, string][] = [
  ['versions[].versionNo', 'versionNo'],
  ['versions[].createdAt', 'createdAt'],
  ['versions[].effectiveDate', 'effectiveDate'],
  ['versions[].plannedEffectiveDate', 'effectiveDate'],
  ['versions[].lastWorkDate', 'lastWorkDate'],
  ['events[].state', 'status'],
  ['events[].createdAt', 'createdAt'],
  ['cancellation.id', 'id'],
  ['cancellation.stateBefore', 'status'],
  ['cancellation.case', 'status'],
  ['cancellation.revision', 'revision'],
  ['cancellation.createdAt', 'createdAt'],
  ['dutyTransfer.timing', 'dutyTransferTiming'],
  ['dates.planned.lastWorkDate', 'lastWorkDate'],
  ['dates.final.lastWorkDate', 'lastWorkDate'],
  ['dates.planned.effectiveDate', 'effectiveDate'],
  ['dates.final.effectiveDate', 'effectiveDate'],
];
/** 没有自己的字段编码、只作容器内说明的叶子：行可见即可见（撤销原因 / 类型、事件序号、效果汇总、转交件数）。 */
const CONTAINER_ONLY = [
  'events[].eventNo',
  'cancellation.reason',
  'effects[].phase',
  'effects[].kind',
  'effects[].count',
  'dutyTransfer.transferred',
  'dutyTransfer.failed',
];

async function nestedWorld(label: string) {
  const x = await world(label);
  const made = await x.exit('嵌套员工', '2026-10-20', 'direct', { exit: { exitTypeCode: 'voluntary' } });
  const t = x.w.session.tenant.id;
  await x.run(sql`INSERT INTO exit_effects(tenant_id,business_id,employee_id,phase,kind,target_type,target_id,
      command_id) VALUES (${t},${made.id}::uuid,${made.employee.id}::uuid,'confirmed','duty_transferred',
      'employment_record',gen_random_uuid(),'fx')`);
  await x.force(made.id, 'voided');
  await x.cancellation(made.id, made.employee.id, '撤销原因', '2026-10-06T03:00:00Z');
  const as = (fields: readonly string[]) => x.w.restricted(denyButtons(), undefined, fields);
  const detailOf = async (api: Api) => (await (await api('GET', `/exits/${made.id}`)).json()) as DetailBody;
  const rowOf = async (api: Api) =>
    ((await (await api('GET', '/exits?view=cancellations')).json()) as ViewPage).items[0]!;
  return { x, made, as, detailOf, rowOf };
}

describe('AC-DM-19 嵌套字段按路径裁剪（第 3 轮 P2-A，设计 §9.1）', () => {
  it('嵌套叶子要么登记了自己的字段编码，要么是明确的容器叶子（新增嵌套键不能默认放行）', async () => {
    const { x, as, detailOf, rowOf } = await nestedWorld('views-nested-catalog');
    const full = as(FULL);
    const known = new Set([...NESTED.map(([path]) => path), ...CONTAINER_ONLY]);
    const listed = (await rowOf(full)) as object;
    const nested = [...leafPaths(await detailOf(full)), ...leafPaths(listed)].filter(isNested);
    expect(nested.filter((path) => !known.has(path))).toEqual([]);
    expect(
      NESTED.every(([path]) => nested.includes(path)),
      '登记的路径都真实出现',
    ).toBe(true);
    expect(x.ids(await x.view('cancellations'))).toHaveLength(1);
  });

  it('真实角色逐个撤掉嵌套键对应的字段权：该路径在详情（和列表的撤销信息）里不再出现，其余路径保留', async () => {
    const { as, detailOf, rowOf } = await nestedWorld('views-nested-revoke');
    const full = as(FULL);
    const fullDetail = leafPaths(await detailOf(full)).filter(isNested);
    const fullRow = leafPaths(await rowOf(full)).filter(isNested);
    for (const code of new Set(NESTED.map(([, field]) => field))) {
      const viewer = as(FULL.filter((field) => field !== code));
      const gone = NESTED.filter(([, field]) => field === code).map(([path]) => path);
      const label = `撤掉 ${code}`;
      expect(leafPaths(await detailOf(viewer)).filter(isNested), label).toEqual(
        fullDetail.filter((path) => !gone.includes(path)),
      );
      expect(leafPaths(await rowOf(viewer)).filter(isNested), label).toEqual(
        fullRow.filter((path) => !gone.includes(path)),
      );
    }
  });
});

describe('AC-DM-19 状态筛选需要状态字段的查看权（第 3 轮 P2-B）', () => {
  it('无 status 字段权：离职中 / 全部视图按 status 筛选都在查询前 403，有权照常；不带 status 不受影响', async () => {
    const x = await world('views-status-filter');
    const draft = await x.exit('草稿', '2026-10-20');
    await x.exit('审批通过', '2026-10-25', 'direct');
    const hidden = x.w.restricted(
      denyButtons(),
      undefined,
      FULL.filter((field) => field !== 'status'),
    );
    const sighted = x.w.restricted(denyButtons(), undefined, FULL);
    for (const view of ['all', 'in_progress'])
      for (const status of ['approved', 'draft', 'rejected']) {
        const label = `${view} status=${status}`;
        const blocked = await hidden('GET', `/exits?view=${view}&status=${status}`);
        expect(blocked.status, label).toBe(403);
        expect(await blocked.clone().text(), label).not.toContain('"total"');
        expect((await sighted('GET', `/exits?view=${view}&status=${status}`)).status, label).toBe(200);
      }
    expect(x.ids(await x.view('all', '&status=draft', sighted))).toEqual([draft.id]);
    expect((await hidden('GET', '/exits?view=all')).status).toBe(200);
  });
});

// ---- 第 4 轮（#409 审查 P2 两项）：由状态派生的值与撤销视图排序同样受字段权约束 --------------------------------------

describe('AC-DM-19 派生值与撤销视图排序（第 4 轮）', () => {
  it('无 status 字段权：撤销信息的 case（由撤销前状态决定，§7.1）在列表与详情里都不返回；有权照常', async () => {
    const x = await world('views-case');
    const made = await x.exit('派生员工', '2026-10-20', 'direct');
    await x.force(made.id, 'voided');
    await x.cancellation(made.id, made.employee.id, '原因', '2026-10-06T03:00:00Z');
    const viewer = (fields: readonly string[]) => x.w.restricted(denyButtons(), undefined, fields);
    const seen = async (api: Api) => ({
      detail: ((await (await api('GET', `/exits/${made.id}`)).json()) as { cancellation: object }).cancellation,
      row: ((await (await api('GET', '/exits?view=cancellations')).json()) as ViewPage).items[0]!.cancellation,
    });
    const blind = await seen(viewer(FULL.filter((field) => field !== 'status')));
    for (const cancellation of [blind.detail, blind.row]) {
      expect(cancellation).not.toHaveProperty('case');
      expect(cancellation).not.toHaveProperty('stateBefore');
      expect(JSON.stringify(cancellation)).not.toContain('approved');
      expect(cancellation).toMatchObject({ reason: '原因' });
    }
    const sighted = await seen(viewer(FULL));
    expect(sighted.detail).toMatchObject({ case: 'approved_voided', stateBefore: 'approved' });
    expect(sighted.row).toMatchObject({ case: 'approved_voided' });
  });

  it('撤销视图：没有创建时间查看权时不按撤销时间排序，改按业务 id；有权保留撤销时间降序（含参照记录）', async () => {
    const x = await world('views-sort-cancel');
    const cancelledAt = new Map<string, string>();
    let counter = 0;
    const ids = await distinguishable(
      async (day) => {
        const made = await x.exit(`撤销序${counter}`, day);
        await x.force(made.id, 'voided');
        const at = `2026-10-06T0${(counter % 8) + 1}:00:00Z`;
        await x.cancellation(made.id, made.employee.id, `原因${counter}`, at);
        cancelledAt.set(made.id, at);
        counter += 1;
        return made;
      },
      ['2026-10-20'],
      descendingThenIdDesc((id) => cancelledAt.get(id)!),
    );
    const viewer = (fields: readonly string[]) => x.w.restricted(denyButtons(), undefined, fields);
    const order = async (api: Api) => (await x.view('cancellations', '&pageSize=50', api)).items.map((i) => i.id);
    expect(await order(viewer(FULL.filter((field) => field !== 'createdAt')))).toEqual([...ids].sort());
    const designed = ids
      .map((id) => ({ id }))
      .sort(descendingThenIdDesc((id) => cancelledAt.get(id)!))
      .map((row) => row.id);
    expect(await order(viewer(FULL))).toEqual(designed);
  });
});

// ---- 字段依赖表守卫（#409 第 4 轮，DEC-431①）：派生 / 排序 / 筛选依赖的字段只在一张表里登记 ----------------------------

/** 一份数据 / 样本里没有在依赖表登记的路径（默认拒绝：叶子、容器、数组与数组元素都必须登记）。 */
function unregisteredPaths(
  value: unknown,
  table: Readonly<Record<string, unknown>> = EXIT_RESPONSE_DEPENDENCIES,
  path = '',
): string[] {
  const own = path && !(path in table) ? [path] : [];
  if (Array.isArray(value))
    return [...own, ...value.flatMap((item) => unregisteredPaths(item, table, path ? `${path}[]` : ''))];
  if (value && typeof value === 'object')
    return [
      ...own,
      ...Object.entries(value).flatMap(([key, item]) => unregisteredPaths(item, table, path ? `${path}.${key}` : key)),
    ];
  return own;
}

/** 样本里的全部路径（叶子、容器、数组、数组元素），不依赖数据里有没有子项。 */
function allPaths(value: unknown, path = ''): string[] {
  const own = path ? [path] : [];
  if (Array.isArray(value)) return [...own, ...value.flatMap((item) => allPaths(item, path ? `${path}[]` : ''))];
  if (value && typeof value === 'object')
    return [...own, ...Object.entries(value).flatMap(([key, item]) => allPaths(item, path ? `${path}.${key}` : key))];
  return own;
}

/**
 * 按响应类型枚举路径（不按数据）：样本用 satisfies 绑定到 ExitItem / ExitDetailPayload，类型里新增 / 改名任何字段
 * 这里都编译不过，必须补样本；样本里每个数组带一个元素、每个可空对象取对象形态，所以空数组、未填写这类“数据里没有
 * 子路径”的情形也在枚举之内。
 */
const ITEM_SAMPLE = {
  id: '',
  employeeId: '',
  code: '',
  name: '',
  departmentId: null,
  positionId: null,
  lastWorkDate: '',
  plannedLastWorkDate: '',
  effectiveDate: '',
  exitTypeCode: null,
  exitTypeName: null,
  reasonCode: null,
  reasonName: null,
  whereaboutsCode: null,
  whereaboutsName: null,
  status: 'approved',
  mode: 'direct',
  initiator: 'hr',
  initiatorUserId: '',
  batchId: null,
  revision: 1,
  createdAt: '',
  activation: {
    status: 'failed',
    reason: null,
    blockedByBusinessId: null,
    details: {
      title: '离职暂无法生效',
      message: '',
      hiddenCount: 0,
      actions: ['查看记录', '关闭'],
      records: [{ docId: '', docNo: '', bizType: 'regularization', effectiveDate: '2026-10-20' }],
    },
  },
  cancellation: { id: '', reason: '', case: '', stateBefore: '', revision: 1, createdAt: '' },
} satisfies ExitItem;
const DETAIL_SAMPLE = {
  ...ITEM_SAMPLE,
  attachmentRefs: [''],
  handoverEmployeeId: null,
  addToBlacklist: false,
  compensationAmount: null,
  nonCompeteAmount: null,
  lastPayDate: null,
  socialInsuranceEndMonth: null,
  annualLeaveSettled: null,
  taxPeriod: null,
  taxYear: null,
  employerName: null,
  actualLeaveDate: null,
  dutyTransferTiming: '',
  preReleaseDate: null,
  versions: [{ versionNo: 1, effectiveDate: '', plannedEffectiveDate: '', lastWorkDate: null, createdAt: '' }],
  events: [{ eventNo: 1, state: '', createdAt: '' }],
  approvalInstanceId: null,
  effects: [{ phase: '', kind: '', count: 1 }],
  dutyTransfer: { timing: '', transferred: 0, failed: 0 },
  dates: {
    planned: { lastWorkDate: '', effectiveDate: '' },
    final: { lastWorkDate: '', effectiveDate: '' },
  },
} satisfies ExitDetailPayload;

describe('AC-DM-19 字段依赖表守卫', () => {
  it('不依赖任何受控字段的叶子必须写明理由；依赖的字段都在字段目录里（防拼错）', () => {
    for (const [path, rule] of Object.entries(EXIT_RESPONSE_DEPENDENCIES)) {
      if (rule.field === null) expect(rule.why.trim().length, `${path} 缺“不派生自受控字段”的理由`).toBeGreaterThan(8);
      else expect(FULL, `${path} 依赖的字段 ${rule.field}`).toContain(rule.field);
    }
    for (const view of EXIT_VIEWS)
      for (const field of EXIT_SORT_DEPENDENCIES[view].anyOf)
        expect(FULL, `${view} 排序依赖 ${field}`).toContain(field);
    for (const [filter, rule] of Object.entries(EXIT_FILTER_DEPENDENCIES))
      for (const field of [...(rule.employee ?? []), ...(rule.employment ?? [])])
        expect(FULL, `筛选 ${filter} 依赖 ${field}`).toContain(field);
  });

  it('响应里的每个叶子（含全字段权的完整响应）都登记了依赖：顶层键是字段目录里的字段、派生名或已登记，嵌套叶子必须在表里', async () => {
    const { x, as, detailOf, rowOf } = await nestedWorld('views-guard');
    const full = as(FULL);
    const leaves = [...leafPaths(await detailOf(full)), ...leafPaths(await rowOf(full))];
    const unregistered = leaves.filter((path) =>
      isNested(path)
        ? !(path in EXIT_RESPONSE_DEPENDENCIES)
        : !(path in EXIT_RESPONSE_DEPENDENCIES) && !FULL.includes(path),
    );
    expect(unregistered).toEqual([]);
    expect(x.ids(await x.view('all'))).toHaveLength(1);
  });

  it('新增的嵌套叶子没有登记依赖字段时一律不输出（fail-closed），即使查看人字段权不受限', () => {
    const everything = { employee: () => true, employment: () => true };
    const item = {
      id: randomUUID(),
      status: 'voided',
      cancellation: { reason: 'r', newSecretLeaf: 'x' },
      newTopLevelButRegisteredNowhereNested: { inner: 1 },
    } as unknown as ExitItem;
    const out = trimExit(item, everything) as { cancellation: object };
    expect(out.cancellation).toEqual({ reason: 'r' });
    expect(out).not.toHaveProperty('newTopLevelButRegisteredNowhereNested');
  });
});

// ---- 第 5 轮（#409 审查 P2）：容器整体按依赖字段判权，无权时键缺席（不留空对象泄露存在性）；守卫检查裁剪前的路径 ----------

describe('AC-DM-19 容器整体判权（第 5 轮）', () => {
  it('无 activation 字段权：失败 / 挂起 / 无尝试三类单在列表与详情里形状一致（均无 activation 键）；有权时正常返回', async () => {
    const x = await world('views-activation-container');
    const failed = await x.exit('失败单', '2026-10-25', 'direct');
    await x.attempt(failed.id, failed.employee.id, 'failed', 'REBUILD_REQUIRED');
    const suspended = await x.exit('挂起单', '2026-10-26', 'direct');
    const blocker = await x.w.synthetic(suspended.employee.id, {
      kind: 'transfer',
      state: 'approved',
      effectiveDate: '2026-10-10',
    });
    await x.attempt(suspended.id, suspended.employee.id, 'suspended', 'PREDECESSOR_FAILED', blocker);
    const plain = await x.exit('无尝试单', '2026-10-27', 'direct');
    const viewer = (fields: readonly string[]) => x.w.restricted(denyButtons(), undefined, fields);
    const shapes = async (api: Api) => {
      const rows = new Map((await x.view('in_progress', '&pageSize=50', api)).items.map((item) => [item.id, item]));
      const details = new Map<string, Record<string, unknown>>();
      for (const made of [failed, suspended, plain])
        details.set(made.id, (await (await api('GET', `/exits/${made.id}`)).json()) as Record<string, unknown>);
      return [failed, suspended, plain].map((made) => ({ row: rows.get(made.id)!, detail: details.get(made.id)! }));
    };
    for (const { row, detail } of await shapes(viewer(FULL.filter((field) => field !== 'activation')))) {
      expect(row).not.toHaveProperty('activation');
      expect(detail).not.toHaveProperty('activation');
    }
    const blindShapes = await shapes(viewer(FULL.filter((field) => field !== 'activation')));
    expect(new Set(blindShapes.map(({ row }) => keysOf(row).join())).size, '列表三类形状一致').toBe(1);
    expect(new Set(blindShapes.map(({ detail }) => keysOf(detail).join())).size, '详情三类形状一致').toBe(1);
    const [f, s2, p2] = await shapes(viewer(FULL));
    expect(f!.row.activation).toMatchObject({ status: 'failed', reason: 'REBUILD_REQUIRED' });
    expect(f!.detail.activation).toMatchObject({ status: 'failed' });
    expect(s2!.row.activation).toMatchObject({ status: 'suspended', blockedByBusinessId: blocker });
    expect(p2!.row.activation).toBeNull();
    expect(p2!.detail.activation).toBeNull();
  });

  it('其他嵌套容器同理：容器内叶子全部无权时整个容器缺席，不留 [] / {} 暴露条数或存在性', async () => {
    const { as, detailOf } = await nestedWorld('views-container-empty');
    const noVersions = await detailOf(
      as(FULL.filter((f) => !['versionNo', 'createdAt', 'effectiveDate', 'lastWorkDate'].includes(f))),
    );
    expect(noVersions).not.toHaveProperty('versions');
    expect(noVersions).not.toHaveProperty('dates');
    const noDates = await detailOf(as(FULL.filter((f) => f !== 'effectiveDate' && f !== 'lastWorkDate')));
    expect(noDates).not.toHaveProperty('dates');
    expect(JSON.stringify(noDates)).not.toContain('"dates"');
  });

  it('按响应类型枚举：列表项与详情的每个路径（含数组、数组元素、容器）都在依赖表登记，表里没有多余登记；去掉登记或新增未登记的数组字段会判红', () => {
    const paths = [...new Set([...allPaths(ITEM_SAMPLE), ...allPaths(DETAIL_SAMPLE)])];
    expect(
      paths.filter((path) => !(path in EXIT_RESPONSE_DEPENDENCIES)),
      '类型里有、表里没登记',
    ).toEqual([]);
    expect(
      Object.keys(EXIT_RESPONSE_DEPENDENCIES).filter((path) => !paths.includes(path)),
      '表里有、类型样本里没有（拼错或多余）',
    ).toEqual([]);
    // 变异一：去掉 attachmentRefs 登记（容器与元素）
    const withoutAttachment = Object.fromEntries(
      Object.entries(EXIT_RESPONSE_DEPENDENCIES).filter(([path]) => !path.startsWith('attachmentRefs')),
    );
    expect(unregisteredPaths(DETAIL_SAMPLE, withoutAttachment).sort()).toEqual(['attachmentRefs', 'attachmentRefs[]']);
    // 变异二：类型 / 样本里新增一个数据为空数组的字段、一个嵌套数组
    const grown = {
      ...DETAIL_SAMPLE,
      newList: [] as string[],
      effects: [{ ...DETAIL_SAMPLE.effects[0], newItems: [] }],
    };
    expect(unregisteredPaths(grown).sort()).toEqual(['effects[].newItems', 'newList']);
  });

  it('裁剪前的输出路径（含容器）都登记了依赖：未登记的嵌套叶子或容器会让守卫判红（含注入 cancellation.newSecretLeaf 的变异）', async () => {
    const { x } = await nestedWorld('views-guard-pre');
    const failed = await x.exit('失败单', '2026-10-25', 'direct');
    await x.attempt(failed.id, failed.employee.id, 'failed', 'REBUILD_REQUIRED');
    const t = x.w.session.tenant.id;
    const all = { employee: () => true, employment: () => true };
    const pre = await withTenant(database().db, t, async (tx) => {
      const page = { page: 1, pageSize: 50, limit: 50, offset: 0 };
      const rows = (await listExitView(tx, t, { view: 'all', page, filter: {}, show: all }, undefined)).items;
      const details = [];
      for (const row of rows) details.push(exitDetailPayload((await loadExitDetail(tx, t, row.id, undefined))!));
      return { rows, details };
    });
    // 数据里确实有撤销信息、生效失败标记、效果台账，守卫看得到这些容器
    expect(leafPaths(pre.details).some((path) => path.includes('cancellation.'))).toBe(true);
    expect(leafPaths(pre.details).some((path) => path.includes('activation.'))).toBe(true);
    expect(unregisteredPaths(pre.rows)).toEqual([]);
    expect(unregisteredPaths(pre.details)).toEqual([]);
    // 变异：加入未登记的嵌套叶子 / 嵌套容器，守卫必须报出
    const voided = pre.details.findIndex((detail) => detail.cancellation);
    const leafMutant = structuredClone(pre.details);
    (leafMutant[voided]!.cancellation as Record<string, unknown>).newSecretLeaf = 'x';
    expect(unregisteredPaths(leafMutant)).toEqual(['cancellation.newSecretLeaf']);
    const containerMutant = structuredClone(pre.details);
    (containerMutant[voided]!.cancellation as Record<string, unknown>).extra = { inner: 1 };
    expect(unregisteredPaths(containerMutant)).toEqual(['cancellation.extra', 'cancellation.extra.inner']);
    // 数据为空数组的新字段也要报出（空容器没有子路径，仍按容器自身路径检查）
    const emptyArrayMutant = structuredClone(pre.details);
    (emptyArrayMutant[voided] as Record<string, unknown>).newEmptyArray = [];
    expect(unregisteredPaths(emptyArrayMutant)).toEqual(['newEmptyArray']);
  });
});

// ---- 第 6 轮（#409 审查 P2）：默认拒绝——没有登记依赖的路径一律不输出，空数组 / 未填写也不例外 --------------------------

describe('AC-DM-19 默认拒绝与附件（第 6 轮）', () => {
  it('无 attachmentRefs 字段权：空数组 / 非空 / 未填写三类在详情里形状一致（均无该键）；有权时原样返回', async () => {
    const x = await world('views-attachments');
    const empty = await x.exit('空附件', '2026-10-20', 'application', { exit: { attachmentRefs: [] } });
    const refs = [randomUUID()];
    const filled = await x.exit('有附件', '2026-10-21', 'application', { exit: { attachmentRefs: refs } });
    const unset = await x.exit('未填附件', '2026-10-22');
    const viewer = (fields: readonly string[]) => x.w.restricted(denyButtons(), undefined, fields);
    const detail = async (api: Api, id: string) =>
      (await (await api('GET', `/exits/${id}`)).json()) as Record<string, unknown>;
    const blind = viewer(FULL.filter((field) => field !== 'attachmentRefs'));
    const shapes = [];
    for (const made of [empty, filled, unset]) {
      const seen = await detail(blind, made.id);
      expect(seen, made.id).not.toHaveProperty('attachmentRefs');
      shapes.push(keysOf(seen).join());
    }
    expect(new Set(shapes).size, '三类形状一致').toBe(1);
    const sighted = viewer(FULL);
    expect((await detail(sighted, empty.id)).attachmentRefs).toEqual([]);
    expect((await detail(sighted, filled.id)).attachmentRefs).toEqual(refs);
    expect((await detail(sighted, unset.id)).attachmentRefs).toBeNull();
  });

  it('默认拒绝：生产输出里临时多出未登记的标量 / 空数组 / 空对象 / 嵌套数组，裁剪后都不出现（即使字段权不受限）', () => {
    const everything = { employee: () => true, employment: () => true };
    const item = {
      id: randomUUID(),
      status: 'approved',
      newScalar: 1,
      newEmptyArray: [],
      newEmptyObject: {},
      newNullable: null,
      cancellation: { reason: 'r', nestedEmpty: [] },
    } as unknown as ExitItem;
    const out = trimExit(item, everything) as Record<string, unknown>;
    expect(out).toMatchObject({ status: 'approved' });
    for (const key of ['newScalar', 'newEmptyArray', 'newEmptyObject', 'newNullable'])
      expect(out, key).not.toHaveProperty(key);
    expect(out.cancellation).toEqual({ reason: 'r' });
  });
});
