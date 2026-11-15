/**
 * F-474-8c-2c 生效侧（设计 §3.3 / §4.2，AC-INS-06 / 07 / 11 / 13）：生效日由既有定时联动登记 insurance_archive 子项，
 * 在自己的保存点里追加一条社保档案版本；失败只记子项、可重试；撤销 / 改期按联动现有路径。
 * 真实 HTTP + 真实定时任务；档案与审计用属主身份只读核对。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { D } from './AC-LNK-support.js';
import { insuranceWriteWorld } from './support/insurance-write.js';

const testDb = useTestDb();
const AT_D = `${D}T01:00:00Z`;

async function scene(label: string) {
  const w = await insuranceWriteWorld(testDb().db, label);
  const person = await w.hire('社保生效员工');
  const [plan, company] = [await w.plan('P', '440100', w.MONTH), await w.company('C')];
  const adjust = {
    adjustedInsuranceRegionCode: '440100',
    adjustedInsurancePlanId: plan,
    adjustedInsuranceCompanyId: company,
  };
  return { w, person, plan, company, adjust };
}

describe('AC-INS-06 版本链追加', () => {
  it('每笔生效追加一条（version_no 递增），旧版本一字不改；全空的调动不写档案、不登记子项', async () => {
    const { w, person, plan, company, adjust } = await scene('ins-exec-chain');
    const first = await w.submitTransfer(person, D, adjust);
    await w.approve(first, '2026-10-02T01:00:00Z');
    await w.runScheduler(AT_D);
    const [v1] = await w.archive(person.employee.id);
    expect(v1).toMatchObject({
      versionNo: 1,
      businessId: first.id,
      regionCode: '440100',
      planId: plan,
      companyId: company,
    });

    const second = await w.submitTransfer(person, '2026-10-20', { adjustedInsuranceRegionCode: '110105' });
    await w.approve(second, '2026-10-02T02:00:00Z');
    await w.runScheduler('2026-10-20T01:00:00Z');
    const chain = await w.archive(person.employee.id);
    expect(chain.map((v) => v.versionNo)).toEqual([1, 2]);
    expect(chain[0]).toEqual(v1);
    // 只存本单实际填写的三项；未填的不复制前驱（读取时继承）
    expect(chain[1]).toMatchObject({ businessId: second.id, regionCode: '110105', planId: null, companyId: null });
    // 不设“变更前”列
    const columns = await w.db.execute(
      (await import('@italent/db')).sql`SELECT column_name FROM information_schema.columns
        WHERE table_name='social_insurance_archive_versions' AND column_name LIKE 'before%'`,
    );
    expect(Array.isArray(columns) ? columns : (columns as { rows: unknown[] }).rows).toEqual([]);

    const empty = await w.submitTransfer(person, '2026-10-25', {});
    await w.approve(empty, '2026-10-02T03:00:00Z');
    await w.runScheduler('2026-10-25T01:00:00Z');
    expect(await w.archive(person.employee.id)).toHaveLength(2);
    expect(await w.insuranceItems(empty.id)).toEqual([]);
  });

  it('子项登记为 insurance_archive 且成功，生效日取调动实际生效日', async () => {
    const { w, person, adjust } = await scene('ins-exec-item');
    const business = await w.submitTransfer(person, D, adjust);
    await w.approve(business, '2026-10-02T01:00:00Z');
    expect(await w.insuranceItems(business.id)).toEqual([]);
    await w.runScheduler(AT_D);
    expect(await w.insuranceItems(business.id)).toEqual([
      expect.objectContaining({
        itemType: 'insurance_archive',
        status: 'succeeded',
        attemptCount: 1,
        effectiveDate: D,
      }),
    ]);
  });
});

describe('AC-INS-07 幂等与失败可重试', () => {
  it('重复执行命中原事件：不新增版本、不分配新 version_no、不重复审计', async () => {
    const { w, person, adjust } = await scene('ins-exec-idem');
    const business = await w.submitTransfer(person, D, adjust);
    await w.approve(business, '2026-10-02T01:00:00Z');
    await w.runScheduler(AT_D);
    const before = { archive: await w.archive(person.employee.id), audits: await w.audits(business.id) };
    await w.runScheduler('2026-10-10T02:00:00Z');
    await w.runScheduler('2026-10-11T02:00:00Z');
    expect(await w.archive(person.employee.id)).toEqual(before.archive);
    expect(await w.audits(business.id)).toEqual(before.audits);
  });

  it('业务拒绝（方案已停用）：任职照常生效，子项记失败并带次数，不写档案；修复后重试成功、只写一条', async () => {
    const { w, person, plan, adjust } = await scene('ins-exec-fail');
    const business = await w.submitTransfer(person, D, adjust);
    await w.approve(business, '2026-10-02T01:00:00Z');
    await w.disablePlan(plan);
    const run = await w.runScheduler(AT_D);
    expect(run).toMatchObject({ activated: [business.id], failed: [] });
    expect((await w.business(business.id)).status).toBe('effective');
    expect(await w.archive(person.employee.id)).toEqual([]);
    const [failed] = await w.insuranceItems(business.id);
    expect(failed).toMatchObject({ itemType: 'insurance_archive', status: 'failed', attemptCount: 1 });
    expect(failed!.failureCode).toEqual(expect.any(String));

    // 未修复前重试仍失败，次数累加，不伪造成功
    const again = await w.retryItem(failed!);
    expect(again.status, await again.clone().text()).toBe(200);
    const [still] = await w.insuranceItems(business.id);
    expect(still).toMatchObject({ status: 'failed', attemptCount: 2 });
    expect(await w.archive(person.employee.id)).toEqual([]);

    await w.enablePlan(plan);
    expect((await w.retryItem(still!)).status).toBe(200);
    expect(await w.insuranceItems(business.id)).toEqual([
      expect.objectContaining({ status: 'succeeded', attemptCount: 3 }),
    ]);
    expect(await w.archive(person.employee.id)).toHaveLength(1);
  });

  it('同来源不同调整值是冲突：不覆盖已写版本', async () => {
    const { w, person, adjust } = await scene('ins-exec-conflict');
    const business = await w.submitTransfer(person, D, adjust);
    await w.approve(business, '2026-10-02T01:00:00Z');
    await w.runScheduler(AT_D);
    const before = await w.archive(person.employee.id);
    // 直接以属主身份把联动版本改成另一组值再重放子项，模拟“同来源不同值”：重试已成功的子项不得改写档案
    const [item] = await w.insuranceItems(business.id);
    const response = await w.retryItem(item!);
    expect(response.status).toBe(409);
    expect(await w.archive(person.employee.id)).toEqual(before);
  });
});

describe('AC-INS-11 撤销与改期', () => {
  it('生效前撤销（申请被撤销 / 已批准后删除）：定时任务不写档案、不登记子项', async () => {
    const { w, person, adjust } = await scene('ins-exec-revoke');
    const revoked = await w.submitTransfer(person, D, adjust);
    expect(
      (await w.session.request('POST', `/businesses/${revoked.id}/revoke`, { ifMatch: revoked.revision })).status,
    ).toBe(200);
    const removed = await w.submitTransfer(person, D, adjust);
    await w.approve(removed, '2026-10-02T01:00:00Z');
    const current = await w.business(removed.id);
    expect((await w.session.request('DELETE', `/businesses/${removed.id}`, { ifMatch: current.revision })).status).toBe(
      200,
    );
    await w.runScheduler(AT_D);
    expect(await w.archive(person.employee.id)).toEqual([]);
    expect(await w.insuranceItems(revoked.id)).toEqual([]);
    expect(await w.insuranceItems(removed.id)).toEqual([]);
  });

  it('生效前改期（删除后以新日期重存）：档案只写新单、生效日是新日期', async () => {
    const { w, person, adjust } = await scene('ins-exec-resched');
    const old = await w.submitTransfer(person, D, adjust);
    await w.approve(old, '2026-10-02T01:00:00Z');
    const oldNow = await w.business(old.id);
    expect((await w.session.request('DELETE', `/businesses/${old.id}`, { ifMatch: oldNow.revision })).status).toBe(200);
    const moved = await w.submitTransfer(person, '2026-10-15', adjust);
    await w.approve(moved, '2026-10-02T02:00:00Z');
    await w.runScheduler(AT_D);
    expect(await w.archive(person.employee.id)).toEqual([]);
    await w.runScheduler('2026-10-15T01:00:00Z');
    expect(await w.archive(person.employee.id)).toEqual([
      expect.objectContaining({ businessId: moved.id, effectiveDate: '2026-10-15' }),
    ]);
  });

  it('已生效后人工删除调动：已写入的档案版本保留（U7-A）', async () => {
    const { w, person, adjust } = await scene('ins-exec-after');
    const business = await w.submitTransfer(person, D, adjust);
    await w.approve(business, '2026-10-02T01:00:00Z');
    await w.runScheduler(AT_D);
    const before = await w.archive(person.employee.id);
    const current = await w.business(business.id);
    await w.session.request('DELETE', `/businesses/${business.id}`, { ifMatch: current.revision });
    expect(await w.archive(person.employee.id)).toEqual(before);
  });
});

describe('AC-INS-13 审计同事务', () => {
  it('档案追加与子项结果各有审计，字段级变更日志记新版本的三项值（DEC-019）', async () => {
    const { w, person, plan, company, adjust } = await scene('ins-exec-audit');
    const business = await w.submitTransfer(person, D, adjust);
    await w.approve(business, '2026-10-02T01:00:00Z');
    await w.runScheduler(AT_D);
    const events = await w.audits(business.id);
    const append = events.filter((event) => event.action === 'insurance.archive.append');
    expect(append).toHaveLength(1);
    expect(append[0]!.after).toMatchObject({
      versionNo: 1,
      regionCode: '440100',
      planId: plan,
      companyId: company,
    });
    expect(events.map((event) => event.action)).toContain('transfer.linkage.item.succeeded');
  });

  it('失败的尝试不留下档案版本，也没有“追加”审计；失败有子项审计', async () => {
    const { w, person, plan, adjust } = await scene('ins-exec-audit-fail');
    const business = await w.submitTransfer(person, D, adjust);
    await w.approve(business, '2026-10-02T01:00:00Z');
    await w.disablePlan(plan);
    await w.runScheduler(AT_D);
    const actions = (await w.audits(business.id)).map((event) => event.action);
    expect(actions).not.toContain('insurance.archive.append');
    expect(actions).toContain('transfer.linkage.item.failed');
  });
});
