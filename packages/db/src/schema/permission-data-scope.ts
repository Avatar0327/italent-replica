/** R1-T02：业务范围正表关系化；JSON 仅保存不可变审计快照（DEC-043、11 §14）。 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { employmentEmployees } from './employment.js';
import { orgObjects } from './org.js';
import { permissionGrants, permissionProfiles } from './permission.js';
import { tenantMemberships, tenants } from './tenancy.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const revision = () => integer('revision').notNull().default(1);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const memberFk = (name: string, tenant: AnyPgColumn, user: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [tenant, user],
    foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
  });

export const permissionMous = pgTable(
  'permission_mous',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    parentId: uuid('parent_id'),
    kind: text('kind').$type<'named' | 'virtual'>().notNull().default('named'),
    ownerUserId: uuid('owner_user_id'),
    appCode: text('app_code'),
    status: text('status').$type<'active' | 'disabled' | 'deleted'>().notNull().default('active'),
    revision: revision(),
    description: text('description').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [
    unique('permission_mous_tenant_id').on(t.tenantId, t.id),
    unique('permission_mous_tenant_code').on(t.tenantId, t.code),
    uniqueIndex('permission_mous_virtual_owner')
      .on(t.tenantId, t.ownerUserId, t.appCode)
      .where(sql`${t.kind} = 'virtual'`),
    foreignKey({
      name: 'permission_mous_parent',
      columns: [t.tenantId, t.parentId],
      foreignColumns: [t.tenantId, t.id],
    }),
    memberFk('permission_mous_owner', t.tenantId, t.ownerUserId),
    index('permission_mous_list').on(t.tenantId, t.kind, t.status, t.code),
    check('permission_mous_kind', sql`${t.kind} IN ('named', 'virtual')`),
    check('permission_mous_status', sql`${t.status} IN ('active', 'disabled', 'deleted')`),
    check(
      'permission_mous_owner_kind',
      sql`(${t.kind}='named' AND ${t.ownerUserId} IS NULL AND ${t.appCode} IS NULL)
    OR (${t.kind}='virtual' AND ${t.ownerUserId} IS NOT NULL AND ${t.appCode} IS NOT NULL)`,
    ),
    check('permission_mous_revision', sql`${t.revision} > 0`),
    check('permission_mous_name', sql`btrim(${t.code}) <> '' AND btrim(${t.name}) <> ''`),
  ],
);

export const permissionMouOrgRefs = pgTable(
  'permission_mou_org_refs',
  {
    tenantId: tenantId(),
    mouId: uuid('mou_id').notNull(),
    orgId: uuid('org_id').notNull(),
    dimension: text('dimension').notNull().default('admin'),
    includeDescendants: boolean('include_descendants').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.mouId, t.orgId, t.dimension] }),
    foreignKey({
      name: 'permission_mou_refs_mou',
      columns: [t.tenantId, t.mouId],
      foreignColumns: [permissionMous.tenantId, permissionMous.id],
    }),
    foreignKey({
      name: 'permission_mou_refs_org',
      columns: [t.tenantId, t.orgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
    }),
    check('permission_mou_refs_dimension', sql`${t.dimension} IN ('admin','business','product','reserve4','reserve5')`),
  ],
);

export const permissionUserAppScopes = pgTable(
  'permission_user_app_scopes',
  {
    tenantId: tenantId(),
    userId: uuid('user_id').notNull(),
    appCode: text('app_code').notNull(),
    kind: text('kind').$type<'default' | 'mou' | 'org_range'>().notNull().default('default'),
    mouId: uuid('mou_id'),
    revision: revision(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId, t.appCode] }),
    memberFk('permission_scopes_member', t.tenantId, t.userId),
    foreignKey({
      name: 'permission_scopes_mou',
      columns: [t.tenantId, t.mouId],
      foreignColumns: [permissionMous.tenantId, permissionMous.id],
    }),
    index('permission_scopes_mou_usage').on(t.tenantId, t.mouId),
    check('permission_scopes_kind', sql`${t.kind} IN ('default', 'mou', 'org_range')`),
    check(
      'permission_scopes_mou_kind',
      sql`(${t.kind}='default' AND ${t.mouId} IS NULL)
    OR (${t.kind}<>'default' AND ${t.mouId} IS NOT NULL)`,
    ),
    check('permission_scopes_revision', sql`${t.revision} > 0`),
  ],
);

export const permissionScopeVersions = pgTable(
  'permission_scope_versions',
  {
    id: id(),
    tenantId: tenantId(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id').notNull(),
    revision: revision(),
    before: jsonb('before'),
    after: jsonb('after'),
    commandId: text('command_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('permission_scope_versions_object_revision').on(t.tenantId, t.objectType, t.objectId, t.revision),
    check('permission_scope_versions_revision', sql`${t.revision} > 0`),
  ],
);

export const permissionIdentityScopes = pgTable(
  'permission_identity_scopes',
  {
    tenantId: tenantId(),
    profileId: uuid('profile_id').notNull(),
    appCode: text('app_code').notNull(),
    targetKind: text('target_kind').$type<'app' | 'entity' | 'page' | 'datasource'>().notNull(),
    targetCode: text('target_code').notNull().default(''),
    seeAll: boolean('see_all').notNull().default(false),
    revision: revision(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.profileId, t.appCode, t.targetKind, t.targetCode] }),
    foreignKey({
      name: 'permission_identity_scopes_profile',
      columns: [t.tenantId, t.profileId],
      foreignColumns: [permissionProfiles.tenantId, permissionProfiles.id],
    }),
    check('permission_identity_scopes_target', sql`${t.targetKind} IN ('app','entity','page','datasource')`),
    check(
      'permission_identity_scopes_code',
      sql`(${t.targetKind}='app' AND ${t.targetCode}='')
    OR (${t.targetKind}<>'app' AND btrim(${t.targetCode})<>'')`,
    ),
    check('permission_identity_scopes_revision', sql`${t.revision} > 0`),
  ],
);

export const permissionUserPersonLinks = pgTable(
  'permission_user_person_links',
  {
    tenantId: tenantId(),
    userId: uuid('user_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    revision: revision(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    unique('permission_person_links_employee').on(t.tenantId, t.employeeId),
    memberFk('permission_person_links_member', t.tenantId, t.userId),
    foreignKey({
      name: 'permission_person_links_employee_fk',
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    check('permission_person_links_revision', sql`${t.revision} > 0`),
  ],
);

export const permissionDynamicOrgGrants = pgTable(
  'permission_dynamic_org_grants',
  {
    tenantId: tenantId(),
    grantId: uuid('grant_id').notNull(),
    roleCode: text('role_code').$type<'head' | 'hrbp'>().notNull(),
    revision: revision(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.grantId] }),
    foreignKey({
      name: 'permission_dynamic_grants_grant',
      columns: [t.tenantId, t.grantId],
      foreignColumns: [permissionGrants.tenantId, permissionGrants.id],
    }),
    check('permission_dynamic_grants_role', sql`${t.roleCode} IN ('head','hrbp')`),
    check('permission_dynamic_grants_revision', sql`${t.revision} > 0`),
  ],
);

export const permissionScopePolicies = pgTable(
  'permission_scope_policies',
  {
    id: id(),
    tenantId: tenantId(),
    appCode: text('app_code').notNull(),
    objectCode: text('object_code').notNull(),
    targetKind: text('target_kind').$type<'entity' | 'page' | 'datasource'>().notNull(),
    targetCode: text('target_code').notNull(),
    revision: revision(),
    personField: text('person_field'),
    departmentField: text('department_field'),
    creatorField: text('creator_field'),
  },
  (t) => [
    unique('permission_scope_policies_tenant_id').on(t.tenantId, t.id),
    unique('permission_scope_policies_target').on(t.tenantId, t.appCode, t.objectCode, t.targetKind, t.targetCode),
    check('permission_scope_policies_target_kind', sql`${t.targetKind} IN ('entity','page','datasource')`),
    check('permission_scope_policies_revision', sql`${t.revision} > 0`),
  ],
);

export const permissionScopePolicyRules = pgTable(
  'permission_scope_policy_rules',
  {
    id: id(),
    tenantId: tenantId(),
    policyId: uuid('policy_id').notNull(),
    dimension: text('dimension').$type<'management' | 'organization' | 'reporting' | 'using_user'>().notNull(),
    roleCode: text('role_code'),
    relationMode: text('relation_mode'),
  },
  (t) => [
    foreignKey({
      name: 'permission_scope_rules_policy',
      columns: [t.tenantId, t.policyId],
      foreignColumns: [permissionScopePolicies.tenantId, permissionScopePolicies.id],
    }),
    index('permission_scope_rules_policy_lookup').on(t.tenantId, t.policyId),
    check(
      'permission_scope_rules_dimension',
      sql`${t.dimension} IN ('management','organization','reporting','using_user')`,
    ),
  ],
);

export const permissionScopeApps = pgTable(
  'permission_scope_apps',
  {
    tenantId: tenantId(),
    appCode: text('app_code').notNull(),
    family: text('family').$type<'hr' | 'attendance' | 'other' | 'payroll'>().notNull().default('other'),
    allowedKinds: text('allowed_kinds')
      .array()
      .notNull()
      .default(sql`ARRAY['default','mou','org_range']::text[]`),
    revision: revision(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.appCode] }),
    check('permission_scope_apps_family', sql`${t.family} IN ('hr','attendance','other','payroll')`),
    check('permission_scope_apps_kinds', sql`${t.allowedKinds} <@ ARRAY['default','mou','org_range']::text[]`),
    check('permission_scope_apps_revision', sql`${t.revision} > 0`),
  ],
);
