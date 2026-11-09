/**
 * AC-APV-F326-01（F-326 S1，设计 §2.1 / §7）：五张表 FORCE RLS；他租户读不到、写被拒；(tenant_id, code) 唯一。
 * 读写都放进对应租户的 withTenant，可在普通角色 app_owner 下通过（F-212，DEC-568）。
 * 另核对结构类约束：编码前缀 CHECK、公共 / 应用变量互斥列、矩阵列 / 格的 CHECK、应用角色不可 DELETE 变量与矩阵头。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { resultRows } from './AC-ORG-people-support.js';
import { seedTenantWithMember } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];
interface World {
  tenantId: string;
  userId: string;
}

const FIVE_TABLES = [
  'approval_variables',
  'approval_matrices',
  'approval_matrix_columns',
  'approval_matrix_rows',
  'approval_matrix_cells',
] as const;

async function world(label: string): Promise<World> {
  const { tenant, user } = await seedTenantWithMember(testDb().db, label);
  return { tenantId: tenant.id, userId: user.id };
}

type Row = Record<string, unknown>;
async function insert(tx: Tx, table: string, tenantId: string, row: Row) {
  const columns = Object.keys(row);
  const values = sql.join(
    columns.map((c) => sql`${row[c]}`),
    sql`, `,
  );
  const names = sql.raw(columns.join(', '));
  await tx.execute(sql`INSERT INTO ${sql.identifier(table)}(tenant_id, ${names}) VALUES (${tenantId}, ${values})`);
  return row;
}

const publicVariable = (w: World, over: Row = {}): Row => ({
  id: randomUUID(),
  scope: 'public',
  code: `Global.B.V${uniqueSuffix()}`,
  name: '合成公共变量',
  data_type: 'person',
  usage_scopes: sql`ARRAY['process']::text[]`,
  status: 'draft',
  created_by: w.userId,
  updated_by: w.userId,
  ...over,
});

const applicationVariable = (w: World, over: Row = {}): Row => ({
  id: randomUUID(),
  scope: 'application',
  app_id: 'transfer',
  code: `B.${uniqueSuffix()}`,
  name: '合成应用变量',
  data_type: 'persons',
  status: 'draft',
  created_by: w.userId,
  updated_by: w.userId,
  ...over,
});

const matrix = (w: World, over: Row = {}): Row => ({
  id: randomUUID(),
  code: `M${uniqueSuffix()}`,
  name: '合成矩阵',
  status: 'draft',
  created_by: w.userId,
  updated_by: w.userId,
  ...over,
});

/** 每次尝试各开一个租户事务，失败让整个事务回滚（真 PG 与 PGlite 行为一致，不依赖保存点）。 */
const rejects = async (w: World, run: (tx: Tx) => Promise<unknown>) => {
  const error = await withTenant(testDb().db, w.tenantId, run).then(
    () => null,
    (e: unknown) => e as Error,
  );
  return error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : null;
};

describe('五张表 FORCE RLS', () => {
  it.each(FIVE_TABLES)('%s：ENABLE + FORCE RLS，带 tenant_id', async (table) => {
    const rows = resultRows<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      await testDb().db.execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid = to_regclass(${`public.${table}`})`),
    );
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const column = resultRows<{ attname: string }>(
      await testDb().db.execute(sql`SELECT attname FROM pg_attribute
        WHERE attrelid = to_regclass(${`public.${table}`}) AND attname = 'tenant_id' AND NOT attisdropped`),
    );
    expect(column).toHaveLength(1);
  });

  it('他租户读不到变量与矩阵（含子表）；写入别租户的行被 RLS 拒绝', async () => {
    const a = await world('f326s1-rls-a');
    const b = await world('f326s1-rls-b');
    const seeded = await withTenant(testDb().db, a.tenantId, async (tx) => {
      const variable = await insert(tx, 'approval_variables', a.tenantId, publicVariable(a));
      const head = await insert(tx, 'approval_matrices', a.tenantId, matrix(a));
      const column = await insert(tx, 'approval_matrix_columns', a.tenantId, {
        id: randomUUID(),
        matrix_id: head.id,
        kind: 'role',
        name: '审批人',
        seq: 1,
      });
      const row = await insert(tx, 'approval_matrix_rows', a.tenantId, {
        id: randomUUID(),
        matrix_id: head.id,
        seq: 1,
      });
      await insert(tx, 'approval_matrix_cells', a.tenantId, {
        row_id: row.id,
        column_id: column.id,
        ref_ids: sql`ARRAY[${a.userId}]::uuid[]`,
      });
      return { variable, head };
    });
    for (const table of FIVE_TABLES) {
      const own = await withTenant(testDb().db, a.tenantId, async (tx) =>
        resultRows(await tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)}`)),
      );
      expect(own.length, `${table} 自己租户可见`).toBeGreaterThan(0);
      const seenByB = await withTenant(testDb().db, b.tenantId, async (tx) =>
        resultRows(await tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)}`)),
      );
      expect(seenByB, `${table} 他租户不可见`).toEqual([]);
    }
    // 在 B 的租户事务里写 A 的 tenant_id：策略 WITH CHECK 拒绝
    const rlsMessage = /row-level security|violates/i;
    expect(await rejects(b, (tx) => insert(tx, 'approval_variables', a.tenantId, publicVariable(b)))).toMatch(
      rlsMessage,
    );
    expect(await rejects(b, (tx) => insert(tx, 'approval_matrices', a.tenantId, matrix(b)))).toMatch(rlsMessage);
    // 他租户改不到、删不到 A 的行：UPDATE 命中 0 行
    const touched = await withTenant(testDb().db, b.tenantId, async (tx) =>
      resultRows(
        await tx.execute(sql`UPDATE approval_matrices SET name = '被篡改' WHERE id = ${seeded.head.id} RETURNING id`),
      ),
    );
    expect(touched).toEqual([]);
    const name = await withTenant(testDb().db, a.tenantId, async (tx) =>
      resultRows<{ name: string }>(
        await tx.execute(sql`SELECT name FROM approval_matrices WHERE id = ${seeded.head.id}`),
      ),
    );
    expect(name).toEqual([{ name: '合成矩阵' }]);
  });
});

describe('(tenant_id, code) 唯一', () => {
  it('变量：同租户同码冲突（公共与应用变量同表）；不同租户可同码', async () => {
    const a = await world('f326s1-code-a');
    const b = await world('f326s1-code-b');
    const code = `Global.B.Same${uniqueSuffix()}`;
    await withTenant(testDb().db, a.tenantId, (tx) =>
      insert(tx, 'approval_variables', a.tenantId, publicVariable(a, { code })),
    );
    expect(await rejects(a, (tx) => insert(tx, 'approval_variables', a.tenantId, publicVariable(a, { code })))).toMatch(
      /unique|duplicate/i,
    );
    await withTenant(testDb().db, b.tenantId, (tx) =>
      insert(tx, 'approval_variables', b.tenantId, publicVariable(b, { code })),
    );
    // 应用变量跨应用同码也冲突（编码在租户内唯一）
    const appCode = `B.${uniqueSuffix()}`;
    await withTenant(testDb().db, a.tenantId, (tx) =>
      insert(tx, 'approval_variables', a.tenantId, applicationVariable(a, { code: appCode, app_id: 'transfer' })),
    );
    expect(
      await rejects(a, (tx) =>
        insert(tx, 'approval_variables', a.tenantId, applicationVariable(a, { code: appCode, app_id: 'idp' })),
      ),
    ).toMatch(/unique|duplicate/i);
  });

  it('矩阵：同租户同码冲突；不同租户可同码', async () => {
    const a = await world('f326s1-mcode-a');
    const b = await world('f326s1-mcode-b');
    const code = `Same${uniqueSuffix()}`;
    await withTenant(testDb().db, a.tenantId, (tx) => insert(tx, 'approval_matrices', a.tenantId, matrix(a, { code })));
    expect(await rejects(a, (tx) => insert(tx, 'approval_matrices', a.tenantId, matrix(a, { code })))).toMatch(
      /unique|duplicate/i,
    );
    await withTenant(testDb().db, b.tenantId, (tx) => insert(tx, 'approval_matrices', b.tenantId, matrix(b, { code })));
  });
});

describe('变量表约束（设计 §2.1 / §2.2）', () => {
  it('编码前缀由 CHECK 兜底：公共 Global.B.+字母开头，应用 B.+字母数字下划线', async () => {
    const w = await world('f326s1-prefix');
    const ok = async (row: Row) => {
      await withTenant(testDb().db, w.tenantId, (tx) => insert(tx, 'approval_variables', w.tenantId, row));
    };
    await ok(publicVariable(w, { code: `Global.B.HTCtoTind0${uniqueSuffix()}` }));
    await ok(applicationVariable(w, { code: `B.${Date.now()}${uniqueSuffix()}`.slice(0, 20) }));
    for (const code of ['Global.B.2x', 'Global.B.a-b', 'B.a', 'Global.B.', 'Global.B.' + 'a'.repeat(65)]) {
      expect(
        await rejects(w, (tx) => insert(tx, 'approval_variables', w.tenantId, publicVariable(w, { code }))),
        code,
      ).not.toBeNull();
    }
    for (const code of ['Global.B.x', 'B.', 'B.a-b', 'B.' + 'a'.repeat(65), 'X.1']) {
      expect(
        await rejects(w, (tx) => insert(tx, 'approval_variables', w.tenantId, applicationVariable(w, { code }))),
        code,
      ).not.toBeNull();
    }
  });

  it('公共变量须有非空适用范围且无 app_id；应用变量须有 app_id 且无适用范围与描述', async () => {
    const w = await world('f326s1-scope');
    const bad: Row[] = [
      publicVariable(w, { app_id: 'transfer' }),
      publicVariable(w, { usage_scopes: sql`ARRAY[]::text[]` }),
      publicVariable(w, { usage_scopes: sql`ARRAY['other']::text[]` }),
      applicationVariable(w, { app_id: null }),
      applicationVariable(w, { usage_scopes: sql`ARRAY['process']::text[]` }),
      applicationVariable(w, { description: '应用变量没有描述' }),
    ];
    for (const row of bad) {
      expect(
        await rejects(w, (tx) => insert(tx, 'approval_variables', w.tenantId, row)),
        JSON.stringify(row),
      ).not.toBeNull();
    }
    await withTenant(testDb().db, w.tenantId, async (tx) => {
      await insert(
        tx,
        'approval_variables',
        w.tenantId,
        publicVariable(w, { usage_scopes: sql`ARRAY['process','business_rule','message_template']::text[]` }),
      );
    });
  });

  it('数据类型、状态、revision 受 CHECK 限制；默认 revision 1', async () => {
    const w = await world('f326s1-enums');
    for (const over of [{ data_type: 'object' }, { status: 'deleted' }, { scope: 'global' }, { revision: 0 }]) {
      expect(
        await rejects(w, (tx) => insert(tx, 'approval_variables', w.tenantId, publicVariable(w, over))),
        JSON.stringify(over),
      ).not.toBeNull();
    }
    for (const dataType of ['string', 'integer', 'decimal', 'datetime', 'boolean', 'person', 'persons']) {
      await withTenant(testDb().db, w.tenantId, (tx) =>
        insert(tx, 'approval_variables', w.tenantId, publicVariable(w, { data_type: dataType })),
      );
    }
    const read = await withTenant(testDb().db, w.tenantId, async (tx) =>
      resultRows<{ revision: number }>(await tx.execute(sql`SELECT DISTINCT revision FROM approval_variables`)),
    );
    expect(read).toEqual([{ revision: 1 }]);
  });
});

describe('矩阵子表约束（设计 §2.1）', () => {
  async function seedMatrix(w: World) {
    return withTenant(testDb().db, w.tenantId, async (tx) => {
      const head = await insert(tx, 'approval_matrices', w.tenantId, matrix(w));
      return head.id as string;
    });
  }
  const column = (matrixId: string, over: Row = {}): Row => ({
    id: randomUUID(),
    matrix_id: matrixId,
    kind: 'condition',
    dimension: 'department',
    name: `部门${uniqueSuffix()}`,
    seq: 1,
    ...over,
  });

  it('列：条件列必须有维度、角色列不得有维度；维度限部门 / 职位 / 职务；列名矩阵内唯一', async () => {
    const w = await world('f326s1-columns');
    const matrixId = await seedMatrix(w);
    const insertColumn = (over: Row) =>
      withTenant(testDb().db, w.tenantId, (tx) =>
        insert(tx, 'approval_matrix_columns', w.tenantId, column(matrixId, over)),
      );
    await insertColumn({ seq: 1 });
    await insertColumn({ seq: 2, dimension: 'position', name: `职位${uniqueSuffix()}` });
    await insertColumn({
      seq: 3,
      kind: 'role',
      dimension: null,
      name: `审批人${uniqueSuffix()}`,
      allow_multiple: true,
    });
    const bad: Row[] = [
      { dimension: null },
      { dimension: 'grade' },
      { kind: 'role' }, // 角色列带维度
      { kind: 'other', dimension: null },
      { kind: 'role', dimension: null, include_children: true },
      { dimension: 'position', include_children: true },
      { allow_multiple: true },
    ];
    for (const over of bad) {
      const message = await rejects(w, (tx) =>
        insert(tx, 'approval_matrix_columns', w.tenantId, column(matrixId, { seq: 9, ...over })),
      );
      expect(message, JSON.stringify(over)).not.toBeNull();
    }
    const dupName = `重名${uniqueSuffix()}`;
    await insertColumn({ seq: 4, name: dupName });
    expect(
      await rejects(w, (tx) =>
        insert(tx, 'approval_matrix_columns', w.tenantId, column(matrixId, { seq: 5, name: dupName })),
      ),
    ).toMatch(/unique|duplicate/i);
  });

  it('行顺序在矩阵内唯一；单元格 (row, column) 唯一；ref_ids 不得为 NULL 且不超过 100 个', async () => {
    const w = await world('f326s1-cells');
    const matrixId = await seedMatrix(w);
    const ids = await withTenant(testDb().db, w.tenantId, async (tx) => {
      const col = await insert(tx, 'approval_matrix_columns', w.tenantId, column(matrixId));
      const row = await insert(tx, 'approval_matrix_rows', w.tenantId, {
        id: randomUUID(),
        matrix_id: matrixId,
        seq: 1,
      });
      return { col: col.id as string, row: row.id as string };
    });
    expect(
      await rejects(w, (tx) =>
        insert(tx, 'approval_matrix_rows', w.tenantId, { id: randomUUID(), matrix_id: matrixId, seq: 1 }),
      ),
    ).toMatch(/unique|duplicate/i);
    const refs = (n: number) => sql`ARRAY(SELECT gen_random_uuid() FROM generate_series(1, ${n}))::uuid[]`;
    await withTenant(testDb().db, w.tenantId, (tx) =>
      insert(tx, 'approval_matrix_cells', w.tenantId, { row_id: ids.row, column_id: ids.col, ref_ids: refs(100) }),
    );
    expect(
      await rejects(w, (tx) =>
        insert(tx, 'approval_matrix_cells', w.tenantId, { row_id: ids.row, column_id: ids.col, ref_ids: refs(1) }),
      ),
    ).toMatch(/unique|duplicate|primary/i);
    const other = await withTenant(testDb().db, w.tenantId, async (tx) =>
      insert(tx, 'approval_matrix_columns', w.tenantId, column(matrixId, { seq: 2, name: `列${uniqueSuffix()}` })),
    );
    expect(
      await rejects(w, (tx) =>
        insert(tx, 'approval_matrix_cells', w.tenantId, { row_id: ids.row, column_id: other.id, ref_ids: refs(101) }),
      ),
    ).not.toBeNull();
    expect(
      await rejects(w, (tx) =>
        insert(tx, 'approval_matrix_cells', w.tenantId, { row_id: ids.row, column_id: other.id, ref_ids: null }),
      ),
    ).not.toBeNull();
  });

  it('子表不能挂到他租户的矩阵头 / 行 / 列（复合外键带 tenant_id）', async () => {
    const a = await world('f326s1-fk-a');
    const b = await world('f326s1-fk-b');
    const matrixOfA = await seedMatrix(a);
    const message = await rejects(b, (tx) =>
      insert(tx, 'approval_matrix_columns', b.tenantId, column(matrixOfA, { seq: 1 })),
    );
    expect(message).toMatch(/foreign key|violates/i);
  });
});

describe('应用角色权限（无删除）', () => {
  it('变量与矩阵头不可 DELETE（只停用不删除，设计 §2.5）；结构子表可整体重写', async () => {
    const w = await world('f326s1-grants');
    const ids = await withTenant(testDb().db, w.tenantId, async (tx) => {
      const variable = await insert(tx, 'approval_variables', w.tenantId, publicVariable(w));
      const head = await insert(tx, 'approval_matrices', w.tenantId, matrix(w));
      const row = await insert(tx, 'approval_matrix_rows', w.tenantId, {
        id: randomUUID(),
        matrix_id: head.id,
        seq: 1,
      });
      return { variable: variable.id as string, head: head.id as string, row: row.id as string };
    });
    const denied = /permission denied/i;
    expect(
      await rejects(w, (tx) => tx.execute(sql`DELETE FROM approval_variables WHERE id = ${ids.variable}`)),
    ).toMatch(denied);
    expect(await rejects(w, (tx) => tx.execute(sql`DELETE FROM approval_matrices WHERE id = ${ids.head}`))).toMatch(
      denied,
    );
    await withTenant(testDb().db, w.tenantId, async (tx) => {
      await tx.execute(sql`DELETE FROM approval_matrix_rows WHERE id = ${ids.row}`);
    });
  });
});
