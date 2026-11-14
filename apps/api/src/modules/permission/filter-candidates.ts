import { and, asc, eq, inArray, permissionGrants, permissionMous, permissionProfiles, sql, type Tx } from '@italent/db';
import { hasAdminCapability } from '@italent/domain';
import { or } from 'drizzle-orm';
import { z } from 'zod';
import { likePattern, listPage, textFilter } from './enterprise-lists.js';
import { grantableSetsOf } from './admins.js';

export const candidateQuery = z.strictObject({ q: textFilter.optional(), ...listPage });
type CandidateQuery = z.infer<typeof candidateQuery>;

/** DEC-889⑥：目录权覆盖未授权身份，其余沿用已可见的授权行与可授予身份。 */
async function candidateVisibility(tx: Tx, actorUserId: string, kind: 'profile' | 'mou') {
  const { heldRoles, profiles } = await grantableSetsOf(tx, actorUserId);
  if (hasAdminCapability(heldRoles, kind === 'profile' ? 'profile_manage' : 'mou_manage')) return sql`true`;
  if (kind === 'mou') return sql`false`;
  // listGrants 可查看本租户全部授权行（含已撤销），grantableProfiles 可查看当前可授予集合。
  return or(
    inArray(permissionProfiles.id, [...profiles]),
    inArray(permissionProfiles.id, tx.select({ id: permissionGrants.profileId }).from(permissionGrants)),
  )!;
}

export async function profileCandidates(tx: Tx, actorUserId: string, query: CandidateQuery) {
  const where = and(
    await candidateVisibility(tx, actorUserId, 'profile'),
    query.q ? sql`lower(${permissionProfiles.name}) LIKE ${likePattern(query.q)}` : undefined,
  );
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
export async function mouCandidates(tx: Tx, actorUserId: string, query: CandidateQuery) {
  const where = and(
    await candidateVisibility(tx, actorUserId, 'mou'),
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
