/**
 * BE-2a 待入职入口与状态动作（docs/02_业务建模/34 EN-R8～R11 / R14；DEC-484② / DEC-540 保守口径）：
 * 添加待入职、开放是否有试用期、办理入职、取消入职、改期入职、删除待入职（含失效删除端口）。
 */
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { deletePendingEntry } from '../../apps/api/src/modules/employment/entry-actions.js';
import {
  addHire,
  addPending,
  businessRevision,
  entryAction,
  entryActionRows,
  entryRecords,
  entryWorld,
  hireBody,
  portContext,
} from './AC-EN-BE2a-support.js';

const testDb = useTestDb();
const PENDING = 1;
const NORMAL = 0;
const CANCELLED = 1;
const POSTPONED = 2;

describe('BE-2a 添加待入职与是否有试用期', () => {
  it('添加待入职：人员状态待入职、入职状态正常，员工概要为 pending', async () => {
    const w = await entryWorld(testDb().db, 'be2a-add');
    const { employee } = await addPending(w);
    const [record] = await entryRecords(w, employee.id);
    expect(record).toMatchObject({ employeeStatus: PENDING, entryStatus: NORMAL, effectiveDate: '2026-10-10' });
    expect((await w.session.getEmployee(employee.id)).status).toBe('pending');
  });

  it.each([
    ['有试用期', true, 2],
    ['无试用期', false, 3],
    ['缺省', undefined, 3],
  ])('直接入职开放 probation：%s → 人员状态 %i', async (_name, probation, status) => {
    const w = await entryWorld(testDb().db, `be2a-prob-${String(probation)}`);
    const employee = await w.session.employee('试用期合成员工');
    const extra = probation === undefined ? {} : { probation };
    const response = await addHire(w.session, employee, hireBody(w.org.id, '2026-09-01', extra));
    expect(response.status).toBe(201);
    expect((await entryRecords(w, employee.id))[0]).toMatchObject({ employeeStatus: status, entryStatus: null });
  });

  it.each([
    ['待入职只能直接添加', { pendingEntry: true, mode: 'application' }],
    ['待入职阶段不填是否有试用期（办理入职时再填）', { pendingEntry: true, probation: true }],
    ['probation 必须为布尔值', { probation: 'yes' }],
    ['非入职类业务不能带 pendingEntry', { pendingEntry: true, kind: 'transfer' }],
    ['非入职类业务不能带 probation', { probation: true, kind: 'regularization' }],
  ])('入口拒绝：%s', async (_name, extra) => {
    const w = await entryWorld(testDb().db, `be2a-reject-${_name.length}`);
    const employee = await w.session.employee('入口拒绝合成员工');
    const response = await addHire(w.session, employee, hireBody(w.org.id, '2026-09-01', extra));
    expect(response.status).toBe(400);
    expect(await entryRecords(w, employee.id)).toEqual([]);
  });
});

describe('BE-2a 办理入职', () => {
  it('办理入职：有试用期 → 试用；入职状态保留；重复办理被拒', async () => {
    const w = await entryWorld(testDb().db, 'be2a-complete');
    const { employee, recordId } = await addPending(w);
    const missing = await entryAction(w, recordId, 'complete', {});
    expect(missing.status).toBe(400);
    const done = await entryAction(w, recordId, 'complete', { probation: true });
    expect(done.status, await done.clone().text()).toBe(200);
    expect((await entryRecords(w, employee.id))[0]).toMatchObject({ employeeStatus: 2, entryStatus: NORMAL });
    const again = await entryAction(w, recordId, 'complete', { probation: false });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { details: { reason: 'NOT_PENDING_ENTRY' } } });
  });

  it('已取消入职不能直接办理，须先改期恢复', async () => {
    const w = await entryWorld(testDb().db, 'be2a-complete-cancelled');
    const { recordId } = await addPending(w);
    expect((await entryAction(w, recordId, 'cancel', {})).status).toBe(200);
    const response = await entryAction(w, recordId, 'complete', { probation: false });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'ENTRY_CANCELLED' } } });
  });
});

describe('BE-2a 取消入职（原因 5 项下拉、非必填）', () => {
  it('取消：入职状态变取消，原因与备注落库；重复取消被拒', async () => {
    const w = await entryWorld(testDb().db, 'be2a-cancel');
    const { employee, recordId } = await addPending(w);
    const response = await entryAction(w, recordId, 'cancel', { reason: 'personal', remark: '候选人另有安排' });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await entryRecords(w, employee.id))[0]).toMatchObject({ employeeStatus: PENDING, entryStatus: CANCELLED });
    expect(await entryActionRows(w)).toMatchObject([
      { action: 'cancel', reasonCode: 'personal', remark: '候选人另有安排', businessId: recordId },
    ]);
    expect((await entryAction(w, recordId, 'cancel', {})).status).toBe(409);
  });

  it('原因可不填；不在 5 项内的原因被拒', async () => {
    const w = await entryWorld(testDb().db, 'be2a-cancel-reason');
    const { recordId } = await addPending(w);
    expect((await entryAction(w, recordId, 'cancel', { reason: '随便写' })).status).toBe(400);
    expect((await entryAction(w, recordId, 'cancel', {})).status).toBe(200);
    expect(await entryActionRows(w)).toMatchObject([{ action: 'cancel', reasonCode: null, remark: null }]);
  });
});

describe('BE-2a 改期入职（日期必填、备注可选、状态延期；已取消入职改期即恢复）', () => {
  it('改期：入职日改到新日期、状态延期，字段保持；原待入职记录被替换（记录 ID 变更）', async () => {
    const w = await entryWorld(testDb().db, 'be2a-postpone');
    const { employee, recordId } = await addPending(w, '2026-10-10');
    const response = await entryAction(w, recordId, 'postpone', { effectiveDate: '2026-10-20', remark: '延后报到' });
    expect(response.status, await response.clone().text()).toBe(200);
    const records = await entryRecords(w, employee.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      employeeStatus: PENDING,
      entryStatus: POSTPONED,
      effectiveDate: '2026-10-20',
      fields: { departmentId: w.org.id, employType: 'internal' },
    });
    expect(records[0]!.id).not.toBe(recordId);
    expect(await entryActionRows(w)).toMatchObject([
      { action: 'postpone', remark: '延后报到', fromDate: '2026-10-10', toDate: '2026-10-20' },
    ]);
    expect((await entryActionRows(w))[0]).toMatchObject({
      businessId: records[0]!.id,
      previousBusinessId: recordId,
    });
  });

  it('日期必填；日期未变更（非取消状态）被拒；日期不合法被拒', async () => {
    const w = await entryWorld(testDb().db, 'be2a-postpone-date');
    const { recordId } = await addPending(w, '2026-10-10');
    for (const body of [{}, { remark: '无日期' }, { effectiveDate: '2026-10-10' }, { effectiveDate: '10-20' }])
      expect((await entryAction(w, recordId, 'postpone', body)).status).toBe(400);
    expect(await entryActionRows(w)).toEqual([]);
  });

  it('已取消入职改期即恢复：状态延期；同日期也可恢复', async () => {
    const w = await entryWorld(testDb().db, 'be2a-postpone-restore');
    const { employee, recordId } = await addPending(w, '2026-10-10');
    expect((await entryAction(w, recordId, 'cancel', { reason: 'other' })).status).toBe(200);
    const restored = await entryAction(w, recordId, 'postpone', { effectiveDate: '2026-10-10' });
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect((await entryRecords(w, employee.id))[0]).toMatchObject({
      entryStatus: POSTPONED,
      effectiveDate: '2026-10-10',
    });
  });

  it('已办理入职的记录不能改期；有后续任职记录时拒绝且不改动', async () => {
    const w = await entryWorld(testDb().db, 'be2a-postpone-guard');
    const done = await addPending(w, '2026-09-01', '已办理合成员工');
    expect((await entryAction(w, done.recordId, 'complete', { probation: false })).status).toBe(200);
    const response = await entryAction(w, done.recordId, 'postpone', { effectiveDate: '2026-09-05' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'NOT_PENDING_ENTRY' } } });

    const other = await addPending(w, '2026-10-10', '有后续记录合成员工');
    const next = await w.session.request('POST', `/employees/${other.employee.id}/businesses`, {
      ifMatch: other.business.employeeRevision,
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-15', fields: { place: '新地点' } },
    });
    expect(next.status, await next.clone().text()).toBe(201);
    const blocked = await entryAction(w, other.recordId, 'postpone', { effectiveDate: '2026-10-12' });
    expect(blocked.status).toBe(409);
    expect((await entryRecords(w, other.employee.id)).map((r) => r.effectiveDate)).toEqual([
      '2026-10-10',
      '2026-10-15',
    ]);
  });
});

describe('BE-2a 删除待入职（不可恢复，只删待入职本身）', () => {
  it('删除后该员工没有任职记录；已取消的也可删除', async () => {
    const w = await entryWorld(testDb().db, 'be2a-delete');
    const { employee, recordId } = await addPending(w);
    await entryAction(w, recordId, 'cancel', {});
    const response = await w.session.request('DELETE', `/pending-entries/${recordId}`, {
      ifMatch: await businessRevision(w, recordId),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'deleted' });
    expect(await entryRecords(w, employee.id)).toEqual([]);
    expect((await w.session.getEmployee(employee.id)).id).toBe(employee.id);
  });

  it('已入职记录拒绝删除；记录不存在 404', async () => {
    const w = await entryWorld(testDb().db, 'be2a-delete-hired');
    const { employee, recordId } = await addPending(w);
    await entryAction(w, recordId, 'complete', { probation: false });
    const response = await w.session.request('DELETE', `/pending-entries/${recordId}`, {
      ifMatch: await businessRevision(w, recordId),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'NOT_PENDING_ENTRY' } } });
    expect(await entryRecords(w, employee.id)).toHaveLength(1);
    const missing = await w.session.request('DELETE', `/pending-entries/${employee.id}`, { ifMatch: 1 });
    expect(missing.status).toBe(404);
  });

  it('失效删除端口（给 BE-14：Offer 失效时删除待入职）：同一删除内核，已入职拒绝', async () => {
    const w = await entryWorld(testDb().db, 'be2a-delete-port');
    const pending = await addPending(w, '2026-10-10', '失效待入职');
    const hired = await addPending(w, '2026-09-01', '失效已入职');
    await entryAction(w, hired.recordId, 'complete', { probation: false });
    await withTenant(w.db, w.session.tenant.id, (tx) =>
      deletePendingEntry(tx, portContext(w, pending.business.revision), pending.recordId),
    );
    expect(await entryRecords(w, pending.employee.id)).toEqual([]);
    await expect(
      withTenant(w.db, w.session.tenant.id, async (tx) =>
        deletePendingEntry(tx, portContext(w, await businessRevision(w, hired.recordId)), hired.recordId),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'NOT_PENDING_ENTRY' } });
  });
});
