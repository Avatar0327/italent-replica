/**
 * F-474-8c-2c 第 2 轮审查（P1 / P2-1）：社保子项重试与手工入口同权——
 * ① 撤掉三个社保调整字段的编辑权后，已知子项 ID / revision 也不能重试写档案（入口、命令守卫、员工锁内同口径）；
 * ② 失败子项在源调动被删除后不得首次追加档案，已写入的版本照旧保留（U7-A）。
 * 真实 HTTP + 真实定时任务；受控权限替身只撤字段编辑权，保留任职编辑、重试按钮与员工范围。
 */
import { sql } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { controlledApi, D } from './AC-LNK-support.js';
import { asOwner } from './support/insurance-tables.js';
import { insuranceScene, type InsuranceWriteWorld } from './support/insurance-write.js';

const testDb = useTestDb();
const EMPLOYMENT = MODULE_OBJECTS.employmentRecord.code;
const AT_D = `${D}T01:00:00Z`;
const RETRY = '/api/tenant/employment/transfers/linkage-items';
const REGION = 'adjustedInsuranceRegionCode';
const PLAN = 'adjustedInsurancePlanId';
const COMPANY = 'adjustedInsuranceCompanyId';

type Request = { action: string; resource?: string; fields?: readonly string[] };
const editing =
  (...fields: string[]) =>
  (request: Request) =>
    request.action.startsWith('object.') &&
    request.action !== 'object.view' &&
    request.resource === EMPLOYMENT &&
    !!request.fields?.some((field) => fields.includes(field));

/** 方案停用致失败 → 恢复方案，剩下一条可重试的失败社保子项。 */
async function failedItem(w: InsuranceWriteWorld, person: { employee: { id: string } }, plan: string, adjust: object) {
  const business = await w.submitTransfer(person, D, adjust);
  await w.approve(business, '2026-10-02T01:00:00Z');
  await w.disablePlan(plan);
  await w.runScheduler(AT_D);
  const [item] = await w.insuranceItems(business.id);
  expect(item).toMatchObject({ status: 'failed', attemptCount: 1 });
  return { business, item: item! };
}

describe('P1 社保子项重试复核三个调整字段的当前编辑权（fail-closed）', () => {
  it('撤掉社保调整字段编辑权（保留任职编辑与重试权）：重试 403，档案与子项不变；未撤权的同一重试成功', async () => {
    const { w, person, plan, adjust } = await insuranceScene(testDb().db, 'ins-retry-auth');
    const { business, item } = await failedItem(w, person, plan, adjust);
    await w.enablePlan(plan);

    const revoked = controlledApi(
      w.db,
      w.tenantId,
      w.session.user.id,
      { deny: editing(REGION, PLAN, COMPANY) },
      `${D}T02:00:00Z`,
    );
    const denied = await revoked('POST', `${RETRY}/${item.id}/retry`, { body: {}, ifMatch: item.revision });
    expect(denied.status, await denied.clone().text()).toBe(403);
    expect(await w.archive(person.employee.id)).toEqual([]);
    expect(await w.insuranceItems(business.id)).toEqual([item]);

    const granted = controlledApi(w.db, w.tenantId, w.session.user.id, {}, `${D}T02:00:00Z`);
    const ok = await granted('POST', `${RETRY}/${item.id}/retry`, { body: {}, ifMatch: item.revision });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await w.archive(person.employee.id)).toHaveLength(1);
  });

  it('只复核已保存的非空调整字段：只填缴交地时，撤方案 / 公司编辑权不影响重试，撤缴交地编辑权则 403', async () => {
    const { w, person } = await insuranceScene(testDb().db, 'ins-retry-auth-partial');
    const business = await w.submitTransfer(person, D, { adjustedInsuranceRegionCode: '440100' });
    await w.approve(business, '2026-10-02T01:00:00Z');
    await w.runScheduler(AT_D);
    // 把已成功的子项置为失败（属主身份，模拟一次被拒的尝试）：同来源同值重试命中原事件，不新增版本
    await asOwner(w.db, w.tenantId, (tx) =>
      tx.execute(sql`UPDATE transfer_linkage_items SET status='failed', failure_code='CONFLICT', revision=revision+1
        WHERE tenant_id=${w.tenantId} AND business_id=${business.id}::uuid AND item_type='insurance_archive'`),
    );
    const [item] = await w.insuranceItems(business.id);
    expect(item).toMatchObject({ status: 'failed' });
    const at = `${D}T02:00:00Z`;

    const regionRevoked = controlledApi(w.db, w.tenantId, w.session.user.id, { deny: editing(REGION) }, at);
    const denied = await regionRevoked('POST', `${RETRY}/${item!.id}/retry`, { body: {}, ifMatch: item!.revision });
    expect(denied.status, await denied.clone().text()).toBe(403);

    const others = controlledApi(w.db, w.tenantId, w.session.user.id, { deny: editing(PLAN, COMPANY) }, at);
    const ok = await others('POST', `${RETRY}/${item!.id}/retry`, { body: {}, ifMatch: item!.revision });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await w.archive(person.employee.id)).toHaveLength(1);
  });
});

describe('P2-1 源调动删除后，失败的社保子项不得首次追加档案', () => {
  it('失败 → 删除调动 → 恢复方案 → 重试：档案零新增，子项保持失败并带可辨认的失败原因', async () => {
    const { w, person, plan, adjust } = await insuranceScene(testDb().db, 'ins-retry-deleted');
    const { business, item } = await failedItem(w, person, plan, adjust);
    const current = await w.business(business.id);
    const removed = await w.session.request('DELETE', `/businesses/${business.id}`, { ifMatch: current.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    await w.enablePlan(plan);

    const retried = await w.retryItem(item);
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(await w.archive(person.employee.id)).toEqual([]);
    expect(await w.insuranceItems(business.id)).toEqual([
      expect.objectContaining({ status: 'failed', attemptCount: 2, failureRule: 'INSURANCE_SOURCE_DELETED' }),
    ]);
    expect((await w.auditRows(business.id)).map((event) => event.action)).not.toContain('insurance.archive.append');
  });

  it('已写入的版本照旧保留（U7-A）：生效后删除调动，档案不变', async () => {
    const { w, person, adjust } = await insuranceScene(testDb().db, 'ins-retry-deleted-kept');
    const business = await w.submitTransfer(person, D, adjust);
    await w.approve(business, '2026-10-02T01:00:00Z');
    await w.runScheduler(AT_D);
    const before = await w.archive(person.employee.id);
    expect(before).toHaveLength(1);
    const current = await w.business(business.id);
    const removed = await w.session.request('DELETE', `/businesses/${business.id}`, { ifMatch: current.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await w.archive(person.employee.id)).toEqual(before);
  });
});
