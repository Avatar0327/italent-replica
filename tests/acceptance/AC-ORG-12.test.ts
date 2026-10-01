import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgSession } from './AC-ORG-support.js';

const testDb = useTestDb();

interface ImportResult {
  readonly sourceCode: string;
  readonly status: 'created' | 'updated' | 'conflict';
  readonly orgId?: string;
  readonly reason?: string;
}

describe('AC-ORG-12 DEC-060 原站编码映射与导入冲突', () => {
  it('按已存映射更新稳定内部 ID，导入前已有的业务编码冲突行不覆盖组织', async () => {
    const session = await orgSession(testDb().db, 'org12');
    const first = await session.request('POST', '/import', {
      ifMatch: 0,
      body: {
        rows: [{ sourceCode: 'A001', code: 'zz001', name: '映射部门', parentId: session.tenant.id }],
      },
    });
    expect(first.status).toBe(200);
    const initial = ((await first.json()) as { results: ImportResult[] }).results;
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ sourceCode: 'A001', status: 'created' });
    const id = initial[0]!.orgId;
    expect(id).toBeTruthy();

    // 第二行与导入开始前的 zz001 冲突；第一行改编码不会使冲突行在同批次趁机覆盖。
    const imported = await session.request('POST', '/import', {
      ifMatch: 0,
      body: {
        rows: [
          {
            sourceCode: 'A001',
            code: 'zz009',
            name: '映射部门',
            parentId: session.tenant.id,
            expectedRevision: 1,
          },
          { sourceCode: 'A777', code: 'zz001', name: '冲突部门', parentId: session.tenant.id },
        ],
      },
    });
    expect(imported.status).toBe(200);
    const results = ((await imported.json()) as { results: ImportResult[] }).results;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ sourceCode: 'A001', status: 'updated', orgId: id });
    expect(results[1]).toMatchObject({ sourceCode: 'A777', status: 'conflict' });
    expect(results[1]!.reason).toBeTruthy();
    const [updated] = await session.list('映射部门');
    expect(updated).toMatchObject({ id, code: 'zz009', revision: 2 });
    expect(await session.list('冲突部门')).toEqual([]);

    // 后续导入仍按 A001 找到同一内部 ID，证明映射并非只存在于一次请求内。
    const repeated = await session.request('POST', '/import', {
      ifMatch: 0,
      body: {
        rows: [
          {
            sourceCode: 'A001',
            code: 'zz010',
            name: '映射部门',
            parentId: session.tenant.id,
            expectedRevision: 2,
          },
        ],
      },
    });
    expect(repeated.status).toBe(200);
    expect(((await repeated.json()) as { results: ImportResult[] }).results[0]).toMatchObject({
      sourceCode: 'A001',
      status: 'updated',
      orgId: id,
    });
    expect((await session.list('映射部门'))[0]).toMatchObject({ id, code: 'zz010' });
  });

  it('同一原站编码不得重绑定到另一内部 ID，冲突保留双方原记录', async () => {
    const session = await orgSession(testDb().db, 'org12mapping');
    const mapped = await session.request('POST', '/import', {
      ifMatch: 0,
      body: {
        rows: [{ sourceCode: 'A001', code: 'map001', name: '已映射部门', parentId: session.tenant.id }],
      },
    });
    expect(mapped.status).toBe(200);
    const target = await session.create('另一部门');
    const conflict = await session.request('POST', '/import', {
      ifMatch: 0,
      body: {
        rows: [
          {
            sourceCode: 'A001',
            orgId: target.id,
            code: target.code,
            name: '不得覆盖',
            parentId: session.tenant.id,
            expectedRevision: target.revision,
          },
        ],
      },
    });
    expect(conflict.status).toBe(200);
    const [result] = ((await conflict.json()) as { results: ImportResult[] }).results;
    expect(result).toMatchObject({ sourceCode: 'A001', status: 'conflict' });
    expect(result?.reason).toBeTruthy();
    expect((await session.list('另一部门'))[0]).toMatchObject({ id: target.id, code: target.code });
    expect(await session.list('已映射部门')).toHaveLength(1);
    expect(await session.list('不得覆盖')).toEqual([]);
  });
});
