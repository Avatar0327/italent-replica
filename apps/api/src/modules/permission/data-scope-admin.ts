/** 管理单元与用户×应用范围：同事务写业务、不可变版本和审计；撤身份不回滚共享范围（DEC-043）。 */
import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  eq,
  inArray,
  orgObjects,
  permissionMouOrgRefs,
  permissionMous,
  permissionProfileApps,
  permissionScopeApps,
  permissionScopeVersions,
  permissionUserAppScopes,
  pgErrorCode,
  sql,
  tenantMemberships,
  type Tx,
} from '@italent/db';
import { AppError } from '../../errors.js';
import { audit, type WriteContext } from './audit.js';
import type { GrantScopeInput, MouInput, OrgRangeInput, ScopeAssignment } from './data-scope-schemas.js';
import { revisionConflict } from './http.js';
import { assertActiveMember } from './members.js';
import { loadProfile } from './profiles.js';

type MouRow = typeof permissionMous.$inferSelect;
export interface ScopeView {
  readonly userId: string;
  readonly appCode: string;
  readonly kind: 'default' | 'mou' | 'org_range';
  readonly mouId: string | null;
  readonly revision: number;
  readonly orgRanges: readonly OrgRangeInput[];
}
const notFound = () => new AppError('NOT_FOUND', '数据范围对象不存在');

export async function recordScopeChange(
  tx: Tx,
  write: WriteContext,
  change: { objectType: string; objectId: string; revision: number; before: unknown; after: unknown },
): Promise<void> {
  await tx.insert(permissionScopeVersions).values({
    ...change,
    tenantId: write.tenantId,
    commandId: write.commandId,
    createdAt: write.now,
  });
  await audit(tx, write, { ...change, action: `${change.objectType}.change` });
}

async function orgRefs(tx: Tx, mouId: string): Promise<OrgRangeInput[]> {
  const refs = await tx
    .select({
      orgId: permissionMouOrgRefs.orgId,
      dimension: permissionMouOrgRefs.dimension,
      includeDescendants: permissionMouOrgRefs.includeDescendants,
    })
    .from(permissionMouOrgRefs)
    .where(eq(permissionMouOrgRefs.mouId, mouId))
    .orderBy(asc(permissionMouOrgRefs.orgId));
  return refs as OrgRangeInput[];
}

export async function getMou(tx: Tx, id: string) {
  const [row] = await tx.select().from(permissionMous).where(eq(permissionMous.id, id));
  if (!row || row.kind !== 'named' || row.status === 'deleted') throw notFound();
  return { ...row, orgRanges: await orgRefs(tx, id) };
}

export async function listMous(tx: Tx, page: { limit: number; offset: number }) {
  return tx
    .select()
    .from(permissionMous)
    .where(and(eq(permissionMous.kind, 'named'), sql`${permissionMous.status}<>'deleted'`))
    .orderBy(asc(permissionMous.code), asc(permissionMous.id))
    .limit(page.limit)
    .offset(page.offset);
}

async function validateRefs(tx: Tx, refs: readonly OrgRangeInput[]) {
  if (refs.length > 200) throw new AppError('VALIDATION_FAILED', '一次最多选择200个组织');
  const keys = new Set(refs.map((r) => `${r.orgId}:${r.dimension}`));
  if (keys.size !== refs.length) throw new AppError('VALIDATION_FAILED', '组织范围不能重复');
  const ids = [...new Set(refs.map((r) => r.orgId))];
  if (!ids.length) return;
  const rows = await tx.select({ id: orgObjects.id }).from(orgObjects).where(inArray(orgObjects.id, ids));
  if (rows.length !== ids.length) throw notFound();
}

async function replaceRefs(tx: Tx, tenantId: string, mouId: string, refs: readonly OrgRangeInput[]) {
  await tx.delete(permissionMouOrgRefs).where(eq(permissionMouOrgRefs.mouId, mouId));
  if (refs.length) await tx.insert(permissionMouOrgRefs).values(refs.map((ref) => ({ ...ref, tenantId, mouId })));
}

async function validateParent(tx: Tx, parentId: string | null, id?: string) {
  if (!parentId) return;
  const parent = await getMou(tx, parentId);
  if (parent.status !== 'active') throw notFound();
  if (parentId === id) throw new AppError('VALIDATION_FAILED', '管理单元不能形成循环');
  if (!id) return;
  const result = await tx.execute(sql`
    WITH RECURSIVE parents AS (
      SELECT id,parent_id,ARRAY[id] AS path FROM permission_mous WHERE id=${parentId}::uuid
      UNION ALL SELECT m.id,m.parent_id,p.path||m.id FROM permission_mous m JOIN parents p ON m.id=p.parent_id
      WHERE NOT m.id=ANY(p.path)
    ) SELECT id FROM parents WHERE id=${id}::uuid LIMIT 1
  `);
  const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
  if (rows.length) throw new AppError('VALIDATION_FAILED', '管理单元不能形成循环');
}

export async function createMou(tx: Tx, write: WriteContext, input: MouInput, expectedRevision: number) {
  if (expectedRevision !== 0) throw revisionConflict(expectedRevision, 0);
  await validateRefs(tx, input.orgRanges);
  await validateParent(tx, input.parentId);
  const { orgRanges, ...fields } = input;
  let saved: MouRow;
  try {
    const [row] = await tx
      .insert(permissionMous)
      .values({ ...fields, tenantId: write.tenantId, createdAt: write.now })
      .returning();
    saved = row!;
  } catch (error) {
    if (pgErrorCode(error) === '23505') throw new AppError('CONFLICT', '管理单元编码已存在');
    throw error;
  }
  await replaceRefs(tx, write.tenantId, saved.id, orgRanges);
  const after = { ...saved, orgRanges };
  await recordScopeChange(tx, write, {
    objectType: 'permission_mou',
    objectId: saved.id,
    revision: 1,
    before: null,
    after,
  });
  return after;
}

export async function updateMou(
  tx: Tx,
  write: WriteContext,
  id: string,
  expectedRevision: number,
  input: MouInput | null,
) {
  // 序列化管理单元的层级变更，避免 A→B/B→A 并发分别通过循环检查。
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${write.tenantId + ':mou-hierarchy'},0))`);
  const [row] = await tx.select().from(permissionMous).where(eq(permissionMous.id, id)).for('update');
  if (!row || row.kind !== 'named' || row.status === 'deleted') throw notFound();
  if (row.revision !== expectedRevision) throw revisionConflict(expectedRevision, row.revision);
  const before = { ...row, orgRanges: await orgRefs(tx, id) };
  if (input) {
    await validateRefs(tx, input.orgRanges);
    await validateParent(tx, input.parentId, id);
  }
  const revision = row.revision + 1;
  const fields = input
    ? {
        code: input.code,
        name: input.name,
        parentId: input.parentId,
        description: input.description,
        status: input.status,
      }
    : { status: 'deleted' as const };
  let saved: MouRow;
  try {
    const [result] = await tx
      .update(permissionMous)
      .set({ ...fields, revision })
      .where(eq(permissionMous.id, id))
      .returning();
    saved = result!;
  } catch (error) {
    if (pgErrorCode(error) === '23505') throw new AppError('CONFLICT', '管理单元编码已存在');
    throw error;
  }
  if (input) await replaceRefs(tx, write.tenantId, id, input.orgRanges);
  const after = { ...saved, orgRanges: input?.orgRanges ?? before.orgRanges };
  await recordScopeChange(tx, write, { objectType: 'permission_mou', objectId: id, revision, before, after });
  return after;
}

export async function getUserAppScope(tx: Tx, userId: string, appCode: string): Promise<ScopeView> {
  await assertActiveMember(tx, userId);
  const [row] = await tx
    .select()
    .from(permissionUserAppScopes)
    .where(and(eq(permissionUserAppScopes.userId, userId), eq(permissionUserAppScopes.appCode, appCode)));
  if (!row) return { userId, appCode, kind: 'default', mouId: null, revision: 0, orgRanges: [] };
  return {
    userId,
    appCode,
    kind: row.kind,
    mouId: row.mouId,
    revision: row.revision,
    orgRanges: row.mouId ? await orgRefs(tx, row.mouId) : [],
  };
}

async function virtualMou(
  tx: Tx,
  write: WriteContext,
  userId: string,
  appCode: string,
  refs: readonly OrgRangeInput[],
) {
  const [current] = await tx
    .select()
    .from(permissionMous)
    .where(
      and(
        eq(permissionMous.kind, 'virtual'),
        eq(permissionMous.ownerUserId, userId),
        eq(permissionMous.appCode, appCode),
      ),
    );
  const before = current ? { ...current, orgRanges: await orgRefs(tx, current.id) } : null;
  let saved: MouRow;
  if (current) {
    const [row] = await tx
      .update(permissionMous)
      .set({ revision: current.revision + 1, status: 'active' })
      .where(eq(permissionMous.id, current.id))
      .returning();
    saved = row!;
  } else {
    const [row] = await tx
      .insert(permissionMous)
      .values({
        tenantId: write.tenantId,
        kind: 'virtual',
        ownerUserId: userId,
        appCode,
        code: `virtual-${randomUUID()}`,
        name: '组织范围',
        createdAt: write.now,
      })
      .returning();
    saved = row!;
  }
  await replaceRefs(tx, write.tenantId, saved.id, refs);
  await recordScopeChange(tx, write, {
    objectType: 'permission_mou',
    objectId: saved.id,
    revision: saved.revision,
    before,
    after: { ...saved, orgRanges: refs },
  });
  return saved.id;
}

export async function assignUserAppScope(
  tx: Tx,
  write: WriteContext,
  userId: string,
  appCode: string,
  expectedRevision: number,
  input: ScopeAssignment,
): Promise<ScopeView> {
  await assertActiveMember(tx, userId);
  // 首次写无范围行可锁，锁成员行使首次并发同样得到明确 409。用 NO KEY UPDATE：同样串行化范围写入，但不与
  // 审批派单的 FOR KEY SHARE 冲突——成员行上的 FOR UPDATE 只留给成员停用（R1-T07 R4-2 串行协议）。
  await tx
    .select({ id: tenantMemberships.id })
    .from(tenantMemberships)
    .where(eq(tenantMemberships.userId, userId))
    .for('no key update');
  const before = await getUserAppScope(tx, userId, appCode);
  if (before.revision !== expectedRevision) throw revisionConflict(expectedRevision, before.revision);
  const [app] = await tx.select().from(permissionScopeApps).where(eq(permissionScopeApps.appCode, appCode));
  const allowed =
    app?.allowedKinds ?? (appCode === 'TenantBase' ? ['default', 'mou', 'org_range'] : ['default', 'mou']);
  if (!allowed.includes(input.kind)) throw new AppError('VALIDATION_FAILED', '该应用不支持此范围类型');
  let mouId: string | null = null;
  if (input.kind === 'mou') {
    const mou = await getMou(tx, input.mouId);
    if (mou.status !== 'active') throw notFound();
    mouId = mou.id;
  } else if (input.kind === 'org_range') {
    await validateRefs(tx, input.orgRanges);
    mouId = await virtualMou(tx, write, userId, appCode, input.orgRanges);
  }
  const value = { tenantId: write.tenantId, userId, appCode, kind: input.kind, mouId, revision: before.revision + 1 };
  await tx
    .insert(permissionUserAppScopes)
    .values(value)
    .onConflictDoUpdate({
      target: [permissionUserAppScopes.tenantId, permissionUserAppScopes.userId, permissionUserAppScopes.appCode],
      set: { kind: value.kind, mouId, revision: value.revision },
    });
  const after = await getUserAppScope(tx, userId, appCode);
  await recordScopeChange(tx, write, {
    objectType: 'permission_user_app_scope',
    objectId: `${userId}:${appCode}`,
    revision: value.revision,
    before,
    after,
  });
  return after;
}

export async function applyGrantScopes(
  tx: Tx,
  write: WriteContext,
  userId: string,
  profileId: string,
  scopes: readonly GrantScopeInput[],
) {
  if (new Set(scopes.map((s) => s.appCode)).size !== scopes.length)
    throw new AppError('VALIDATION_FAILED', '同一应用只能设置一次范围');
  const apps = await tx
    .select({ appCode: permissionProfileApps.appCode })
    .from(permissionProfileApps)
    .where(eq(permissionProfileApps.profileId, profileId));
  for (const scope of scopes) {
    if (!apps.some((app) => app.appCode === scope.appCode)) throw new AppError('VALIDATION_FAILED', '身份不覆盖该应用');
    await assignUserAppScope(tx, write, userId, scope.appCode, scope.expectedRevision, scope);
  }
}

export async function grantScopePrefill(tx: Tx, userId: string, profileId: string) {
  await assertActiveMember(tx, userId);
  await loadProfile(tx, profileId);
  const apps = await tx
    .select({ appCode: permissionProfileApps.appCode })
    .from(permissionProfileApps)
    .where(eq(permissionProfileApps.profileId, profileId))
    .orderBy(asc(permissionProfileApps.appCode));
  const appCodes = apps.map((app) => app.appCode);
  const current = appCodes.length
    ? await tx
        .select()
        .from(permissionUserAppScopes)
        .where(and(eq(permissionUserAppScopes.userId, userId), inArray(permissionUserAppScopes.appCode, appCodes)))
    : [];
  const mouIds = [...new Set(current.flatMap((scope) => (scope.mouId ? [scope.mouId] : [])))];
  const refs = mouIds.length
    ? await tx
        .select()
        .from(permissionMouOrgRefs)
        .where(inArray(permissionMouOrgRefs.mouId, mouIds))
        .orderBy(asc(permissionMouOrgRefs.orgId))
    : [];
  const scopes = apps.map(({ appCode }) => {
    const row = current.find((scope) => scope.appCode === appCode);
    return {
      userId,
      appCode,
      kind: row?.kind ?? 'default',
      mouId: row?.mouId ?? null,
      revision: row?.revision ?? 0,
      orgRanges: refs
        .filter((ref) => ref.mouId === row?.mouId)
        .map(({ orgId, dimension, includeDescendants }) => ({ orgId, dimension, includeDescendants })),
    };
  });
  return { sharedScopeNotice: '此范围由该用户在应用下的所有身份共享', scopes };
}
