import { pgErrorCode, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { resultRows } from './AC-JOB-personnel-support.js';
import { jobSession } from './AC-JOB-support.js';

const testDb = useTestDb();

describe('职务业务版本与历史编码不可覆盖', () => {
  it('更名改码追加版本，历史时点保持原值，数据库属主也不能改写或删除版本', async () => {
    const { db } = testDb();
    const session = await jobSession(db, 'jobimmutable');
    const post = await session.create('posts', '历史职务', { code: 'IMMUTABLE_OLD' });
    const response = await session.request('PATCH', `/posts/${post.id}`, {
      ifMatch: post.revision,
      body: { name: '变更职务', code: 'IMMUTABLE_NEW', effectiveDate: '2026-10-02' },
    });
    expect(response.status).toBe(200);
    expect(await session.detail('posts', post.id, '2026-10-01')).toMatchObject({
      id: post.id,
      name: '历史职务',
      code: 'IMMUTABLE_OLD',
    });
    expect(await session.detail('posts', post.id, '2026-10-02')).toMatchObject({
      id: post.id,
      name: '变更职务',
      code: 'IMMUTABLE_NEW',
      revision: 2,
    });
    const readVersions = () =>
      withTenant(db, session.tenant.id, async (tx) =>
        resultRows<{ code: string; name: string }>(
          await tx.execute(sql`SELECT code, name FROM job_post_versions
            WHERE object_id = ${post.id} ORDER BY version_no`),
        ),
      );
    expect(await readVersions()).toEqual([
      { code: 'IMMUTABLE_OLD', name: '历史职务' },
      { code: 'IMMUTABLE_NEW', name: '变更职务' },
    ]);
    const overwritten = await db
      .execute(sql`UPDATE job_post_versions SET name = '禁止改写' WHERE object_id = ${post.id}`)
      .catch((error: unknown) => error);
    expect(pgErrorCode(overwritten)).toBe('55000');
    const deleted = await db
      .execute(sql`DELETE FROM job_post_versions WHERE object_id = ${post.id}`)
      .catch((error: unknown) => error);
    expect(pgErrorCode(deleted)).toBe('55000');
    expect(await readVersions()).toHaveLength(2);
  });
});
