/**
 * BE-7 PT-3c 编辑兼职（docs/08_设计/R2-T05_兼职设计.md §4.4 直接修改结束日期、§5.1、§7.2 编辑行、§12 A-9、§13.1 PT-3c）：
 * 开放 PATCH part-times/:recordId（If-Match = 底层业务头 revision）。可改：结束日期（追加期限 source = edit）、部门 / 职位 /
 * 职务 / 序列 / 职级 / 直线与虚线经理 / 用工形式 / 自定义字段（追加快照载荷）；开始日期与任职类型不可改，结束日期不能置空。
 * 覆盖：PB-24（改结束日）、PB-57（联动字段）、PB-60 / PB-61（离职边界与撤销后恢复）、E-4、§7.2 权限与范围。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { denyAction, denyButton, denyFieldWrite, httpWorld, restricted } from './AC-PT-http-support.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();

async function editWorld(label: string, create: Record<string, unknown> = { endDate: '2026-10-31' }) {
  const w = await httpWorld(database().db, label);
  const record = await w.make(create);
  const patch = (body: Record<string, unknown>, revision = record.revision) => w.edit(record.id, body, revision);
  const audits = (action: string) =>
    withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ before: unknown; after: unknown; org: string }>(
        await tx.execute(sql`SELECT before, after, scope_org_id AS org FROM audit_events
          WHERE tenant_id=${w.tenantId} AND object_id=${record.id} AND action=${action}`),
      ),
    );
  const snapshots = () =>
    withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ version_no: number; is_record_snapshot: boolean }>(
        await tx.execute(sql`SELECT version_no, is_record_snapshot FROM employment_payload_versions
          WHERE tenant_id=${w.tenantId} AND business_id=${record.id} ORDER BY version_no`),
      ),
    );
  return { w, record, patch, audits, snapshots };
}

describe('PB-24 直接修改结束日期（追加期限 source = edit）', () => {
  it('改早 → 200：同一条记录追加第 2 期，revision +1（ETag），审计 employment.part_time.end 归属兼职部门', async () => {
    const { w, record, patch, audits } = await editWorld('edit-end-earlier');
    const response = await patch({ endDate: '2026-10-15' });
    expect(response.headers.get('etag')).toBe('"2"');
    expect(await w.ok(response)).toMatchObject({
      id: record.id,
      endDate: '2026-10-15',
      revision: 2,
      serviceStatus: 'serving',
    });
    expect(await w.terms(record.id)).toEqual([
      { term_no: 1, end_date: '2026-10-31', source: 'create', source_id: null },
      { term_no: 2, end_date: '2026-10-15', source: 'edit', source_id: null },
    ]);
    expect(await w.headRevision(record.id)).toBe(2);
    expect(await audits('employment.part_time.end')).toEqual([
      {
        before: { endDate: '2026-10-31' },
        after: expect.objectContaining({ endDate: '2026-10-15' }),
        org: w.partTimeOrg.id,
      },
    ]);
    expect((await w.records(w.employeeId)).map((item) => item.id)).not.toContain(record.id);
  });

  it('改晚 / 部门自结束日之后停用：新增段不可用 → 400 EMPLOYMENT_DEPARTMENT_DISABLED，可用的最后一天成功', async () => {
    const { w, patch } = await editWorld('edit-end-later');
    await w.ok(await patch({ endDate: '2026-10-15' }));
    expect((await w.disableOrg(w.partTimeOrg, '2026-11-10')).status).toBe(200);
    const before = await w.writes();
    expect(await w.refusal(await patch({ endDate: '2026-11-30' }, 2))).toMatchObject({
      status: 400,
      reason: 'EMPLOYMENT_DEPARTMENT_DISABLED',
    });
    expect(await w.writes()).toEqual(before);
    expect(await w.ok(await patch({ endDate: '2026-11-09' }, 2))).toMatchObject({ endDate: '2026-11-09', revision: 3 });
  });

  it('置空 → 400 PART_TIME_END_DATE_REQUIRED；早于开始日期 → 400 PART_TIME_END_BEFORE_START；均无写入', async () => {
    const { w, patch } = await editWorld('edit-end-invalid');
    const before = await w.writes();
    expect(await w.refusal(await patch({ endDate: null }))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      reason: 'PART_TIME_END_DATE_REQUIRED',
    });
    expect(await w.refusal(await patch({ endDate: '2026-08-31' }))).toMatchObject({
      status: 400,
      reason: 'PART_TIME_END_BEFORE_START',
    });
    expect(await w.writes()).toEqual(before);
  });

  it('无结束日期的记录：置空与同值提交都是无操作（200，revision 不变，无任何写入）；可设置结束日期', async () => {
    const { w, record, patch } = await editWorld('edit-end-open', {});
    const before = await w.writes();
    expect(await w.ok(await patch({ endDate: null }))).toMatchObject({ revision: 1, endDate: null });
    expect(await w.ok(await patch({ fields: { departmentId: w.partTimeOrg.id } }))).toMatchObject({ revision: 1 });
    expect(await w.writes()).toEqual(before);
    expect(await w.ok(await patch({ endDate: '2026-12-31' }))).toMatchObject({ endDate: '2026-12-31', revision: 2 });
    expect((await w.terms(record.id)).map((term) => term.source)).toEqual(['create', 'edit']);
  });

  it('结束日改到过去 → 任职结束、进“已结束”视图（R2d）', async () => {
    const { w, patch } = await editWorld('edit-end-past');
    expect(await w.ok(await patch({ endDate: '2026-09-20' }))).toMatchObject({
      serviceStatus: 'ended',
      partTimeView: ['ended', 'all'],
    });
  });
});

describe('§5.1 非日期字段（追加快照载荷）', () => {
  it('改直线经理：载荷追加快照版本、revision +1；期限不动；审计 employment.part_time.edit 只含改动字段', async () => {
    const { w, record, patch, audits, snapshots } = await editWorld('edit-fields');
    const manager = await w.colleague('新经理');
    const edited = await w.ok(await patch({ fields: { directManagerId: manager.id } }));
    expect(edited).toMatchObject({
      revision: 2,
      endDate: '2026-10-31',
      serviceType: 'part_time',
      effectiveDate: '2026-09-01',
      fields: { directManagerId: manager.id, departmentId: w.partTimeOrg.id },
    });
    expect((await snapshots()).map((row) => [row.version_no, row.is_record_snapshot])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(await w.terms(record.id)).toHaveLength(1);
    expect(await audits('employment.part_time.edit')).toEqual([
      { before: { directManagerId: null }, after: { directManagerId: manager.id }, org: w.partTimeOrg.id },
    ]);
    expect(await w.ok(await w.one(record.id))).toMatchObject({ fields: { directManagerId: manager.id } });
  });

  it('同时改结束日与字段：一次命令 revision 只 +1；期限追加一期、载荷追加一版；审计 end 与 edit 各一条', async () => {
    const { w, record, patch, audits, snapshots } = await editWorld('edit-both');
    const manager = await w.colleague('新经理');
    expect(await w.ok(await patch({ endDate: '2026-10-20', fields: { directManagerId: manager.id } }))).toMatchObject({
      revision: 2,
      endDate: '2026-10-20',
    });
    expect(await w.headRevision(record.id)).toBe(2);
    expect(await w.terms(record.id)).toHaveLength(2);
    expect(await snapshots()).toHaveLength(2);
    expect(await audits('employment.part_time.end')).toHaveLength(1);
    expect(await audits('employment.part_time.edit')).toHaveLength(1);
  });

  it('改部门：按结果区间重验（新部门在结束日前停用 → 400；同时缩短结束日则放行），审计归属新部门、before 带旧部门', async () => {
    const { w, record, patch, audits } = await editWorld('edit-department');
    const target = await w.org(`新兼职部门${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    expect((await w.disableOrg(target, '2026-10-20')).status).toBe(200);
    const before = await w.writes();
    expect(await w.refusal(await patch({ fields: { departmentId: target.id } }))).toMatchObject({
      status: 400,
      reason: 'EMPLOYMENT_DEPARTMENT_DISABLED',
    });
    expect(await w.writes()).toEqual(before);
    const moved = await w.ok(await patch({ endDate: '2026-10-19', fields: { departmentId: target.id } }));
    expect(moved).toMatchObject({ revision: 2, endDate: '2026-10-19', fields: { departmentId: target.id } });
    expect(await audits('employment.part_time.edit')).toEqual([
      { before: { departmentId: w.partTimeOrg.id }, after: { departmentId: target.id }, org: target.id },
    ]);
    expect((await audits('employment.part_time.end'))[0]!.org).toBe(target.id);
    expect(await w.ok(await w.one(record.id))).toMatchObject({ fields: { departmentId: target.id } });
  });

  it('引用校验同新增：经理是本人 / 不存在的职位 → 400，无写入', async () => {
    const { w, record, patch } = await editWorld('edit-references');
    const before = await w.writes();
    expect((await w.refusal(await patch({ fields: { directManagerId: w.employeeId } }))).status).toBe(400);
    expect(
      (await w.refusal(await patch({ fields: { positionId: '00000000-0000-4000-8000-000000000001' } }))).status,
    ).toBe(400);
    expect(await w.writes()).toEqual(before);
    expect((await w.one(record.id)).status).toBe(200);
  });

  it('自定义字段：按任职对象定义校验并与现有值合并；非本租户任职对象的字段 → 400', async () => {
    const { w, patch, audits } = await editWorld('edit-custom');
    const field = await w.customField('text');
    const contract = await w.customField('text', 'contract');
    expect(await w.ok(await patch({ customFields: { [field]: '甲' } }))).toMatchObject({
      customFields: { [field]: '甲' },
    });
    expect((await w.refusal(await patch({ customFields: { [contract]: '乙' } }, 2))).status).toBe(400);
    expect((await audits('employment.part_time.edit'))[0]!.after).toEqual({ [`custom:${field}`]: '甲' });
  });
});

describe('A-9 / PB-57 / 请求体与并发', () => {
  it('开始日期、任职类型改成别的值 → 400（RECORD_DATE_IMMUTABLE / PART_TIME_TYPE_IMMUTABLE）；同值是无操作', async () => {
    const { w, patch } = await editWorld('edit-immutable');
    const before = await w.writes();
    expect(await w.refusal(await patch({ startDate: '2026-09-02' }))).toMatchObject({
      status: 400,
      reason: 'RECORD_DATE_IMMUTABLE',
    });
    expect(await w.refusal(await patch({ partTimeType: 'secondment' }))).toMatchObject({
      status: 400,
      reason: 'PART_TIME_TYPE_IMMUTABLE',
    });
    expect(await w.writes()).toEqual(before);
    expect(await w.ok(await patch({ startDate: '2026-09-01', partTimeType: 'part_time' }))).toMatchObject({
      revision: 1,
    });
    expect(await w.writes()).toEqual(before);
  });

  it('PB-57：联动字段 true / 非空 → 400 PART_TIME_LINKAGE_NOT_AVAILABLE；false / [] 是无操作', async () => {
    const { w, patch } = await editWorld('edit-linkage');
    const before = await w.writes();
    for (const fields of [
      { isDepartmentHead: true },
      { addedSubordinateIds: ['00000000-0000-4000-8000-000000000002'] },
    ])
      expect(await w.refusal(await patch({ fields }))).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
        reason: 'PART_TIME_LINKAGE_NOT_AVAILABLE',
      });
    expect(await w.writes()).toEqual(before);
    expect(await w.ok(await patch({ fields: { isDepartmentHead: false, addedSubordinateIds: [] } }))).toMatchObject({
      revision: 1,
    });
  });

  it('请求体严格：未知键 / 非法日期 / 空体 / 非 UUID 字段 → 400；缺 If-Match → REVISION_REQUIRED', async () => {
    const { w, record, patch } = await editWorld('edit-schema');
    for (const body of [{ surprise: 1 }, { fields: { surprise: 1 } }, { endDate: '2026-13-01' }, {}, { fields: {} }])
      expect((await w.refusal(await patch(body))).status, JSON.stringify(body)).toBe(400);
    expect((await w.refusal(await patch({ fields: { directManagerId: 'm' } }))).status).toBe(400);
    const noMatch = await w.request('PATCH', `/part-times/${record.id}`, { body: { endDate: '2026-10-15' } });
    expect(await w.refusal(noMatch)).toMatchObject({ status: 400, code: 'REVISION_REQUIRED' });
  });

  it('revision 过期 → 409 REVISION_CONFLICT（带 expected / actual），不写；刷新后显式重提成功', async () => {
    const { w, record, patch } = await editWorld('edit-revision');
    await w.ok(await patch({ endDate: '2026-10-20' }));
    const before = await w.writes();
    const stale = await patch({ endDate: '2026-10-10' }, 1);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: 'REVISION_CONFLICT', details: { expected: 1, actual: 2 } },
    });
    expect(await w.writes()).toEqual(before);
    expect(await w.ok(await patch({ endDate: '2026-10-10' }, 2))).toMatchObject({ revision: 3, id: record.id });
  });

  it('不存在 / 不是兼职（主职记录 ID）→ 404，不泄露；非 UUID → 400', async () => {
    const { w, patch } = await editWorld('edit-not-found');
    const hire = (await w.records(w.employeeId)).find((item) => item.kind === 'hire')!;
    for (const id of ['00000000-0000-4000-8000-000000000003', hire.id])
      expect((await w.edit(id, { endDate: '2026-10-15' }, 1)).status, id).toBe(404);
    expect((await w.edit('not-a-uuid', { endDate: '2026-10-15' }, 1)).status).toBe(400);
    expect((await patch({ endDate: '2026-10-15' })).status).toBe(200);
  });

  it('E-4：有未办结的延长 / 结束申请时改结束日期 → 409 PART_TIME_REQUEST_IN_PROGRESS；改非日期字段放行', async () => {
    const { w, record, patch } = await editWorld('edit-request-in-progress');
    await w.seedRequest({ requestType: 'extend', recordId: record.id });
    const before = await w.writes();
    expect(await w.refusal(await patch({ endDate: '2026-10-15' }))).toMatchObject({
      status: 409,
      reason: 'PART_TIME_REQUEST_IN_PROGRESS',
    });
    expect(await w.writes()).toEqual(before);
    const manager = await w.colleague('经理');
    expect(await w.ok(await patch({ fields: { directManagerId: manager.id } }))).toMatchObject({ revision: 2 });
  });
});

describe('PB-60 / PB-61 离职边界（§4.3A）：编辑改结束日同样不得越过已生效离职的最后工作日', () => {
  it('PB-60：离职钩子把兼职结束于 09-15 后，编辑结束日改为 10-31 → 409 PART_TIME_BEYOND_EXIT，期限链不变；改到 09-10 成功', async () => {
    const { w, record } = await editWorld('edit-beyond-exit', {});
    await w.leave('2026-09-15');
    const revision = (await w.ok(await w.one(record.id))).revision;
    const before = await w.writes();
    const refused = await w.refusal(await w.edit(record.id, { endDate: '2026-10-31' }, revision));
    expect(refused).toMatchObject({ status: 409, code: 'CONFLICT', reason: 'PART_TIME_BEYOND_EXIT' });
    expect(await w.writes()).toEqual(before);
    expect((await w.terms(record.id)).map((term) => [term.end_date, term.source])).toEqual([
      [null, 'create'],
      ['2026-09-15', 'exit'],
    ]);
    expect(await w.ok(await w.edit(record.id, { endDate: '2026-09-10' }, revision))).toMatchObject({
      endDate: '2026-09-10',
    });
  });

  it('PB-61：撤销（删除）该离职后，同样的编辑成功 —— 撤销离职后允许恢复（造数版）', async () => {
    const { w, record } = await editWorld('edit-undo-exit', {});
    const exit = await w.leave('2026-09-15');
    const revision = (await w.ok(await w.one(record.id))).revision;
    expect((await w.edit(record.id, { endDate: '2026-10-31' }, revision)).status).toBe(409);
    const removed = await w.request('DELETE', `/businesses/${exit.id}`, { ifMatch: exit.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    const restored = await w.ok(await w.edit(record.id, { endDate: '2026-10-31' }, revision));
    expect(restored).toMatchObject({ endDate: '2026-10-31', serviceStatus: 'serving' });
    expect((await w.terms(record.id)).map((term) => term.source)).toEqual(['create', 'exit', 'edit']);
  });
});

describe('§7.2 编辑兼职：功能操作权 → 按钮权 → 范围 → 字段权', () => {
  const send = (
    w: Awaited<ReturnType<typeof editWorld>>['w'],
    id: string,
    who: ReturnType<typeof restricted>,
    body: object,
  ) => w.as(who)('PATCH', `/part-times/${id}`, { ifMatch: 1, body });

  it('缺 object.update → 403；缺 Employment.PartTimeEdit 按钮 → 403；缺实际改动字段的写权 → 403，改别的字段放行', async () => {
    const { w, record } = await editWorld('edit-perm');
    const manager = await w.colleague('经理');
    const before = await w.writes();
    const moveEnd = { endDate: '2026-10-15' };
    expect((await send(w, record.id, restricted({ deny: denyAction('object.update') }), moveEnd)).status).toBe(403);
    expect(
      (await send(w, record.id, restricted({ deny: denyButton('Employment.PartTimeEdit') }), moveEnd)).status,
    ).toBe(403);
    const noEndDate = restricted({ deny: denyFieldWrite('endDate') });
    expect((await send(w, record.id, noEndDate, moveEnd)).status).toBe(403);
    expect(await w.writes()).toEqual(before);
    expect((await send(w, record.id, noEndDate, { fields: { directManagerId: manager.id } })).status).toBe(200);
  });

  it('范围：兼职部门在范围即可编辑（AC-PT-04，员工主职不必在范围）；只管主职部门 / 空范围 → 404；改去范围外部门 → 404', async () => {
    const { w, record } = await editWorld('edit-scope');
    const before = await w.writes();
    const only = (...orgIds: string[]) => restricted({ scope: w.scopeOf(...orgIds) });
    expect((await send(w, record.id, only(w.primaryOrg.id), { endDate: '2026-10-15' })).status).toBe(404);
    expect((await send(w, record.id, restricted({ scope: EMPTY_SCOPE }), { endDate: '2026-10-15' })).status).toBe(404);
    expect(
      (await send(w, record.id, only(w.partTimeOrg.id), { fields: { departmentId: w.primaryOrg.id } })).status,
    ).toBe(404);
    expect(await w.writes()).toEqual(before);
    expect((await send(w, record.id, only(w.partTimeOrg.id), { endDate: '2026-10-15' })).status).toBe(200);
  });
});

describe('AC-PT-01 / 第 1 轮 P2-1：编辑把已结束的外派 / 借调改回进行中，仍受 D-5 唯一约束', () => {
  const exclusive = (type: string, startDate: string, endDate: string | null) => ({
    partTimeType: type,
    startDate,
    endDate,
  });

  it('复现：外派 A 09-01～09-20 已结束，借调 B 09-21～12-31 任职中；把 A 结束日改成 12-31 → 409 PART_TIME_EXCLUSIVE_TYPE_EXISTS，A 不变', async () => {
    const w = await httpWorld(database().db, 'edit-exclusive-repro');
    const a = await w.make(exclusive('expatriate', '2026-09-01', '2026-09-20'));
    await w.make(exclusive('secondment', '2026-09-21', '2026-12-31'));
    const before = await w.writes();
    expect(await w.refusal(await w.edit(a.id, { endDate: '2026-12-31' }, a.revision))).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      reason: 'PART_TIME_EXCLUSIVE_TYPE_EXISTS',
    });
    expect(await w.writes()).toEqual(before);
    expect(await w.ok(await w.one(a.id))).toMatchObject({ endDate: '2026-09-20', revision: 1, serviceStatus: 'ended' });
  });

  it('草稿 / 审批中 / 驳回的外派 / 借调新增申请同样占位（A-7）：恢复被拒；申请办结（作废）后可恢复', async () => {
    const w = await httpWorld(database().db, 'edit-exclusive-pending');
    const a = await w.make(exclusive('secondment', '2026-09-01', '2026-09-20'));
    await w.seedRequest({ requestType: 'add', serviceType: 'expatriate', state: 'in_review' });
    expect(await w.refusal(await w.edit(a.id, { endDate: '2026-12-31' }, a.revision))).toMatchObject({
      status: 409,
      reason: 'PART_TIME_EXCLUSIVE_TYPE_EXISTS',
    });
    const free = await httpWorld(database().db, 'edit-exclusive-pending-voided');
    const b = await free.make(exclusive('secondment', '2026-09-01', '2026-09-20'));
    await free.seedRequest({ requestType: 'add', serviceType: 'expatriate', state: 'voided' });
    expect(await free.ok(await free.edit(b.id, { endDate: '2026-12-31' }, b.revision))).toMatchObject({
      endDate: '2026-12-31',
      serviceStatus: 'serving',
    });
  });

  it('无冲突时仍可恢复（PB-61）：只有这一条外派 / 借调，或其他外派 / 借调都已结束 → 200；恢复后另一条就恢复不了', async () => {
    const w = await httpWorld(database().db, 'edit-exclusive-recover');
    const a = await w.make(exclusive('expatriate', '2026-08-01', '2026-08-20'));
    const b = await w.make(exclusive('secondment', '2026-09-01', '2026-09-20'));
    expect(await w.ok(await w.edit(a.id, { endDate: '2026-12-31' }, a.revision))).toMatchObject({ revision: 2 });
    expect(await w.refusal(await w.edit(b.id, { endDate: '2026-12-31' }, b.revision))).toMatchObject({
      status: 409,
      reason: 'PART_TIME_EXCLUSIVE_TYPE_EXISTS',
    });
  });

  it('普通兼职可以并行（D-6）；外派 / 借调在进行中时改非日期字段、缩短结束日、同在进行中改晚都不受影响', async () => {
    const w = await httpWorld(database().db, 'edit-exclusive-unaffected');
    const ordinary = await w.make(exclusive('part_time', '2026-09-01', '2026-09-20'));
    await w.make(exclusive('part_time', '2026-09-21', '2026-12-31'));
    expect(await w.ok(await w.edit(ordinary.id, { endDate: '2026-12-31' }, ordinary.revision))).toMatchObject({
      serviceStatus: 'serving',
    });
    const mine = await w.make(exclusive('expatriate', '2026-09-10', '2026-12-31'));
    const manager = await w.colleague('经理');
    const edited = await w.ok(await w.edit(mine.id, { fields: { directManagerId: manager.id } }, mine.revision));
    const later = await w.ok(await w.edit(mine.id, { endDate: '2027-01-31' }, edited.revision));
    const shorter = await w.ok(await w.edit(mine.id, { endDate: '2026-11-30' }, later.revision));
    expect(shorter).toMatchObject({ endDate: '2026-11-30', serviceStatus: 'serving' });
  });

  it('批量结束只缩短结束日，不受 D-5 影响：同时存在一条已结束的外派时，批量结束进行中的借调成功', async () => {
    const w = await httpWorld(database().db, 'edit-exclusive-batch');
    await w.make(exclusive('expatriate', '2026-08-01', '2026-08-20'));
    const b = await w.make(exclusive('secondment', '2026-09-01', '2026-12-31'));
    const done = await w.ok<{ succeeded: number }>(
      await w.batchEnd([{ recordId: b.id, revision: b.revision }], '2026-10-15'),
    );
    expect(done.succeeded).toBe(1);
  });
});
