import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgSession } from './AC-ORG-support.js';

const testDb = useTestDb();

describe('AC-ORG-07/11 组织历史版本与结构化引用安全', () => {
  it('仅修改业务上级不会要求重复行政上级，也不会修改行政路径和全称', async () => {
    const session = await orgSession(testDb().db, 'org-partial-dimension');
    expect(
      (
        await session.request('PUT', '/settings', {
          ifMatch: 0,
          body: { enabledDimensions: ['business'], fullNameStartLevel: 0 },
        })
      ).status,
    ).toBe(200);
    const a = await session.create('行政上级');
    const b = await session.create('新业务上级');
    const child = await session.create('单维度调整部门', {
      parents: { admin: { parentId: a.id }, business: { parentId: a.id, sequence: 1 } },
    });
    const response = await session.request('PATCH', `/organizations/${child.id}`, {
      ifMatch: child.revision,
      body: { effectiveDate: '2026-10-02', parents: { business: { parentId: b.id, sequence: 2 } } },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      fullName: child.fullName,
      parents: { admin: { parentId: a.id }, business: { parentId: b.id, sequence: 2 } },
    });
  });

  it('历史时点修改扩展维度也不能与已排定的未来关系形成环，失败后整体回滚', async () => {
    const session = await orgSession(testDb().db, 'org-future-cycle');
    const settings = await session.request('PUT', '/settings', {
      ifMatch: 0,
      body: { enabledDimensions: ['business'], fullNameStartLevel: 0 },
    });
    expect(settings.status).toBe(200);
    const parents = {
      admin: { parentId: session.tenant.id },
      business: { parentId: session.tenant.id },
    };
    const a = await session.create('业务A', { parents });
    const b = await session.create('业务B', { parents });
    const future = await session.request('PATCH', `/organizations/${b.id}`, {
      ifMatch: b.revision,
      body: {
        effectiveDate: '2026-10-10',
        parents: { admin: { parentId: session.tenant.id }, business: { parentId: a.id } },
      },
    });
    expect(future.status).toBe(200);
    const cyclic = await session.request('PATCH', `/organizations/${a.id}`, {
      ifMatch: a.revision,
      body: {
        addEmployment: false,
        effectiveDate: '2026-10-02',
        parents: { admin: { parentId: session.tenant.id }, business: { parentId: b.id } },
      },
    });
    expect(cyclic.status).toBe(400);
    expect((await session.list('业务A', '2026-10-10'))[0]).toMatchObject({
      revision: 1,
      parents: { business: { parentId: session.tenant.id } },
    });
  });

  it('关闭维度后普通改名保留历史关系，但不能修改已关闭维度的上级或顺序', async () => {
    const session = await orgSession(testDb().db, 'org-disabled-links');
    expect(
      (
        await session.request('PUT', '/settings', {
          ifMatch: 0,
          body: { enabledDimensions: ['business'], fullNameStartLevel: 0 },
        })
      ).status,
    ).toBe(200);
    const parent = await session.create('业务上级');
    const child = await session.create('关闭前部门', {
      parents: {
        admin: { parentId: session.tenant.id },
        business: { parentId: parent.id, sequence: 1 },
      },
    });
    expect(
      (
        await session.request('PUT', '/settings', {
          ifMatch: 1,
          body: { enabledDimensions: [], fullNameStartLevel: 0 },
        })
      ).status,
    ).toBe(200);
    const rename = await session.request('PATCH', `/organizations/${child.id}`, {
      ifMatch: child.revision,
      body: { addEmployment: false, effectiveDate: '2026-10-02', name: '关闭后部门' },
    });
    expect(rename.status).toBe(200);
    expect(await rename.json()).toMatchObject({
      revision: 2,
      parents: { business: { parentId: parent.id, sequence: 1 } },
    });
    const forbidden = await session.request('PATCH', `/organizations/${child.id}`, {
      ifMatch: 2,
      body: { effectiveDate: '2026-10-03', parents: { business: { parentId: parent.id, sequence: 2 } } },
    });
    expect(forbidden.status).toBe(400);
  });

  it('DEC-134：成本中心未启用，任意 UUID 一律 400 拒绝，不会接受其他租户对象', async () => {
    const session = await orgSession(testDb().db, 'org-cost-center-ref');
    const response = await session.request('POST', '/organizations', {
      ifMatch: 0,
      body: {
        name: '未验证引用',
        parents: { admin: { parentId: session.tenant.id } },
        costCenterId: randomUUID(),
      },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'COST_CENTER_NOT_ENABLED' } } });
    expect(await session.list('未验证引用')).toEqual([]);
  });

  it('PATCH 上级信息传 null 是字段错误，不能悄悄保留原值并写新版本', async () => {
    const session = await orgSession(testDb().db, 'org-null-parent-patch');
    const child = await session.create('字段校验部门');
    const response = await session.request('PATCH', `/organizations/${child.id}`, {
      ifMatch: child.revision,
      body: { effectiveDate: '2026-10-02', parents: null },
    });
    expect(response.status).toBe(400);
    expect((await session.list('字段校验部门'))[0]?.revision).toBe(1);
  });

  it('DEC-072：已有未来版本时拒绝插入更早变更，且数据不变', async () => {
    const session = await orgSession(testDb().db, 'org-future-full-name');
    const group = await session.create('历史集团');
    const child = await session.create('跨版本部门', {
      parents: { admin: { parentId: group.id } },
      location: '旧地点',
    });
    const future = await session.request('PATCH', `/organizations/${child.id}`, {
      ifMatch: child.revision,
      body: { effectiveDate: '2026-10-10', location: '新地点' },
    });
    expect(future.status).toBe(200);
    const rename = await session.request('PATCH', `/organizations/${child.id}`, {
      ifMatch: 2,
      body: { addEmployment: false, effectiveDate: '2026-10-02', name: '不得插入的名称' },
    });
    expect(rename.status).toBe(409);
    expect(await rename.json()).toMatchObject({ error: { code: 'ORG_FUTURE_VERSION_EXISTS' } });
    expect((await session.list('跨版本部门', '2026-10-01'))[0]).toMatchObject({
      fullName: child.fullName,
      location: '旧地点',
    });
    expect((await session.list('跨版本部门', '2026-10-02'))[0]).toMatchObject({
      fullName: child.fullName,
      location: '旧地点',
    });
    expect((await session.list('跨版本部门', '2026-10-10'))[0]).toMatchObject({
      fullName: child.fullName,
      location: '新地点',
    });
  });

  it('组织编码随版本保存，历史时点仍返回旧编码', async () => {
    const session = await orgSession(testDb().db, 'org-versioned-code');
    const org = await session.create('版本编码部门', { code: 'CODE-OLD' });
    const changed = await session.request('PATCH', `/organizations/${org.id}`, {
      ifMatch: org.revision,
      body: { effectiveDate: '2026-10-02', code: 'CODE-NEW' },
    });
    expect(changed.status).toBe(200);
    expect((await session.list('版本编码部门', '2026-10-01'))[0]?.code).toBe('CODE-OLD');
    expect((await session.list('版本编码部门', '2026-10-02'))[0]?.code).toBe('CODE-NEW');
    const duplicate = await session.request('POST', '/organizations', {
      ifMatch: 0,
      body: { code: 'CODE-NEW', name: '编码冲突', parents: { admin: { parentId: session.tenant.id } } },
    });
    expect(duplicate.status).toBe(409);
  });
});
