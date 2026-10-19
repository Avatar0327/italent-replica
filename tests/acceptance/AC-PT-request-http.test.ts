/**
 * BE-7 PT-4b 兼职新增申请公开入口（docs/08_设计/R2-T05_兼职设计.md §4.1 / §7.2 / §13.1，§9 PB-32 / PB-57 / PB-75）：
 * POST part-time-requests（requestType = add）与 GET / PATCH / submit / withdraw / revoke / DELETE 的 HTTP 全链路。
 * 开闸边界：延长 / 结束申请已随 PT-4c 开放（AC-PT-date-request-http）；
 * isDepartmentHead = true / 非空 addedSubordinateIds → 400 PART_TIME_LINKAGE_NOT_AVAILABLE（PB-57）。
 * 权限（§7.2）：对象创建 / 更新 / 删除权 → 按钮 → 员工主职 + 兼职部门范围 → 字段写权；提交 / 撤回只允许原发起人（DEC-113）。
 * 日期框架：今天 2026-10-01，主职 2020-01-01 入职；审批走真实审批中心接口。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { PART_TIME_AUDIT_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { auditApi } from './AC-AUD-support.js';
import { denyButton, denyFieldWrite, restricted } from './AC-PT-http-support.js';
import { requestWorld, type RequestWorld } from './AC-PT-request-support.js';
import { orgScope } from './support/revocable-rights.js';

const database = useTestDb();
const TODAY = '2026-10-01';

const world = (label: string) => requestWorld(database().db, `pt4b-${label}`);
const linkage = { status: 400, code: 'VALIDATION_FAILED', reason: 'PART_TIME_LINKAGE_NOT_AVAILABLE' };

/** 经 HTTP 把新增申请建成草稿，返回读形状。 */
async function draft(w: RequestWorld, patch: Record<string, unknown> = {}) {
  return w.ok(await w.http().create({ endDate: '2026-12-31', ...patch }), 201);
}

describe('PB-32 HTTP：新增申请 → 提交 → 四节点 → 通过', () => {
  it('建并提交一步到位（submit = true）；通过前不生成记录，通过后进“未开始”，申请详情带主职 / 员工信息分组', async () => {
    const w = await world('happy');
    const api = w.http();
    const created = await w.ok(await api.create({ startDate: '2026-11-01', endDate: '2026-12-31', submit: true }), 201);
    expect(created).toMatchObject({
      kind: 'add',
      status: 'in_review',
      initiator: 'hr',
      processCode: 'AddParttimeJobProcess',
      serviceType: 'part_time',
      effectiveDate: '2026-11-01',
      endDate: '2026-12-31',
      recordId: null,
      fields: { departmentId: w.side },
    });
    expect(await w.partTimeRecords()).toEqual([]);
    const detail = await w.ok(await api.one(created.id));
    expect(detail).toMatchObject({
      status: 'in_review',
      primary: { fields: { departmentId: w.primary } },
      employee: { name: '兼职员工' },
    });
    await w.approveAll(created.id);
    const landed = await w.ok(await api.one(created.id));
    const [record] = await w.partTimeRecords();
    expect(landed).toMatchObject({ status: 'effective', recordId: record!.id });
    expect(record).toMatchObject({ start_date: '2026-11-01', service_type: 'part_time', department_id: w.side });
    const listed = await w.ok<{ items: { id: string; partTimeView: string[] }[] }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${w.worker.employeeId}/part-times`),
    );
    expect(listed.items).toEqual([
      expect.objectContaining({ id: record!.id, partTimeView: expect.arrayContaining(['not_started']) }),
    ]);
  });

  it('草稿全链路：建 → 改 → 提交 → 撤回；撤销（HR）→ 作废；删除草稿；每一步 If-Match 递进', async () => {
    const w = await world('lifecycle');
    const api = w.http();
    const created = await draft(w);
    expect(created).toMatchObject({ status: 'draft', versionNo: 1, warnings: [] });
    const edited = await w.ok(
      await api.patch(created.id, created.revision, { endDate: '2026-11-30', requestRemark: '备注' }),
    );
    expect(edited).toMatchObject({ status: 'draft', versionNo: 2, endDate: '2026-11-30', requestRemark: '备注' });
    const submitted = await w.ok(await api.act(created.id, 'submit', edited.revision));
    expect(submitted.status).toBe('in_review');
    const withdrawn = await w.ok(await api.act(created.id, 'withdraw', submitted.revision));
    expect(withdrawn.status).toBe('draft');
    const resubmitted = await w.ok(await api.act(created.id, 'submit', withdrawn.revision));
    const revoked = await w.ok(await api.act(created.id, 'revoke', resubmitted.revision));
    expect(revoked.status).toBe('voided');
    expect((await w.states(created.id)).at(-1)).toMatchObject({ state: 'voided', reason: 'hr' });

    const other = await draft(w, { startDate: '2026-09-02' });
    const deleted = await w.ok(await api.remove(other.id, other.revision));
    expect(deleted.status).toBe('deleted');
    expect((await w.ok(await api.one(other.id))).status).toBe('deleted');
  });

  it('写后审计动作进同一事务：create / update / submit / withdraw / revoke / delete', async () => {
    const w = await world('audit-actions');
    const api = w.http();
    const created = await draft(w);
    const edited = await w.ok(await api.patch(created.id, created.revision, { endDate: '2026-11-30' }));
    const submitted = await w.ok(await api.act(created.id, 'submit', edited.revision));
    const withdrawn = await w.ok(await api.act(created.id, 'withdraw', submitted.revision));
    await w.ok(await api.remove(created.id, withdrawn.revision));
    expect(await w.auditActions(created.id)).toEqual(
      ['create', 'delete', 'submit', 'update', 'withdraw'].map((name) => `part_time.request.${name}`),
    );
  });
});

describe('开闸边界：仍关闭的行为必须真关', () => {
  it('requestType 不在三类之内 → 400；缺 requestType → 400', async () => {
    const w = await world('bad-type');
    expect((await w.http().create({ requestType: 'transfer' })).status).toBe(400);
    const body = Object.fromEntries(Object.entries(w.requestBody()).filter(([key]) => key !== 'requestType'));
    const response = await w.request(w.hr.id, 'POST', '/api/tenant/employment/part-time-requests', { body });
    expect(response.status).toBe(400);
  });

  it('PB-57：isDepartmentHead = true / 非空 addedSubordinateIds → 400 LINKAGE_NOT_AVAILABLE，创建与修改都无写入', async () => {
    const w = await world('linkage');
    const api = w.http();
    const before = await w.writes();
    for (const fields of [{ isDepartmentHead: true }, { addedSubordinateIds: [randomUUID()] }])
      expect(await w.refusal(await api.create({ fields })), JSON.stringify(fields)).toMatchObject(linkage);
    expect(await w.writes()).toEqual(before);

    const created = await draft(w);
    const mid = await w.writes();
    for (const fields of [{ isDepartmentHead: true }, { addedSubordinateIds: [randomUUID()] }])
      expect(
        await w.refusal(await api.patch(created.id, created.revision, { fields })),
        JSON.stringify(fields),
      ).toMatchObject(linkage);
    expect(await w.writes()).toEqual(mid);
    // 显式 false / 空数组不是联动请求，照常保存
    const saved = await w.ok(
      await api.patch(created.id, created.revision, { fields: { isDepartmentHead: false, addedSubordinateIds: [] } }),
    );
    expect(saved.versionNo).toBe(2);
  });
});

describe('请求校验与业务拒绝（单一入口：同一套 D-1～D-10 / 周期边界 / 状态机）', () => {
  it('缺 If-Match → 400 REVISION_REQUIRED；过期 revision → 409 REVISION_CONFLICT，不追加版本', async () => {
    const w = await world('revision');
    const api = w.http();
    const created = await draft(w);
    const missing = await w.request(w.hr.id, 'PATCH', `/api/tenant/employment/part-time-requests/${created.id}`, {
      body: { endDate: '2026-11-30' },
    });
    expect(await w.refusal(missing)).toMatchObject({ status: 400, code: 'REVISION_REQUIRED' });
    expect(await w.refusal(await api.patch(created.id, created.revision + 5, { endDate: '2026-11-30' }))).toMatchObject(
      {
        status: 409,
        code: 'REVISION_CONFLICT',
      },
    );
    expect((await w.load(created.id)).version.versionNo).toBe(1);
  });

  it('请求体严格：未知键 / 非法日期 / 缺部门 → 400；结束日早于开始日 → 400 PART_TIME_END_BEFORE_START，无写入', async () => {
    const w = await world('validation');
    const api = w.http();
    const before = await w.writes();
    expect((await api.create({ unknown: 1 })).status).toBe(400);
    expect((await api.create({ startDate: '2026-02-30' })).status).toBe(400);
    expect((await api.create({ fields: { departmentId: 'x' } })).status).toBe(400);
    expect(await w.refusal(await api.create({ startDate: '2026-09-10', endDate: '2026-09-01' }))).toMatchObject({
      status: 400,
      reason: 'PART_TIME_END_BEFORE_START',
    });
    expect(await w.writes()).toEqual(before);
  });

  it('周期边界（PB-63 HTTP 版）：主职已离职（L = 09-15）时结束日越界 → 409 PART_TIME_BEYOND_EXIT，创建不留申请头，修改不留版本', async () => {
    const w = await world('boundary');
    await w.leave('2026-09-15');
    const api = w.http();
    const before = await w.writes();
    const refused = await w.refusal(await api.create({ startDate: '2026-09-01', endDate: '2026-09-20' }));
    expect(refused).toMatchObject({ status: 409, reason: 'PART_TIME_BEYOND_EXIT' });
    expect(await w.writes()).toEqual(before);
    const created = await w.ok(await api.create({ startDate: '2026-09-01', endDate: '2026-09-15' }), 201);
    const patched = await w.refusal(await api.patch(created.id, created.revision, { endDate: '2026-09-20' }));
    expect(patched).toMatchObject({ status: 409, reason: 'PART_TIME_BEYOND_EXIT' });
    expect((await w.load(created.id)).version.versionNo).toBe(1);
  });

  it('状态机：审批中不能直接修改 / 删除；草稿不能撤回；已作废不能再撤销，都是 409 PART_TIME_REQUEST_STATE_INVALID', async () => {
    const w = await world('state');
    const api = w.http();
    const created = await draft(w);
    const submitted = await w.ok(await api.act(created.id, 'submit', created.revision));
    const stale = { status: 409, code: 'CONFLICT', reason: 'PART_TIME_REQUEST_STATE_INVALID' };
    expect(await w.refusal(await api.patch(created.id, submitted.revision, { endDate: '2026-11-30' }))).toEqual(stale);
    expect(await w.refusal(await api.remove(created.id, submitted.revision))).toEqual(stale);
    const withdrawn = await w.ok(await api.act(created.id, 'withdraw', submitted.revision));
    expect(await w.refusal(await api.act(created.id, 'withdraw', withdrawn.revision))).toEqual(stale);
    const voided = await w.ok(await api.act(created.id, 'revoke', withdrawn.revision));
    expect(await w.refusal(await api.act(created.id, 'revoke', voided.revision))).toEqual(stale);
  });

  it('提交与撤回只允许原发起人（DEC-113）：其他有权限的 HR 提交 / 撤回 → 403 PART_TIME_NOT_INITIATOR；撤销与删除不限发起人', async () => {
    const w = await world('initiator');
    const other = w.sendWith(() => true, await w.member('另一位HR'));
    const created = await draft(w);
    const notInitiator = { status: 403, code: 'FORBIDDEN', reason: 'PART_TIME_NOT_INITIATOR' };
    expect(await w.refusal(await w.http(other).act(created.id, 'submit', created.revision))).toEqual(notInitiator);
    const submitted = await w.ok(await w.http().act(created.id, 'submit', created.revision));
    expect(await w.refusal(await w.http(other).act(created.id, 'withdraw', submitted.revision))).toEqual(notInitiator);
    const revoked = await w.ok(await w.http(other).act(created.id, 'revoke', submitted.revision));
    expect(revoked.status).toBe('voided');
    const second = await draft(w, { startDate: '2026-09-02' });
    expect((await w.ok(await w.http(other).remove(second.id, second.revision))).status).toBe('deleted');
  });

  it('不存在的申请 → 404（GET / PATCH / 动作 / DELETE 同一口径）；非 UUID → 400', async () => {
    const w = await world('missing');
    const api = w.http();
    const id = randomUUID();
    for (const response of [
      await api.one(id),
      await api.patch(id, 1, { endDate: '2026-11-30' }),
      await api.act(id, 'submit', 1),
      await api.act(id, 'withdraw', 1),
      await api.act(id, 'revoke', 1),
      await api.remove(id, 1),
    ])
      expect((await w.refusal(response)).status).toBe(404);
    expect((await api.one('not-a-uuid')).status).toBe(400);
    // 员工不存在：建申请同样 404，不留任何写入
    const before = await w.writes();
    expect((await w.refusal(await api.create({ employeeId: randomUUID() }))).status).toBe(404);
    expect(await w.writes()).toEqual(before);
  });
});

describe('权限（§7.2）：对象权 → 按钮 → 范围 → 字段权', () => {
  const noButton = (code: string) => restricted({ deny: denyButton(code) });
  const as = (w: RequestWorld, authorize: Authorizer) => w.http(w.sendWith(authorize));

  it('创建需要 Employment.PartTimeApproval；字段写权（endDate）与 Employment.PartTime（直接新增）互不替代', async () => {
    const w = await world('perm-create');
    const before = await w.writes();
    expect((await as(w, noButton('Employment.PartTimeApproval')).create()).status).toBe(403);
    // 建并提交一步到位时，提交按钮也要有；只建草稿不要求
    expect((await as(w, noButton('Employment.Submit')).create({ submit: true })).status).toBe(403);
    expect(
      (await as(w, restricted({ deny: denyFieldWrite('endDate') })).create({ endDate: '2026-12-31' })).status,
    ).toBe(403);
    expect(
      (await as(w, restricted({ deny: denyFieldWrite('requestRemark') })).create({ requestRemark: '备注' })).status,
    ).toBe(403);
    expect(await w.writes()).toEqual(before);
    // 没写被禁字段时放行
    expect((await as(w, restricted({ deny: denyFieldWrite('endDate') })).create({ endDate: undefined })).status).toBe(
      201,
    );
    expect((await as(w, noButton('Employment.Submit')).create({ startDate: '2026-09-02' })).status).toBe(201);
  });

  it('提交 / 撤回 / 删除各需要同名按钮（Employment.Submit / Withdraw / Delete）与创建同一按钮；撤销只需 Employment.Revoke', async () => {
    const w = await world('perm-actions');
    const api = w.http();
    const created = await draft(w);
    const denySubmit = as(w, noButton('Employment.Submit'));
    expect((await denySubmit.act(created.id, 'submit', created.revision)).status).toBe(403);
    expect(
      (await as(w, noButton('Employment.PartTimeApproval')).act(created.id, 'submit', created.revision)).status,
    ).toBe(403);
    const submitted = await w.ok(await api.act(created.id, 'submit', created.revision));
    expect((await as(w, noButton('Employment.Withdraw')).act(created.id, 'withdraw', submitted.revision)).status).toBe(
      403,
    );
    expect(
      (await as(w, noButton('Employment.PartTimeApproval')).patch(created.id, 1, { endDate: '2026-11-30' })).status,
    ).toBe(403);
    // 撤销不要求创建按钮
    const revoked = await w.ok(
      await as(w, noButton('Employment.PartTimeApproval')).act(created.id, 'revoke', submitted.revision),
    );
    expect(revoked.status).toBe('voided');
    expect((await as(w, noButton('Employment.Revoke')).act(created.id, 'revoke', revoked.revision)).status).toBe(403);
    const other = await draft(w, { startDate: '2026-09-02' });
    expect((await as(w, noButton('Employment.Delete')).remove(other.id, other.revision)).status).toBe(403);
  });

  it('数据范围：员工主职与兼职部门缺一不可；范围外与不存在同一个 404；GET 按 DEC-177 任一部门可见', async () => {
    const w = await world('perm-scope');
    const created = await draft(w);
    const elsewhere = await w.org(`他处部门${randomUUID()}`);
    const scoped = (...orgs: string[]) => as(w, restricted({ scope: orgScope(w.tenant.id, TODAY, ...orgs) }));
    const before = await w.writes();
    // 兼职部门在范围外（只管主职部门）
    expect((await scoped(w.primary).create()).status).toBe(404);
    // 员工主职在范围外（只管兼职部门）：员工看不见
    expect((await scoped(w.side).create()).status).toBe(404);
    expect((await scoped(elsewhere).create()).status).toBe(404);
    expect(await w.writes()).toEqual(before);
    // 申请的写动作按写入口径：兼职部门 + 员工主职都要在范围
    expect((await scoped(w.primary).patch(created.id, created.revision, { endDate: '2026-11-30' })).status).toBe(404);
    expect((await scoped(w.primary).act(created.id, 'submit', created.revision)).status).toBe(404);
    expect((await scoped(w.primary).remove(created.id, created.revision)).status).toBe(404);
    expect(
      (await scoped(w.primary, w.side).patch(created.id, created.revision, { endDate: '2026-11-30' })).status,
    ).toBe(200);
    // 范围外与不存在同一个 404、同一文案
    const message = async (response: Response) =>
      ((await response.json()) as { error: { message: string } }).error.message;
    const gone = await message(await scoped(w.primary, w.side).patch(randomUUID(), 1, { endDate: '2026-11-30' }));
    expect(await message(await scoped(elsewhere).patch(created.id, created.revision, { endDate: '2026-11-30' }))).toBe(
      gone,
    );
    expect(await message(await scoped(w.primary).patch(created.id, created.revision, { endDate: '2026-11-30' }))).toBe(
      gone,
    );
    // 读：员工主职部门或申请部门任一在范围内可见；都不在 → 404
    expect((await scoped(w.primary).one(created.id)).status).toBe(200);
    expect((await scoped(w.side).one(created.id)).status).toBe(200);
    expect((await scoped(elsewhere).one(created.id)).status).toBe(404);
  });

  it('改兼职部门：新部门也要在范围内（PATCH fields.departmentId）', async () => {
    const w = await world('perm-move');
    const created = await draft(w);
    const elsewhere = await w.org(`新兼职部门${randomUUID()}`);
    const scoped = w.http(w.sendWith(restricted({ scope: orgScope(w.tenant.id, TODAY, w.primary, w.side) })));
    expect((await scoped.patch(created.id, created.revision, { fields: { departmentId: elsewhere } })).status).toBe(
      404,
    );
    expect((await w.load(created.id)).version.departmentId).toBe(w.side);
  });
});

describe('PB-75：兼职申请日志对兼职部门 HR 可见（HTTP 创建的申请）', () => {
  const AT = `${TODAY}T01:00:00.000Z`;
  function viewer(w: RequestWorld, orgIds: string[]) {
    const authorize: Authorizer = () => true;
    registerScopeProvider(authorize, {
      scope: async () => orgScope(w.tenant.id, TODAY, ...orgIds),
      authorize: async () => true,
      fields: async () => new Set(['departmentId', 'endDate', 'place']),
    });
    return auditApi(w.db, AT, { authorize });
  }
  const seen = async (w: RequestWorld, orgIds: string[]) => {
    const page = await viewer(w, orgIds).dataChanges(
      { tenant: w.tenant.id, user: w.hr.id },
      { objectType: PART_TIME_AUDIT_OBJECTS.request },
    );
    return page.items.map((row) => row.action).sort();
  };

  it('只管兼职部门的 HR 看得到申请的新增 / 修改日志；只管主职部门的 HR 也看得到（员工当前主职）；无关部门看不到', async () => {
    const w = await world('audit-view');
    const created = await draft(w);
    const edited = await w.ok(await w.http().patch(created.id, created.revision, { endDate: '2026-11-30' }));
    await w.ok(await w.http().act(created.id, 'submit', edited.revision));
    // 只改状态的动作（提交等）前后值里没有这位查看人可看的字段，按字段权限裁剪后不出现在其数据变更日志里
    const expected = ['part_time.request.create', 'part_time.request.update'];
    expect(await seen(w, [w.side])).toEqual(expected);
    expect(await seen(w, [w.primary])).toEqual(expected);
    expect(await seen(w, [await w.org(`无关部门${randomUUID()}`)])).toEqual([]);
    const [row] = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ org: string }>(
        await tx.execute(sql`SELECT scope_org_id::text AS org FROM audit_events WHERE tenant_id=${w.tenant.id}
          AND object_id=${created.id} AND action='part_time.request.create'`),
      ),
    );
    expect(row!.org).toBe(w.side);
  });
});
