/**
 * BE-7 PT-7 公开入口开闸（docs/08_设计/R2-T05_兼职设计.md §4.8 / §7.2 / §13.1，PB-57 改正例）：POST employees/:id/part-times（含 preview）与
 * PATCH part-times/:recordId 接受 isDepartmentHead / addedSubordinateIds，不新增路由、不新增授权项：字段写权沿用请求体 fields 的判定，
 * 联动人员沿用调动联动的范围与资格校验，被拒时整单回滚。批量结束与联动无关。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyFieldWrite, httpWorld, restricted } from './AC-PT-http-support.js';
import { LINKED, PENDING, withLinkage } from './AC-PT-linkage-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const world = async (label: string) => withLinkage(await httpWorld(database().db, `lk-${label}`));

describe('POST employees/:id/part-times 新增', () => {
  it('201：负责人 / 下属联动立即执行；读形状带回两个字段；留联动事件', async () => {
    const w = await world('create');
    const sub = await w.subordinate();
    const created = await w.ok(await w.post({ fields: { isDepartmentHead: true, addedSubordinateIds: [sub] } }), 201);
    expect(created.fields).toMatchObject({ isDepartmentHead: true, addedSubordinateIds: [sub] });
    expect(await w.headOf(w.partTimeOrg.id)).toBe(w.employeeId);
    expect((await w.managerOf(sub)).directManagerId).toBe(w.employeeId);
    expect(await w.events(created.id)).toMatchObject({ [LINKED]: 1 });
    expect(await w.ok(await w.one(created.id))).toMatchObject({ fields: { isDepartmentHead: true } });
  });

  it('未来开始 → 201 只写待执行事件，读形状带回标志，组织负责人不动', async () => {
    const w = await world('create-future');
    const created = await w.ok(await w.post({ startDate: '2026-10-20', fields: { isDepartmentHead: true } }), 201);
    expect(created.fields).toMatchObject({ isDepartmentHead: true });
    expect(await w.events(created.id)).toMatchObject({ [PENDING]: 1 });
    expect(await w.headOf(w.partTimeOrg.id)).toBeNull();
  });

  it('联动人员不合格 → 400 整单回滚，无任何写入；预览同一套校验，不写库', async () => {
    const w = await world('create-ineligible');
    const before = await w.writes();
    const body = { fields: { addedSubordinateIds: [w.employeeId] } };
    expect(await w.refusal(await w.post(body))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      reason: 'TRANSFER_PERSON_NOT_ELIGIBLE',
    });
    expect(await w.refusal(await w.preview(body))).toMatchObject({
      status: 400,
      reason: 'TRANSFER_PERSON_NOT_ELIGIBLE',
    });
    expect(await w.writes()).toEqual(before);
  });

  it('预览：负责人 / 下属合格时 200 带回字段，不写库、不执行联动', async () => {
    const w = await world('preview');
    const sub = await w.subordinate();
    const before = await w.writes();
    const preview = await w.ok(await w.preview({ fields: { isDepartmentHead: true, addedSubordinateIds: [sub] } }));
    expect(preview.fields).toMatchObject({ isDepartmentHead: true, addedSubordinateIds: [sub] });
    expect(await w.writes()).toEqual(before);
    expect(await w.headOf(w.partTimeOrg.id)).toBeNull();
  });

  it('字段写权沿用 fields 判定：没有 isDepartmentHead 创建权 → 403，无写入', async () => {
    const w = await world('create-field-deny');
    const before = await w.writes();
    const as = w.as(restricted({ deny: denyFieldWrite('isDepartmentHead') }));
    const response = await as('POST', `/employees/${w.employeeId}/part-times`, {
      body: {
        partTimeType: 'part_time',
        startDate: '2026-09-01',
        fields: { departmentId: w.partTimeOrg.id, isDepartmentHead: true },
      },
    });
    expect((await w.refusal(response)).status).toBe(403);
    expect(await w.writes()).toEqual(before);
    expect(await w.headOf(w.partTimeOrg.id)).toBeNull();
  });

  it('下属不在操作人数据范围内 → 拒绝（沿用调动联动的范围校验），无写入，下属经理不变', async () => {
    const w = await world('create-scope');
    const elsewhere = await w.org(`范围外部门${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    const sub = await w.subordinate('范围外下属', elsewhere.id);
    const before = await w.writes();
    const as = w.as(restricted({ scope: w.scopeOf(w.primaryOrg.id, w.partTimeOrg.id) }));
    const response = await as('POST', `/employees/${w.employeeId}/part-times`, {
      body: {
        partTimeType: 'part_time',
        startDate: '2026-09-01',
        fields: { departmentId: w.partTimeOrg.id, addedSubordinateIds: [sub] },
      },
    });
    expect([403, 404]).toContain((await w.refusal(response)).status);
    expect(await w.writes()).toEqual(before);
    expect((await w.managerOf(sub)).directManagerId).toBeNull();
  });
});

describe('PATCH part-times/:recordId 编辑', () => {
  it('把已有兼职改成负责人：执行一次联动，revision +1；同值再提交是无操作，不重复执行', async () => {
    const w = await world('edit-head');
    const record = await w.make({ endDate: '2026-12-31' });
    const edited = await w.ok(await w.edit(record.id, { fields: { isDepartmentHead: true } }, record.revision));
    expect(edited).toMatchObject({ revision: 2, fields: { isDepartmentHead: true } });
    expect(await w.headOf(w.partTimeOrg.id)).toBe(w.employeeId);
    const versions = await w.orgVersions(w.partTimeOrg.id);
    const again = await w.ok(await w.edit(record.id, { fields: { isDepartmentHead: true } }, edited.revision));
    expect(again.revision).toBe(2);
    expect(await w.orgVersions(w.partTimeOrg.id)).toBe(versions);
    expect(await w.events(record.id)).toMatchObject({ [LINKED]: 1 });
  });

  it('追加下属：只对新增的下属执行；原有下属不重复改', async () => {
    const w = await world('edit-subs');
    const [first, second] = [await w.subordinate('下属甲'), await w.subordinate('下属乙')];
    const record = await w.make({ fields: { addedSubordinateIds: [first] } });
    expect((await w.managerOf(first)).directManagerId).toBe(w.employeeId);
    const edited = await w.ok(
      await w.edit(record.id, { fields: { addedSubordinateIds: [first, second] } }, record.revision),
    );
    expect(edited.fields).toMatchObject({ addedSubordinateIds: [first, second] });
    expect((await w.managerOf(second)).directManagerId).toBe(w.employeeId);
    expect(await w.events(record.id)).toMatchObject({ [LINKED]: 2 });
  });

  it('未来开始的兼职改成负责人：只写待执行事件（已有待执行时不重复写）', async () => {
    const w = await world('edit-future');
    const record = await w.make({ startDate: '2026-10-20' });
    const edited = await w.ok(await w.edit(record.id, { fields: { isDepartmentHead: true } }, record.revision));
    expect(await w.events(record.id)).toMatchObject({ [PENDING]: 1 });
    await w.ok(await w.edit(record.id, { endDate: '2026-12-31', fields: { isDepartmentHead: true } }, edited.revision));
    expect(await w.events(record.id)).toMatchObject({ [PENDING]: 1 });
    expect(await w.headOf(w.partTimeOrg.id)).toBeNull();
  });

  it('联动被拒时整单回滚：编辑不生效、revision 不变', async () => {
    const w = await world('edit-reject');
    const record = await w.make();
    const before = await w.writes();
    const failed = await w.edit(record.id, { fields: { addedSubordinateIds: [w.employeeId] } }, record.revision);
    expect(await w.refusal(failed)).toMatchObject({ status: 400, reason: 'TRANSFER_PERSON_NOT_ELIGIBLE' });
    expect(await w.writes()).toEqual(before);
    expect((await w.ok(await w.one(record.id))).revision).toBe(record.revision);
  });

  it('批量结束与联动无关：结束后负责人 / 下属关系保持', async () => {
    const w = await world('batch-end');
    const sub = await w.subordinate();
    const record = await w.make({ fields: { isDepartmentHead: true, addedSubordinateIds: [sub] } });
    await w.ok(await w.batchEnd([{ recordId: record.id, revision: record.revision }], '2026-10-05'));
    expect(await w.headOf(w.partTimeOrg.id)).toBe(w.employeeId);
    expect((await w.managerOf(sub)).directManagerId).toBe(w.employeeId);
  });
});

describe('到期日编辑 × 未办结的待执行联动（第 1 轮 P2-1：编辑只办增量却结清整条待办）', () => {
  const FUTURE = '2026-10-10';

  it('待执行负责人 + 到期日 PATCH 追加下属：编辑办理完整联动意图（负责人也设），之后调度不再有余留', async () => {
    const w = await world('due-edit-head-then-sub');
    const sub = await w.subordinate();
    const record = await w.make({ startDate: FUTURE, fields: { isDepartmentHead: true } });
    expect(await w.events(record.id)).toMatchObject({ [PENDING]: 1 });
    w.setNow(`${FUTURE}T01:00:00.000Z`);
    await w.ok(await w.edit(record.id, { fields: { addedSubordinateIds: [sub] } }, record.revision));
    expect(await w.headOf(w.partTimeOrg.id)).toBe(w.employeeId);
    expect((await w.managerOf(sub, FUTURE)).directManagerId).toBe(w.employeeId);
    expect((await w.sweep(FUTURE)).errors).toEqual([]);
    expect(await w.events(record.id)).toMatchObject({ [PENDING]: 1, [LINKED]: 1 });
    expect(await w.headOf(w.partTimeOrg.id)).toBe(w.employeeId);
  });

  it('反向：待执行下属 + 到期日 PATCH 设为负责人：下属经理也被改，不被记录级已执行事件吞掉', async () => {
    const w = await world('due-edit-sub-then-head');
    const sub = await w.subordinate();
    const record = await w.make({ startDate: FUTURE, fields: { addedSubordinateIds: [sub] } });
    w.setNow(`${FUTURE}T01:00:00.000Z`);
    await w.ok(await w.edit(record.id, { fields: { isDepartmentHead: true } }, record.revision));
    expect(await w.headOf(w.partTimeOrg.id)).toBe(w.employeeId);
    expect((await w.managerOf(sub, FUTURE)).directManagerId).toBe(w.employeeId);
    await w.sweep(FUTURE);
    expect(await w.events(record.id)).toMatchObject({ [LINKED]: 1 });
  });

  it('到期前（开始日 > 今天）PATCH 追加下属：只并入待执行意图，开始日由调度一次办完整', async () => {
    const w = await world('before-due-edit');
    const sub = await w.subordinate();
    const record = await w.make({ startDate: FUTURE, fields: { isDepartmentHead: true } });
    await w.ok(await w.edit(record.id, { fields: { addedSubordinateIds: [sub] } }, record.revision));
    expect(await w.headOf(w.partTimeOrg.id)).toBeNull();
    await w.sweep(FUTURE);
    expect(await w.headOf(w.partTimeOrg.id)).toBe(w.employeeId);
    expect((await w.managerOf(sub, FUTURE)).directManagerId).toBe(w.employeeId);
    expect(await w.events(record.id)).toMatchObject({ [PENDING]: 1, [LINKED]: 1 });
  });
});
