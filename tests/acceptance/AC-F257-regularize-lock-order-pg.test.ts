/**
 * F-257（#437 R2 P3）直接转正锁序（真 PostgreSQL，普通角色 app_owner）：契约锁序是 组织 → 编制 → 审批实例。
 * 无在途调动、只有审批中的转正申请时，直接转正作废该申请前必须已持有编制锁——
 * 测试会话先持住该申请的审批实例锁，让直接转正请求停在“等实例锁”这一步，再用 NOWAIT 探针取编制行：
 * 编制锁已被请求先取得 → 探针失败（55P03）；若编制锁晚于实例锁，探针会取到，用例判红。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { endWorld } from './AC-INTERN-end-support.js';
import { waitForBlocked } from './support/pg-interleave.js';

const testDb = useTestDb();

/** NOWAIT 取不到锁时 PG 报 55P03；drizzle 把驱动错误包在 cause 里，沿链找。 */
function lockNotAvailable(error: unknown): boolean {
  for (let cur = error as { code?: string; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    if (cur.code === '55P03') return true;
  }
  return false;
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-F257 直接转正锁序（真 PG，app_owner）', () => {
  it('无在途调动、只有审批中的转正申请：请求等审批实例锁时，编制行已被它持有（NOWAIT 取不到）', async () => {
    const w = await endWorld(testDb().db, 'pg-f257-lock-order');
    const intern = await w.hire('F257锁序合成实习生', 'intern');
    const applicationId = await w.applyRegularization(intern.employee.id, '2026-10-20');
    const instance = await w.instanceOf(applicationId);
    expect(instance?.status).toBe('running');
    // 编制设置行预先存在并提交：否则请求自己的 INSERT 未提交，探针看不到该行，验证不了任何锁
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`INSERT INTO establishment_settings (tenant_id) VALUES (${w.tenantId}::uuid)
        ON CONFLICT DO NOTHING`),
    );

    let release!: () => void;
    let held!: () => void;
    const hold = new Promise<void>((done) => (release = done));
    const locked = new Promise<void>((done) => (held = done));
    const holder = withTenant(w.db, w.tenantId, async (tx) => {
      await tx.execute(sql`SELECT 1 FROM approval_instances WHERE tenant_id=${w.tenantId}::uuid
        AND id=${instance!.id}::uuid FOR UPDATE`);
      held();
      await hold;
    });
    await locked;
    const request = w.regularize(intern.employee.id, {
      effectiveDate: '2026-10-16',
      departmentId: w.org.id,
      probation: false,
    });
    await waitForBlocked(w.db, 1);

    let probeError: unknown;
    try {
      await withTenant(w.db, w.tenantId, (tx) =>
        tx.execute(sql`SELECT 1 FROM establishment_settings WHERE tenant_id=${w.tenantId}::uuid FOR UPDATE NOWAIT`),
      );
    } catch (error) {
      probeError = error;
    }
    release();
    await holder;
    const response = await request;
    expect(response.status, await response.clone().text()).toBe(201);
    expect(lockNotAvailable(probeError), '请求等实例锁时编制锁应已先取得').toBe(true);
    expect(await w.statusOf(applicationId)).toBe('voided');
  });
});
