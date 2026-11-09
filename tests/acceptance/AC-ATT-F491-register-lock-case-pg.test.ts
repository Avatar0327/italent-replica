/**
 * AC-ATT-F491-register-lock-case-pg · 附件登记锁键的 UUID 大小写交错（F-491，真 PostgreSQL；PGlite 单连接无法并发）。
 * 登记入口（POST /api/tenant/attachments）按（租户 × 所有人）串行，临时文件数上限才不会被并发突破。租户中间件按原样保留
 * X-Tenant-Id 的大小写，用户 UUID 同理，库按 UUID 值比较：同一所有人的大小写变体必须排在同一把锁后面，不同所有人互不阻塞。
 * 持锁方用登记锁的键文本（小写 `租户:用户:attachments`，与改造前一致），再让真实的登记请求带大小写变体的头进来。
 * 选登记入口而不是别的写入口：它是全仓唯一一处原来自己手拼锁键（toLowerCase）的取锁处，其余取锁处已走公共函数（F-078），
 * 并有各自的 lock-case 用例；已有的 AC-ATT-01 并发用例靠 19→20 个边界的计数间接验证，这里直接验证“排在同一把锁后面”。
 */
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { ATTACHMENTS, attachmentWorld, png, registration } from './AC-ATT-support.js';
import { hold, waitForAdvisoryWaiter } from './support/lock-case.js';

const testDb = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
let a: Awaited<ReturnType<typeof attachmentWorld>>;

beforeAll(async () => {
  if (realPostgres) a = await attachmentWorld(testDb().db, 'att-f491');
});

describe.runIf(realPostgres)('附件登记锁键大小写交错（真 PG）', () => {
  const VARIANTS = [
    ['租户大写、用户小写', 'upper', 'lower'],
    ['租户小写、用户大写', 'lower', 'upper'],
    ['租户与用户都大写', 'upper', 'upper'],
  ] as const;
  const cased = (value: string, form: 'lower' | 'upper') =>
    form === 'upper' ? value.toUpperCase() : value.toLowerCase();

  it.each(VARIANTS)('%s：登记请求排在持锁方后面，持锁方提交后正常 201', async (_name, tenantForm, userForm) => {
    const owner = await a.person('测试员工锁键');
    const tenantId = a.w.tenant.id.toLowerCase();
    const queued = await withTenant(testDb().db, tenantId, async (holder) => {
      await hold(holder, `${tenantId}:${owner.userId.toLowerCase()}:attachments`, 'hashtextextended');
      const pending = a.api
        .request('POST', ATTACHMENTS, {
          user: cased(owner.userId, userForm),
          tenant: cased(tenantId, tenantForm),
          body: registration(png(), `lock-${tenantForm}-${userForm}.png`),
        })
        .then((res) => res.status);
      await waitForAdvisoryWaiter(testDb().db);
      return { pending };
    });
    expect(await queued.pending).toBe(201);
  });

  it('另一位所有人的登记不受持锁方影响（规范化只合并同一 UUID 的大小写变体）', async () => {
    const holderOwner = await a.person('测试员工持锁');
    const other = await a.person('测试员工旁人');
    const tenantId = a.w.tenant.id.toLowerCase();
    await withTenant(testDb().db, tenantId, async (holder) => {
      await hold(holder, `${tenantId}:${holderOwner.userId.toLowerCase()}:attachments`, 'hashtextextended');
      const res = await a.api.request('POST', ATTACHMENTS, {
        user: other.userId.toUpperCase(),
        tenant: tenantId.toUpperCase(),
        body: registration(png(), 'independent.png'),
      });
      expect(res.status).toBe(201); // 持锁方还没提交，请求仍然完成 = 没有被它阻塞
    });
  });
});
