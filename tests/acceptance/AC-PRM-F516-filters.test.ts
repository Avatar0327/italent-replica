import { setUserStatus, revokeMembership } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE, addMember } from './AC-PRM-support.js';
import { f516World } from './AC-PRM-F516-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
describe('AC-PRM-F516 联系邮箱与账号状态独立筛选', () => {
  let w: Awaited<ReturnType<typeof f516World>>;
  let first: Awaited<ReturnType<typeof w.person>>;
  let second: Awaited<ReturnType<typeof w.person>>;
  let disabledId: string;
  beforeAll(async () => {
    w = await f516World(database().db);
    first = await w.person('合成甲', null, 'Zhang.San@example.com');
    second = await w.person('合成乙', null, 'zhang.si@example.com');
    await w.person('zhang仅姓名', null, 'Other@example.com');
    const disabled = await addMember(w, '合成停用账号');
    disabledId = disabled.id;
    await setUserStatus(w.db, { userId: disabled.id, status: 'disabled', expectedRevision: disabled.revision }, cmd());
    await revokeMembership(w.db, { tenantId: w.tenant.id, userId: first.userId, expectedRevision: 1 }, cmd());
  });
  it('邮箱包含匹配忽略大小写，独立于混合 q，分页 total 同口径', async () => {
    const one = await w.page('/users?contactEmail=ZHANG&limit=1');
    const two = await w.page('/users?contactEmail=ZHANG&limit=1&offset=1');
    expect(one.total).toBe(2);
    expect(two.total).toBe(2);
    expect(new Set([...one.items, ...two.items].map((row) => row.userId))).toEqual(
      new Set([first.userId, second.userId]),
    );
    expect((await w.page('/users?q=合成甲&contactEmail=si')).total).toBe(0);
    expect((await w.page('/users?q=zhang')).total).toBe(3);
    for (const value of ['%', '_', '\\', 'missing']) {
      expect((await w.page(`/users?${new URLSearchParams({ contactEmail: value })}`)).total).toBe(0);
    }
  });
  it('默认启用与显式停用按全局账号投影，成员已撤销的启用账号仍命中', async () => {
    const enabled = await w.page('/users');
    expect(enabled.items.every((row) => row.accountStatus === 'active')).toBe(true);
    expect(enabled.items.find((row) => row.userId === first.userId)).toMatchObject({ membershipStatus: 'revoked' });
    const disabled = await w.page('/users?accountStatus=disabled');
    expect(disabled.items.map((row) => row.userId)).toEqual([disabledId]);
    expect(disabled.total).toBe(1);
    expect(
      (await w.page('/users?accountStatus=active&membershipStatus=revoked')).items.map((row) => row.userId),
    ).toEqual([first.userId]);
  });
  it('无匹配为空，邮箱范围裁剪；无字段权限拒绝筛选，非法参数 400', async () => {
    expect((await w.page('/users?contactEmail=zhang', w.restricted([second.id]))).total).toBe(1);
    const hidden = await w
      .restricted(undefined, ['email'])
      .request('GET', `${BASE}/users?contactEmail=zhang`, w.asAdmin);
    expect(hidden.status).toBe(403);
    for (const query of ['accountStatus=revoked', 'contactEmail=', `contactEmail=${'x'.repeat(101)}`]) {
      expect((await w.api.request('GET', `${BASE}/users?${query}`, w.asAdmin)).status).toBe(400);
    }
  });
});
