/**
 * R2 BE-5c2（R2-T04 §9.2，AC-RT-17b）：POST retirement-rules/run?purpose=（立即执行）——
 * - 不占当天登记；一次最多处理一页，回执带 next（retirement_rule_run_cursors.id，随机句柄，不是员工 ID）；
 * - 续跑请求带 cursor：候选超过一页时推进到结束；
 * - 跨租户、跨用户、跨业务日（次日用前日句柄）、把自动转正句柄传给退休接口，均 400 RETIREMENT_RUN_CURSOR_INVALID；
 * - 对应开关关闭 → 400 RETIREMENT_AUTO_DISABLED（设计未写，取保守做法）；purpose 缺失 / 非法 → 400；
 * - 写入规则同批次：已核准不改写（AC-RT-02）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { RETIREMENT_BATCH_LIMITS } from '../../apps/api/src/modules/employment/retirement-scheduler.js';
import { batchWorld, rows, type BatchWorld, type Purpose } from './AC-RT-batch-support.js';
import { addMember } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const original = RETIREMENT_BATCH_LIMITS.page;
afterEach(() => {
  RETIREMENT_BATCH_LIMITS.page = original;
});

interface Receipt {
  businessDate: string;
  purpose: Purpose;
  updated: { employeeId: string; ruleId: string | null }[];
  failed: { employeeId: string; reason: string }[];
  next: string | null;
}

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; details?: { reason?: string } } }).error;

function runNow(w: BatchWorld, purpose: Purpose | undefined, body: unknown = {}) {
  const query = purpose ? `?purpose=${purpose}` : '';
  return w.session.request('POST', `/retirement-rules/run${query}`, { ifMatch: 0, body });
}
async function receiptOf(response: Response): Promise<Receipt> {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Receipt;
}

async function ready(label: string, count: number) {
  const w = await batchWorld(testDb().db, label);
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) ids.push(await w.member(`立即执行员工${i}`));
  ids.sort();
  await w.fixedAgeRule(60);
  await w.setSwitch('expected_date', true);
  return { w, ids };
}

describe('AC-RT-17b 立即执行与游标', () => {
  it('候选超过一页：回执带 next（随机句柄），续跑处理下一页至结束；不占当天登记', async () => {
    const { w, ids } = await ready('rt17b-pages', 5);
    RETIREMENT_BATCH_LIMITS.page = 2;

    const first = await receiptOf(await runNow(w, 'expected_date'));
    expect(first.updated.map((item) => item.employeeId)).toEqual(ids.slice(0, 2));
    expect(first.next).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(ids).not.toContain(first.next);

    const second = await receiptOf(await runNow(w, 'expected_date', { cursor: first.next }));
    expect(second.updated.map((item) => item.employeeId)).toEqual(ids.slice(2, 4));
    expect(second.next).not.toBeNull();

    const third = await receiptOf(await runNow(w, 'expected_date', { cursor: second.next }));
    expect(third.updated.map((item) => item.employeeId)).toEqual(ids.slice(4));
    expect(third.next).toBeNull();

    for (const id of ids) expect((await w.personOf(id)).expected).toBe('2035-06-30');
    expect(await w.runCount()).toBe(0);
  });

  it('已核准的 P 不被立即执行改写（AC-RT-02）；算出值相同不写', async () => {
    const w = await batchWorld(testDb().db, 'rt17b-confirmed');
    const confirmed = await w.member('已核准', {
      expectedRetirementDate: '2031-01-31',
      expectedRetirementConfirmed: true,
    });
    const same = await w.member('同值', { expectedRetirementDate: '2035-06-30', expectedRetirementConfirmed: false });
    await w.fixedAgeRule(60);
    await w.setSwitch('expected_date', true);
    const before = [await w.personOf(confirmed), await w.personOf(same)];
    const receipt = await receiptOf(await runNow(w, 'expected_date'));
    expect(receipt.updated).toEqual([]);
    expect([await w.personOf(confirmed), await w.personOf(same)]).toEqual(before);
  });

  it('开关关闭 → 400 RETIREMENT_AUTO_DISABLED；purpose 缺失 / 非法 → 400；cursor 非 UUID → 400', async () => {
    const { w } = await ready('rt17b-invalid', 1);
    const off = await runNow(w, 'flexible_range');
    expect(off.status).toBe(400);
    expect((await errorOf(off)).details?.reason).toBe('RETIREMENT_AUTO_DISABLED');
    expect((await runNow(w, undefined)).status).toBe(400);
    const bad = await w.session.request('POST', '/retirement-rules/run?purpose=other', { ifMatch: 0, body: {} });
    expect(bad.status).toBe(400);
    const notUuid = await runNow(w, 'expected_date', { cursor: 'not-a-uuid' });
    expect(notUuid.status).toBe(400);
    expect((await runNow(w, 'expected_date', { extra: 1 })).status).toBe(400);
  });

  it('句柄只对签发它的租户 × 操作人 × 用途 × 业务日有效：其余一律 400 RETIREMENT_RUN_CURSOR_INVALID', async () => {
    const { w } = await ready('rt17b-cursor', 4);
    RETIREMENT_BATCH_LIMITS.page = 2;
    const handle = (await receiptOf(await runNow(w, 'expected_date'))).next!;
    const invalid = async (response: Response) => {
      expect(response.status, await response.clone().text()).toBe(400);
      expect((await errorOf(response)).details?.reason).toBe('RETIREMENT_RUN_CURSOR_INVALID');
    };

    // 跨用途
    await w.setSwitch('flexible_range', true);
    await invalid(await runNow(w, 'flexible_range', { cursor: handle }));

    // 跨用户（同租户的另一名操作人）
    const other = await addMember({ db: w.db, tenant: w.session.tenant } as never, '另一操作人');
    await invalid(
      await tenantApi(w.db).request('POST', '/api/tenant/employment/retirement-rules/run?purpose=expected_date', {
        user: other.id,
        tenant: w.tenantId,
        ifMatch: 0,
        body: { cursor: handle },
      }),
    );

    // 跨租户（RLS 查不到，不泄露存在性）
    const foreign = await batchWorld(testDb().db, 'rt17b-cursor-foreign');
    await foreign.setSwitch('expected_date', true);
    await invalid(await runNow(foreign, 'expected_date', { cursor: handle }));

    // 把自动转正的句柄传给退休接口
    const autoHandle = randomUUID();
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`INSERT INTO employment_auto_regularization_run_cursors(id, tenant_id, user_id, business_date,
          position_employee_id, command_id)
        VALUES (${autoHandle}::uuid, ${w.tenantId}, ${w.userId}::uuid, '2026-10-01'::date, ${randomUUID()}::uuid, 'x')`),
    );
    await invalid(await runNow(w, 'expected_date', { cursor: autoHandle }));

    // 跨业务日：次日用前日句柄
    w.session.setNow('2026-10-02T01:00:00.000Z');
    await invalid(await runNow(w, 'expected_date', { cursor: handle }));
    w.session.setNow('2026-10-01T01:00:00.000Z');
    expect((await runNow(w, 'expected_date', { cursor: handle })).status).toBe(200);
  });

  it('句柄表只增不改：库里只存位置，回执里没有员工 ID 之外的内部位置', async () => {
    const { w } = await ready('rt17b-store', 3);
    RETIREMENT_BATCH_LIMITS.page = 2;
    const receipt = await receiptOf(await runNow(w, 'expected_date'));
    const stored = await withTenant(w.db, w.tenantId, async (tx) =>
      rows<{ userId: string; purpose: string; businessDate: string }>(
        await tx.execute(sql`SELECT user_id::text AS "userId", purpose, business_date::text AS "businessDate"
          FROM retirement_rule_run_cursors WHERE tenant_id=${w.tenantId} AND id=${receipt.next}::uuid`),
      ),
    );
    expect(stored).toEqual([{ userId: w.userId, purpose: 'expected_date', businessDate: '2026-10-01' }]);
  });
});
