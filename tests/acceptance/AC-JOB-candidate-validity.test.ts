import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { jobSession, JOB_TODAY } from './AC-JOB-support.js';

const testDb = useTestDb();

describe('AC-JOB-01 候选与保存使用相同的引用有效期', () => {
  it('无类别限制的职务也不能选到所属类别已停用的职级', async () => {
    const session = await jobSession(testDb().db, 'candidate-type');
    const type = await session.create('level-types', '将停用的类别');
    const level = await session.create('levels', '三级', { level: 3, levelTypeId: type.id });
    const post = await session.create('posts', '不限类别的职务');
    const disabled = await session.request('PATCH', `/level-types/${type.id}`, {
      ifMatch: type.revision,
      body: { enabled: false, effectiveDate: JOB_TODAY },
    });
    expect(disabled.status).toBe(200);
    const response = await session.request('GET', `/candidates/levels?postId=${post.id}`);
    expect(response.status).toBe(200);
    expect((await response.json()) as { items: unknown[] }).toEqual({ items: [], page: 1, pageSize: 50 });
    const grades = await session.request('GET', `/candidates/grades?postId=${post.id}&levelId=${level.id}`);
    expect(grades.status).toBe(400);
  });
});
