/**
 * AC-ORG-16（DEC-134，`10` §13）：组织上的标准“成本中心”引用不纳入 R1，一律视为未启用——
 * 新建、变更、预检带 costCenterId 时返回 400，带可机读原因 COST_CENTER_NOT_ENABLED，不再返回 503，也不写入。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgSession } from './AC-ORG-support.js';

const testDb = useTestDb();
const disabled = {
  error: {
    code: 'VALIDATION_FAILED',
    details: { reason: 'COST_CENTER_NOT_ENABLED', fields: { costCenterId: expect.any(String) } },
  },
};

describe('AC-ORG-16 成本中心未启用（DEC-134）', () => {
  it('新建与预检带成本中心返回 400 COST_CENTER_NOT_ENABLED，不写入', async () => {
    const session = await orgSession(testDb().db, 'org16create');
    const body = {
      name: '带成本中心部门',
      parents: { admin: { parentId: session.tenant.id } },
      costCenterId: randomUUID(),
    };
    const create = await session.request('POST', '/organizations', { ifMatch: 0, body });
    expect(create.status).toBe(400);
    expect(await create.json()).toMatchObject(disabled);
    const validate = await session.request('POST', '/validate', { body });
    expect(validate.status).toBe(400);
    expect(await validate.json()).toMatchObject(disabled);
    expect(await session.list('带成本中心部门')).toEqual([]);
  });

  it('变更带成本中心返回 400，组织不变；显式传 null 不算引用', async () => {
    const session = await orgSession(testDb().db, 'org16update');
    const org = await session.create('变更成本中心部门');
    const update = await session.request('PATCH', `/organizations/${org.id}`, {
      ifMatch: org.revision,
      body: { costCenterId: randomUUID(), effectiveDate: '2026-10-02' },
    });
    expect(update.status).toBe(400);
    expect(await update.json()).toMatchObject(disabled);
    expect((await session.list('变更成本中心部门', '2026-10-02'))[0]).toMatchObject({ revision: 1 });
    const cleared = await session.request('PATCH', `/organizations/${org.id}`, {
      ifMatch: org.revision,
      body: { costCenterId: null, location: '新地点', effectiveDate: '2026-10-02' },
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ costCenterId: null, location: '新地点', revision: 2 });
  });
});
