import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { jobSession, type JobRecord } from './AC-JOB-support.js';

const testDb = useTestDb();

describe('AC-JOB-02 序列移动、循环与最大层级', () => {
  it('移动序列同步下级祖先，历史时点保留原路径且内部 ID 不变', async () => {
    const session = await jobSession(testDb().db, 'jobtreemove');
    const firstRoot = await session.create('sequences', '原一级序列');
    const secondRoot = await session.create('sequences', '新一级序列');
    const child = await session.create('sequences', '被移动二级序列', { parentId: firstRoot.id });
    const leaf = await session.create('sequences', '下级三级序列', { parentId: child.id });
    const response = await session.request('PATCH', `/sequences/${child.id}`, {
      ifMatch: child.revision,
      body: { parentId: secondRoot.id, effectiveDate: '2026-10-02' },
    });
    expect(response.status).toBe(200);
    expect(await session.detail('sequences', leaf.id, '2026-10-01')).toMatchObject({
      id: leaf.id,
      firstSequenceId: firstRoot.id,
      secondSequenceId: child.id,
      thirdSequenceId: leaf.id,
    });
    expect(await session.detail('sequences', leaf.id, '2026-10-02')).toMatchObject({
      id: leaf.id,
      firstSequenceId: secondRoot.id,
      secondSequenceId: child.id,
      thirdSequenceId: leaf.id,
    });
  });

  it('将祖先挂到自己的下级会形成循环，拒绝并保留整个树的原版本', async () => {
    const session = await jobSession(testDb().db, 'jobtreecycle');
    const first = await session.create('sequences', '循环一级');
    const second = await session.create('sequences', '循环二级', { parentId: first.id });
    const third = await session.create('sequences', '循环三级', { parentId: second.id });
    const response = await session.request('PATCH', `/sequences/${first.id}`, {
      ifMatch: first.revision,
      body: { parentId: third.id, effectiveDate: '2026-10-02' },
    });
    expect(response.status).toBe(400);
    expect(await session.detail('sequences', first.id, '2026-10-02')).toMatchObject({ revision: 1, level: 1 });
    expect(await session.detail('sequences', third.id, '2026-10-02')).toMatchObject({
      revision: 1,
      firstSequenceId: first.id,
      secondSequenceId: second.id,
      thirdSequenceId: third.id,
    });
  });

  it('规格允许十级序列并填充十级字段，新增第十一级时拒绝且不留下对象', async () => {
    const session = await jobSession(testDb().db, 'jobtreedepth');
    let parent: JobRecord | undefined;
    for (let level = 1; level <= 10; level++) {
      parent = await session.create('sequences', `${level}级序列`, parent ? { parentId: parent.id } : {});
      expect(parent.level).toBe(level);
    }
    expect(parent!.tenthSequenceId).toBe(parent!.id);
    const response = await session.request('POST', '/sequences', {
      ifMatch: 0,
      body: { name: '不允许的十一级', code: `S${randomUUID().replaceAll('-', '')}`, parentId: parent!.id },
    });
    expect(response.status).toBe(400);
    expect(await session.list('sequences')).toHaveLength(10);
  });

  it('AC-JOB-06 关闭重名开关时并发创建同部门同名职位仅一个成功', async () => {
    const session = await jobSession(testDb().db, 'jobconcurrentnames');
    const org = await session.org('并发职位部门');
    const post = await session.create('posts', '并发职位职务');
    const responses = await Promise.all(
      ['CONCURRENT_POS_A', 'CONCURRENT_POS_B'].map((code) =>
        session.request('POST', '/positions', {
          ifMatch: 0,
          body: { name: '并发同名职位', code, orgId: org.id, postId: post.id },
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await session.list('positions')).toHaveLength(1);
  });
});
