/**
 * AC-ORG-15（DEC-130，`10` §11）：新建组织时“设立日期”必填（缺省为租户当天，可倒填或填未来），
 * 组织首个版本的生效日期等于设立日期；新建请求不再单独收生效日期。后续变更照常由变更单填生效日期；
 * 建成后改设立日期走「编辑」（DEC-147，见 AC-ORG-20）。
 */
import { type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgSession, type OrgSession } from './AC-ORG-support.js';
import { seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

async function created(session: OrgSession, body: Record<string, unknown>) {
  const response = await session.request('POST', '/organizations', {
    ifMatch: 0,
    body: { parents: { admin: { parentId: session.tenant.id } }, ...body },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('AC-ORG-15 设立日期必填并作为首个版本的生效日期（DEC-130）', () => {
  it('倒填设立日期：首个版本自设立日期起生效，设立日期前查不到', async () => {
    const session = await orgSession(testDb().db, 'org15backdated');
    const result = await created(session, { name: '倒填设立部门', establishedOn: '2026-09-01' });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ establishedOn: '2026-09-01', startDate: '2026-09-01', revision: 1 });
    expect(await session.list('倒填设立部门', '2026-09-01')).toHaveLength(1);
    expect(await session.list('倒填设立部门', '2026-08-31')).toEqual([]);
  });

  it('不填设立日期时缺省为租户当天（DEC-056），并作为首个版本的生效日期', async () => {
    const session = await orgSession(testDb().db, 'org15default');
    const result = await created(session, { name: '缺省设立部门' });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ establishedOn: '2026-10-01', startDate: '2026-10-01' });
  });

  it('缺省的“当天”按租户时区计算，不按服务器 UTC 日期', async () => {
    const db: Db = testDb().db;
    const { tenant, user } = await seedTenantWithMember(db, 'org15zone', 'America/Los_Angeles');
    const api = tenantApi(db, { clock: () => new Date('2026-10-01T01:00:00.000Z') });
    const response = await api.request('POST', '/api/tenant/org/organizations', {
      user: user.id,
      tenant: tenant.id,
      ifMatch: 0,
      body: { name: '时区设立部门', parents: { admin: { parentId: tenant.id } } },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ establishedOn: '2026-09-30', startDate: '2026-09-30' });
  });

  it('设立日期填未来：首个版本自该日起生效，之前查不到', async () => {
    const session = await orgSession(testDb().db, 'org15future');
    const result = await created(session, { name: '预设未来部门', establishedOn: '2026-12-01' });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ establishedOn: '2026-12-01', startDate: '2026-12-01' });
    expect(await session.list('预设未来部门', '2026-10-01')).toEqual([]);
    expect(await session.list('预设未来部门', '2026-12-01')).toHaveLength(1);
  });

  it('新建不再单独收生效日期，设立日期不能为空', async () => {
    const session = await orgSession(testDb().db, 'org15reject');
    const withStart = await created(session, { name: '单独生效日期', startDate: '2026-09-01' });
    expect(withStart.status).toBe(400);
    const nullEstablished = await created(session, { name: '设立日期为空', establishedOn: null });
    expect(nullEstablished.status).toBe(400);
    expect(nullEstablished.body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(await session.list('单独生效日期', '2026-09-01')).toEqual([]);
    expect(await session.list('设立日期为空')).toEqual([]);
  });

  it('变更照常由变更单填生效日期；「变更」中没有设立日期，改动或清空都 400，须到「编辑」中改（DEC-147）', async () => {
    const session = await orgSession(testDb().db, 'org15change');
    const org = (await created(session, { name: '变更设立部门', establishedOn: '2026-09-01' })).body as {
      id: string;
      revision: number;
    };
    const renamed = await session.request('PATCH', `/organizations/${org.id}`, {
      ifMatch: org.revision,
      body: { name: '变更后名称', effectiveDate: '2026-10-05' },
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ establishedOn: '2026-09-01', startDate: '2026-10-05', revision: 2 });
    for (const establishedOn of ['2026-08-01', null]) {
      const changed = await session.request('PATCH', `/organizations/${org.id}`, {
        ifMatch: 2,
        body: { establishedOn, effectiveDate: '2026-10-06' },
      });
      expect(changed.status).toBe(400);
      expect(await changed.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHED_ON_EDIT_ONLY' } } });
    }
    expect((await session.list('变更后名称', '2026-10-06'))[0]).toMatchObject({ revision: 2 });
  });

  it('预检接口同样按设立日期校验上级在该日是否生效', async () => {
    const session = await orgSession(testDb().db, 'org15validate');
    const parent = await created(session, { name: '十月设立上级', establishedOn: '2026-10-01' });
    const response = await session.request('POST', '/validate', {
      body: {
        name: '早于上级设立的下级',
        establishedOn: '2026-09-01',
        parents: { admin: { parentId: parent.body.id } },
      },
    });
    expect(response.status).toBe(400);
  });
});
