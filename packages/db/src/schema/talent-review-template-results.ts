/** B6a-2：版本内表单快照与结果公式；所有跨表引用都包含租户（设计 §2.3）。 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, boolean, unique, foreignKey, check, primaryKey } from 'drizzle-orm/pg-core';
import { tenants } from './tenancy.js';
import {
  talentReviewTemplateSteps as S,
  talentReviewTemplateVersions as V,
  talentReviewTemplateModules as M,
  talentReviewForms as F,
  talentReviewFields as D,
  talentReviewRoles as R,
} from './talent-review.js';

export const talentReviewTemplateStepForms = pgTable(
  'talent_review_template_step_forms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    stepId: uuid('step_id').notNull(),
    roleId: uuid('role_id'),
    purpose: text('purpose').notNull(),
    formId: uuid('form_id').notNull(),
    sortNo: integer('sort_no').notNull(),
  },
  (t) => [
    unique('tr_step_forms_tenant_id').on(t.tenantId, t.id),
    unique('tr_step_forms_seat').on(t.tenantId, t.stepId, t.roleId, t.purpose).nullsNotDistinct(),
    foreignKey({ columns: [t.tenantId, t.stepId], foreignColumns: [S.tenantId, S.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.tenantId, t.roleId], foreignColumns: [R.tenantId, R.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.tenantId, t.formId], foreignColumns: [F.tenantId, F.id] }).onDelete('restrict'),
    check('tr_step_forms_purpose', sql`${t.purpose} IN ('info','calibrate_edit','successor_edit','target_edit')`),
  ],
);

export const talentReviewTemplateFormFields = pgTable(
  'talent_review_template_form_fields',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    stepFormId: uuid('step_form_id').notNull(),
    fieldId: uuid('field_id').notNull(),
    access: text('access').notNull(),
    required: boolean('required').notNull(),
    sortNo: integer('sort_no').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.stepFormId, t.fieldId] }),
    foreignKey({
      columns: [t.tenantId, t.stepFormId],
      foreignColumns: [talentReviewTemplateStepForms.tenantId, talentReviewTemplateStepForms.id],
    }).onDelete('cascade'),
    foreignKey({ columns: [t.tenantId, t.fieldId], foreignColumns: [D.tenantId, D.id] }).onDelete('restrict'),
    check(
      'tr_template_form_access',
      sql`${t.access} IN ('hidden','view','edit') AND (NOT ${t.required} OR ${t.access} = 'edit')`,
    ),
  ],
);

export const talentReviewTemplateResultRules = pgTable(
  'talent_review_template_result_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    versionId: uuid('version_id').notNull(),
    targetFieldId: uuid('target_field_id').notNull(),
    formula: text('formula').notNull(),
    priority: integer('priority').notNull(),
    sortNo: integer('sort_no').notNull(),
  },
  (t) => [
    unique('tr_result_rules_tenant_id').on(t.tenantId, t.id),
    unique('tr_result_rules_target').on(t.tenantId, t.versionId, t.targetFieldId),
    foreignKey({ columns: [t.tenantId, t.versionId], foreignColumns: [V.tenantId, V.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.tenantId, t.targetFieldId], foreignColumns: [D.tenantId, D.id] }).onDelete('restrict'),
    check('tr_result_rules_priority', sql`${t.priority} BETWEEN 0 AND 1000000`),
  ],
);

export const talentReviewTemplateResultRefs = pgTable(
  'talent_review_template_result_refs',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    ruleId: uuid('rule_id').notNull(),
    fieldId: uuid('field_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.ruleId, t.fieldId] }),
    foreignKey({
      columns: [t.tenantId, t.ruleId],
      foreignColumns: [talentReviewTemplateResultRules.tenantId, talentReviewTemplateResultRules.id],
    }).onDelete('cascade'),
    foreignKey({ columns: [t.tenantId, t.fieldId], foreignColumns: [D.tenantId, D.id] }).onDelete('restrict'),
  ],
);

export const talentReviewTemplateResultModuleRefs = pgTable(
  'talent_review_template_result_module_refs',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    ruleId: uuid('rule_id').notNull(),
    moduleId: uuid('module_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.ruleId, t.moduleId] }),
    foreignKey({
      columns: [t.tenantId, t.ruleId],
      foreignColumns: [talentReviewTemplateResultRules.tenantId, talentReviewTemplateResultRules.id],
    }).onDelete('cascade'),
    foreignKey({ columns: [t.tenantId, t.moduleId], foreignColumns: [M.tenantId, M.id] }).onDelete('cascade'),
  ],
);
