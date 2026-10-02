import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { jobSession, type JobRecord } from './AC-JOB-support.js';

const testDb = useTestDb();

// DEC-072 / Q-M0-06：未取证的未来结构传播先拒绝，避免新下级缓存祖先与排定的未来结构矛盾。
describe('AC-JOB-02 未来祖先关系与冗余序列字段一致性', () => {
  it('上级已有未来父关系变化时，拒绝在更早日期创建下级且不留下对象', async () => {
    const session = await jobSession(testDb().db, 'jobfutureancestorcreate');
    const first = await session.create('sequences', '未来祖先A');
    const parent = await session.create('sequences', '未来上级B');
    const future = await session.request('PATCH', `/sequences/${parent.id}`, {
      ifMatch: parent.revision,
      body: { parentId: first.id, effectiveDate: '2026-11-01' },
    });
    expect(future.status).toBe(200);
    const created = await session.request('POST', '/sequences', {
      ifMatch: 0,
      body: {
        name: '拒绝提前缓存的下级',
        code: `S${randomUUID().replaceAll('-', '')}`,
        parentId: parent.id,
        startDate: '2026-10-01',
      },
    });
    expect(created.status).toBe(409);
    expect(await created.json()).toMatchObject({ error: { code: 'JOB_FUTURE_VERSION_EXISTS' } });
    expect((await session.list('sequences')).map((item) => item.name)).not.toContain('拒绝提前缓存的下级');
    expect(await session.detail('sequences', parent.id, '2026-11-01')).toMatchObject({
      parentId: first.id,
      firstSequenceId: first.id,
      secondSequenceId: parent.id,
    });
  });

  it('移动到已有未来父关系变化的上级时拒绝，原下级路径与 revision 不改变', async () => {
    const session = await jobSession(testDb().db, 'jobfutureancestormove');
    const futureRoot = await session.create('sequences', '未来移入根');
    const parent = await session.create('sequences', '将变更的上级');
    const originalRoot = await session.create('sequences', '原属根');
    const child = await session.create('sequences', '原属下级', { parentId: originalRoot.id });
    const future = await session.request('PATCH', `/sequences/${parent.id}`, {
      ifMatch: parent.revision,
      body: { parentId: futureRoot.id, effectiveDate: '2026-11-01' },
    });
    expect(future.status).toBe(200);
    const moved = await session.request('PATCH', `/sequences/${child.id}`, {
      ifMatch: child.revision,
      body: { parentId: parent.id, effectiveDate: '2026-10-02' },
    });
    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({ error: { code: 'JOB_FUTURE_VERSION_EXISTS' } });
    expect(await session.detail('sequences', child.id, '2026-10-02')).toMatchObject({
      revision: 1,
      parentId: originalRoot.id,
      firstSequenceId: originalRoot.id,
      secondSequenceId: child.id,
    });
  });

  it('未来版本仅更名改码而不改变父关系时允许提前创建下级，祖先 ID 在未来时点仍正确', async () => {
    const session = await jobSession(testDb().db, 'jobfutureancestorrename');
    const parent = await session.create('sequences', '未来只更名上级');
    const future = await session.request('PATCH', `/sequences/${parent.id}`, {
      ifMatch: parent.revision,
      body: { name: '未来已更名上级', code: 'FUTURE_RENAMED_SEQUENCE', effectiveDate: '2026-11-01' },
    });
    expect(future.status).toBe(200);
    const child: JobRecord = await session.create('sequences', '允许提前建立下级', { parentId: parent.id });
    expect(await session.detail('sequences', child.id, '2026-11-01')).toMatchObject({
      parentId: parent.id,
      firstSequenceId: parent.id,
      secondSequenceId: child.id,
      level: 2,
    });
  });
});
