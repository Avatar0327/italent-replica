/**
 * BE-3 调整试用信息（B6）与互斥校验（docs/02_业务建模/29 PB-R9～R12，§8 AC-PB-03 / AC-PB-04，W-597）：
 * - AC-PB-03：已有转正申请在审批中时，再提交转正申请、直接转正、调整试用期都被拒；拦截在提交时，草稿照常能保存；
 * - AC-PB-04（§8 实际口径）：审批通过但未到生效日的转正记录也算“生效的转正任职记录”，转正日期不能清空；
 * - PB-R12：开始日不早于入职日、结束日不早于开始日；“是否有试用期”由是改否，人员状态直接变正式。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  adjust,
  draftRegularization,
  employeeRevision,
  hire,
  pbWorld,
  probationOf,
  regularize,
  regularizeOk,
  transition,
} from './AC-PB-support.js';

const testDb = useTestDb();

const info = { hasProbation: true, startDate: '2026-09-01', months: 3, expectedEndDate: '2026-11-30' };

async function errorOf(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string; details?: { reason?: string } } }).error;
}

describe('调整试用信息（B6，PB-R11 / R12）', () => {
  it('合法调整追加新版本：改月数后按开始日重算预计结束日，员工 revision 递增', async () => {
    const w = await pbWorld(testDb().db, 'pb-adjust-ok');
    const { employee } = await hire(w, { months: 3 });
    const before = await employeeRevision(w, employee.id);
    const response = await adjust(w, employee.id, { hasProbation: true, startDate: '2026-09-01', months: 2 });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await probationOf(w, employee.id)).toMatchObject({ months: 2, expectedEndDate: '2026-10-31' });
    expect(await employeeRevision(w, employee.id)).toBe(before + 1);
    const stale = await adjust(w, employee.id, info, before);
    expect(stale.status).toBe(409);
  });

  it('PB-R12：开始日早于入职日、预计结束日早于开始日 → 400', async () => {
    const w = await pbWorld(testDb().db, 'pb-adjust-r12');
    const { employee } = await hire(w, { months: 3 });
    const early = await adjust(w, employee.id, { ...info, startDate: '2026-08-31' });
    expect(early.status).toBe(400);
    expect((await errorOf(early)).details?.reason).toBe('PROBATION_START_BEFORE_ENTRY');
    const reversed = await adjust(w, employee.id, { ...info, startDate: '2026-09-10', expectedEndDate: '2026-09-09' });
    expect(reversed.status).toBe(400);
    expect((await errorOf(reversed)).details?.reason).toBe('PROBATION_END_BEFORE_START');
  });

  it('PB-R12：是否有试用期由是改否，入职记录及之后的记录人员状态直接变正式；再改回是恢复试用', async () => {
    const w = await pbWorld(testDb().db, 'pb-adjust-off');
    const { employee } = await hire(w, { months: 3 });
    await w.session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-12-01', fields: { place: '调动地点' } },
      await employeeRevision(w, employee.id),
    );
    const off = await adjust(w, employee.id, { hasProbation: false });
    expect(off.status, await off.clone().text()).toBe(200);
    const statuses = async () => (await probationOf(w, employee.id, '2026-12-01')).records.map((r) => r.employeeStatus);
    expect(await statuses()).toEqual([3, 3]);
    expect(await probationOf(w, employee.id)).toMatchObject({ hasProbation: false, startDate: null });
    expect((await adjust(w, employee.id, info)).status).toBe(200);
    expect(await statuses()).toEqual([2, 2]);
  });

  it('AC-PB-04：审批通过、未到生效日的转正记录也算生效记录——不带转正日期提交被拒，提示原站原文', async () => {
    const w = await pbWorld(testDb().db, 'pb-adjust-r11');
    const { employee } = await hire(w, { months: 3 });
    const draft = await draftRegularization(w, employee.id, '2026-10-15');
    expect((await transition(w, draft, 'submit')).status).toBe(200);
    expect((await transition(w, draft, 'approve')).status).toBe(200);
    expect(await probationOf(w, employee.id)).toMatchObject({
      regularizationDate: '2026-10-15',
      regularizationState: 'approved',
    });
    // 原站只改预计结束日 11-30 → 11-29，实际转正日期为空，保存被拦截
    const cleared = await adjust(w, employee.id, { ...info, expectedEndDate: '2026-11-29' });
    expect(cleared.status).toBe(409);
    expect(await errorOf(cleared)).toMatchObject({
      message: '该人员已存在生效的转正任职记录，转正日期不允许清空',
      details: { reason: 'PROBATION_REGULARIZATION_DATE_REQUIRED' },
    });
    expect((await probationOf(w, employee.id)).expectedEndDate).toBe('2026-11-30');
    const off = await adjust(w, employee.id, { hasProbation: false, regularizationDate: '2026-10-15' });
    expect(off.status).toBe(409);
    expect((await errorOf(off)).details?.reason).toBe('PROBATION_REGULARIZED');
    const ok = await adjust(w, employee.id, {
      ...info,
      expectedEndDate: '2026-11-29',
      regularizationDate: '2026-10-15',
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
  });

  it('没有转正记录时不能填写实际转正日期', async () => {
    const w = await pbWorld(testDb().db, 'pb-adjust-noreg');
    const { employee } = await hire(w, { months: 3 });
    const response = await adjust(w, employee.id, { ...info, regularizationDate: '2026-12-01' });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).details?.reason).toBe('PROBATION_REGULARIZATION_DATE_WITHOUT_RECORD');
  });

  it('请求体严格：多余字段、月数越界 → 400', async () => {
    const w = await pbWorld(testDb().db, 'pb-adjust-strict');
    const { employee } = await hire(w, { months: 3 });
    expect((await adjust(w, employee.id, { ...info, employeeStatus: 3 })).status).toBe(400);
    expect((await adjust(w, employee.id, { ...info, months: 7 })).status).toBe(400);
  });
});

describe('AC-PB-03 互斥校验（PB-R9）', () => {
  async function inReview(label: string) {
    const w = await pbWorld(testDb().db, label);
    const { employee } = await hire(w, { months: 3 });
    const first = await draftRegularization(w, employee.id, '2026-12-01');
    expect((await transition(w, first, 'submit')).status).toBe(200);
    return { w, employee, first };
  }

  it('转正申请在审批中：草稿照常能保存（打开表单不拦），提交第二张时被拒', async () => {
    const { w, employee } = await inReview('pb-mutex-submit');
    const second = await draftRegularization(w, employee.id, '2026-12-01');
    const submitted = await transition(w, second, 'submit');
    expect(submitted.status).toBe(409);
    expect((submitted.body as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'PROBATION_PROCESS_IN_REVIEW',
    );
  });

  it('转正申请在审批中：直接转正、批量申请逐人失败，调整试用期 409', async () => {
    const { w, employee } = await inReview('pb-mutex-others');
    for (const mode of ['direct', 'application'] as const) {
      const receipt = (await (await regularize(w, { mode, effectiveDate: '2026-12-01' }, [employee.id])).json()) as {
        items: { status: string; error: { details?: { reason?: string } } }[];
      };
      expect(receipt.items[0]).toMatchObject({ status: 'failed' });
      expect(receipt.items[0]!.error.details?.reason).toBe('PROBATION_PROCESS_IN_REVIEW');
    }
    const adjusted = await adjust(w, employee.id, info);
    expect(adjusted.status).toBe(409);
    expect((await errorOf(adjusted)).details?.reason).toBe('PROBATION_PROCESS_IN_REVIEW');
  });

  it('审批中的申请被驳回后不再拦截，可以直接转正', async () => {
    const { w, employee, first } = await inReview('pb-mutex-release');
    expect((await transition(w, first, 'reject')).status).toBe(200);
    const receipt = await regularizeOk(w, { mode: 'direct', effectiveDate: '2026-10-20' }, [employee.id]);
    expect(receipt.items[0]!.status).toBe('succeeded');
  });
});
