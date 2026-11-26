import { sql } from 'drizzle-orm';
import {
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
import { onboardingEntryCases } from './onboarding.js';
import { tenantMemberships, tenants } from './tenancy.js';

/** R2-T01 §3.2 / §12 U5。欢迎信可用的通知变量白名单，保存与预览共用。 */
export const WELCOME_VARIABLES = ['employeeName', 'companyName', 'departmentName', 'positionName', 'hiredOn'] as const;
export type WelcomeVariable = (typeof WELCOME_VARIABLES)[number];

export const HANDBOOK_BLOCK_TYPES = ['heading', 'paragraph', 'list'] as const;
export type HandbookBlock = { type: 'heading' | 'paragraph'; text: string } | { type: 'list'; items: string[] };

/** 欢迎信模板。每租户至多一份启用中的发送模板；DELETE 即归档（DEC-983），不物理删除。 */
export const onboardingWelcomeLetters = pgTable(
  'onboarding_welcome_letters',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    variables: jsonb('variables').$type<readonly WelcomeVariable[]>().notNull(),
    enabled: boolean('enabled').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').notNull(),
    updatedBy: uuid('updated_by').notNull(),
  },
  (t) => [
    unique('onboarding_welcome_letters_tenant_id').on(t.tenantId, t.id),
    uniqueIndex('onboarding_welcome_letters_one_enabled')
      .on(t.tenantId)
      .where(sql`${t.enabled}`),
    foreignKey({
      name: 'onboarding_welcome_letters_creator_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    foreignKey({
      name: 'onboarding_welcome_letters_updater_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    index('onboarding_welcome_letters_list').on(t.tenantId, t.name, t.id),
    check('onboarding_welcome_letters_revision', sql`${t.revision} > 0`),
    check(
      'onboarding_welcome_letters_text',
      sql`char_length(btrim(${t.name})) BETWEEN 1 AND 100 AND char_length(btrim(${t.title})) BETWEEN 1 AND 200
        AND char_length(btrim(${t.body})) BETWEEN 1 AND 5000`,
    ),
    check('onboarding_welcome_letters_variables', sql`jsonb_typeof(${t.variables}) = 'array'`),
    check('onboarding_welcome_letters_archived', sql`${t.archivedAt} IS NULL OR NOT ${t.enabled}`),
  ],
);

/** 入职手册模板：只存经校验的展示块，不含扫码报到。DELETE 即归档。 */
export const onboardingHandbooks = pgTable(
  'onboarding_handbooks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    title: text('title').notNull(),
    blocks: jsonb('blocks').$type<HandbookBlock[]>().notNull(),
    enabled: boolean('enabled').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').notNull(),
    updatedBy: uuid('updated_by').notNull(),
  },
  (t) => [
    unique('onboarding_handbooks_tenant_id').on(t.tenantId, t.id),
    foreignKey({
      name: 'onboarding_handbooks_creator_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    foreignKey({
      name: 'onboarding_handbooks_updater_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    index('onboarding_handbooks_list').on(t.tenantId, t.name, t.id),
    check('onboarding_handbooks_revision', sql`${t.revision} > 0`),
    check(
      'onboarding_handbooks_text',
      sql`char_length(btrim(${t.name})) BETWEEN 1 AND 100 AND char_length(btrim(${t.title})) BETWEEN 1 AND 200`,
    ),
    check('onboarding_handbooks_blocks', sql`jsonb_typeof(${t.blocks}) = 'array'`),
    check('onboarding_handbooks_archived', sql`${t.archivedAt} IS NULL OR NOT ${t.enabled}`),
  ],
);

export const WELCOME_JOB_STATUSES = ['pending', 'done', 'skipped', 'failed'] as const;

/**
 * 欢迎信生效任务：随生效（hire）事务写入，同一阶段只有一条（§8、AC-EN-BE16-12）。
 * done 只表示“已交付”，当前没有真实投递适配器，消费者不会写 done；任务保持 pending 并留原因。
 */
export const onboardingWelcomeJobs = pgTable(
  'onboarding_welcome_jobs',
  {
    tenantId: uuid('tenant_id').notNull(),
    caseId: uuid('case_id').notNull(),
    status: text('status', { enum: WELCOME_JOB_STATUSES }).notNull().default('pending'),
    reason: text('reason'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.caseId] }),
    index('onboarding_welcome_job_due')
      .on(t.tenantId, t.nextAttemptAt, t.caseId)
      .where(sql`${t.status} IN ('pending','failed')`),
    foreignKey({
      name: 'onboarding_welcome_job_case_fk',
      columns: [t.tenantId, t.caseId],
      foreignColumns: [onboardingEntryCases.tenantId, onboardingEntryCases.id],
    }),
    check('onboarding_welcome_job_status', sql`${t.status} IN ('pending','done','skipped','failed')`),
    check('onboarding_welcome_job_attempts', sql`${t.attempts} >= 0`),
  ],
);

export type OnboardingWelcomeLetter = typeof onboardingWelcomeLetters.$inferSelect;
export type OnboardingHandbook = typeof onboardingHandbooks.$inferSelect;
