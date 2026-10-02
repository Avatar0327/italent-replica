import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { jobSession } from './AC-JOB-support.js';

const testDb = useTestDb();

interface ImportReceipt {
  readonly sourceCode: string;
  readonly status: 'created' | 'updated' | 'conflict';
  readonly objectId?: string;
  readonly reason?: string;
}

describe('DEC-060 职务原站编码导入映射与稳定 ID', () => {
  it('改码保持职务 ID 与职位引用，批前已占编码仍冲突，同命令重放不覆盖新版本', async () => {
    const session = await jobSession(testDb().db, 'jobimportcodes');
    const firstRequest = {
      ifMatch: 0,
      idempotencyKey: randomUUID(),
      body: { kind: 'posts', rows: [{ sourceCode: 'A001', code: 'POST001', name: '导入职务' }] },
    };
    const initial = await session.request('POST', '/import', firstRequest);
    expect(initial.status).toBe(200);
    const initialResults = ((await initial.json()) as { results: ImportReceipt[] }).results;
    expect(initialResults).toHaveLength(1);
    expect(initialResults[0]).toMatchObject({ sourceCode: 'A001', status: 'created' });
    const id = initialResults[0]!.objectId!;
    expect(id).toBeTruthy();
    const org = await session.org('导入引用部门');
    const position = await session.create('positions', '导入引用职位', { orgId: org.id, postId: id });
    const response = await session.request('POST', '/import', {
      ifMatch: 0,
      body: {
        kind: 'posts',
        rows: [
          { sourceCode: 'A001', code: 'POST009', name: '导入职务', expectedRevision: 1 },
          { sourceCode: 'A777', code: 'POST001', name: '编码冲突职务' },
        ],
      },
    });
    expect(response.status).toBe(200);
    const { results } = (await response.json()) as { results: ImportReceipt[] };
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ sourceCode: 'A001', status: 'updated', objectId: id });
    expect(results[1]).toMatchObject({ sourceCode: 'A777', status: 'conflict' });
    expect(results[1]!.reason).toBeTruthy();
    expect(await session.detail('posts', id)).toMatchObject({ id, code: 'POST009', revision: 2 });
    expect(await session.detail('positions', position.id)).toMatchObject({ id: position.id, postId: id });
    expect((await session.list('posts')).map((post) => post.name)).not.toContain('编码冲突职务');

    const replay = await session.request('POST', '/import', firstRequest);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { results: ImportReceipt[] }).results).toEqual(initialResults);
    expect(await session.detail('posts', id)).toMatchObject({ id, code: 'POST009', revision: 2 });
    expect(await session.list('posts')).toHaveLength(1);
  });

  it('已有原站编码不得重绑定到另一 ID，跨租户 ID 不可用且冲突回执不泄露外部对象', async () => {
    const { db } = testDb();
    const session = await jobSession(db, 'jobimportmapping');
    const foreign = await jobSession(db, 'jobimportforeign');
    const foreignPost = await foreign.create('posts', '外租户职务');
    const ownPost = await session.create('posts', '本租户独立职务');
    const first = await session.request('POST', '/import', {
      ifMatch: 0,
      body: { kind: 'posts', rows: [{ sourceCode: 'A001', code: 'MAP001', name: '映射职务' }] },
    });
    expect(first.status).toBe(200);
    const mappedId = ((await first.json()) as { results: ImportReceipt[] }).results[0]!.objectId;
    const response = await session.request('POST', '/import', {
      ifMatch: 0,
      body: {
        kind: 'posts',
        rows: [
          {
            sourceCode: 'A001',
            code: ownPost.code,
            name: '不得重绑定',
            objectId: ownPost.id,
            expectedRevision: 1,
          },
          {
            sourceCode: 'FOREIGN001',
            code: 'FOREIGN001',
            name: '不得跨租户',
            objectId: foreignPost.id,
            expectedRevision: 1,
          },
          { sourceCode: 'VALID001', code: 'VALID001', name: '冲突后合法职务' },
        ],
      },
    });
    expect(response.status).toBe(200);
    const { results } = (await response.json()) as { results: ImportReceipt[] };
    expect(results.map((result) => result.status)).toEqual(['conflict', 'conflict', 'created']);
    expect(results.slice(0, 2).every((result) => !!result.reason)).toBe(true);
    expect(JSON.stringify(results)).not.toContain(foreignPost.id);
    expect(await session.detail('posts', ownPost.id)).toMatchObject({ name: ownPost.name, revision: 1 });
    expect(await session.detail('posts', mappedId!)).toMatchObject({ name: '映射职务', code: 'MAP001', revision: 1 });
    expect((await session.list('posts')).map((post) => post.name)).not.toContain('不得重绑定');
  });
});
