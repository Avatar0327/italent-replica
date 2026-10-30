/**
 * R2-T08 BE-10a：两张表与共享 CHECK 放宽的数据层契约（设计 §2.1 / §2.2 / §2.4）。
 * 租户表一律 FORCE RLS（F-212）；审批状态 0～6、执行状态 1～3 各自 CHECK，不加跨列组合约束（§2.1 末段）。
 * 读写都放进对应租户的 withTenant，可在普通角色 app_owner 下通过。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld } from './AC-APV-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
type World = Awaited<ReturnType<typeof approvalWorld>>;
type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

async function world(label: string) {
  const w = await approvalWorld(testDb().db, label);
  return { w, orgId: await w.org(`审批主体${uniqueSuffix()}`) };
}

const header = (w: World, orgId: string, over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  code: `OA${uniqueSuffix()}`,
  subject: '合成调整主题',
  effective_date: '2026-11-01',
  approval_subject_org_id: orgId,
  created_by: w.hr.id,
  ...over,
});

async function insertHeader(tx: Tx, w: World, orgId: string, over: Record<string, unknown> = {}) {
  const row = header(w, orgId, over);
  const columns = Object.keys(row);
  const values = sql.join(
    columns.map((c) => sql`${(row as Record<string, unknown>)[c]}`),
    sql`, `,
  );
  await tx.execute(
    sql`INSERT INTO org_adjustments(tenant_id, ${sql.raw(columns.join(', '))}) VALUES (${w.tenant.id}, ${values})`,
  );
  return row;
}

async function insertItem(tx: Tx, w: World, adjustmentId: string, over: Record<string, unknown> = {}) {
  const row = { id: randomUUID(), adjustment_id: adjustmentId, seq: 1, adjust_type: 1, name: '新部门', ...over };
  const columns = Object.keys(row);
  const values = sql.join(
    columns.map((c) => sql`${(row as Record<string, unknown>)[c]}`),
    sql`, `,
  );
  await tx.execute(
    sql`INSERT INTO org_adjustment_org_items(tenant_id, ${sql.raw(columns.join(', '))})
      VALUES (${w.tenant.id}, ${values})`,
  );
  return row;
}

/** 每次尝试各开一个租户事务，失败让整个事务回滚（真 PG 与 PGlite 行为一致，不依赖保存点）。 */
const rejects = async (w: World, run: (tx: Tx) => Promise<unknown>) => {
  const error = await withTenant(testDb().db, w.tenant.id, run).then(
    () => null,
    (e: unknown) => e as Error,
  );
  return error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : null;
};

describe('表结构与租户隔离', () => {
  it.each(['org_adjustments', 'org_adjustment_org_items'])('%s：ENABLE + FORCE RLS', async (table) => {
    const rows = resultRows<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      await testDb().db.execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid = to_regclass(${`public.${table}`})`),
    );
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it('申请单默认值：已暂存 / 未执行 / revision 1；他租户看不到、写不进', async () => {
    const a = await world('oa10a-rls-a');
    const b = await world('oa10a-rls-b');
    const row = await withTenant(testDb().db, a.w.tenant.id, async (tx) => {
      const inserted = await insertHeader(tx, a.w, a.orgId);
      return {
        inserted,
        read: resultRows<Record<string, unknown>>(
          await tx.execute(sql`SELECT approval_status, execution_status, revision, data_volume,
            success_count, failure_count FROM org_adjustments WHERE id = ${inserted.id}`),
        )[0],
      };
    });
    expect(row.read).toMatchObject({
      approval_status: 0,
      execution_status: 1,
      revision: 1,
      data_volume: 0,
      success_count: 0,
      failure_count: 0,
    });
    const seenByB = await withTenant(testDb().db, b.w.tenant.id, async (tx) =>
      resultRows(await tx.execute(sql`SELECT id FROM org_adjustments WHERE id = ${row.inserted.id}`)),
    );
    expect(seenByB).toEqual([]);
    const crossTenant = await rejects(b.w, (tx) =>
      tx.execute(
        sql`INSERT INTO org_adjustments(tenant_id, code, subject, effective_date, approval_subject_org_id, created_by)
          VALUES (${b.w.tenant.id}, ${`OA${uniqueSuffix()}`}, '跨租户', '2026-11-01', ${a.orgId}, ${b.w.hr.id})`,
      ),
    );
    expect(crossTenant).toMatch(/foreign key|approval_subject/i);
  });
});

describe('申请单 CHECK（§2.1）', () => {
  it('审批状态只能 0～6、执行状态只能 1～3；两列各自检查，不加组合约束', async () => {
    const { w, orgId } = await world('oa10a-status');
    for (const status of [0, 1, 2, 3, 4, 5, 6]) {
      await withTenant(testDb().db, w.tenant.id, (tx) => insertHeader(tx, w, orgId, { approval_status: status }));
    }
    for (const status of [3, 2, 1]) {
      // 审批中 + 执行中、审批通过 + 已执行等任意组合在数据层都合法
      await withTenant(testDb().db, w.tenant.id, (tx) =>
        insertHeader(tx, w, orgId, { approval_status: 1, execution_status: status }),
      );
    }
    for (const bad of [
      { approval_status: 7 },
      { approval_status: -1 },
      { execution_status: 0 },
      { execution_status: 4 },
    ]) {
      expect(await rejects(w, (tx) => insertHeader(tx, w, orgId, bad)), JSON.stringify(bad)).toMatch(/check|violates/i);
    }
  });

  it('主题 1～100 字、调整内容 ≤ 2000、revision > 0、数据量与计数 ≥ 0、同租户编号唯一', async () => {
    const { w, orgId } = await world('oa10a-text');
    const bad: Record<string, unknown>[] = [
      { subject: '' },
      { subject: '  ' },
      { subject: '题'.repeat(101) },
      { content: '内'.repeat(2001) },
      { revision: 0 },
      { data_volume: -1 },
      { success_count: -1 },
      { failure_count: -1 },
    ];
    for (const over of bad) {
      expect(await rejects(w, (tx) => insertHeader(tx, w, orgId, over)), JSON.stringify(over).slice(0, 40)).toMatch(
        /check|violates/i,
      );
    }
    await withTenant(testDb().db, w.tenant.id, (tx) =>
      insertHeader(tx, w, orgId, {
        subject: '题'.repeat(100),
        content: '内'.repeat(2000),
      }),
    );
    const code = `OA${uniqueSuffix()}`;
    await withTenant(testDb().db, w.tenant.id, (tx) => insertHeader(tx, w, orgId, { code }));
    expect(await rejects(w, (tx) => insertHeader(tx, w, orgId, { code }))).toMatch(/duplicate|unique/i);
  });
});

describe('组织明细 CHECK 与唯一约束（§2.2）', () => {
  it('新增无目标组织；变更 / 停用必须有目标；调整类型只能 1～3', async () => {
    const { w, orgId } = await world('oa10a-items');
    const adjustmentId = await withTenant(
      testDb().db,
      w.tenant.id,
      async (tx) => (await insertHeader(tx, w, orgId)).id,
    );
    await withTenant(testDb().db, w.tenant.id, async (tx) => {
      await insertItem(tx, w, adjustmentId, { seq: 1, adjust_type: 1 });
      await insertItem(tx, w, adjustmentId, { seq: 2, adjust_type: 2, target_org_id: orgId });
    });
    const bad: Record<string, unknown>[] = [
      { seq: 3, adjust_type: 0 },
      { seq: 3, adjust_type: 4 },
      { seq: 3, adjust_type: 1, target_org_id: orgId },
      { seq: 3, adjust_type: 3 },
      { seq: 3, level: 11 },
      { seq: 3, level: 0 },
      { seq: 3, half_level: 3 },
      { seq: 3, deactivation_establishment_mode: 3 },
      { seq: 3, execution_result: 3 },
      { seq: 3, exec_phase: 3 },
      { seq: 3, employment_done: -1 },
      { seq: 3, parent_org_id: orgId, parent_item_id: randomUUID() },
      { seq: 3, transfer_to_org_id: orgId, transfer_to_item_id: randomUUID() },
      { seq: 1 },
    ];
    for (const over of bad) {
      expect(await rejects(w, (tx) => insertItem(tx, w, adjustmentId, over)), JSON.stringify(over)).toMatch(
        /check|violates|duplicate|unique/i,
      );
    }
  });

  it('既有组织一张单里只出现一次；created_org_id 部分唯一；明细引用同单明细', async () => {
    const { w, orgId } = await world('oa10a-unique');
    const other = await w.org(`其他${uniqueSuffix()}`);
    const [first, second] = await withTenant(testDb().db, w.tenant.id, async (tx) => [
      (await insertHeader(tx, w, orgId)).id,
      (await insertHeader(tx, w, orgId)).id,
    ]);
    await withTenant(testDb().db, w.tenant.id, async (tx) => {
      await insertItem(tx, w, first!, { seq: 1, adjust_type: 2, target_org_id: orgId });
      // 同一既有组织可出现在另一张单
      await insertItem(tx, w, second!, { seq: 1, adjust_type: 2, target_org_id: orgId });
      await insertItem(tx, w, first!, { seq: 2, adjust_type: 1, created_org_id: other });
    });
    expect(
      await rejects(w, (tx) => insertItem(tx, w, first!, { seq: 3, adjust_type: 3, target_org_id: orgId })),
    ).toMatch(/duplicate|unique/i);
    expect(
      await rejects(w, (tx) => insertItem(tx, w, second!, { seq: 2, adjust_type: 1, created_org_id: other })),
    ).toMatch(/duplicate|unique/i);
    // 引用别的单的明细 → 外键拒绝；引用同单明细 → 通过
    const parent = await withTenant(testDb().db, w.tenant.id, async (tx) =>
      resultRows<{ id: string }>(
        await tx.execute(sql`SELECT id FROM org_adjustment_org_items WHERE adjustment_id = ${first!} AND seq = 2`),
      ),
    );
    expect(await rejects(w, (tx) => insertItem(tx, w, second!, { seq: 3, parent_item_id: parent[0]!.id }))).toMatch(
      /foreign key/i,
    );
    await withTenant(testDb().db, w.tenant.id, (tx) =>
      insertItem(tx, w, first!, { seq: 4, parent_item_id: parent[0]!.id, cascaded_from_item_id: parent[0]!.id }),
    );
  });
});

describe('共享 CHECK 放宽（§2.4）', () => {
  const definition = async (name: string) =>
    resultRows<{ def: string }>(
      await testDb().db.execute(
        sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name}`,
      ),
    ).map((row) => row.def);

  it('approval_instances.business_type 含 org_adjustment，原 9 项不丢', async () => {
    const [def] = await definition('approval_instances_business_type');
    for (const value of [
      'employment',
      'personnel_change',
      'contract',
      'idp',
      'talent_review',
      'part_time',
      'offer',
      'offer_batch',
      'probation_assessment',
      'org_adjustment',
    ]) {
      expect(def, value).toContain(`'${value}'`);
    }
  });

  it('审批节点 approver 白名单（单人 / 会签两处）含两个新表达式', async () => {
    for (const name of ['approval_nodes_approver', 'approval_nodes_approvers']) {
      const [def] = await definition(name);
      expect(def, name).toContain("'approval_subject_org_hrbp'");
      expect(def, name).toContain("'approval_subject_org_head'");
      expect(def, name).toContain("'assessment_employee'");
    }
  });

  it('变动类型 CHECK（任职记录 / 载荷版本）含 org_adjustment；kind 约束本就含它', async () => {
    for (const name of ['employment_records_change_type', 'employment_payload_versions_change_type']) {
      const [def] = await definition(name);
      expect(def, name).toContain("'org_adjustment'");
      expect(def, name).toContain("'position_adjustment'");
    }
  });
});

describe('AC-OA-42 范围子表契约（BE-10a2，§2.1A）', () => {
  it('范围表 FORCE RLS，头表 scope_note 已删除', async () => {
    expect(
      resultRows(
        await testDb().db.execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid = to_regclass('public.org_adjustment_range_orgs')`),
      ),
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    expect(
      resultRows(
        await testDb().db.execute(sql`SELECT column_name FROM information_schema.columns
      WHERE table_name='org_adjustments' AND column_name='scope_note'`),
      ),
    ).toEqual([]);
  });

  it('同租户复合外键、范围去重主键与跨租户读写隔离', async () => {
    const a = await world('oa-range-a');
    const b = await world('oa-range-b');
    const head = await withTenant(testDb().db, a.w.tenant.id, (tx) => insertHeader(tx, a.w, a.orgId));
    const insert = (tx: Tx, tenant: string, orgId: string) =>
      tx.execute(sql`
      INSERT INTO org_adjustment_range_orgs(tenant_id, adjustment_id, org_id, seq)
      VALUES (${tenant}, ${head.id}, ${orgId}, 1)`);
    await withTenant(testDb().db, a.w.tenant.id, (tx) => insert(tx, a.w.tenant.id, a.orgId));
    expect(await rejects(a.w, (tx) => insert(tx, a.w.tenant.id, a.orgId))).toMatch(/duplicate|unique/i);
    expect(await rejects(a.w, (tx) => insert(tx, a.w.tenant.id, b.orgId))).toMatch(/foreign key/i);
    expect(await rejects(b.w, (tx) => insert(tx, b.w.tenant.id, b.orgId))).toMatch(/foreign key/i);
    expect(
      await withTenant(testDb().db, b.w.tenant.id, async (tx) =>
        resultRows(await tx.execute(sql`SELECT * FROM org_adjustment_range_orgs`)),
      ),
    ).toEqual([]);
    expect(await rejects(b.w, (tx) => insert(tx, a.w.tenant.id, b.orgId))).not.toBeNull();
    expect(
      await withTenant(testDb().db, a.w.tenant.id, async (tx) =>
        resultRows(await tx.execute(sql`SELECT org_id, seq FROM org_adjustment_range_orgs`)),
      ),
    ).toEqual([{ org_id: a.orgId, seq: 1 }]);
  });
});
