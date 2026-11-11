import { and, asc, eq, permissionMous, permissionProfiles, sql, type Tx } from '@italent/db';
import { z } from 'zod';
import { likePattern, listPage, textFilter } from './enterprise-lists.js';

export const candidateQuery = z.strictObject({ q: textFilter.optional(), ...listPage });
type CandidateQuery = z.infer<typeof candidateQuery>;

/** DEC-889⑥：筛选候选按列表查看能力读取配置目录，覆盖无授权行的身份，不使用可授予集合。 */
export async function profileCandidates(tx: Tx, query: CandidateQuery) {
  const where = query.q ? sql`lower(${permissionProfiles.name}) LIKE ${likePattern(query.q)}` : undefined;
  const items = await tx
    .select({ id: permissionProfiles.id, name: permissionProfiles.name })
    .from(permissionProfiles)
    .where(where)
    .orderBy(asc(permissionProfiles.code), asc(permissionProfiles.id))
    .limit(query.limit)
    .offset(query.offset);
  const [count] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(permissionProfiles)
    .where(where);
  return { items, total: count!.total };
}

/** 与既有管理单元目录同口径，命名且未删除；停用单元仍可用于检索已分配的记录。 */
export async function mouCandidates(tx: Tx, query: CandidateQuery) {
  const where = and(
    eq(permissionMous.kind, 'named'),
    sql`${permissionMous.status} <> 'deleted'`,
    query.q ? sql`lower(${permissionMous.name}) LIKE ${likePattern(query.q)}` : undefined,
  );
  const items = await tx
    .select({ id: permissionMous.id, name: permissionMous.name })
    .from(permissionMous)
    .where(where)
    .orderBy(asc(permissionMous.code), asc(permissionMous.id))
    .limit(query.limit)
    .offset(query.offset);
  const [count] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(permissionMous)
    .where(where);
  return { items, total: count!.total };
}
