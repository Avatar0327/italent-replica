/**
 * BE-7 PT-4c 延长 / 结束申请公开入口（docs/08_设计/R2-T05_兼职设计.md §4.1 / §4.4 / §7.2 / §13.1，§9 PB-33 / 35 / 41 / 57）：
 * POST part-time-requests（requestType = extend / end）与既有 GET / PATCH / submit / withdraw / revoke / DELETE 对延长 / 结束申请的
 * HTTP 全链路。开闸要真开：extend / end 不再 409 PART_TIME_REQUEST_TYPE_NOT_AVAILABLE；仍关的行为要真关：
 * isDepartmentHead = true / 非空 addedSubordinateIds → 400 PART_TIME_LINKAGE_NOT_AVAILABLE（PB-57，至 PT-7）。
 * 权限（§7.2）：对象更新权（不是创建权）→ 延长 / 结束按钮 → 兼职记录的兼职部门范围 → endDate / requestRemark 字段写权；
 * 同一兼职有未办结申请时直接改结束日期 / 批量结束 409（PB-41）。日期框架：今天 2026-10-01。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyAction, denyButton, denyFieldWrite, restricted } from './AC-PT-http-support.js';
import { requestWorld, type RequestWorld } from './AC-PT-request-support.js';
import { orgScope } from './support/revocable-rights.js';

const database = useTestDb();
const TODAY = '2026-10-01';
const EMPLOYMENT = '/api/tenant/employment';

const world = (label: string) => requestWorld(database().db, `pt4c-http-${label}`);
const linkage = { status: 400, code: 'VALIDATION_FAILED', reason: 'PART_TIME_LINKAGE_NOT_AVAILABLE' };

const dateBody = (requestType: 'extend' | 'end', recordId: string, patch: Record<string, unknown> = {}) => ({
  requestType,
  recordId,
  endDate: requestType === 'extend' ? '2026-12-31' : '2026-09-20',
  ...patch,
});
const as = (w: RequestWorld, authorize: Authorizer) => w.http(w.sendWith(authorize));
const noButton = (code: string) => restricted({ deny: denyButton(code) });

/** 经 HTTP 把延长 / 结束申请建成草稿。 */
async function draft(w: RequestWorld, requestType: 'extend' | 'end', recordId: string, patch = {}) {
  return w.ok(await w.http().createDate(dateBody(requestType, recordId, patch)), 201);
}

describe('开闸：延长 / 结束申请的 HTTP 全链路', () => {
  it('延长：建草稿 → 读详情（kind / 目标记录 / 原定结束日期）→ 修改 → 提交 → 四节点通过 → 同一条记录结束日更新', async () => {
    const w = await world('extend-chain');
    const api = w.http();
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await draft(w, 'extend', record, { requestRemark: '合成备注' });
    expect(created).toMatchObject({
      kind: 'extend',
      status: 'draft',
      initiator: 'hr',
      processCode: 'ExtendParttimeJobProcess',
      recordId: record,
      serviceType: 'part_time',
      effectiveDate: '2026-09-01',
      endDate: '2026-12-31',
      originalEndDate: '2026-10-31',
      requestRemark: '合成备注',
      fields: { departmentId: w.side },
      warnings: [],
    });
    const detail = await w.ok(await api.one(created.id));
    expect(detail).toMatchObject({
      kind: 'extend',
      recordId: record,
      originalEndDate: '2026-10-31',
      primary: { fields: { departmentId: w.primary } },
      employee: { name: '兼职员工' },
    });
    const edited = await w.ok(await api.patch(created.id, created.revision, { endDate: '2027-01-31' }));
    expect(edited).toMatchObject({
      status: 'draft',
      versionNo: 2,
      endDate: '2027-01-31',
      originalEndDate: '2026-10-31',
    });
    const submitted = await w.ok(await api.act(created.id, 'submit', edited.revision));
    expect(submitted.status).toBe('in_review');
    await w.approveInOrder(created.id, w.order.extend);
    const landed = await w.ok(await api.one(created.id));
    expect(landed).toMatchObject({ status: 'effective', recordId: record, endDate: '2027-01-31' });
    expect(await w.terms(record)).toEqual([
      { term_no: 1, end_date: '2026-10-31', source: 'create', source_id: null },
      { term_no: 2, end_date: '2027-01-31', source: 'extend', source_id: created.id },
    ]);
    expect((await w.partTimeRecords()).map((row) => row.id)).toEqual([record]);
  });

  it('结束：建并提交一步到位（submit = true）→ 四节点（相反顺序）→ 同一条记录截短，原定结束日期不变', async () => {
    const w = await world('end-chain');
    const api = w.http();
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.ok(await api.createDate(dateBody('end', record, { submit: true })), 201);
    expect(created).toMatchObject({
      kind: 'end',
      status: 'in_review',
      processCode: 'EndParttimeJobProcess',
      recordId: record,
      endDate: '2026-09-20',
      originalEndDate: '2026-10-31',
    });
    await w.approveInOrder(created.id, w.order.end);
    expect(await w.ok(await api.one(created.id))).toMatchObject({
      status: 'effective',
      recordId: record,
      endDate: '2026-09-20',
      originalEndDate: '2026-10-31',
    });
    expect((await w.terms(record)).at(-1)).toMatchObject({
      end_date: '2026-09-20',
      source: 'end',
      source_id: created.id,
    });
  });

  it('业务拒绝走明确的业务错误码：PB-33 NOT_EXTENDED / E-1 OPEN_ENDED / E-5 ALREADY_ENDED / T-1 / T-2，均无写入', async () => {
    const w = await world('rules');
    const api = w.http();
    const record = await w.seedRecord({ startDate: '2026-09-10', endDate: '2026-10-31' });
    const open = await w.seedRecord({ startDate: '2026-09-11', endDate: null });
    const ended = await w.seedRecord({ startDate: '2026-09-12', endDate: '2026-09-20' });
    const before = await w.writes();
    const refuse = async (body: Record<string, unknown>) => w.refusal(await api.createDate(body));
    expect(await refuse(dateBody('extend', record, { endDate: '2026-10-15' }))).toEqual({
      status: 409,
      code: 'CONFLICT',
      reason: 'PART_TIME_NOT_EXTENDED',
    });
    expect(await refuse(dateBody('extend', open))).toMatchObject({ status: 409, reason: 'PART_TIME_OPEN_ENDED' });
    expect(await refuse(dateBody('extend', ended))).toMatchObject({ status: 409, reason: 'PART_TIME_ALREADY_ENDED' });
    expect(await refuse(dateBody('end', record, { endDate: '2026-09-09' }))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      reason: 'PART_TIME_END_BEFORE_START',
    });
    expect(await refuse(dateBody('end', record, { endDate: '2026-11-01' }))).toMatchObject({
      status: 409,
      reason: 'PART_TIME_END_AFTER_CURRENT',
    });
    expect(await refuse(dateBody('end', ended, { endDate: '2026-09-15' }))).toMatchObject({
      status: 409,
      reason: 'PART_TIME_ALREADY_ENDED',
    });
    expect(await w.writes()).toEqual(before);
  });
});

describe('PB-57：负责人 / 新增下属两字段仍关闭（延长 / 结束申请同样），创建与修改都无写入', () => {
  it.each(['extend', 'end'] as const)(
    '%s：isDepartmentHead = true / 非空 addedSubordinateIds → 400 LINKAGE_NOT_AVAILABLE',
    async (type) => {
      const w = await world(`linkage-${type}`);
      const api = w.http();
      const record = await w.seedRecord();
      const before = await w.writes();
      for (const extra of [{ isDepartmentHead: true }, { addedSubordinateIds: [randomUUID()] }])
        expect(
          await w.refusal(await api.createDate(dateBody(type, record, extra))),
          JSON.stringify(extra),
        ).toMatchObject(linkage);
      expect(await w.writes()).toEqual(before);
      const created = await draft(w, type, record);
      const mid = await w.writes();
      for (const fields of [{ isDepartmentHead: true }, { addedSubordinateIds: [randomUUID()] }])
        expect(
          await w.refusal(await api.patch(created.id, created.revision, { fields })),
          JSON.stringify(fields),
        ).toMatchObject(linkage);
      expect(await w.writes()).toEqual(mid);
      // 显式 false / 空数组不是联动请求，照常受理
      const saved = await w.ok(
        await api.createDate(
          dateBody(type, await w.seedRecord({ startDate: '2026-09-02' }), {
            isDepartmentHead: false,
            addedSubordinateIds: [],
          }),
        ),
        201,
      );
      expect(saved.status).toBe('draft');
    },
  );
});

describe('请求校验', () => {
  it('请求体严格：未知键 / 缺 recordId / recordId 非 UUID / 缺 endDate / endDate 为空 / 非法日期 → 400，无写入', async () => {
    const w = await world('validation');
    const api = w.http();
    const record = await w.seedRecord();
    const before = await w.writes();
    const bad: Record<string, unknown>[] = [
      dateBody('extend', record, { unknown: 1 }),
      dateBody('extend', record, { employeeId: w.worker.employeeId }),
      dateBody('extend', record, { fields: { departmentId: w.side } }),
      { requestType: 'extend', endDate: '2026-12-31' },
      dateBody('extend', 'not-a-uuid'),
      { requestType: 'end', recordId: record },
      dateBody('end', record, { endDate: null }),
      dateBody('end', record, { endDate: '2026-02-30' }),
      dateBody('end', record, { requestRemark: 'x'.repeat(32767) }),
    ];
    for (const body of bad) expect((await api.createDate(body)).status, JSON.stringify(body)).toBe(400);
    expect(await w.writes()).toEqual(before);
  });

  it('目标兼职记录不存在 / 不是兼职 → 404 PART_TIME_RECORD_NOT_FOUND，无写入', async () => {
    const w = await world('missing-record');
    const before = await w.writes();
    for (const requestType of ['extend', 'end'] as const)
      expect(await w.refusal(await w.http().createDate(dateBody(requestType, randomUUID())))).toMatchObject({
        status: 404,
        reason: 'PART_TIME_RECORD_NOT_FOUND',
      });
    expect(await w.writes()).toEqual(before);
  });

  it('修改延长 / 结束申请：只能改结束日期与备注（其他字段 400 PART_TIME_FIELD_NOT_EDITABLE）；结束日置空 400 PART_TIME_END_DATE_REQUIRED', async () => {
    const w = await world('patch');
    const api = w.http();
    const record = await w.seedRecord();
    const created = await draft(w, 'extend', record);
    const before = await w.writes();
    for (const body of [
      { fields: { departmentId: w.primary } },
      { partTimeType: 'secondment' },
      { startDate: '2026-09-02' },
    ])
      expect(await w.refusal(await api.patch(created.id, created.revision, body)), JSON.stringify(body)).toMatchObject({
        status: 400,
        reason: 'PART_TIME_FIELD_NOT_EDITABLE',
      });
    expect(await w.refusal(await api.patch(created.id, created.revision, { endDate: null }))).toMatchObject({
      status: 400,
      reason: 'PART_TIME_END_DATE_REQUIRED',
    });
    expect(await w.refusal(await api.patch(created.id, created.revision, { endDate: '2026-10-31' }))).toMatchObject({
      status: 409,
      reason: 'PART_TIME_NOT_EXTENDED',
    });
    expect(await w.writes()).toEqual(before);
    const saved = await w.ok(await api.patch(created.id, created.revision, { requestRemark: '只改备注' }));
    expect(saved).toMatchObject({ versionNo: 2, requestRemark: '只改备注', endDate: '2026-12-31' });
  });
});

describe('PB-41：同一兼职有未办结申请时，其他入口互斥', () => {
  it.each(['draft', 'in_review', 'rejected'] as const)(
    '申请处于 %s：直接改结束日期（PATCH part-times）与批量结束都 409 PART_TIME_REQUEST_IN_PROGRESS，另发延长 / 结束申请同码；作废后放开',
    async (state) => {
      const w = await world(`pb41-${state}`);
      const api = w.http();
      const record = await w.seedRecord({ endDate: '2026-10-31' });
      let current = await draft(w, 'extend', record);
      if (state !== 'draft') current = await w.ok(await api.act(current.id, 'submit', current.revision));
      if (state === 'rejected') {
        await w.decide(current.id, w.approvers.pHrbp, 'reject');
        current = await w.ok(await api.one(current.id));
      }
      expect(current.status).toBe(state);
      const inProgress = { status: 409, code: 'CONFLICT', reason: 'PART_TIME_REQUEST_IN_PROGRESS' };
      const patch = await w.request(w.hr.id, 'PATCH', `${EMPLOYMENT}/part-times/${record}`, {
        ifMatch: 1,
        body: { endDate: '2026-11-30' },
      });
      expect(await w.refusal(patch)).toEqual(inProgress);
      const batch = await w.request(w.hr.id, 'POST', `${EMPLOYMENT}/part-times/batch-end`, {
        body: { items: [{ recordId: record, revision: 1 }], endDate: '2026-10-15' },
      });
      expect(await w.refusal(batch)).toMatchObject(inProgress);
      for (const requestType of ['extend', 'end'] as const)
        expect(await w.refusal(await api.createDate(dateBody(requestType, record))), requestType).toEqual(inProgress);
      const voided = await w.ok(await api.act(current.id, 'revoke', current.revision));
      expect(voided.status).toBe('voided');
      const ok = await w.request(w.hr.id, 'PATCH', `${EMPLOYMENT}/part-times/${record}`, {
        ifMatch: 1,
        body: { endDate: '2026-11-30' },
      });
      expect(ok.status, await ok.clone().text()).toBe(200);
    },
  );
});

describe('权限（§7.2）：对象更新权 → 延长 / 结束按钮 → 兼职部门范围 → 字段写权', () => {
  it('延长需要 Employment.PartTimeExtend、结束需要 Employment.PartTimeEnd，新增申请按钮不能替代；只要更新权，不要创建权', async () => {
    const w = await world('perm-buttons');
    const record = await w.seedRecord();
    const before = await w.writes();
    const body = (type: 'extend' | 'end') => dateBody(type, record);
    expect((await as(w, noButton('Employment.PartTimeExtend')).createDate(body('extend'))).status).toBe(403);
    expect((await as(w, noButton('Employment.PartTimeEnd')).createDate(body('end'))).status).toBe(403);
    expect((await as(w, restricted({ deny: denyAction('object.update') })).createDate(body('extend'))).status).toBe(
      403,
    );
    // 建并提交另要 Employment.Submit；只建草稿不要求
    expect((await as(w, noButton('Employment.Submit')).createDate({ ...body('extend'), submit: true })).status).toBe(
      403,
    );
    expect(await w.writes()).toEqual(before);
    // 创建权、新增申请按钮都不是延长 / 结束的前置
    const lean = restricted({
      deny: (request) => denyAction('object.create')(request) || denyButton('Employment.PartTimeApproval')(request),
    });
    expect((await as(w, lean).createDate(body('extend'))).status).toBe(201);
    const another = await w.seedRecord({ startDate: '2026-09-02' });
    expect((await as(w, noButton('Employment.Submit')).createDate(dateBody('end', another))).status).toBe(201);
  });

  it('字段写权：endDate / requestRemark 各自需要；没写被禁字段时放行', async () => {
    const w = await world('perm-fields');
    const record = await w.seedRecord();
    const before = await w.writes();
    const noEnd = as(w, restricted({ deny: denyFieldWrite('endDate') }));
    const noRemark = as(w, restricted({ deny: denyFieldWrite('requestRemark') }));
    expect((await noEnd.createDate(dateBody('extend', record))).status).toBe(403);
    expect((await noRemark.createDate(dateBody('extend', record, { requestRemark: '备注' }))).status).toBe(403);
    expect(await w.writes()).toEqual(before);
    expect((await noRemark.createDate(dateBody('extend', record))).status).toBe(201);
  });

  it('数据范围：兼职记录的兼职部门在范围内才可建；范围外与不存在同一个 404 PART_TIME_RECORD_NOT_FOUND', async () => {
    const w = await world('perm-scope');
    const record = await w.seedRecord();
    const before = await w.writes();
    const scoped = (...orgs: string[]) => as(w, restricted({ scope: orgScope(w.tenant.id, TODAY, ...orgs) }));
    const elsewhere = await w.org(`他处部门${randomUUID()}`);
    for (const orgs of [[w.primary], [elsewhere]]) {
      const refused = await w.refusal(await scoped(...orgs).createDate(dateBody('end', record)));
      expect(refused).toMatchObject({ status: 404, reason: 'PART_TIME_RECORD_NOT_FOUND' });
    }
    const gone = await w.refusal(await scoped(w.side).createDate(dateBody('end', randomUUID())));
    expect(gone).toMatchObject({ status: 404, reason: 'PART_TIME_RECORD_NOT_FOUND' });
    expect(await w.writes()).toEqual(before);
    expect((await scoped(w.primary, w.side).createDate(dateBody('end', record))).status).toBe(201);
  });

  it('申请动作用同类型按钮：延长申请的提交 / 撤回 / 修改要 PartTimeExtend（不是 PartTimeApproval）；结束申请要 PartTimeEnd；撤销只要 Revoke', async () => {
    const w = await world('perm-actions');
    const extendRecord = await w.seedRecord();
    const endRecord = await w.seedRecord({ startDate: '2026-09-02' });
    const extend = await draft(w, 'extend', extendRecord);
    const end = await draft(w, 'end', endRecord);
    // 另一类型的按钮没有时不受影响，本类型按钮没有时 403
    expect((await as(w, noButton('Employment.PartTimeExtend')).act(extend.id, 'submit', extend.revision)).status).toBe(
      403,
    );
    expect(
      (await as(w, noButton('Employment.PartTimeExtend')).patch(extend.id, extend.revision, { endDate: '2027-01-31' }))
        .status,
    ).toBe(403);
    expect((await as(w, noButton('Employment.PartTimeEnd')).act(end.id, 'submit', end.revision)).status).toBe(403);
    expect((await as(w, noButton('Employment.Submit')).act(end.id, 'submit', end.revision)).status).toBe(403);
    expect((await as(w, noButton('Employment.PartTimeApproval')).act(end.id, 'submit', end.revision)).status).toBe(200);
    const submitted = await w.ok(await w.http().act(extend.id, 'submit', extend.revision));
    expect(
      (await as(w, noButton('Employment.PartTimeExtend')).act(extend.id, 'withdraw', submitted.revision)).status,
    ).toBe(403);
    expect((await as(w, noButton('Employment.Withdraw')).act(extend.id, 'withdraw', submitted.revision)).status).toBe(
      403,
    );
    // 撤销只要 Employment.Revoke
    const revoked = await w.ok(
      await as(w, restricted({ deny: (request) => denyButton('Employment.PartTimeExtend')(request) })).act(
        extend.id,
        'revoke',
        submitted.revision,
      ),
    );
    expect(revoked.status).toBe('voided');
    const other = await draft(w, 'extend', await w.seedRecord({ startDate: '2026-09-03' }));
    expect((await as(w, noButton('Employment.Delete')).remove(other.id, other.revision)).status).toBe(403);
    expect((await as(w, noButton('Employment.PartTimeExtend')).remove(other.id, other.revision)).status).toBe(403);
    expect((await w.ok(await w.http().remove(other.id, other.revision))).status).toBe('deleted');
  });

  it('申请的写动作范围按目标记录当前部门判：记录被改到范围外部门后 404（§7.2，读取时取当前值）', async () => {
    const w = await world('perm-moved');
    const record = await w.seedRecord();
    const created = await draft(w, 'extend', record);
    const elsewhere = await w.org(`被改去的部门${randomUUID()}`);
    const scoped = as(w, restricted({ scope: orgScope(w.tenant.id, TODAY, w.primary, w.side) }));
    const submitted = await w.ok(await scoped.act(created.id, 'submit', created.revision));
    // 把记录的当前部门改成范围外的部门（编辑兼职写快照载荷的等价可信造数）
    await w.moveSnapshot(record, elsewhere);
    expect((await scoped.act(created.id, 'withdraw', submitted.revision)).status).toBe(404);
  });
});
