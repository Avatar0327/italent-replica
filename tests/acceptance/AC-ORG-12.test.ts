import { randomUUID } from 'node:crypto';
import { eq, orgImportMappings, orgImportResults, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgSession, resultRows } from './AC-ORG-support.js';

const testDb = useTestDb();

interface ImportResult {
  readonly sourceCode: string;
  readonly status: 'created' | 'updated' | 'conflict';
  readonly orgId?: string;
  readonly reason?: string;
}

describe('AC-ORG-12 DEC-060 原站编码映射与导入冲突', () => {
  it('按已存映射更新稳定内部 ID，导入前已有的业务编码冲突行不覆盖组织', async () => {
    const { db } = testDb();
    const session = await orgSession(db, 'org12');
    const firstCommandId = randomUUID();
    const firstRequest = {
      ifMatch: 0,
      idempotencyKey: firstCommandId,
      body: {
        rows: [{ sourceCode: 'A001', code: 'zz001', name: '映射部门', parentId: session.tenant.id }],
      },
    };
    const first = await session.request('POST', '/import', firstRequest);
    expect(first.status).toBe(200);
    const initial = ((await first.json()) as { results: ImportResult[] }).results;
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ sourceCode: 'A001', status: 'created' });
    const id = initial[0]!.orgId;
    expect(id).toBeTruthy();
    const child = await session.create('映射部门下级', { parents: { admin: { parentId: id } } });

    // 第二行与导入开始前的 zz001 冲突；第一行改编码不会使冲突行在同批次趁机覆盖。
    const importCommandId = randomUUID();
    const imported = await session.request('POST', '/import', {
      ifMatch: 0,
      idempotencyKey: importCommandId,
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
    expect((await session.list('映射部门下级'))[0]).toMatchObject({
      id: child.id,
      parents: { admin: { parentId: id } },
    });

    const stored = await withTenant(db, session.tenant.id, (tx) =>
      tx.select().from(orgImportResults).where(eq(orgImportResults.commandId, importCommandId)),
    );
    expect(stored.sort((a, b) => a.rowIndex - b.rowIndex)).toMatchObject([
      { rowIndex: 0, sourceCode: 'A001', status: 'updated', orgId: id },
      { rowIndex: 1, sourceCode: 'A777', status: 'conflict', orgId: null },
    ]);
    const mappings = await withTenant(db, session.tenant.id, (tx) => tx.select().from(orgImportMappings));
    expect(mappings.map((mapping) => [mapping.sourceCode, mapping.orgId])).toEqual([['A001', id]]);

    // 旧创建命令在后续改码后重放原回执，不重新覆盖版本或重复记录映射/结果。
    const replay = await session.request('POST', '/import', firstRequest);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { results: ImportResult[] }).results).toEqual(initial);
    expect((await session.list('映射部门'))[0]).toMatchObject({ id, code: 'zz010' });
    const replayReceipts = await withTenant(db, session.tenant.id, (tx) =>
      tx.select().from(orgImportResults).where(eq(orgImportResults.commandId, firstCommandId)),
    );
    expect(replayReceipts).toHaveLength(1);
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

  it('一行落库中途失败时撤销该行对象和映射，后续行继续成功并保存逐条回执', async () => {
    const { db } = testDb();
    const session = await orgSession(db, 'org12savepoint');
    await db.execute(sql`ALTER TABLE org_versions ADD CONSTRAINT org_import_test_failure
      CHECK (name <> '测试落库失败')`);
    try {
      const response = await session.request('POST', '/import', {
        ifMatch: 0,
        body: {
          rows: [
            {
              sourceCode: 'FAIL001',
              code: 'fail001',
              name: '测试落库失败',
              parentId: session.tenant.id,
            },
            {
              sourceCode: 'PASS001',
              code: 'pass001',
              name: '失败行后续部门',
              parentId: session.tenant.id,
            },
          ],
        },
      });
      expect(response.status).toBe(200);
      const results = ((await response.json()) as { results: ImportResult[] }).results;
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ sourceCode: 'FAIL001', status: 'conflict' });
      expect(results[1]).toMatchObject({ sourceCode: 'PASS001', status: 'created' });
      expect(await session.list('失败行后续部门')).toHaveLength(1);
      expect(await session.list('测试落库失败')).toEqual([]);
      const objects = await withTenant(db, session.tenant.id, (tx) =>
        tx.execute(sql`SELECT id FROM org_objects WHERE code = 'fail001'`),
      );
      expect(resultRows(objects)).toEqual([]);
      const mappings = await withTenant(db, session.tenant.id, (tx) => tx.select().from(orgImportMappings));
      expect(mappings.map((mapping) => mapping.sourceCode)).toEqual(['PASS001']);
    } finally {
      await db.execute(sql`ALTER TABLE org_versions DROP CONSTRAINT org_import_test_failure`);
    }
  });

  it('更新映射的行缺少 revision 返回 400，整批不会先写入排在前面的新建行', async () => {
    const { db } = testDb();
    const session = await orgSession(db, 'org12revision');
    const initial = await session.request('POST', '/import', {
      ifMatch: 0,
      body: {
        rows: [{ sourceCode: 'A001', code: 'rev001', name: '版本保护部门', parentId: session.tenant.id }],
      },
    });
    expect(initial.status).toBe(200);
    const commandId = randomUUID();
    const response = await session.request('POST', '/import', {
      ifMatch: 0,
      idempotencyKey: commandId,
      body: {
        rows: [
          { sourceCode: 'NEW001', code: 'rev002', name: '不得提前写入', parentId: session.tenant.id },
          { sourceCode: 'A001', code: 'rev003', name: '不得盲改', parentId: session.tenant.id },
        ],
      },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'REVISION_REQUIRED' } });
    expect(await session.list('不得提前写入')).toEqual([]);
    expect((await session.list('版本保护部门'))[0]).toMatchObject({ code: 'rev001', revision: 1 });
    const receipts = await withTenant(db, session.tenant.id, (tx) =>
      tx.select().from(orgImportResults).where(eq(orgImportResults.commandId, commandId)),
    );
    expect(receipts).toEqual([]);
  });

  it('批内原站编码和业务编码重复、跨租户上级都列冲突，后续合法行仍可写入', async () => {
    const { db } = testDb();
    const session = await orgSession(db, 'org12batch');
    const foreign = await orgSession(db, 'org12foreign');
    const foreignParent = await foreign.create('外部租户上级');
    const response = await session.request('POST', '/import', {
      ifMatch: 0,
      body: {
        rows: [
          { sourceCode: 'A001', code: 'batch001', name: '批次首行', parentId: session.tenant.id },
          { sourceCode: 'A001', code: 'batch002', name: '重复映射行', parentId: session.tenant.id },
          { sourceCode: 'A003', code: 'batch001', name: '重复编码行', parentId: session.tenant.id },
          { sourceCode: 'A004', code: 'batch004', name: '跨租户上级行', parentId: foreignParent.id },
          { sourceCode: 'A005', code: 'batch005', name: '批次末行', parentId: session.tenant.id },
        ],
      },
    });
    expect(response.status).toBe(200);
    const results = ((await response.json()) as { results: ImportResult[] }).results;
    expect(results.map((result) => result.status)).toEqual(['created', 'conflict', 'conflict', 'conflict', 'created']);
    expect(results.slice(1, 4).every((result) => !!result.reason)).toBe(true);
    expect(JSON.stringify(results)).not.toContain(foreignParent.id);
    expect(await session.list('批次首行')).toHaveLength(1);
    expect(await session.list('批次末行')).toHaveLength(1);
    expect(await session.list('重复映射行')).toEqual([]);
    expect(await session.list('重复编码行')).toEqual([]);
    expect(await session.list('跨租户上级行')).toEqual([]);
  });
});
