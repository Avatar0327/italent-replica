/**
 * 职务体系主数据（R1-T04；docs/02_业务建模/19、REQ-JOB-001）。
 * 八类稳定标识与各自的业务版本分表保存；所有引用都限定租户及具体对象类型。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import { orgObjects } from './org.js';
import { tenants } from './tenancy.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const utc = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

function objectTable<TName extends string>(name: TName) {
  return pgTable(
    name,
    { id: id(), tenantId: tenantId(), revision: integer('revision').notNull().default(1), createdAt: utc() },
    (t) => [
      unique(`${name}_tenant_id`).on(t.tenantId, t.id),
      check(`${name}_revision_positive`, sql`${t.revision} > 0`),
    ],
  );
}

export const jobLayerObjects = objectTable('job_layer_objects');
export const jobGradeObjects = objectTable('job_grade_objects');
export const jobLevelTypeObjects = objectTable('job_level_type_objects');
export const jobLevelObjects = objectTable('job_level_objects');
export const jobSequenceObjects = objectTable('job_sequence_objects');
export const jobProfessionalLineObjects = objectTable('job_professional_line_objects');
export const jobPostObjects = objectTable('job_post_objects');
export const jobPositionObjects = objectTable('job_position_objects');

function versionFields() {
  return {
    id: id(),
    tenantId: tenantId(),
    objectId: uuid('object_id').notNull(),
    versionNo: integer('version_no').notNull(),
    previousVersionId: uuid('previous_version_id'),
    code: text('code').notNull(),
    name: text('name').notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    stopDate: date('stop_date', { mode: 'string' }).notNull().default('9999-12-31'),
    enabled: boolean('enabled').notNull().default(true),
    establishedOn: date('established_on', { mode: 'string' }),
    displayOrder: integer('display_order'),
    qualificationId: uuid('qualification_id'),
    createdAt: utc(),
  };
}

interface ObjectColumns {
  readonly tenantId: AnyPgColumn;
  readonly id: AnyPgColumn;
}

interface VersionColumns extends ObjectColumns {
  readonly objectId: AnyPgColumn;
  readonly versionNo: AnyPgColumn;
  readonly previousVersionId: AnyPgColumn;
  readonly code: AnyPgColumn;
  readonly name: AnyPgColumn;
  readonly startDate: AnyPgColumn;
  readonly stopDate: AnyPgColumn;
}

function reference(name: string, tenant: AnyPgColumn, targetId: AnyPgColumn, target: ObjectColumns) {
  return foreignKey({ name, columns: [tenant, targetId], foreignColumns: [target.tenantId, target.id] });
}

function versionRules(name: string, t: VersionColumns, object: ObjectColumns): PgTableExtraConfigValue[] {
  return [
    unique(`${name}_tenant_id`).on(t.tenantId, t.id),
    unique(`${name}_tenant_object_id`).on(t.tenantId, t.objectId, t.id),
    unique(`${name}_tenant_object_version`).on(t.tenantId, t.objectId, t.versionNo),
    reference(`${name}_object_fk`, t.tenantId, t.objectId, object),
    foreignKey({
      name: `${name}_previous_fk`,
      columns: [t.tenantId, t.objectId, t.previousVersionId],
      foreignColumns: [t.tenantId, t.objectId, t.id],
    }),
    index(`${name}_tenant_as_of`).on(t.tenantId, t.objectId, t.startDate, t.versionNo),
    check(`${name}_version_positive`, sql`${t.versionNo} > 0`),
    check(`${name}_code_nonempty`, sql`btrim(${t.code}) <> ''`),
    check(`${name}_name_nonempty`, sql`btrim(${t.name}) <> ''`),
    check(`${name}_dates_valid`, sql`${t.stopDate} >= ${t.startDate}`),
    check(`${name}_previous_not_self`, sql`${t.previousVersionId} <> ${t.id}`),
  ];
}

export const jobLayerVersions = pgTable(
  'job_layer_versions',
  { ...versionFields(), layerLevel: integer('layer_level') },
  (t) => versionRules('job_layer_versions', t, jobLayerObjects),
);

export const jobGradeVersions = pgTable(
  'job_grade_versions',
  {
    ...versionFields(),
    grade: integer('grade'),
    scoreLow: numeric('score_low', { mode: 'number' }),
    scoreHigh: numeric('score_high', { mode: 'number' }),
    layerId: uuid('layer_id'),
  },
  (t) => [
    ...versionRules('job_grade_versions', t, jobGradeObjects),
    reference('job_grade_versions_layer_fk', t.tenantId, t.layerId, jobLayerObjects),
    check('job_grade_versions_scores_valid', sql`${t.scoreHigh} >= ${t.scoreLow}`),
  ],
);

export const jobLevelTypeVersions = pgTable('job_level_type_versions', versionFields(), (t) =>
  versionRules('job_level_type_versions', t, jobLevelTypeObjects),
);

export const jobLevelVersions = pgTable(
  'job_level_versions',
  {
    ...versionFields(),
    level: integer('level'),
    levelTypeId: uuid('level_type_id'),
    minGradeId: uuid('min_grade_id'),
    maxGradeId: uuid('max_grade_id'),
  },
  (t) => [
    ...versionRules('job_level_versions', t, jobLevelObjects),
    reference('job_level_versions_type_fk', t.tenantId, t.levelTypeId, jobLevelTypeObjects),
    reference('job_level_versions_min_grade_fk', t.tenantId, t.minGradeId, jobGradeObjects),
    reference('job_level_versions_max_grade_fk', t.tenantId, t.maxGradeId, jobGradeObjects),
  ],
);

/** 一级至十级序列保存稳定祖先 ID，供编制维度使用（docs/02_业务建模/19 §1–§2）。 */
export const jobSequenceVersions = pgTable(
  'job_sequence_versions',
  {
    ...versionFields(),
    parentId: uuid('parent_id'),
    level: integer('level').notNull().default(1),
    firstSequenceId: uuid('first_sequence_id'),
    secondSequenceId: uuid('second_sequence_id'),
    thirdSequenceId: uuid('third_sequence_id'),
    fourthSequenceId: uuid('fourth_sequence_id'),
    fifthSequenceId: uuid('fifth_sequence_id'),
    sixthSequenceId: uuid('sixth_sequence_id'),
    seventhSequenceId: uuid('seventh_sequence_id'),
    eighthSequenceId: uuid('eighth_sequence_id'),
    ninthSequenceId: uuid('ninth_sequence_id'),
    tenthSequenceId: uuid('tenth_sequence_id'),
    levelTypeId: uuid('level_type_id'),
    source: text('source'),
    externalId: text('external_id'),
  },
  (t) => [
    ...versionRules('job_sequence_versions', t, jobSequenceObjects),
    reference('job_sequence_versions_parent_fk', t.tenantId, t.parentId, jobSequenceObjects),
    reference('job_sequence_versions_first_fk', t.tenantId, t.firstSequenceId, jobSequenceObjects),
    reference('job_sequence_versions_second_fk', t.tenantId, t.secondSequenceId, jobSequenceObjects),
    reference('job_sequence_versions_third_fk', t.tenantId, t.thirdSequenceId, jobSequenceObjects),
    reference('job_sequence_versions_fourth_fk', t.tenantId, t.fourthSequenceId, jobSequenceObjects),
    reference('job_sequence_versions_fifth_fk', t.tenantId, t.fifthSequenceId, jobSequenceObjects),
    reference('job_sequence_versions_sixth_fk', t.tenantId, t.sixthSequenceId, jobSequenceObjects),
    reference('job_sequence_versions_seventh_fk', t.tenantId, t.seventhSequenceId, jobSequenceObjects),
    reference('job_sequence_versions_eighth_fk', t.tenantId, t.eighthSequenceId, jobSequenceObjects),
    reference('job_sequence_versions_ninth_fk', t.tenantId, t.ninthSequenceId, jobSequenceObjects),
    reference('job_sequence_versions_tenth_fk', t.tenantId, t.tenthSequenceId, jobSequenceObjects),
    reference('job_sequence_versions_type_fk', t.tenantId, t.levelTypeId, jobLevelTypeObjects),
    check('job_sequence_versions_level_valid', sql`${t.level} BETWEEN 1 AND 10`),
    check('job_sequence_versions_parent_not_self', sql`${t.parentId} <> ${t.objectId}`),
  ],
);

export const jobProfessionalLineVersions = pgTable(
  'job_professional_line_versions',
  { ...versionFields(), parentId: uuid('parent_id'), level: integer('level').notNull().default(1) },
  (t) => [
    ...versionRules('job_professional_line_versions', t, jobProfessionalLineObjects),
    reference('job_professional_line_versions_parent_fk', t.tenantId, t.parentId, jobProfessionalLineObjects),
    check('job_professional_line_versions_level_valid', sql`${t.level} >= 1`),
    check('job_professional_line_versions_parent_not_self', sql`${t.parentId} <> ${t.objectId}`),
  ],
);

function classificationFields() {
  return {
    sequenceId: uuid('sequence_id'),
    professionalLineId: uuid('professional_line_id'),
    levelTypeId: uuid('level_type_id'),
    minLevelId: uuid('min_level_id'),
    maxLevelId: uuid('max_level_id'),
    minGradeId: uuid('min_grade_id'),
    maxGradeId: uuid('max_grade_id'),
  };
}

interface ClassificationColumns {
  readonly tenantId: AnyPgColumn;
  readonly sequenceId: AnyPgColumn;
  readonly professionalLineId: AnyPgColumn;
  readonly levelTypeId: AnyPgColumn;
  readonly minLevelId: AnyPgColumn;
  readonly maxLevelId: AnyPgColumn;
  readonly minGradeId: AnyPgColumn;
  readonly maxGradeId: AnyPgColumn;
}

function classificationRules(name: string, t: ClassificationColumns): PgTableExtraConfigValue[] {
  return [
    reference(`${name}_sequence_fk`, t.tenantId, t.sequenceId, jobSequenceObjects),
    reference(`${name}_professional_line_fk`, t.tenantId, t.professionalLineId, jobProfessionalLineObjects),
    reference(`${name}_level_type_fk`, t.tenantId, t.levelTypeId, jobLevelTypeObjects),
    reference(`${name}_min_level_fk`, t.tenantId, t.minLevelId, jobLevelObjects),
    reference(`${name}_max_level_fk`, t.tenantId, t.maxLevelId, jobLevelObjects),
    reference(`${name}_min_grade_fk`, t.tenantId, t.minGradeId, jobGradeObjects),
    reference(`${name}_max_grade_fk`, t.tenantId, t.maxGradeId, jobGradeObjects),
  ];
}

export const jobPostVersions = pgTable(
  'job_post_versions',
  {
    ...versionFields(),
    ...classificationFields(),
    competencyModelId: uuid('competency_model_id'),
    responsibilities: text('responsibilities'),
    requirements: text('requirements'),
    isKey: boolean('is_key').notNull().default(false),
    isConfidential: boolean('is_confidential').notNull().default(false),
    evaluationScore: numeric('evaluation_score', { mode: 'number' }),
    syncSequenceToAssignments: boolean('sync_sequence_to_assignments').notNull().default(false),
  },
  (t) => [...versionRules('job_post_versions', t, jobPostObjects), ...classificationRules('job_post_versions', t)],
);

/** 职位是组织 × 职务实例，直线与虚线上级及排序独立保存（docs/02_业务建模/19 §2–§3）。 */
export const jobPositionVersions = pgTable(
  'job_position_versions',
  {
    ...versionFields(),
    ...classificationFields(),
    orgId: uuid('org_id').notNull(),
    postId: uuid('post_id').notNull(),
    directParentId: uuid('direct_parent_id'),
    dottedParentId: uuid('dotted_parent_id'),
    directSequence: integer('direct_sequence'),
    dottedSequence: integer('dotted_sequence'),
    standardPositionId: uuid('standard_position_id'),
    workLocation: text('work_location'),
    isKey: boolean('is_key').notNull().default(false),
    isConfidential: boolean('is_confidential').notNull().default(false),
    syncSequenceToAssignments: boolean('sync_sequence_to_assignments').notNull().default(false),
  },
  (t) => [
    ...versionRules('job_position_versions', t, jobPositionObjects),
    ...classificationRules('job_position_versions', t),
    reference('job_position_versions_org_fk', t.tenantId, t.orgId, orgObjects),
    reference('job_position_versions_post_fk', t.tenantId, t.postId, jobPostObjects),
    reference('job_position_versions_direct_parent_fk', t.tenantId, t.directParentId, jobPositionObjects),
    reference('job_position_versions_dotted_parent_fk', t.tenantId, t.dottedParentId, jobPositionObjects),
    reference('job_position_versions_standard_fk', t.tenantId, t.standardPositionId, jobPositionObjects),
    check('job_position_versions_direct_not_self', sql`${t.directParentId} <> ${t.objectId}`),
    check('job_position_versions_dotted_not_self', sql`${t.dottedParentId} <> ${t.objectId}`),
  ],
);

/** 同租户职位重名及编码检查共用本行事务锁，配置字段自身仍以版本保存。 */
export const jobSettingsObjects = pgTable(
  'job_settings_objects',
  { tenantId: tenantId().primaryKey(), revision: integer('revision').notNull().default(0), createdAt: utc() },
  (t) => [check('job_settings_objects_revision_valid', sql`${t.revision} >= 0`)],
);

export const jobSettingsVersions = pgTable(
  'job_settings_versions',
  {
    id: id(),
    tenantId: tenantId(),
    versionNo: integer('version_no').notNull(),
    previousVersionId: uuid('previous_version_id'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    stopDate: date('stop_date', { mode: 'string' }).notNull().default('9999-12-31'),
    enabled: boolean('enabled').notNull().default(true),
    allowDuplicatePositionNames: boolean('allow_duplicate_position_names').notNull().default(false),
    adjustEmployeeDirectManager: boolean('adjust_employee_direct_manager').notNull().default(false),
    createdAt: utc(),
  },
  (t) => [
    unique('job_settings_versions_tenant_id').on(t.tenantId, t.id),
    unique('job_settings_versions_tenant_version').on(t.tenantId, t.versionNo),
    foreignKey({
      name: 'job_settings_versions_object_fk',
      columns: [t.tenantId],
      foreignColumns: [jobSettingsObjects.tenantId],
    }),
    reference('job_settings_versions_previous_fk', t.tenantId, t.previousVersionId, t),
    index('job_settings_versions_tenant_as_of').on(t.tenantId, t.startDate, t.versionNo),
    check('job_settings_versions_version_positive', sql`${t.versionNo} > 0`),
    check('job_settings_versions_dates_valid', sql`${t.stopDate} >= ${t.startDate}`),
    check('job_settings_versions_previous_not_self', sql`${t.previousVersionId} <> ${t.id}`),
  ],
);

export const JOB_KINDS = [
  'layers',
  'grades',
  'level-types',
  'levels',
  'sequences',
  'professional-lines',
  'posts',
  'positions',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

function importTargets() {
  return {
    layerId: uuid('layer_id'),
    gradeId: uuid('grade_id'),
    levelTypeId: uuid('level_type_id'),
    levelId: uuid('level_id'),
    sequenceId: uuid('sequence_id'),
    professionalLineId: uuid('professional_line_id'),
    postId: uuid('post_id'),
    positionId: uuid('position_id'),
  };
}

interface ImportColumns {
  readonly tenantId: AnyPgColumn;
  readonly kind: AnyPgColumn;
  readonly layerId: AnyPgColumn;
  readonly gradeId: AnyPgColumn;
  readonly levelTypeId: AnyPgColumn;
  readonly levelId: AnyPgColumn;
  readonly sequenceId: AnyPgColumn;
  readonly professionalLineId: AnyPgColumn;
  readonly postId: AnyPgColumn;
  readonly positionId: AnyPgColumn;
}

function importReferences(name: string, t: ImportColumns): PgTableExtraConfigValue[] {
  return [
    reference(`${name}_layer_fk`, t.tenantId, t.layerId, jobLayerObjects),
    reference(`${name}_grade_fk`, t.tenantId, t.gradeId, jobGradeObjects),
    reference(`${name}_level_type_fk`, t.tenantId, t.levelTypeId, jobLevelTypeObjects),
    reference(`${name}_level_fk`, t.tenantId, t.levelId, jobLevelObjects),
    reference(`${name}_sequence_fk`, t.tenantId, t.sequenceId, jobSequenceObjects),
    reference(`${name}_professional_line_fk`, t.tenantId, t.professionalLineId, jobProfessionalLineObjects),
    reference(`${name}_post_fk`, t.tenantId, t.postId, jobPostObjects),
    reference(`${name}_position_fk`, t.tenantId, t.positionId, jobPositionObjects),
  ];
}

function importTargetRules(t: ImportColumns) {
  const count = sql`num_nonnulls(${t.layerId}, ${t.gradeId}, ${t.levelTypeId}, ${t.levelId},
    ${t.sequenceId}, ${t.professionalLineId}, ${t.postId}, ${t.positionId})`;
  const matched = sql`(
    (${t.kind} = 'layers' AND ${t.layerId} IS NOT NULL) OR
    (${t.kind} = 'grades' AND ${t.gradeId} IS NOT NULL) OR
    (${t.kind} = 'level-types' AND ${t.levelTypeId} IS NOT NULL) OR
    (${t.kind} = 'levels' AND ${t.levelId} IS NOT NULL) OR
    (${t.kind} = 'sequences' AND ${t.sequenceId} IS NOT NULL) OR
    (${t.kind} = 'professional-lines' AND ${t.professionalLineId} IS NOT NULL) OR
    (${t.kind} = 'posts' AND ${t.postId} IS NOT NULL) OR
    (${t.kind} = 'positions' AND ${t.positionId} IS NOT NULL)
  )`;
  return { count, matched };
}

/** kind 对应的唯一具体 FK 列非空，避免多态 ID 绕开对象类型及租户校验（DEC-060）。 */
export const jobImportMappings = pgTable(
  'job_import_mappings',
  {
    tenantId: tenantId(),
    kind: text('kind').$type<JobKind>().notNull(),
    sourceCode: text('source_code').notNull(),
    ...importTargets(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.kind, t.sourceCode] }),
    ...importReferences('job_import_mappings', t),
    check(
      'job_import_mappings_target_valid',
      sql`${importTargetRules(t).count} = 1 AND ${importTargetRules(t).matched}`,
    ),
  ],
);

export const JOB_IMPORT_STATUSES = ['created', 'updated', 'conflict'] as const;
export type JobImportStatus = (typeof JOB_IMPORT_STATUSES)[number];

export const jobImportResults = pgTable(
  'job_import_results',
  {
    tenantId: tenantId(),
    commandId: text('command_id').notNull(),
    rowIndex: integer('row_index').notNull(),
    kind: text('kind').$type<JobKind>().notNull(),
    sourceCode: text('source_code').notNull(),
    code: text('code').notNull(),
    status: text('status').$type<JobImportStatus>().notNull(),
    reason: text('reason'),
    ...importTargets(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.commandId, t.rowIndex] }),
    ...importReferences('job_import_results', t),
    check('job_import_results_status_valid', sql`${t.status} IN ('created', 'updated', 'conflict')`),
    check('job_import_results_row_index_valid', sql`${t.rowIndex} >= 0`),
    check(
      'job_import_results_kind_valid',
      sql`${t.kind} IN
      ('layers', 'grades', 'level-types', 'levels', 'sequences', 'professional-lines', 'posts', 'positions')`,
    ),
    check(
      'job_import_results_target_valid',
      sql`
      (${t.status} = 'conflict' AND ${importTargetRules(t).count} = 0) OR
      (${importTargetRules(t).count} = 1 AND ${importTargetRules(t).matched})`,
    ),
  ],
);

export type JobLayer = typeof jobLayerVersions.$inferSelect;
export type JobGrade = typeof jobGradeVersions.$inferSelect;
export type JobLevelType = typeof jobLevelTypeVersions.$inferSelect;
export type JobLevel = typeof jobLevelVersions.$inferSelect;
export type JobSequence = typeof jobSequenceVersions.$inferSelect;
export type JobProfessionalLine = typeof jobProfessionalLineVersions.$inferSelect;
export type JobPost = typeof jobPostVersions.$inferSelect;
export type JobPosition = typeof jobPositionVersions.$inferSelect;
export type JobSettings = typeof jobSettingsVersions.$inferSelect;
export type JobImportMapping = typeof jobImportMappings.$inferSelect;
export type JobImportResult = typeof jobImportResults.$inferSelect;
