/**
 * F-048 “对象 → 主体”适配器契约测试套件（设计 §5.3）。集合审批的业务域（如 R3-T04 结果审批）用自己的适配器调用：
 *   runSubjectAdapterContract('盘点结果审批', async () => ({ db, tenantId, ctx, businessId, expected, subjects }))
 * 校验：返回值都是规范 UUID 的本租户员工；覆盖本单快照的全部对象（与 expected 同集合）；只读（在只读事务里调用）；
 * 重复调用结果一致。适配器不得写入、不得自行判断回避。
 */
import { sql, withTenant, type Db, type Tx } from '@italent/db';
import { describe, expect, it } from 'vitest';
import type { BusinessAdapter } from '../../../apps/api/src/modules/approval/adapters.js';
import type { ApprovalContext } from '../../../apps/api/src/modules/approval/context.js';

export interface SubjectAdapterFixture {
  readonly db: Db;
  readonly tenantId: string;
  readonly ctx: ApprovalContext;
  readonly businessId: string;
  /** 本单快照涵盖的全部对象对应的员工（含已终止对象）。 */
  readonly expected: readonly string[];
  readonly subjects: NonNullable<BusinessAdapter['subjects']>;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function readOnly<T>(fixture: SubjectAdapterFixture, run: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(fixture.db, fixture.tenantId, async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    return run(tx);
  });
}

export function runSubjectAdapterContract(name: string, setup: () => Promise<SubjectAdapterFixture>): void {
  describe(`F-048 主体适配器契约：${name}`, () => {
    it('只读调用返回规范 UUID，覆盖本单全部对象的员工，重复调用一致', async () => {
      const fixture = await setup();
      const first = await readOnly(fixture, (tx) => fixture.subjects(tx, fixture.ctx, fixture.businessId));
      const second = await readOnly(fixture, (tx) => fixture.subjects(tx, fixture.ctx, fixture.businessId));
      for (const id of first) expect(id).toMatch(CANONICAL_UUID);
      expect(new Set(first)).toEqual(new Set(fixture.expected.map((id) => id.toLowerCase())));
      expect(new Set(second)).toEqual(new Set(first));
      const known = await withTenant(fixture.db, fixture.tenantId, async (tx) => {
        const rows = await tx.execute(sql`SELECT count(*)::int AS n FROM employment_employees
          WHERE tenant_id=${fixture.tenantId} AND id = ANY(${`{${[...new Set(first)].join(',')}}`}::uuid[])`);
        const list = (Array.isArray(rows) ? rows : (rows as { rows: { n: number }[] }).rows) as { n: number }[];
        return Number(list[0]?.n ?? 0);
      });
      expect(known).toBe(new Set(first).size);
    });
  });
}
