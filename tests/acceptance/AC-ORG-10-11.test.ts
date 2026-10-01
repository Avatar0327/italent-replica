import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgSession, type Organization } from './AC-ORG-support.js';

const testDb = useTestDb();

describe('AC-ORG-10~11 DEC-021 组织全称与生效日期', () => {
  it('AC-ORG-10 全称默认从租户根起算，租户可设置显示起始层级', async () => {
    const session = await orgSession(testDb().db, 'org10');
    const group = await session.create('集团');
    const child = await session.create('部门A', { parents: { admin: { parentId: group.id } } });
    expect(child.fullName).toBe(`${session.tenant.name}/集团/部门A`);
    expect((await session.list('部门A'))[0]?.fullName).toBe(child.fullName);
    const settings = await session.request('PUT', '/settings', {
      ifMatch: 0,
      body: { enabledDimensions: [], fullNameStartLevel: 1 },
    });
    expect(settings.status).toBe(200);
    expect((await session.list('部门A'))[0]?.fullName).toBe('集团/部门A');
  });

  it('AC-ORG-11 上级改名同步改变下级全称，历史时点仍保留旧名称', async () => {
    const session = await orgSession(testDb().db, 'org11');
    const group = await session.create('集团');
    const child = await session.create('部门A', { parents: { admin: { parentId: group.id } } });
    const grandchild = await session.create('团队B', { parents: { admin: { parentId: child.id } } });
    const response = await session.request('PATCH', `/organizations/${group.id}`, {
      ifMatch: group.revision,
      body: { name: '集团X', effectiveDate: '2026-10-02' },
    });
    expect(response.status).toBe(200);
    const renamed = (await response.json()) as Organization;
    expect(renamed.id).toBe(group.id);
    expect(renamed.revision).toBe(2);
    expect((await session.list('团队B', '2026-10-01'))[0]?.fullName).toBe(grandchild.fullName);
    expect((await session.list('团队B', '2026-10-02'))[0]?.fullName).toBe(`${session.tenant.name}/集团X/部门A/团队B`);
    expect((await session.list('集团', '2026-10-01'))[0]?.id).toBe(group.id);
    expect(await session.list('集团', '2026-10-02')).toEqual([]);
  });
});
