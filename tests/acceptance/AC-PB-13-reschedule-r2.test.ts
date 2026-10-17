/**
 * PB-R13 转正改期第 2 轮（#391 第 2 轮审查 P2-R2-1 / P2-R2-2，DEC-589）：
 * - 继承字段按新位置的前驱重新解析：业务没显式填写的任职字段与自定义字段取新前驱，显式值保留；
 * - 目标位置按新计划日计算：冲突检测、状态重算上界、最终插入共用同一个位置（同日先后仍按 DEC-108 操作先后）。
 * 对照用例比较完整语义快照：改期后 = 按新日期逐条办理（员工 / 记录 / 周期 ID 映射成别名；revision 按追加规则另行核对；
 * isInserted 是落地时写在不可变底表上的标记，迟到改期同口径不重算，不参与比较）。今天 = 2026-10-01。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { EmploymentRecord } from './AC-EMP-support.js';
import { customField } from './AC-EMP-inheritance-support.js';
import {
  businessRevision,
  draftRegularization,
  employeeRevision,
  hire,
  pbWorld,
  probationOf,
  regularizeAt,
  rescheduleRegularization,
  transferAt,
  type PbWorld,
} from './AC-PB-support.js';

const testDb = useTestDb();

/** 任职记录接口返回的完整字段（夹具类型只列了公共部分）。 */
type RecordView = EmploymentRecord & {
  readonly revision: number;
  readonly employeeStatus: number;
  readonly before: { readonly fields: Readonly<Record<string, unknown>> } | null;
};

async function recordsAt(w: PbWorld, employeeId: string, asOf: string) {
  return (await w.session.records(employeeId, asOf)) as RecordView[];
}

async function currentAt(w: PbWorld, employeeId: string, asOf: string) {
  return (await recordsAt(w, employeeId, asOf)).find((record) => record.isCurrent)!;
}

async function statuses(w: PbWorld, employeeId: string) {
  return (await probationOf(w, employeeId, '2027-06-30')).records.map((r) => [
    r.kind,
    r.effectiveDate,
    r.employeeStatus,
  ]);
}

/** 完整语义快照：任职记录（字段、自定义字段、变更前、状态、区间、当前 / 最新）+ 转正日期投影，ID 换成别名。 */
async function semantic(w: PbWorld, employeeId: string, asOf: string) {
  const records = await recordsAt(w, employeeId, asOf);
  const aliases = new Map<string, string>([[employeeId, 'employee']]);
  records.forEach((record, index) => {
    aliases.set(record.id, `record-${index}`);
    aliases.set(record.staffId, 'staff');
    if (typeof record.fields.jobNumber === 'string') aliases.set(record.fields.jobNumber, 'jobNumber');
  });
  const alias = (value: unknown): unknown => {
    if (typeof value === 'string') return aliases.get(value) ?? value;
    if (Array.isArray(value)) return value.map(alias);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, alias(item)]));
    return value;
  };
  const projection = (await probationOf(w, employeeId, asOf)).records.map((r) => r.regularizationDate);
  return records.map(({ revision: _revision, isInserted: _inserted, ...record }, index) =>
    alias({ ...record, regularizationDate: projection[index] }),
  );
}

async function revisions(w: PbWorld, ids: readonly string[]) {
  return Promise.all(ids.map((id) => businessRevision(w, id)));
}

describe('PB-R13 转正改期：继承字段按新位置的前驱重算（P2-R2-1）', () => {
  it('提前跨过改了地点的调动：11-01～11-14 的当前任职不再沿用调动后的地点', async () => {
    const w = await pbWorld(testDb().db, 'pb13r2-place-earlier');
    const { employee } = await hire(w, { months: 3 });
    await transferAt(w, employee.id, '2026-11-15', { place: '十一月地点' });
    const id = await regularizeAt(w, employee.id, '2026-12-01');
    expect((await currentAt(w, employee.id, '2026-12-05')).fields.place).toBe('十一月地点');
    const response = await rescheduleRegularization(w, id, '2026-11-01');
    expect(response.status, await response.clone().text()).toBe(200);
    const moved = await currentAt(w, employee.id, '2026-11-10');
    expect(moved.kind).toBe('regularization');
    expect(moved.fields.place).toBeNull();
    expect(moved.before?.fields.place).toBeNull();
    const after = await currentAt(w, employee.id, '2026-11-20');
    expect([after.kind, after.fields.place, after.employeeStatus]).toEqual(['transfer', '十一月地点', 3]);
  });

  it('推后跨过改了地点的调动：转正取调动后的地点，变更前也取调动', async () => {
    const w = await pbWorld(testDb().db, 'pb13r2-place-later');
    const { employee } = await hire(w, { months: 3 });
    const id = await regularizeAt(w, employee.id, '2026-11-01');
    await transferAt(w, employee.id, '2026-11-15', { place: '十一月地点' });
    expect((await rescheduleRegularization(w, id, '2026-12-01')).status).toBe(200);
    const moved = await currentAt(w, employee.id, '2026-12-05');
    expect([moved.kind, moved.fields.place, moved.before?.fields.place]).toEqual([
      'regularization',
      '十一月地点',
      '十一月地点',
    ]);
  });

  it('对照（提前）：改了不同字段的调动，改期后的完整语义快照 = 按新日期逐条办理', async () => {
    const w = await pbWorld(testDb().db, 'pb13r2-replay-earlier');
    const field = await customField(w.session);
    const build = async (name: string, regularizeOn: string) => {
      const { employee } = await hire(w, { months: 3, name });
      const first = await transferAt(w, employee.id, '2026-11-15', { place: '十一月地点' }, { [field.id]: '十一月值' });
      const second = await transferAt(w, employee.id, '2026-12-10', { dimension1: '十二月维度' });
      const id = await regularizeAt(w, employee.id, regularizeOn);
      return { employee, ids: [id, first.id, second.id] };
    };
    const moved = await build('改期', '2026-12-01');
    const before = await revisions(w, moved.ids);
    const response = await rescheduleRegularization(w, moved.ids[0]!, '2026-11-01', before[0]);
    expect(response.status, await response.clone().text()).toBe(200);
    // 转正单 +1（改期命令）；11-15 调动由试用改为正式 +1；12-10 调动原本就在转正之后，不变
    expect(await revisions(w, moved.ids)).toEqual([before[0]! + 1, before[1]! + 1, before[2]]);
    const replayed = await build('重放', '2026-11-01');
    for (const asOf of ['2026-11-10', '2026-11-20', '2026-12-05', '2027-01-01'])
      expect(await semantic(w, moved.employee.id, asOf), asOf).toEqual(await semantic(w, replayed.employee.id, asOf));
  });

  it('对照（推后）：改了不同字段的调动，改期后的完整语义快照 = 按新日期逐条办理', async () => {
    const w = await pbWorld(testDb().db, 'pb13r2-replay-later');
    const field = await customField(w.session);
    const { employee } = await hire(w, { months: 3, name: '改期' });
    const id = await regularizeAt(w, employee.id, '2026-11-01');
    const first = await transferAt(w, employee.id, '2026-11-15', { place: '十一月地点' }, { [field.id]: '十一月值' });
    const second = await transferAt(w, employee.id, '2026-12-10', { dimension1: '十二月维度' });
    const before = await revisions(w, [id, first.id, second.id]);
    expect((await rescheduleRegularization(w, id, '2026-12-01', before[0])).status).toBe(200);
    expect(await revisions(w, [id, first.id, second.id])).toEqual([before[0]! + 1, before[1]! + 1, before[2]]);

    const replayed = await hire(w, { months: 3, name: '重放' });
    await transferAt(w, replayed.employee.id, '2026-11-15', { place: '十一月地点' }, { [field.id]: '十一月值' });
    await regularizeAt(w, replayed.employee.id, '2026-12-01');
    await transferAt(w, replayed.employee.id, '2026-12-10', { dimension1: '十二月维度' });
    for (const asOf of ['2026-11-10', '2026-11-20', '2026-12-05', '2027-01-01'])
      expect(await semantic(w, employee.id, asOf), asOf).toEqual(await semantic(w, replayed.employee.id, asOf));
  });
});

describe('PB-R13 转正改期：目标位置按新计划日计算（P2-R2-2）', () => {
  it('推后到先办的调动当天：转正排在调动之后，调动回退为试用', async () => {
    const w = await pbWorld(testDb().db, 'pb13r2-same-day-after');
    const { employee } = await hire(w, { months: 3 });
    await transferAt(w, employee.id, '2026-12-01', { place: '十二月地点' });
    const id = await regularizeAt(w, employee.id, '2026-11-01');
    expect((await rescheduleRegularization(w, id, '2026-12-01')).status).toBe(200);
    expect(await statuses(w, employee.id)).toEqual([
      ['hire', '2026-09-01', 2],
      ['transfer', '2026-12-01', 2],
      ['regularization', '2026-12-01', 3],
    ]);
  });

  it('推后到后办的调动当天：转正排在调动之前，调动仍为正式', async () => {
    const w = await pbWorld(testDb().db, 'pb13r2-same-day-before');
    const { employee } = await hire(w, { months: 3 });
    const id = await regularizeAt(w, employee.id, '2026-11-01');
    await transferAt(w, employee.id, '2026-12-01', { place: '十二月地点' });
    expect((await rescheduleRegularization(w, id, '2026-12-01')).status).toBe(200);
    expect(await statuses(w, employee.id)).toEqual([
      ['hire', '2026-09-01', 2],
      ['regularization', '2026-12-01', 3],
      ['transfer', '2026-12-01', 3],
    ]);
  });

  it('推后到另一条先办的转正当天 → 409 列出它，数据与 revision 不变', async () => {
    const w = await pbWorld(testDb().db, 'pb13r2-same-day-regularization');
    const { employee } = await hire(w, { months: 3 });
    const other = await regularizeAt(w, employee.id, '2026-12-01');
    const id = await regularizeAt(w, employee.id, '2026-11-01');
    const before = await statuses(w, employee.id);
    const revision = await businessRevision(w, id);
    const blocked = await rescheduleRegularization(w, id, '2026-12-01', revision);
    expect(blocked.status).toBe(409);
    const details = ((await blocked.json()) as { error: { details: { conflicts: { id: string }[] } } }).error.details;
    expect(details.conflicts.map((item) => item.id)).toEqual([other]);
    expect(await statuses(w, employee.id)).toEqual(before);
    expect(await businessRevision(w, id)).toBe(revision);
  });

  it('提前到后办的另一条转正当天：本单先办、排在它之前 → 409 列出它', async () => {
    const w = await pbWorld(testDb().db, 'pb13r2-earlier-regularization');
    const { employee } = await hire(w, { months: 3 });
    const id = await regularizeAt(w, employee.id, '2026-12-01');
    const other = await regularizeAt(w, employee.id, '2026-11-15');
    const blocked = await rescheduleRegularization(w, id, '2026-11-15');
    expect(blocked.status).toBe(409);
    const details = ((await blocked.json()) as { error: { details: { conflicts: { id: string }[] } } }).error.details;
    expect(details.conflicts.map((item) => item.id)).toEqual([other]);
  });

  it('目标日有在途申请：推后到离职申请生效日、提前到转正申请生效日 → 409 列出申请', async () => {
    const w = await pbWorld(testDb().db, 'pb13r2-in-flight');
    const leaving = await hire(w, { months: 3, name: '离职申请' });
    const later = await regularizeAt(w, leaving.employee.id, '2026-11-01');
    const leave = await w.session.business(
      leaving.employee.id,
      { kind: 'leave', mode: 'application', lastWorkDate: '2026-11-30' },
      await employeeRevision(w, leaving.employee.id),
    );
    const postponed = await rescheduleRegularization(w, later, '2026-12-01');
    expect(postponed.status).toBe(409);
    const leaveConflicts = ((await postponed.json()) as { error: { details: { conflicts: { id: string }[] } } }).error
      .details.conflicts;
    expect(leaveConflicts.map((item) => item.id)).toEqual([leave.id]);

    const applying = await hire(w, { months: 3, name: '转正申请' });
    const earlier = await regularizeAt(w, applying.employee.id, '2026-12-01');
    const application = await draftRegularization(w, applying.employee.id, '2026-11-15');
    const advanced = await rescheduleRegularization(w, earlier, '2026-11-15');
    expect(advanced.status).toBe(409);
    const draftConflicts = ((await advanced.json()) as { error: { details: { conflicts: { id: string }[] } } }).error
      .details.conflicts;
    expect(draftConflicts.map((item) => item.id)).toEqual([application.id]);
  });
});
