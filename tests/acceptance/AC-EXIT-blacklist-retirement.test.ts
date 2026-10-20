/**
 * R2 BE-8b1 × BE-5a（R2-T04 设计 §3.2、§7.2）：退休复用离职侧的加黑接线。
 * - 退休可写 exit 区块里的 addToBlacklist，以及 BE-8b1 加的加黑原因 / 有效截止日期 / 说明（同一个 resolveBlacklistFields 校验）；
 * - 退休生效后手动勾选照常写名单（source = manual，加黑日期 = 生效日，记下退休请求 ID）；
 * - 自动加黑规则是“离职”自动加黑（DM-R3）：只对离职生效，退休不自动加黑。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { blacklistApi } from './AC-DM-R2-blacklist-support.js';
import { retireBody, retirementWorld } from './AC-RT-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const DUE = '2026-10-05';
const MANUAL = { addToBlacklist: true, blacklistReason: 'integrity', blacklistNote: '合成说明' };

async function world(label: string) {
  const x = await retirementWorld(database().db, `bl-rt-${label}`, TODAY);
  const tenantId = x.session.tenant.id;
  const page = blacklistApi(x.session);
  const rowsOf = (employeeId: string) =>
    x.sqlRows<{
      source: string;
      reason: string;
      blacklistDate: string;
      exitRequestId: string | null;
      status: string;
    }>(sql`
      SELECT source, reason, blacklist_date::text AS "blacklistDate", exit_request_id::text AS "exitRequestId", status
      FROM employment_blacklist WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid ORDER BY created_at`);
  async function autoOn() {
    const as = { tenant: tenantId, user: x.session.user.id };
    const put = await x.api.request('PUT', '/api/tenant/settings/exit.auto_blacklist_enabled', {
      ...as,
      ifMatch: 0,
      body: { value: true },
    });
    expect(put.status, await put.clone().text()).toBe(200);
    const rule = await x.session.request('POST', '/blacklist-rules', {
      ifMatch: 0,
      body: {
        name: '退休不适用',
        priority: 1,
        orgIds: [x.from.id],
        conditions: [{ field: 'exitCount', operator: 'gte', value: 1 }],
        term: 'permanent',
        reason: 'instability',
      },
    });
    expect(rule.status, await rule.clone().text()).toBe(201);
  }
  return { ...x, tenantId, page, rowsOf, autoOn };
}

describe('退休接入 BE-8b1 加黑', () => {
  it('退休手动勾选加入黑名单：生效后写一行 manual，加黑日期 = 生效日，记下退休请求 ID', async () => {
    const x = await world('manual');
    await x.setExpectedRetirement(DUE);
    const created = await x.createdRetire(x.employee.id, retireBody(DUE, 'direct', MANUAL));
    expect(created.status).toBe('effective');
    expect(await x.rowsOf(x.employee.id)).toEqual([
      { source: 'manual', reason: 'integrity', blacklistDate: TODAY, exitRequestId: created.id, status: 'active' },
    ]);
    expect((await x.page.list()).items).toHaveLength(1);
  });

  it('退休的加黑字段与离职同一校验：未勾选带原因 400；勾选不带原因 400；离职专用字段仍被拒绝', async () => {
    const x = await world('validate');
    await x.setExpectedRetirement(DUE);
    const reasonOf = async (exit: object) => {
      const response = await x.createRetire(x.employee.id, retireBody(DUE, 'direct', exit));
      const body = (await response.json()) as { error?: { code: string; details?: { reason?: string } } };
      return { status: response.status, code: body.error?.code, reason: body.error?.details?.reason };
    };
    expect(await reasonOf({ blacklistReason: 'integrity' })).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      reason: 'EXIT_BLACKLIST_FIELDS_NOT_ALLOWED',
    });
    expect(await reasonOf({ addToBlacklist: true })).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      reason: 'EXIT_BLACKLIST_REASON_REQUIRED',
    });
    expect(await reasonOf({ exitTypeCode: 'voluntary' })).toMatchObject({
      status: 400,
      reason: 'RETIREMENT_FIELD_NOT_ALLOWED',
    });
    expect(await x.rowsOf(x.employee.id)).toEqual([]);
  });

  it('自动加黑只对离职：总开关开启、规则命中，退休生效也不自动加黑', async () => {
    const x = await world('auto-leave-only');
    await x.autoOn();
    await x.setExpectedRetirement(DUE);
    const created = await x.createdRetire(x.employee.id, retireBody(DUE, 'direct'));
    expect(created.status).toBe('effective');
    expect(await x.rowsOf(x.employee.id)).toEqual([]);
  });
});
