import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgSession, type Organization, resultRows } from './AC-ORG-support.js';

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

  it('AC-ORG-10 显示起始层级统一用于 POST、PATCH、GET 与列表，存储仍保留租户根全路径', async () => {
    const { db } = testDb();
    const session = await orgSession(db, 'org10-write-display');
    const settings = await session.request('PUT', '/settings', {
      ifMatch: 0,
      body: { enabledDimensions: [], fullNameStartLevel: 1 },
    });
    expect(settings.status).toBe(200);
    const group = await session.create('集团');
    expect(group.fullName).toBe('集团');
    const child = await session.create('部门A', { parents: { admin: { parentId: group.id } } });
    expect(child.fullName).toBe('集团/部门A');
    const createdDetail = await session.request('GET', `/organizations/${child.id}?asOf=2026-10-01`);
    expect(createdDetail.status).toBe(200);
    expect((await createdDetail.json()) as Organization).toMatchObject({ id: child.id, fullName: child.fullName });
    expect((await session.list('部门A'))[0]?.fullName).toBe(child.fullName);

    const response = await session.request('PATCH', `/organizations/${child.id}`, {
      ifMatch: child.revision,
      body: { name: '部门X', effectiveDate: '2026-10-02' },
    });
    expect(response.status).toBe(200);
    const updated = (await response.json()) as Organization;
    expect(updated).toMatchObject({ id: child.id, fullName: '集团/部门X', revision: 2 });
    const updatedDetail = await session.request('GET', `/organizations/${child.id}?asOf=2026-10-02`);
    expect(updatedDetail.status).toBe(200);
    expect((await updatedDetail.json()) as Organization).toMatchObject({ id: child.id, fullName: updated.fullName });
    expect((await session.list('部门X', '2026-10-02'))[0]?.fullName).toBe(updated.fullName);
    expect((await session.list('部门A', '2026-10-01'))[0]?.fullName).toBe(child.fullName);

    const stored = await withTenant(db, session.tenant.id, (tx) =>
      tx.execute(sql`
        SELECT full_name FROM org_versions
        WHERE tenant_id = ${session.tenant.id} AND org_id = ${child.id}
        ORDER BY version_no
      `),
    );
    expect(resultRows<{ full_name: string }>(stored).map((row) => row.full_name)).toEqual([
      `${session.tenant.name}/集团/部门A`,
      `${session.tenant.name}/集团/部门X`,
    ]);
  });
});
