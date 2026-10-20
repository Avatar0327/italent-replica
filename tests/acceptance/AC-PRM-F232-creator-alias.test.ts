/** F-232 / DEC-198：创建人 SQL 在关联与嵌套查询里不得遮蔽调用方的别名。 */
import { randomUUID } from 'node:crypto';
import { auditObjectCreators, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import type { SQL } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { firstCreatorSql } from '../../apps/api/src/modules/permission/scope-audit.js';
import { seedTenantWithMember } from './support/tenant-api.js';

const database = useTestDb();
const ACTION = 'f232.object.create';
const linkId = randomUUID();
let tenantId: string;
let otherTenantId: string;
let creatorId: string;
let otherCreatorId: string;

beforeAll(async () => {
  const { db } = database();
  const own = await seedTenantWithMember(db, 'f232-own');
  const other = await seedTenantWithMember(db, 'f232-other');
  tenantId = own.tenant.id;
  otherTenantId = other.tenant.id;
  creatorId = own.user.id;
  otherCreatorId = other.user.id;
  await withTenant(db, tenantId, (tx) =>
    tx.insert(auditObjectCreators).values(
      [
        // 较早的其他对象使 object_id 错绑必然返回错误创建人，不能靠恰巧命中目标而通过。
        {
          objectId: randomUUID(),
          objectType: 'target',
          creatorUserId: otherCreatorId,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          objectId: creatorId,
          objectType: 'target',
          creatorUserId: creatorId,
          createdAt: new Date('2026-01-02T00:00:00Z'),
        },
        {
          objectId: creatorId,
          objectType: 'alternate',
          creatorUserId: otherCreatorId,
          createdAt: new Date('2026-01-03T00:00:00Z'),
        },
        {
          objectId: randomUUID(),
          objectType: 'link',
          creatorUserId: otherCreatorId,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
        { objectId: linkId, objectType: 'link', creatorUserId: creatorId, createdAt: new Date('2026-01-04T00:00:00Z') },
      ].map((row) => ({ ...row, tenantId, action: ACTION })),
    ),
  );
  await withTenant(db, otherTenantId, (tx) =>
    tx.insert(auditObjectCreators).values({
      tenantId: otherTenantId,
      objectId: creatorId,
      objectType: 'target',
      action: ACTION,
      creatorUserId: otherCreatorId,
      createdAt: new Date('2025-01-01T00:00:00Z'),
    }),
  );
});

async function query(statement: SQL) {
  return withTenant(database().db, tenantId, async (tx) => {
    const result = await tx.execute(statement);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { creator: string | null }[];
  });
}

const source = (objectId: string) => sql`(VALUES (${tenantId}::uuid, ${objectId}::text))
  AS creator_meta(tenant_id, object_id)`;

describe('AC-PRM-F232 创建人子查询别名隔离', () => {
  it('AC-PRM-F232-01 外层旧固定别名的专有列不被遮蔽（旧实现 42703）', async () => {
    const creator = firstCreatorSql(tenantId, sql`creator_meta.target_id`, ACTION, 'target');
    expect(
      await query(sql`SELECT ${creator} AS creator
      FROM (VALUES (${creatorId}::uuid)) AS creator_meta(target_id)`),
    ).toEqual([{ creator: creatorId }]);
  });

  it('AC-PRM-F232-02 外层与元数据同名列仍关联目标对象，不静默取最早的其他对象', async () => {
    const creator = firstCreatorSql(sql`creator_meta.tenant_id`, sql`creator_meta.object_id`, ACTION, 'target');
    expect(await query(sql`SELECT ${creator} AS creator FROM ${source(creatorId)}`)).toEqual([{ creator: creatorId }]);
  });

  it('AC-PRM-F232-03 两层 helper 嵌套仍读取最外层对象表达式', async () => {
    const linkedId = firstCreatorSql(sql`creator_meta.tenant_id`, sql`creator_meta.object_id`, ACTION, 'link');
    const creator = firstCreatorSql(sql`creator_meta.tenant_id`, linkedId, ACTION, 'target');
    expect(await query(sql`SELECT ${creator} AS creator FROM ${source(linkId)}`)).toEqual([{ creator: creatorId }]);
  });

  it('AC-PRM-F232-04 外层租户表达式不被改绑，未匹配租户时不得返回当前租户创建人', async () => {
    const creator = firstCreatorSql(sql`creator_meta.tenant_id`, sql`${creatorId}`, ACTION, 'target');
    expect(
      await query(sql`SELECT ${creator} AS creator
      FROM (VALUES (${randomUUID()}::uuid)) AS creator_meta(tenant_id)`),
    ).toEqual([{ creator: null }]);
  });

  it('AC-PRM-F232-05 保持可选对象类型、首个创建时间、动作过滤与未找到返回 null', async () => {
    const lookups = [
      firstCreatorSql(tenantId, sql`${creatorId}`, ACTION),
      firstCreatorSql(tenantId, sql`${creatorId}`, ACTION, 'alternate'),
      firstCreatorSql(tenantId, sql`${creatorId}`, 'f232.other.create'),
      firstCreatorSql(tenantId, sql`${randomUUID()}`, ACTION),
    ];
    expect(
      await query(
        sql.join(
          lookups.map((creator) => sql`SELECT ${creator} AS creator`),
          sql` UNION ALL `,
        ),
      ),
    ).toEqual([{ creator: creatorId }, { creator: otherCreatorId }, { creator: null }, { creator: null }]);
  });

  it('AC-PRM-F232-06 同形查询保持 SQL 文本稳定，参数变化不产生新别名', () => {
    const build = (id: string) =>
      database()
        .db.select({ creator: firstCreatorSql(tenantId, sql`${id}`, ACTION, 'target') })
        .from(auditObjectCreators)
        .toSQL();
    const first = build(creatorId);
    const second = build(otherCreatorId);
    expect(first.sql).toBe(second.sql);
    expect(first.params).not.toEqual(second.params);
  });

  it.each(['creator_meta_1', 'creator_meta_2', 'CREATOR_META_1'])(
    'AC-PRM-F232-07 外层已占用层级别名 %s 时仍能关联目标',
    async (alias) => {
      const outer = sql.identifier(alias);
      const creator = firstCreatorSql(sql`${outer}.tenant_id`, sql`${outer}.object_id`, ACTION, 'target');
      expect(
        await query(sql`SELECT ${creator} AS creator
          FROM (VALUES (${tenantId}::uuid, ${creatorId}::text)) AS ${outer}(tenant_id, object_id)`),
      ).toEqual([{ creator: creatorId }]);
    },
  );
});
