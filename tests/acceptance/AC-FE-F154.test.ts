import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { seedDemo } from '../../apps/api/src/demo/seed.js';
import { createDemoClient, listAll } from '../../apps/api/src/demo/client.js';
import { infoReceipt, projectInfo } from '../../apps/web/src/idp/info-model.js';
const db = useTestDb();

describe('AC-FE-F154 真实种子与提交契约', () => {
  it('AC-FE-F154-09 两次公开接口种子后保持 5 / 4 / 7 条，不新增、不报错', async () => {
    const clock = () => new Date('2026-10-15T02:00:00Z');
    const first = await seedDemo(db().db, { nodeEnv: 'test', clock });
    const call = createDemoClient(db().db, clock, 'test').forTenant(first.manifest.tenantId);
    const admin = first.manifest.personas.find((p) => p.role === '系统管理员')!.userId;
    const inventory = async () =>
      Promise.all(
        ['tutorships', 'careers', 'work-shifts'].map(async (path) => {
          const rows = await listAll(call, admin, `/api/tenant/idp/${path}`);
          return rows.map((r) => r.id).sort();
        }),
      );
    const before = await inventory();
    expect(before.map((r) => r.length)).toEqual([5, 4, 7]);
    const second = await seedDemo(db().db, { nodeEnv: 'test', clock });
    expect(second.created).toBe(false);
    expect(await inventory()).toEqual(before);
    // 非租户成员不能借种子公开入口读取示例人员信息。
    await expect(call('c1540000-0000-4000-8000-000000000099', 'GET', '/api/tenant/idp/careers')).rejects.toThrow('403');
  }, 300_000);
  it('AC-FE-F154-10 写入与删除按真实回执 revision 校验，拒绝伪成功', () => {
    expect(infoReceipt({ id: 'a', revision: 3 }, 2, 'save', 'a').revision).toBe(3);
    expect(infoReceipt({ id: 'a', revision: 2 }, 2, 'delete', 'a').revision).toBe(2);
    expect(() => infoReceipt({ id: 'a', revision: 2 }, 2, 'save', 'a')).toThrow();
    expect(() => infoReceipt({ id: 'b', revision: 3 }, 2, 'save', 'a')).toThrow();
    expect(() => infoReceipt({ id: 'a' }, 2, 'delete', 'a')).toThrow();
    expect(projectInfo('careers', { strengths: '' })).toMatchObject({ strengths: '', employeeId: null });
  });
});
