/**
 * PB-R13 修改转正日期（DEC-589，#391 第 1 轮审查 P2-1，用户选 B）：转正单专用改期命令
 * POST /businesses/:id/regularization-date（If-Match = 业务 revision）。复用迟到改期的重排机制（追加载荷版本、重建时间轴）；
 * 新旧日期之间的调动等记录允许跨过并重算人员状态（提前 → 正式，推后 → 试用）；区间内有离职 / 另一条转正 / 入职 → 409
 * 列出冲突记录；新日期超出本任职周期 → 400。通用编辑入口仍不能改日期，DEC-231 不变。今天 = 2026-10-01。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
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
  transition,
  type PbWorld,
} from './AC-PB-support.js';

const testDb = useTestDb();

const transfer = (w: PbWorld, employeeId: string, effectiveDate: string, place: string) =>
  transferAt(w, employeeId, effectiveDate, { place });
const regularize = regularizeAt;
const revisionOf = businessRevision;
const reschedule = rescheduleRegularization;

/** 本周期记录（类型、日期、人员状态、转正日期投影），按时间轴顺序。 */
async function timeline(w: PbWorld, employeeId: string) {
  return (await probationOf(w, employeeId, '2027-06-30')).records.map((r) => [
    r.kind,
    r.effectiveDate,
    r.employeeStatus,
    r.regularizationDate,
  ]);
}

describe('PB-R13 转正改期：区间内记录重算人员状态', () => {
  it('提前：12-01 → 11-01，11-15 的调动由试用改为正式，转正日期投影随之更新', async () => {
    const w = await pbWorld(testDb().db, 'pb13-earlier');
    const { employee } = await hire(w, { months: 3 });
    await transfer(w, employee.id, '2026-11-15', '调动地点');
    const id = await regularize(w, employee.id, '2026-12-01');
    expect(await timeline(w, employee.id)).toEqual([
      ['hire', '2026-09-01', 2, null],
      ['transfer', '2026-11-15', 2, null],
      ['regularization', '2026-12-01', 3, '2026-12-01'],
    ]);
    const response = await reschedule(w, id, '2026-11-01');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(((await response.json()) as { effectiveDate: string }).effectiveDate).toBe('2026-11-01');
    expect(await timeline(w, employee.id)).toEqual([
      ['hire', '2026-09-01', 2, null],
      ['regularization', '2026-11-01', 3, '2026-11-01'],
      ['transfer', '2026-11-15', 3, '2026-11-01'],
    ]);
  });

  it('推后：11-01 → 12-01，11-15 的调动由正式回退为试用，不再带转正日期', async () => {
    const w = await pbWorld(testDb().db, 'pb13-later');
    const { employee } = await hire(w, { months: 3 });
    const id = await regularize(w, employee.id, '2026-11-01');
    await transfer(w, employee.id, '2026-11-15', '调动地点');
    expect((await reschedule(w, id, '2026-12-01')).status).toBe(200);
    expect(await timeline(w, employee.id)).toEqual([
      ['hire', '2026-09-01', 2, null],
      ['transfer', '2026-11-15', 2, null],
      ['regularization', '2026-12-01', 3, '2026-12-01'],
    ]);
  });

  it('跨多条：区间内两条调动都重算，区间外（之前的入职、之后的调动）不动', async () => {
    const w = await pbWorld(testDb().db, 'pb13-many');
    const { employee } = await hire(w, { months: 3 });
    const id = await regularize(w, employee.id, '2026-11-01');
    for (const [date, place] of [
      ['2026-11-05', '地点一'],
      ['2026-11-10', '地点二'],
      ['2026-12-10', '地点三'],
    ] as const)
      await transfer(w, employee.id, date, place);
    expect((await reschedule(w, id, '2026-12-01')).status).toBe(200);
    expect(await timeline(w, employee.id)).toEqual([
      ['hire', '2026-09-01', 2, null],
      ['transfer', '2026-11-05', 2, null],
      ['transfer', '2026-11-10', 2, null],
      ['regularization', '2026-12-01', 3, '2026-12-01'],
      ['transfer', '2026-12-10', 3, '2026-12-01'],
    ]);
  });
  // 对照用例（完整语义快照）见 AC-PB-13-reschedule-r2.test.ts
});

describe('PB-R13 转正改期：拒绝与并发', () => {
  it('区间内有另一条转正、在途离职申请 → 409 列出冲突记录，数据与 revision 不变', async () => {
    const w = await pbWorld(testDb().db, 'pb13-conflict');
    const { employee } = await hire(w, { months: 3 });
    const first = await regularize(w, employee.id, '2026-11-01');
    const second = await regularize(w, employee.id, '2026-12-01');
    const before = await timeline(w, employee.id);
    const revision = await revisionOf(w, first);
    const blocked = await reschedule(w, first, '2026-12-15', revision);
    expect(blocked.status).toBe(409);
    const body = (await blocked.json()) as {
      error: { details: { reason: string; conflicts: { id: string; kind: string; effectiveDate: string }[] } };
    };
    expect(body.error.details.reason).toBe('REGULARIZATION_RESCHEDULE_BLOCKED');
    expect(body.error.details.conflicts).toEqual([
      expect.objectContaining({ id: second, kind: 'regularization', effectiveDate: '2026-12-01' }),
    ]);
    expect(await timeline(w, employee.id)).toEqual(before);
    expect(await revisionOf(w, first)).toBe(revision);

    const leaving = await hire(w, { months: 3, name: '离职申请' });
    const regularization = await regularize(w, leaving.employee.id, '2026-11-01');
    const leave = await w.session.business(
      leaving.employee.id,
      { kind: 'leave', mode: 'application', lastWorkDate: '2026-11-19' },
      await employeeRevision(w, leaving.employee.id),
    );
    const crossed = await reschedule(w, regularization, '2026-12-01');
    expect(crossed.status).toBe(409);
    const details = ((await crossed.json()) as { error: { details: { conflicts: { id: string }[] } } }).error.details;
    expect(details.conflicts.map((item) => item.id)).toEqual([leave.id]);
  });

  it('新日期超出本任职周期 → 400：早于入职日，或在已生效的离职之后', async () => {
    const w = await pbWorld(testDb().db, 'pb13-cycle');
    const { employee } = await hire(w, { months: 3 });
    const id = await regularize(w, employee.id, '2026-11-01');
    const early = await reschedule(w, id, '2026-08-31');
    expect(early.status).toBe(400);
    expect(((await early.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'REGULARIZATION_DATE_OUT_OF_CYCLE',
    );
    await w.session.business(
      employee.id,
      { kind: 'leave', mode: 'direct', lastWorkDate: '2026-11-30' },
      await employeeRevision(w, employee.id),
    );
    expect((await reschedule(w, id, '2026-12-05')).status).toBe(400);
  });

  it('旧 revision → 409 REVISION_CONFLICT，不写入；缺 If-Match → 400；不是转正单 → 409', async () => {
    const w = await pbWorld(testDb().db, 'pb13-revision');
    const { employee, business: hired } = await hire(w, { months: 3 });
    const id = await regularize(w, employee.id, '2026-11-01');
    const revision = await revisionOf(w, id);
    expect((await reschedule(w, id, '2026-11-02', revision)).status).toBe(200);
    const stale = await reschedule(w, id, '2026-11-03', revision);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('REVISION_CONFLICT');
    expect((await probationOf(w, employee.id)).regularizationDate).toBe('2026-11-02');
    const noMatch = await w.session.request('POST', `/businesses/${id}/regularization-date`, {
      body: { effectiveDate: '2026-11-03' },
    });
    expect(noMatch.status).toBe(400);
    const notRegularization = await reschedule(w, hired.id, '2026-09-02');
    expect(notRegularization.status).toBe(409);
  });

  it('审批通过未落地的转正申请可改期（到新日期生效）；审批中的申请不能改期', async () => {
    const w = await pbWorld(testDb().db, 'pb13-approved');
    const { employee } = await hire(w, { months: 3 });
    const application = await draftRegularization(w, employee.id, '2026-12-01');
    expect((await transition(w, application, 'submit')).status).toBe(200);
    const reviewing = await reschedule(w, application.id, '2026-11-20');
    expect(reviewing.status).toBe(409);
    expect((await transition(w, application, 'approve')).status).toBe(200);
    expect((await reschedule(w, application.id, '2026-11-20')).status).toBe(200);
    expect(await probationOf(w, employee.id)).toMatchObject({
      regularizationDate: '2026-11-20',
      regularizationState: 'approved',
    });
    w.session.setNow('2026-11-20T01:00:00.000Z');
    expect((await transition(w, application, 'activate', '2026-11-20T01:00:00Z')).status).toBe(200);
    expect((await timeline(w, employee.id)).at(-1)).toEqual(['regularization', '2026-11-20', 3, '2026-11-20']);
  });

  it('通用编辑入口仍不能改转正日期（RECORD_DATE_IMMUTABLE）', async () => {
    const w = await pbWorld(testDb().db, 'pb13-generic');
    const { employee } = await hire(w, { months: 3 });
    const id = await regularize(w, employee.id, '2026-11-01');
    const response = await w.session.request('PATCH', `/records/${id}`, {
      ifMatch: await revisionOf(w, id),
      body: { effectiveDate: '2026-11-02' },
    });
    expect(response.status).toBe(400);
  });
});
