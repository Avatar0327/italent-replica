/**
 * AC-ORG-19（DEC-089 / DEC-037，`15` §12）：组织列表按预计算并存储的组织名次排序——行政路径上逐级比较
 * 行政维度顺序号、再比较编码；不现算、不拼长整数分段编码。停用或不在行政树上的组织没有名次，排在最后按编码。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgSession } from './AC-ORG-support.js';

const testDb = useTestDb();

describe('AC-ORG-19 组织列表按预计算名次排序（DEC-089）', () => {
  it('上级按行政维度顺序号在前的整支先列，下级紧随上级；停用组织排在最后', async () => {
    const session = await orgSession(testDb().db, 'org19rank');
    const root = session.tenant.id;
    const second = await session.create('顺序号二', { parents: { admin: { parentId: root, sequence: 2 } } });
    const first = await session.create('顺序号一', { parents: { admin: { parentId: root, sequence: 1 } } });
    const child = await session.create('顺序号二的下级', { parents: { admin: { parentId: second.id, sequence: 1 } } });
    const disabled = await session.create('将停用部门', { parents: { admin: { parentId: root, sequence: 0 } } });
    const stop = await session.request('PATCH', `/organizations/${disabled.id}`, {
      ifMatch: disabled.revision,
      body: { enabled: false, effectiveDate: '2026-10-01' },
    });
    expect(stop.status).toBe(200);
    const response = await session.request('GET', '/organizations?asOf=2026-10-01&includeDisabled=true');
    expect(response.status).toBe(200);
    const items = ((await response.json()) as { items: { id: string }[] }).items;
    expect(items.map((item) => item.id)).toEqual([first.id, second.id, child.id, disabled.id]);
  });
});
