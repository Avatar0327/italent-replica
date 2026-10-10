import { PERSONNEL_SCOPE_FIELDS } from '@italent/domain';
/** 显式范围配置；身份绕过必须由租户管理员授予，空配置始终 fail-closed。 */
import {
  and,
  desc,
  eq,
  permissionDynamicOrgGrants,
  permissionGrants,
  permissionIdentityScopes,
  permissionProfileApps,
  permissionScopeApps,
  permissionScopePolicies,
  permissionScopePolicyRules,
  permissionScopeVersions,
  permissionUserPersonLinks,
  sql,
  type Tx,
} from '@italent/db';
import { ESTABLISHMENT_SCHEME_DATASOURCE, MODULE_OBJECTS } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { WriteContext } from './audit.js';
import { objectCatalog } from './catalog.js';
import { recordScopeChange } from './data-scope-admin.js';
import { revisionConflict } from './http.js';
import { loadProfile } from './profiles.js';
import { assertActiveMember } from './members.js';

export const identityScopeBody = z.strictObject({
  targetKind: z.enum(['app', 'entity', 'page', 'datasource']),
  targetCode: z.string().max(128),
  seeAll: z.boolean(),
});
export type IdentityTarget = Pick<z.infer<typeof identityScopeBody>, 'targetKind' | 'targetCode'>;
export interface IdentityScopeKey extends IdentityTarget {
  profileId: string;
  appCode: string;
}
const invalid = (message: string) => new AppError('VALIDATION_FAILED', message);
/** 业务模块按数据源编码单独解析范围的内置数据源 → 所属对象（module-route-access.ts 的 requestScope dataSource 参数）。 */
const BUILTIN_SCOPE_DATASOURCES: Readonly<Record<string, string>> = {
  [ESTABLISHMENT_SCHEME_DATASOURCE]: MODULE_OBJECTS.establishment.code,
};

/** 范围策略写入的串行化锁；key 是对象标识（含身份 / 授权 id 等）。 */
export async function lockScopeObject(tx: Tx, tenantId: string, key: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':' + key},0))`);
}
const lock = (tx: Tx, write: WriteContext, key: string) => lockScopeObject(tx, write.tenantId, key);

async function identityTarget(tx: Tx, key: IdentityScopeKey) {
  await loadProfile(tx, key.profileId);
  const [app] = await tx
    .select()
    .from(permissionProfileApps)
    .where(and(eq(permissionProfileApps.profileId, key.profileId), eq(permissionProfileApps.appCode, key.appCode)));
  if (!app) throw invalid('身份未登记该应用');
  if (key.targetKind === 'app') {
    if (key.targetCode !== '') throw invalid('应用级数据权限的目标编码必须为空');
    return;
  }
  if (!key.targetCode.trim()) throw invalid('数据权限目标编码不能为空');
  if (key.targetKind === 'entity') {
    const entity = objectCatalog.get(key.targetCode);
    if (!entity || entity.application !== key.appCode) throw invalid('目标对象不属于该应用');
    return;
  }
  // 模块内置的数据源（如编制方案，DEC-121 开通预置的目标）直接按所属对象校验
  const builtin = key.targetKind === 'datasource' ? BUILTIN_SCOPE_DATASOURCES[key.targetCode] : undefined;
  if (builtin) {
    if (objectCatalog.get(builtin)?.application !== key.appCode) throw invalid('目标对象不属于该应用');
    return;
  }
  // R1 尚无页面元数据模块：已登记的消费策略提供可校验的页面/数据源所属应用与对象。
  const policies = await tx
    .select({ objectCode: permissionScopePolicies.objectCode })
    .from(permissionScopePolicies)
    .where(
      and(
        eq(permissionScopePolicies.appCode, key.appCode),
        eq(permissionScopePolicies.targetKind, key.targetKind),
        eq(permissionScopePolicies.targetCode, key.targetCode),
      ),
    )
    .limit(2);
  if (policies.length !== 1) throw invalid('页面或数据源尚未登记唯一的鉴权对象');
  const entity = objectCatalog.get(policies[0]!.objectCode);
  if (entity?.application !== key.appCode) throw invalid('目标对象不属于该应用');
}

const identityWhere = (key: IdentityScopeKey) =>
  and(
    eq(permissionIdentityScopes.profileId, key.profileId),
    eq(permissionIdentityScopes.appCode, key.appCode),
    eq(permissionIdentityScopes.targetKind, key.targetKind),
    eq(permissionIdentityScopes.targetCode, key.targetCode),
  );

export async function getIdentityScope(tx: Tx, key: IdentityScopeKey) {
  await identityTarget(tx, key);
  const [row] = await tx.select().from(permissionIdentityScopes).where(identityWhere(key));
  return row ?? { ...key, seeAll: false, revision: 0 };
}

export async function setIdentityScope(
  tx: Tx,
  write: WriteContext,
  key: IdentityScopeKey,
  seeAll: boolean,
  expectedRevision: number,
) {
  const objectId = `${key.profileId}:${key.appCode}:${key.targetKind}:${key.targetCode}`;
  await lock(tx, write, `identity-scope:${objectId}`);
  const before = await getIdentityScope(tx, key);
  if (before.revision !== expectedRevision) throw revisionConflict(expectedRevision, before.revision);
  const revision = before.revision + 1;
  const [after] = await tx
    .insert(permissionIdentityScopes)
    .values({ ...key, tenantId: write.tenantId, seeAll, revision })
    .onConflictDoUpdate({
      target: [
        permissionIdentityScopes.tenantId,
        permissionIdentityScopes.profileId,
        permissionIdentityScopes.appCode,
        permissionIdentityScopes.targetKind,
        permissionIdentityScopes.targetCode,
      ],
      set: { seeAll, revision },
    })
    .returning();
  await recordScopeChange(tx, write, { objectType: 'permission_identity_scope', objectId, revision, before, after });
  return after!;
}

export const scopeAppBody = z.strictObject({
  family: z.enum(['hr', 'attendance', 'other', 'payroll']),
  allowedKinds: z
    .array(z.enum(['default', 'mou', 'org_range']))
    .min(1)
    .max(3)
    .refine((kinds) => new Set(kinds).size === kinds.length, '范围类型不能重复'),
});

export async function getScopeApp(tx: Tx, appCode: string) {
  const [row] = await tx.select().from(permissionScopeApps).where(eq(permissionScopeApps.appCode, appCode));
  return (
    row ?? {
      appCode,
      family: appCode === 'TenantBase' ? 'hr' : 'other',
      allowedKinds: appCode === 'TenantBase' ? ['default', 'mou', 'org_range'] : ['default', 'mou'],
      revision: 0,
    }
  );
}

export async function setScopeApp(
  tx: Tx,
  write: WriteContext,
  appCode: string,
  body: z.infer<typeof scopeAppBody>,
  expectedRevision: number,
) {
  await lock(tx, write, `scope-app:${appCode}`);
  const before = await getScopeApp(tx, appCode);
  if (before.revision !== expectedRevision) throw revisionConflict(expectedRevision, before.revision);
  const revision = before.revision + 1;
  const [after] = await tx
    .insert(permissionScopeApps)
    .values({ ...body, tenantId: write.tenantId, appCode, revision })
    .onConflictDoUpdate({
      target: [permissionScopeApps.tenantId, permissionScopeApps.appCode],
      set: { ...body, revision },
    })
    .returning();
  await recordScopeChange(tx, write, {
    objectType: 'permission_scope_app',
    objectId: appCode,
    revision,
    before,
    after,
  });
  return after!;
}

/** 删除关系也保留版本号，防止旧 If-Match:0 在重建后再次生效（ABA）。 */
async function lastRevision(tx: Tx, objectType: string, objectId: string) {
  const [version] = await tx
    .select({ revision: permissionScopeVersions.revision })
    .from(permissionScopeVersions)
    .where(and(eq(permissionScopeVersions.objectType, objectType), eq(permissionScopeVersions.objectId, objectId)))
    .orderBy(desc(permissionScopeVersions.revision))
    .limit(1);
  return version?.revision ?? 0;
}

/** 用户与人员的绑定只读（DEC-128）：写入只在建档 / 入职的同一事务里经 user-provisioning.ts 进行。 */
export async function getPersonLink(tx: Tx, userId: string) {
  await assertActiveMember(tx, userId);
  const [row] = await tx.select().from(permissionUserPersonLinks).where(eq(permissionUserPersonLinks.userId, userId));
  return row ?? { userId, employeeId: null, revision: await lastRevision(tx, 'permission_person_link', userId) };
}

export const dynamicOrgBody = z.strictObject({ roleCode: z.enum(['head', 'hrbp']) });
async function autoGrant(tx: Tx, grantId: string) {
  const [grant] = await tx.select().from(permissionGrants).where(eq(permissionGrants.id, grantId));
  if (!grant) throw new AppError('NOT_FOUND', '授权记录不存在');
  if (grant.source !== 'auto') throw invalid('组织角色范围只能关联自动授权');
  return grant;
}

export async function getDynamicOrgGrant(tx: Tx, grantId: string) {
  await autoGrant(tx, grantId);
  const [row] = await tx
    .select()
    .from(permissionDynamicOrgGrants)
    .where(eq(permissionDynamicOrgGrants.grantId, grantId));
  return row ?? { grantId, roleCode: null, revision: await lastRevision(tx, 'permission_dynamic_org_grant', grantId) };
}

export async function setDynamicOrgGrant(
  tx: Tx,
  write: WriteContext,
  grantId: string,
  roleCode: 'head' | 'hrbp' | null,
  expectedRevision: number,
) {
  await lock(tx, write, `dynamic-org:${grantId}`);
  const grant = await autoGrant(tx, grantId);
  if (roleCode && grant.status !== 'active') throw invalid('授权已撤销');
  const before = await getDynamicOrgGrant(tx, grantId);
  if (before.revision !== expectedRevision) throw revisionConflict(expectedRevision, before.revision);
  const revision = before.revision + 1;
  if (roleCode) {
    await tx
      .insert(permissionDynamicOrgGrants)
      .values({ tenantId: write.tenantId, grantId, roleCode, revision })
      .onConflictDoUpdate({
        target: [permissionDynamicOrgGrants.tenantId, permissionDynamicOrgGrants.grantId],
        set: { roleCode, revision },
      });
  } else {
    if (!before.roleCode) throw new AppError('NOT_FOUND', '动态组织角色关联不存在');
    await tx.delete(permissionDynamicOrgGrants).where(eq(permissionDynamicOrgGrants.grantId, grantId));
  }
  const after = { grantId, roleCode, revision };
  await recordScopeChange(tx, write, {
    objectType: 'permission_dynamic_org_grant',
    objectId: grantId,
    revision,
    before,
    after,
  });
  return after;
}

export const scopePolicyRule = z
  .strictObject({
    dimension: z.enum(['management', 'organization', 'reporting', 'using_user']),
    roleCode: z.enum(['head', 'hrbp']).optional(),
    relationMode: z.enum(['direct', 'all_direct', 'dotted', 'direct_mixed', 'dotted_mixed', 'part_time']).optional(),
  })
  .superRefine((rule, ctx) => {
    if ((rule.dimension === 'organization') !== (rule.roleCode !== undefined))
      ctx.addIssue({ code: 'custom', message: '只有组织关系规则必须填写角色', path: ['roleCode'] });
    if ((rule.dimension === 'reporting') !== (rule.relationMode !== undefined))
      ctx.addIssue({ code: 'custom', message: '只有汇报关系规则必须填写关系类型', path: ['relationMode'] });
  });
export const scopePolicyBody = z.strictObject({
  personField: z.string().min(1).max(128).optional(),
  departmentField: z.string().min(1).max(128).optional(),
  creatorField: z.string().min(1).max(128).optional(),
  rules: z.array(scopePolicyRule).max(20),
});
export const scopePolicyKey = z.strictObject({
  appCode: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,63}$/),
  objectCode: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,127}$/),
  targetKind: z.enum(['entity', 'page', 'datasource']),
  targetCode: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/),
});
type PolicyKey = z.infer<typeof scopePolicyKey>;
type PolicyBody = z.infer<typeof scopePolicyBody>;
const policyWhere = (key: PolicyKey) =>
  and(
    eq(permissionScopePolicies.appCode, key.appCode),
    eq(permissionScopePolicies.objectCode, key.objectCode),
    eq(permissionScopePolicies.targetKind, key.targetKind),
    eq(permissionScopePolicies.targetCode, key.targetCode),
  );

function policyFields(key: PolicyKey, body?: PolicyBody) {
  const entity = objectCatalog.get(key.objectCode);
  if (!entity || entity.application !== key.appCode) throw invalid('对象未登记或不属于该应用');
  if (key.targetKind === 'entity' && key.targetCode !== key.objectCode) throw invalid('实体目标编码必须与对象一致');
  if (key.targetKind !== 'entity' && ![`${key.objectCode}.list`, `${key.objectCode}.detail`].includes(key.targetCode))
    throw invalid('页面或数据源必须使用服务端登记的列表或详情编码');
  const personField =
    PERSONNEL_SCOPE_FIELDS[key.objectCode] ??
    ([MODULE_OBJECTS.employmentRecord.code, MODULE_OBJECTS.contract.code].includes(key.objectCode)
      ? 'employeeId'
      : key.objectCode === MODULE_OBJECTS.employee.code
        ? 'id'
        : null);
  const departmentField =
    key.objectCode === MODULE_OBJECTS.employmentRecord.code
      ? 'departmentId'
      : key.objectCode === MODULE_OBJECTS.organization.code
        ? 'id'
        : [MODULE_OBJECTS.jobPosition.code, MODULE_OBJECTS.establishment.code].includes(key.objectCode)
          ? 'orgId'
          : null;
  const expected = { personField, departmentField, creatorField: 'createdBy' };
  for (const field of ['personField', 'departmentField', 'creatorField'] as const) {
    const value = body?.[field];
    if (value !== undefined && (value !== expected[field] || !entity.fields.some((f) => f.code === value)))
      throw invalid('鉴权字段必须使用该实体已登记的固定SQL映射');
  }
  return {
    personField,
    departmentField,
    creatorField:
      body?.creatorField ?? (body?.rules.some((rule) => rule.dimension === 'using_user') ? 'createdBy' : null),
  };
}

export async function getScopePolicy(tx: Tx, key: PolicyKey) {
  const fields = policyFields(key);
  const [policy] = await tx.select().from(permissionScopePolicies).where(policyWhere(key));
  if (!policy)
    return {
      ...key,
      ...fields,
      revision: 0,
      configured: false,
      rules: [],
    };
  const rules = await tx
    .select({
      dimension: permissionScopePolicyRules.dimension,
      roleCode: permissionScopePolicyRules.roleCode,
      relationMode: permissionScopePolicyRules.relationMode,
    })
    .from(permissionScopePolicyRules)
    .where(eq(permissionScopePolicyRules.policyId, policy.id))
    .orderBy(permissionScopePolicyRules.id)
    .limit(21);
  return { ...policy, configured: true, rules };
}

export async function setScopePolicy(
  tx: Tx,
  write: WriteContext,
  key: PolicyKey,
  body: PolicyBody,
  expectedRevision: number,
) {
  const fields = policyFields(key, body);
  const objectId = `${key.appCode}:${key.targetKind}:${key.targetCode}`;
  // Both policy kinds share one lock so concurrent first writes cannot create an ambiguous pair.
  await lock(tx, write, `scope-policy:${key.appCode}:${key.targetCode}`);
  const [other] = await tx
    .select()
    .from(permissionScopePolicies)
    .where(
      and(
        eq(permissionScopePolicies.appCode, key.appCode),
        eq(permissionScopePolicies.targetKind, key.targetKind),
        eq(permissionScopePolicies.targetCode, key.targetCode),
      ),
    )
    .limit(1);
  if (other && other.objectCode !== key.objectCode) throw new AppError('CONFLICT', '目标已登记到另一对象');
  if (key.targetKind !== 'entity') {
    const [conflict] = await tx
      .select({ id: permissionScopePolicies.id })
      .from(permissionScopePolicies)
      .where(
        and(
          eq(permissionScopePolicies.appCode, key.appCode),
          eq(permissionScopePolicies.objectCode, key.objectCode),
          eq(permissionScopePolicies.targetCode, key.targetCode),
          eq(permissionScopePolicies.targetKind, key.targetKind === 'page' ? 'datasource' : 'page'),
        ),
      )
      .limit(1);
    // TODO(需取证 Q-M0-32): §13.1 仅确认各自覆盖实体，页面和数据源之间的优先级待证。
    if (conflict) throw new AppError('CONFLICT', '同一目标的页面与数据源数据权限不可同时配置');
  }
  const before = await getScopePolicy(tx, key);
  if (before.revision !== expectedRevision) throw revisionConflict(expectedRevision, before.revision);
  const revision = before.revision + 1;
  const [policy] = await tx
    .insert(permissionScopePolicies)
    .values({ ...key, ...fields, tenantId: write.tenantId, revision })
    .onConflictDoUpdate({
      target: [
        permissionScopePolicies.tenantId,
        permissionScopePolicies.appCode,
        permissionScopePolicies.objectCode,
        permissionScopePolicies.targetKind,
        permissionScopePolicies.targetCode,
      ],
      set: { ...fields, revision },
    })
    .returning();
  await tx.delete(permissionScopePolicyRules).where(eq(permissionScopePolicyRules.policyId, policy!.id));
  if (body.rules.length)
    await tx.insert(permissionScopePolicyRules).values(
      body.rules.map((rule) => ({
        tenantId: write.tenantId,
        policyId: policy!.id,
        dimension: rule.dimension,
        roleCode: rule.roleCode ?? null,
        relationMode: rule.relationMode ?? null,
      })),
    );
  const after = await getScopePolicy(tx, key);
  await recordScopeChange(tx, write, { objectType: 'permission_scope_policy', objectId, revision, before, after });
  return after;
}
