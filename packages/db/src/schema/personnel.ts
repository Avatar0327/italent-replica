import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { employmentEmployees, employmentRecords } from './employment.js';
import { tenants } from './tenancy.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
function employeeFk(name: string, t: { tenantId: AnyPgColumn; employeeId: AnyPgColumn }) {
  return foreignKey({
    name,
    columns: [t.tenantId, t.employeeId],
    foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
  });
}
function subsetMeta() {
  return {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    revision: integer('revision').notNull().default(1),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id'),
    deleted: boolean('deleted').notNull().default(false),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    commandId: text('command_id').notNull(),
  };
}
/** 来源类型与来源单据成对出现；版本表上的同名约束由迁移 0022 手写添加。 */
function versionSourceCheck(name: string, t: { sourceType: AnyPgColumn; sourceId: AnyPgColumn }) {
  return check(
    name,
    sql`${t.sourceType} IN ('hr_direct','self_service','info_collection','employment_sync')
    AND ((${t.sourceType} = 'hr_direct' AND ${t.sourceId} IS NULL)
      OR (${t.sourceType} <> 'hr_direct' AND ${t.sourceId} IS NOT NULL))`,
  );
}
function employeeFields() {
  return {
    name: text('name'),
    displayName: text('display_name'),
    engName: text('eng_name'),
    lastname: text('lastname'),
    firstname: text('firstname'),
    gender: text('gender'),
    birthday: date('birthday', { mode: 'string' }),
    nation: text('nation'),
    nationality: text('nationality'),
    registAddress: text('regist_address'),
    marryCategory: text('marry_category'),
    politicalStatus: text('political_status'),
    workDate: date('work_date', { mode: 'string' }),
    idPhoto: uuid('id_photo'),
    idType: text('id_type'),
    idNumber: text('id_number'),
    idStartDate: date('id_start_date', { mode: 'string' }),
    idEndDate: date('id_end_date', { mode: 'string' }),
    idLongTerm: boolean('id_long_term'),
    idIssuer: text('id_issuer'),
    idFront: uuid('id_front'),
    idBack: uuid('id_back'),
    mobilePhone: text('mobile_phone'),
    email: text('email'),
    workEmail: text('work_email'),
    backupMail: text('backup_mail'),
    officePhone: text('office_phone'),
    homePhone: text('home_phone'),
    contactAddress: text('contact_address'),
    householdAddress: text('household_address'),
    householdCategory: text('household_category'),
    emergencyContact: text('emergency_contact'),
    emergencyPhone: text('emergency_phone'),
    emergencyRelationship: text('emergency_relationship'),
    isRehire: boolean('is_rehire'),
    rehireType: text('rehire_type'),
    confirmRehireUserId: uuid('confirm_rehire_user_id'),
    expectedRetirementDate: date('expected_retirement_date', { mode: 'string' }),
    actualRetirementDate: date('actual_retirement_date', { mode: 'string' }),
    allowToLoginIn: boolean('allow_to_login_in'),
    namePinyin: text('name_pinyin'),
    pinyinInitials: text('pinyin_initials'),
    lastNamePinyin: text('last_name_pinyin'),
    firstNamePinyin: text('first_name_pinyin'),
    educationLevel: text('education_level'),
    lastSchool: text('last_school'),
    major: text('major'),
    graduateDate: date('graduate_date', { mode: 'string' }),
    firstEducationLevel: text('first_education_level'),
    highestDegree: text('highest_degree'),
    highestTechnicalLevel: text('highest_technical_level'),
    highestVocationalLevel: text('highest_vocational_level'),
    accountActivationStatus: text('account_activation_status'),
    invitationStatus: text('invitation_status'),
    approvalStatus: text('approval_status'),
    approvalObjectDataId: uuid('approval_object_data_id'),
    approvalObjectDataId2: uuid('approval_object_data_id2'),
    approvalType: text('approval_type'),
    currentApproverId: uuid('current_approver_id'),
  };
}
export const personnelEmployeeVersions = pgTable(
  'personnel_employee_versions',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    revision: integer('revision').notNull(),
    previousVersionId: uuid('previous_version_id'),
    commandId: text('command_id').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    ...employeeFields(),
  },
  (t) => [
    unique('personnel_employee_versions_owner_id').on(t.tenantId, t.employeeId, t.id),
    unique('personnel_employee_versions_revision').on(t.tenantId, t.employeeId, t.revision),
    employeeFk('personnel_employee_versions_employee_fk', t),
    foreignKey({
      name: 'personnel_employee_previous_fk',
      columns: [t.tenantId, t.employeeId, t.previousVersionId],
      foreignColumns: [t.tenantId, t.employeeId, t.id],
    }),
    check('personnel_employee_revision_positive', sql`${t.revision} > 0`),
  ],
);
export const personnelAttachments = pgTable(
  'personnel_attachments',
  {
    id: id(),
    // 0024 用列内联约束建表，约束名由 PostgreSQL 自动生成，这里与之对齐
    tenantId: uuid('tenant_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    purpose: text('purpose').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    status: text('status').notNull().default('registered'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('personnel_attachments_tenant_id').on(t.tenantId, t.id),
    employeeFk('personnel_attachments_employee_fk', t),
    foreignKey({ name: 'personnel_attachments_tenant_id_fkey', columns: [t.tenantId], foreignColumns: [tenants.id] }),
    check('personnel_attachments_status_check', sql`${t.status} IN ('registered','uploaded','pending_cleanup')`),
    check('personnel_attachments_byte_size_check', sql`${t.byteSize} >= 0`),
  ],
);
function educationFields() {
  return {
    educationLevel: text('education_level'),
    degree: text('degree'),
    school: text('school'),
    schoolType: text('school_type'),
    major: text('major'),
    majorCategory: text('major_category'),
    majorDescription: text('major_description'),
    mainCourses: text('main_courses'),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    learningForm: text('learning_form'),
    schoolingLength: text('schooling_length'),
    graduationType: text('graduation_type'),
    trainingMode: text('training_mode'),
    isFirstEducation: boolean('is_first_education'),
    isHighestEducation: boolean('is_highest_education'),
    isHighestDegree: boolean('is_highest_degree'),
    isMainMajor: boolean('is_main_major'),
    educationCertificate: uuid('education_certificate'),
    educationCertificateNumber: text('education_certificate_number'),
    degreeCertificate: uuid('degree_certificate'),
    degreeCertificateNumber: text('degree_certificate_number'),
    degreeCountry: text('degree_country'),
    gpa: numeric('gpa'),
    classRank: integer('class_rank'),
    majorRank: integer('major_rank'),
    attachmentId: uuid('attachment_id'),
  };
}
export const personnelEducation = pgTable(
  'personnel_education',
  {
    ...subsetMeta(),
    ...educationFields(),
  },
  (t) => [
    unique('personnel_education_tenant_id').on(t.tenantId, t.id),
    unique('personnel_education_owner_id').on(t.tenantId, t.employeeId, t.id),
    employeeFk('personnel_education_employee_fk', t),
    index('personnel_education_employee').on(t.tenantId, t.employeeId, t.id),
    check('personnel_education_revision_positive', sql`${t.revision} > 0`),
    check(
      'personnel_education_source',
      sql`${t.sourceType} IN ('hr_direct','self_service','info_collection','employment_sync')
    AND ((${t.sourceType} = 'hr_direct' AND ${t.sourceId} IS NULL)
      OR (${t.sourceType} <> 'hr_direct' AND ${t.sourceId} IS NOT NULL))`,
    ),
    uniqueIndex('personnel_education_is_first_education_one')
      .on(t.tenantId, t.employeeId)
      .where(sql`${t.isFirstEducation} = true AND NOT ${t.deleted}`),
    uniqueIndex('personnel_education_is_highest_education_one')
      .on(t.tenantId, t.employeeId)
      .where(sql`${t.isHighestEducation} = true AND NOT ${t.deleted}`),
    uniqueIndex('personnel_education_is_highest_degree_one')
      .on(t.tenantId, t.employeeId)
      .where(sql`${t.isHighestDegree} = true AND NOT ${t.deleted}`),
    uniqueIndex('personnel_education_is_main_major_one')
      .on(t.tenantId, t.employeeId)
      .where(sql`${t.isMainMajor} = true AND NOT ${t.deleted}`),
  ],
);
export const personnelEducationVersions = pgTable(
  'personnel_education_versions',
  {
    ...subsetMeta(),
    recordId: uuid('record_id').notNull(),
    ...educationFields(),
  },
  (t) => [
    unique('personnel_education_versions_revision').on(t.tenantId, t.recordId, t.revision),
    versionSourceCheck('personnel_education_versions_source', t),
    employeeFk('personnel_education_versions_employee_fk', t),
    foreignKey({
      name: 'personnel_education_versions_record_fk',
      columns: [t.tenantId, t.employeeId, t.recordId],
      foreignColumns: [personnelEducation.tenantId, personnelEducation.employeeId, personnelEducation.id],
    }),
  ],
);
function jobHistoryFields() {
  return {
    company: text('company'),
    department: text('department'),
    post: text('post'),
    position: text('position'),
    level: text('level'),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    entryDate: date('entry_date', { mode: 'string' }),
    leaveDate: date('leave_date', { mode: 'string' }),
    leaveReason: text('leave_reason'),
    responsibilities: text('responsibilities'),
    achievements: text('achievements'),
    referenceName: text('reference_name'),
    referenceTitle: text('reference_title'),
    referencePhone: text('reference_phone'),
    companyType: text('company_type'),
    industry: text('industry'),
    companySize: text('company_size'),
    subordinateCount: integer('subordinate_count'),
    reportsTo: text('reports_to'),
    monthlySalary: numeric('monthly_salary'),
    isThisCompany: boolean('is_this_company'),
    employmentRecordId: uuid('employment_record_id'),
    employmentType: text('employment_type'),
    departmentFullName: text('department_full_name'),
  };
}
export const personnelJobHistory = pgTable(
  'personnel_job_history',
  {
    ...subsetMeta(),
    ...jobHistoryFields(),
  },
  (t) => [
    unique('personnel_job_history_tenant_id').on(t.tenantId, t.id),
    unique('personnel_job_history_owner_id').on(t.tenantId, t.employeeId, t.id),
    employeeFk('personnel_job_history_employee_fk', t),
    index('personnel_job_history_employee').on(t.tenantId, t.employeeId, t.id),
    check('personnel_job_history_revision_positive', sql`${t.revision} > 0`),
    check(
      'personnel_job_history_source',
      sql`${t.sourceType} IN ('hr_direct','self_service','info_collection','employment_sync')
    AND ((${t.sourceType} = 'hr_direct' AND ${t.sourceId} IS NULL)
      OR (${t.sourceType} <> 'hr_direct' AND ${t.sourceId} IS NOT NULL))`,
    ),
    uniqueIndex('personnel_job_history_employment')
      .on(t.tenantId, t.employmentRecordId)
      .where(sql`${t.employmentRecordId} IS NOT NULL`),
    foreignKey({
      name: 'personnel_job_history_employment_fk',
      columns: [t.tenantId, t.employeeId, t.employmentRecordId],
      foreignColumns: [employmentRecords.tenantId, employmentRecords.employeeId, employmentRecords.id],
    }),
    check('personnel_job_history_link', sql`(${t.isThisCompany} IS TRUE) = (${t.employmentRecordId} IS NOT NULL)`),
  ],
);
export const personnelJobHistoryVersions = pgTable(
  'personnel_job_history_versions',
  {
    ...subsetMeta(),
    recordId: uuid('record_id').notNull(),
    ...jobHistoryFields(),
  },
  (t) => [
    unique('personnel_job_history_versions_revision').on(t.tenantId, t.recordId, t.revision),
    versionSourceCheck('personnel_job_history_versions_source', t),
    employeeFk('personnel_job_history_versions_employee_fk', t),
    foreignKey({
      name: 'personnel_job_history_versions_record_fk',
      columns: [t.tenantId, t.employeeId, t.recordId],
      foreignColumns: [personnelJobHistory.tenantId, personnelJobHistory.employeeId, personnelJobHistory.id],
    }),
  ],
);
function familyFields() {
  return {
    name: text('name'),
    relationship: text('relationship'),
    gender: text('gender'),
    birthday: date('birthday', { mode: 'string' }),
    company: text('company'),
    post: text('post'),
    phone: text('phone'),
    mobilePhone: text('mobile_phone'),
    email: text('email'),
    nationality: text('nationality'),
    nation: text('nation'),
    politicalStatus: text('political_status'),
    idNumber: text('id_number'),
    idFront: uuid('id_front'),
    idBack: uuid('id_back'),
    idStartDate: date('id_start_date', { mode: 'string' }),
    idEndDate: date('id_end_date', { mode: 'string' }),
    idIssuer: text('id_issuer'),
    previousChildcareDays: numeric('previous_childcare_days'),
    childcareStartYear: integer('childcare_start_year'),
  };
}
export const personnelFamily = pgTable(
  'personnel_family',
  {
    ...subsetMeta(),
    ...familyFields(),
  },
  (t) => [
    unique('personnel_family_tenant_id').on(t.tenantId, t.id),
    unique('personnel_family_owner_id').on(t.tenantId, t.employeeId, t.id),
    employeeFk('personnel_family_employee_fk', t),
    index('personnel_family_employee').on(t.tenantId, t.employeeId, t.id),
    check('personnel_family_revision_positive', sql`${t.revision} > 0`),
    check(
      'personnel_family_source',
      sql`${t.sourceType} IN ('hr_direct','self_service','info_collection','employment_sync')
    AND ((${t.sourceType} = 'hr_direct' AND ${t.sourceId} IS NULL)
      OR (${t.sourceType} <> 'hr_direct' AND ${t.sourceId} IS NOT NULL))`,
    ),
  ],
);
export const personnelFamilyVersions = pgTable(
  'personnel_family_versions',
  {
    ...subsetMeta(),
    recordId: uuid('record_id').notNull(),
    ...familyFields(),
  },
  (t) => [
    unique('personnel_family_versions_revision').on(t.tenantId, t.recordId, t.revision),
    versionSourceCheck('personnel_family_versions_source', t),
    employeeFk('personnel_family_versions_employee_fk', t),
    foreignKey({
      name: 'personnel_family_versions_record_fk',
      columns: [t.tenantId, t.employeeId, t.recordId],
      foreignColumns: [personnelFamily.tenantId, personnelFamily.employeeId, personnelFamily.id],
    }),
  ],
);
function trainingFields() {
  return {
    name: text('name'),
    category: text('category'),
    institution: text('institution'),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    hours: numeric('hours'),
    score: numeric('score'),
    passed: boolean('passed'),
    completed: boolean('completed'),
    credits: numeric('credits'),
    certificate: text('certificate'),
    lecturer: text('lecturer'),
    mentor: text('mentor'),
    activityNumber: text('activity_number'),
    hasMedal: boolean('has_medal'),
  };
}
export const personnelTraining = pgTable(
  'personnel_training',
  {
    ...subsetMeta(),
    ...trainingFields(),
  },
  (t) => [
    unique('personnel_training_tenant_id').on(t.tenantId, t.id),
    unique('personnel_training_owner_id').on(t.tenantId, t.employeeId, t.id),
    employeeFk('personnel_training_employee_fk', t),
    index('personnel_training_employee').on(t.tenantId, t.employeeId, t.id),
    check('personnel_training_revision_positive', sql`${t.revision} > 0`),
    check(
      'personnel_training_source',
      sql`${t.sourceType} IN ('hr_direct','self_service','info_collection','employment_sync')
    AND ((${t.sourceType} = 'hr_direct' AND ${t.sourceId} IS NULL)
      OR (${t.sourceType} <> 'hr_direct' AND ${t.sourceId} IS NOT NULL))`,
    ),
  ],
);
export const personnelTrainingVersions = pgTable(
  'personnel_training_versions',
  {
    ...subsetMeta(),
    recordId: uuid('record_id').notNull(),
    ...trainingFields(),
  },
  (t) => [
    unique('personnel_training_versions_revision').on(t.tenantId, t.recordId, t.revision),
    versionSourceCheck('personnel_training_versions_source', t),
    employeeFk('personnel_training_versions_employee_fk', t),
    foreignKey({
      name: 'personnel_training_versions_record_fk',
      columns: [t.tenantId, t.employeeId, t.recordId],
      foreignColumns: [personnelTraining.tenantId, personnelTraining.employeeId, personnelTraining.id],
    }),
  ],
);
function certificateFields() {
  return {
    name: text('name'),
    type: text('type'),
    number: text('number'),
    issuer: text('issuer'),
    obtainedDate: date('obtained_date', { mode: 'string' }),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    attachmentId: uuid('attachment_id'),
    learningCertificateId: text('learning_certificate_id'),
  };
}
export const personnelCertificate = pgTable(
  'personnel_certificate',
  {
    ...subsetMeta(),
    ...certificateFields(),
  },
  (t) => [
    unique('personnel_certificate_tenant_id').on(t.tenantId, t.id),
    unique('personnel_certificate_owner_id').on(t.tenantId, t.employeeId, t.id),
    employeeFk('personnel_certificate_employee_fk', t),
    index('personnel_certificate_employee').on(t.tenantId, t.employeeId, t.id),
    check('personnel_certificate_revision_positive', sql`${t.revision} > 0`),
    check(
      'personnel_certificate_source',
      sql`${t.sourceType} IN ('hr_direct','self_service','info_collection','employment_sync')
    AND ((${t.sourceType} = 'hr_direct' AND ${t.sourceId} IS NULL)
      OR (${t.sourceType} <> 'hr_direct' AND ${t.sourceId} IS NOT NULL))`,
    ),
  ],
);
export const personnelCertificateVersions = pgTable(
  'personnel_certificate_versions',
  {
    ...subsetMeta(),
    recordId: uuid('record_id').notNull(),
    ...certificateFields(),
  },
  (t) => [
    unique('personnel_certificate_versions_revision').on(t.tenantId, t.recordId, t.revision),
    versionSourceCheck('personnel_certificate_versions_source', t),
    employeeFk('personnel_certificate_versions_employee_fk', t),
    foreignKey({
      name: 'personnel_certificate_versions_record_fk',
      columns: [t.tenantId, t.employeeId, t.recordId],
      foreignColumns: [personnelCertificate.tenantId, personnelCertificate.employeeId, personnelCertificate.id],
    }),
  ],
);
function awardsFields() {
  return {
    name: text('name'),
    category: text('category'),
    level: text('level'),
    awardDate: date('award_date', { mode: 'string' }),
    description: text('description'),
  };
}
export const personnelAwards = pgTable(
  'personnel_awards',
  {
    ...subsetMeta(),
    ...awardsFields(),
  },
  (t) => [
    unique('personnel_awards_tenant_id').on(t.tenantId, t.id),
    unique('personnel_awards_owner_id').on(t.tenantId, t.employeeId, t.id),
    employeeFk('personnel_awards_employee_fk', t),
    index('personnel_awards_employee').on(t.tenantId, t.employeeId, t.id),
    check('personnel_awards_revision_positive', sql`${t.revision} > 0`),
    check(
      'personnel_awards_source',
      sql`${t.sourceType} IN ('hr_direct','self_service','info_collection','employment_sync')
    AND ((${t.sourceType} = 'hr_direct' AND ${t.sourceId} IS NULL)
      OR (${t.sourceType} <> 'hr_direct' AND ${t.sourceId} IS NOT NULL))`,
    ),
  ],
);
export const personnelAwardsVersions = pgTable(
  'personnel_awards_versions',
  {
    ...subsetMeta(),
    recordId: uuid('record_id').notNull(),
    ...awardsFields(),
  },
  (t) => [
    unique('personnel_awards_versions_revision').on(t.tenantId, t.recordId, t.revision),
    versionSourceCheck('personnel_awards_versions_source', t),
    employeeFk('personnel_awards_versions_employee_fk', t),
    foreignKey({
      name: 'personnel_awards_versions_record_fk',
      columns: [t.tenantId, t.employeeId, t.recordId],
      foreignColumns: [personnelAwards.tenantId, personnelAwards.employeeId, personnelAwards.id],
    }),
  ],
);
function projectExperienceFields() {
  return {
    name: text('name'),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    post: text('post'),
    position: text('position'),
    responsibilities: text('responsibilities'),
    results: text('results'),
    headcount: integer('headcount'),
    description: text('description'),
    hardwareEnvironment: text('hardware_environment'),
    softwareEnvironment: text('software_environment'),
    developmentTools: text('development_tools'),
  };
}
export const personnelProjectExperience = pgTable(
  'personnel_project_experience',
  {
    ...subsetMeta(),
    ...projectExperienceFields(),
  },
  (t) => [
    unique('personnel_project_experience_tenant_id').on(t.tenantId, t.id),
    unique('personnel_project_experience_owner_id').on(t.tenantId, t.employeeId, t.id),
    employeeFk('personnel_project_experience_employee_fk', t),
    index('personnel_project_experience_employee').on(t.tenantId, t.employeeId, t.id),
    check('personnel_project_experience_revision_positive', sql`${t.revision} > 0`),
    check(
      'personnel_project_experience_source',
      sql`${t.sourceType} IN ('hr_direct','self_service','info_collection','employment_sync')
    AND ((${t.sourceType} = 'hr_direct' AND ${t.sourceId} IS NULL)
      OR (${t.sourceType} <> 'hr_direct' AND ${t.sourceId} IS NOT NULL))`,
    ),
  ],
);
export const personnelProjectExperienceVersions = pgTable(
  'personnel_project_experience_versions',
  {
    ...subsetMeta(),
    recordId: uuid('record_id').notNull(),
    ...projectExperienceFields(),
  },
  (t) => [
    unique('personnel_project_experience_versions_revision').on(t.tenantId, t.recordId, t.revision),
    versionSourceCheck('personnel_project_experience_versions_source', t),
    employeeFk('personnel_project_experience_versions_employee_fk', t),
    foreignKey({
      name: 'personnel_project_experience_versions_record_fk',
      columns: [t.tenantId, t.employeeId, t.recordId],
      foreignColumns: [
        personnelProjectExperience.tenantId,
        personnelProjectExperience.employeeId,
        personnelProjectExperience.id,
      ],
    }),
  ],
);
function skillFields() {
  return {
    name: text('name'),
    category: text('category'),
    proficiency: text('proficiency'),
    months: numeric('months'),
  };
}
export const personnelSkill = pgTable(
  'personnel_skill',
  {
    ...subsetMeta(),
    ...skillFields(),
  },
  (t) => [
    unique('personnel_skill_tenant_id').on(t.tenantId, t.id),
    unique('personnel_skill_owner_id').on(t.tenantId, t.employeeId, t.id),
    employeeFk('personnel_skill_employee_fk', t),
    index('personnel_skill_employee').on(t.tenantId, t.employeeId, t.id),
    check('personnel_skill_revision_positive', sql`${t.revision} > 0`),
    check(
      'personnel_skill_source',
      sql`${t.sourceType} IN ('hr_direct','self_service','info_collection','employment_sync')
    AND ((${t.sourceType} = 'hr_direct' AND ${t.sourceId} IS NULL)
      OR (${t.sourceType} <> 'hr_direct' AND ${t.sourceId} IS NOT NULL))`,
    ),
  ],
);
export const personnelSkillVersions = pgTable(
  'personnel_skill_versions',
  {
    ...subsetMeta(),
    recordId: uuid('record_id').notNull(),
    ...skillFields(),
  },
  (t) => [
    unique('personnel_skill_versions_revision').on(t.tenantId, t.recordId, t.revision),
    versionSourceCheck('personnel_skill_versions_source', t),
    employeeFk('personnel_skill_versions_employee_fk', t),
    foreignKey({
      name: 'personnel_skill_versions_record_fk',
      columns: [t.tenantId, t.employeeId, t.recordId],
      foreignColumns: [personnelSkill.tenantId, personnelSkill.employeeId, personnelSkill.id],
    }),
  ],
);
function languageAbilityFields() {
  return {
    language: text('language'),
    proficiency: text('proficiency'),
    listening: text('listening'),
    speaking: text('speaking'),
    reading: text('reading'),
    writing: text('writing'),
    isNative: boolean('is_native'),
    description: text('description'),
  };
}
export const personnelLanguageAbility = pgTable(
  'personnel_language_ability',
  {
    ...subsetMeta(),
    ...languageAbilityFields(),
  },
  (t) => [
    unique('personnel_language_ability_tenant_id').on(t.tenantId, t.id),
    unique('personnel_language_ability_owner_id').on(t.tenantId, t.employeeId, t.id),
    employeeFk('personnel_language_ability_employee_fk', t),
    index('personnel_language_ability_employee').on(t.tenantId, t.employeeId, t.id),
    check('personnel_language_ability_revision_positive', sql`${t.revision} > 0`),
    check(
      'personnel_language_ability_source',
      sql`${t.sourceType} IN ('hr_direct','self_service','info_collection','employment_sync')
    AND ((${t.sourceType} = 'hr_direct' AND ${t.sourceId} IS NULL)
      OR (${t.sourceType} <> 'hr_direct' AND ${t.sourceId} IS NOT NULL))`,
    ),
  ],
);
export const personnelLanguageAbilityVersions = pgTable(
  'personnel_language_ability_versions',
  {
    ...subsetMeta(),
    recordId: uuid('record_id').notNull(),
    ...languageAbilityFields(),
  },
  (t) => [
    unique('personnel_language_ability_versions_revision').on(t.tenantId, t.recordId, t.revision),
    versionSourceCheck('personnel_language_ability_versions_source', t),
    employeeFk('personnel_language_ability_versions_employee_fk', t),
    foreignKey({
      name: 'personnel_language_ability_versions_record_fk',
      columns: [t.tenantId, t.employeeId, t.recordId],
      foreignColumns: [
        personnelLanguageAbility.tenantId,
        personnelLanguageAbility.employeeId,
        personnelLanguageAbility.id,
      ],
    }),
  ],
);
function estimationResultFields() {
  return {
    year: integer('year'),
    cycleName: text('cycle_name'),
    cycleOrder: integer('cycle_order'),
    cycleStartDate: date('cycle_start_date', { mode: 'string' }),
    cycleEndDate: date('cycle_end_date', { mode: 'string' }),
    activity: text('activity'),
    performanceId: text('performance_id'),
    department: text('department'),
    finalScore: numeric('final_score'),
    totalGrade: text('total_grade'),
    abilityGrade: text('ability_grade'),
    abilityScore: numeric('ability_score'),
    valuesGrade: text('values_grade'),
    valuesScore: numeric('values_score'),
    coefficient: numeric('coefficient'),
    nineBoxResult: text('nine_box_result'),
    comments: text('comments'),
    developmentPlan: text('development_plan'),
  };
}
export const personnelEstimationResult = pgTable(
  'personnel_estimation_result',
  {
    ...subsetMeta(),
    ...estimationResultFields(),
  },
  (t) => [
    unique('personnel_estimation_result_tenant_id').on(t.tenantId, t.id),
    unique('personnel_estimation_result_owner_id').on(t.tenantId, t.employeeId, t.id),
    employeeFk('personnel_estimation_result_employee_fk', t),
    index('personnel_estimation_result_employee').on(t.tenantId, t.employeeId, t.id),
    check('personnel_estimation_result_revision_positive', sql`${t.revision} > 0`),
    check(
      'personnel_estimation_result_source',
      sql`${t.sourceType} IN ('hr_direct','self_service','info_collection','employment_sync')
    AND ((${t.sourceType} = 'hr_direct' AND ${t.sourceId} IS NULL)
      OR (${t.sourceType} <> 'hr_direct' AND ${t.sourceId} IS NOT NULL))`,
    ),
  ],
);
export const personnelEstimationResultVersions = pgTable(
  'personnel_estimation_result_versions',
  {
    ...subsetMeta(),
    recordId: uuid('record_id').notNull(),
    ...estimationResultFields(),
  },
  (t) => [
    unique('personnel_estimation_result_versions_revision').on(t.tenantId, t.recordId, t.revision),
    versionSourceCheck('personnel_estimation_result_versions_source', t),
    employeeFk('personnel_estimation_result_versions_employee_fk', t),
    foreignKey({
      name: 'personnel_estimation_result_versions_record_fk',
      columns: [t.tenantId, t.employeeId, t.recordId],
      foreignColumns: [
        personnelEstimationResult.tenantId,
        personnelEstimationResult.employeeId,
        personnelEstimationResult.id,
      ],
    }),
  ],
);
function punishFields() {
  return {
    month: text('month'),
    description: text('description'),
  };
}
export const personnelPunish = pgTable(
  'personnel_punish',
  {
    ...subsetMeta(),
    ...punishFields(),
  },
  (t) => [
    unique('personnel_punish_tenant_id').on(t.tenantId, t.id),
    unique('personnel_punish_owner_id').on(t.tenantId, t.employeeId, t.id),
    employeeFk('personnel_punish_employee_fk', t),
    index('personnel_punish_employee').on(t.tenantId, t.employeeId, t.id),
    check('personnel_punish_revision_positive', sql`${t.revision} > 0`),
    check(
      'personnel_punish_source',
      sql`${t.sourceType} IN ('hr_direct','self_service','info_collection','employment_sync')
    AND ((${t.sourceType} = 'hr_direct' AND ${t.sourceId} IS NULL)
      OR (${t.sourceType} <> 'hr_direct' AND ${t.sourceId} IS NOT NULL))`,
    ),
  ],
);
export const personnelPunishVersions = pgTable(
  'personnel_punish_versions',
  {
    ...subsetMeta(),
    recordId: uuid('record_id').notNull(),
    ...punishFields(),
  },
  (t) => [
    unique('personnel_punish_versions_revision').on(t.tenantId, t.recordId, t.revision),
    versionSourceCheck('personnel_punish_versions_source', t),
    employeeFk('personnel_punish_versions_employee_fk', t),
    foreignKey({
      name: 'personnel_punish_versions_record_fk',
      columns: [t.tenantId, t.employeeId, t.recordId],
      foreignColumns: [personnelPunish.tenantId, personnelPunish.employeeId, personnelPunish.id],
    }),
  ],
);
function professionalTechnicalPostFields() {
  return {
    qualificationName: text('qualification_name'),
    level: text('level'),
    appointedPost: text('appointed_post'),
    appointedLevel: text('appointed_level'),
    company: text('company'),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    assessmentDate: date('assessment_date', { mode: 'string' }),
    assessmentInstitution: text('assessment_institution'),
    qualificationRoute: text('qualification_route'),
    isHighestLevel: boolean('is_highest_level'),
  };
}
export const personnelProfessionalTechnicalPost = pgTable(
  'personnel_professional_technical_post',
  {
    ...subsetMeta(),
    ...professionalTechnicalPostFields(),
  },
  (t) => [
    unique('personnel_professional_technical_post_tenant_id').on(t.tenantId, t.id),
    unique('personnel_professional_technical_post_owner_id').on(t.tenantId, t.employeeId, t.id),
    employeeFk('personnel_professional_technical_post_employee_fk', t),
    index('personnel_professional_technical_post_employee').on(t.tenantId, t.employeeId, t.id),
    check('personnel_professional_technical_post_revision_positive', sql`${t.revision} > 0`),
    check(
      'personnel_professional_technical_post_source',
      sql`${t.sourceType} IN ('hr_direct','self_service','info_collection','employment_sync')
    AND ((${t.sourceType} = 'hr_direct' AND ${t.sourceId} IS NULL)
      OR (${t.sourceType} <> 'hr_direct' AND ${t.sourceId} IS NOT NULL))`,
    ),
    uniqueIndex('personnel_professional_technical_post_is_highest_level_one')
      .on(t.tenantId, t.employeeId)
      .where(sql`${t.isHighestLevel} = true AND NOT ${t.deleted}`),
  ],
);
export const personnelProfessionalTechnicalPostVersions = pgTable(
  'personnel_professional_technical_post_versions',
  {
    ...subsetMeta(),
    recordId: uuid('record_id').notNull(),
    ...professionalTechnicalPostFields(),
  },
  (t) => [
    unique('personnel_professional_technical_post_versions_revision').on(t.tenantId, t.recordId, t.revision),
    versionSourceCheck('personnel_professional_technical_post_versions_source', t),
    employeeFk('personnel_professional_technical_post_versions_employee_fk', t),
    foreignKey({
      name: 'personnel_professional_technical_post_versions_record_fk',
      columns: [t.tenantId, t.employeeId, t.recordId],
      foreignColumns: [
        personnelProfessionalTechnicalPost.tenantId,
        personnelProfessionalTechnicalPost.employeeId,
        personnelProfessionalTechnicalPost.id,
      ],
    }),
  ],
);
function vocationalQualificationFields() {
  return {
    name: text('name'),
    type: text('type'),
    level: text('level'),
    certificateNumber: text('certificate_number'),
    issuer: text('issuer'),
    obtainedDate: date('obtained_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    durationType: text('duration_type'),
    major: text('major'),
    qualificationRoute: text('qualification_route'),
    isHighestLevel: boolean('is_highest_level'),
    attachmentId: uuid('attachment_id'),
  };
}
export const personnelVocationalQualification = pgTable(
  'personnel_vocational_qualification',
  {
    ...subsetMeta(),
    ...vocationalQualificationFields(),
  },
  (t) => [
    unique('personnel_vocational_qualification_tenant_id').on(t.tenantId, t.id),
    unique('personnel_vocational_qualification_owner_id').on(t.tenantId, t.employeeId, t.id),
    employeeFk('personnel_vocational_qualification_employee_fk', t),
    index('personnel_vocational_qualification_employee').on(t.tenantId, t.employeeId, t.id),
    check('personnel_vocational_qualification_revision_positive', sql`${t.revision} > 0`),
    check(
      'personnel_vocational_qualification_source',
      sql`${t.sourceType} IN ('hr_direct','self_service','info_collection','employment_sync')
    AND ((${t.sourceType} = 'hr_direct' AND ${t.sourceId} IS NULL)
      OR (${t.sourceType} <> 'hr_direct' AND ${t.sourceId} IS NOT NULL))`,
    ),
    uniqueIndex('personnel_vocational_qualification_is_highest_level_one')
      .on(t.tenantId, t.employeeId)
      .where(sql`${t.isHighestLevel} = true AND NOT ${t.deleted}`),
  ],
);
export const personnelVocationalQualificationVersions = pgTable(
  'personnel_vocational_qualification_versions',
  {
    ...subsetMeta(),
    recordId: uuid('record_id').notNull(),
    ...vocationalQualificationFields(),
  },
  (t) => [
    unique('personnel_vocational_qualification_versions_revision').on(t.tenantId, t.recordId, t.revision),
    versionSourceCheck('personnel_vocational_qualification_versions_source', t),
    employeeFk('personnel_vocational_qualification_versions_employee_fk', t),
    foreignKey({
      name: 'personnel_vocational_qualification_versions_record_fk',
      columns: [t.tenantId, t.employeeId, t.recordId],
      foreignColumns: [
        personnelVocationalQualification.tenantId,
        personnelVocationalQualification.employeeId,
        personnelVocationalQualification.id,
      ],
    }),
  ],
);

/** 审批命令载荷为带类型的 patch；不替代任何业务对象表。 */
export const personnelChangeRequests = pgTable(
  'personnel_change_requests',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    subset: text('subset').notNull(),
    recordId: uuid('record_id'),
    targetRevision: integer('target_revision').notNull(),
    values: jsonb('values').$type<Record<string, unknown>>().notNull(),
    revision: integer('revision').notNull().default(1),
    status: text('status').notNull(),
    createdBy: uuid('created_by').notNull(),
    commandId: text('command_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('personnel_change_requests_owner_id').on(t.tenantId, t.employeeId, t.id),
    employeeFk('personnel_change_requests_employee_fk', t),
    // disapproved：审批沿「不同意」流转到结束，申请办结、不写入子集，不能重提（F-003 第二轮，DEC-144）。
    check(
      'personnel_change_requests_state',
      sql`${t.status} IN ('pending_approval','applied','withdrawn','disapproved')`,
    ),
    check('personnel_change_requests_revision_positive', sql`${t.revision}>0 AND ${t.targetRevision}>=0`),
  ],
);
/** 员工信息变更申请的载荷版本（DEC-099）：首次提交为第 1 版，驳回后同单修正追加新版本，历史保留。 */
export const personnelChangeRequestVersions = pgTable(
  'personnel_change_request_versions',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    requestId: uuid('request_id').notNull(),
    versionNo: integer('version_no').notNull(),
    values: jsonb('values').$type<Record<string, unknown>>().notNull(),
    createdBy: uuid('created_by').notNull(),
    commandId: text('command_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('personnel_change_request_versions_no').on(t.tenantId, t.requestId, t.versionNo),
    foreignKey({
      name: 'personnel_change_request_versions_request_fk',
      columns: [t.tenantId, t.employeeId, t.requestId],
      foreignColumns: [
        personnelChangeRequests.tenantId,
        personnelChangeRequests.employeeId,
        personnelChangeRequests.id,
      ],
    }),
    check('personnel_change_request_versions_positive', sql`${t.versionNo} > 0`),
  ],
);
export const personnelOutbox = pgTable(
  'personnel_outbox',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    objectType: text('object_type').notNull(),
    objectId: uuid('object_id').notNull(),
    eventType: text('event_type').notNull(),
    revision: integer('revision').notNull(),
    commandId: text('command_id').notNull(),
    state: text('state').notNull().default('pending'),
    createdAt: createdAt(),
  },
  (t) => [
    employeeFk('personnel_outbox_employee_fk', t),
    unique('personnel_outbox_event').on(t.tenantId, t.objectType, t.objectId, t.revision),
    index('personnel_outbox_cursor').on(t.tenantId, t.createdAt, t.id),
    check('personnel_outbox_state', sql`${t.state} IN ('pending','sent','failed','unknown')`),
  ],
);

/**
 * DEC-089：组织 / 职务排序号预计算（DEC-037 / G-036）。名次按“生效区间”分段存储：版本按生效日期生效，
 * 区间 [valid_from, valid_to) 内名次不变，读取按业务日期取一段，不需要定时任务；
 * 由 org_versions / org_hierarchy_links / job_post_versions 上的触发器在同一事务提交前增量刷新（迁移 0027）。
 */
function sortRankTable(name: 'personnel_org_sort_ranks' | 'personnel_post_sort_ranks', key: string) {
  return pgTable(
    name,
    {
      tenantId: tenantId(),
      objectId: uuid(key).notNull(),
      validFrom: date('valid_from', { mode: 'string' }).notNull(),
      /** 开放区间为 'infinity'。 */
      validTo: date('valid_to', { mode: 'string' }).notNull(),
      sortNumber: integer('sort_number').notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.tenantId, t.objectId, t.validFrom] }),
      index(`${name}_as_of`).on(t.tenantId, t.validFrom),
      check(`${name}_range`, sql`${t.validTo} > ${t.validFrom}`),
      check(`${name}_positive`, sql`${t.sortNumber} > 0`),
    ],
  );
}
export const personnelOrgSortRanks = sortRankTable('personnel_org_sort_ranks', 'org_id');
export const personnelPostSortRanks = sortRankTable('personnel_post_sort_ranks', 'post_id');

/** F-010 / DEC-148：独立的租户人员排序配置与派生名次，不改任职版本链。 */
export const personnelOrderSettings = pgTable(
  'personnel_order_settings',
  {
    tenantId: tenantId().primaryKey(),
    enabled: boolean('enabled').notNull().default(true),
    revision: integer('revision').notNull().default(0),
  },
  (t) => [check('personnel_order_settings_revision', sql`${t.revision} >= 0`)],
);
export const personnelOrderRules = pgTable(
  'personnel_order_rules',
  {
    tenantId: tenantId(),
    field: text('field').notNull(),
    position: integer('position').notNull(),
    direction: text('direction').notNull(),
    enabled: boolean('enabled').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.field] }),
    unique('personnel_order_rules_position').on(t.tenantId, t.position),
    foreignKey({
      name: 'personnel_order_rules_settings_fk',
      columns: [t.tenantId],
      foreignColumns: [personnelOrderSettings.tenantId],
    }),
    check('personnel_order_rules_field', sql`${t.field} IN ('department','post','position','level','grade','code')`),
    check('personnel_order_rules_direction', sql`${t.direction} IN ('asc','desc')`),
    check('personnel_order_rules_position_valid', sql`${t.position} BETWEEN 0 AND 5`),
  ],
);
export const personnelEmployeeOrderCodes = pgTable(
  'personnel_employee_order_codes',
  {
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    orderCode: integer('order_code'),
    revision: integer('revision').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.employeeId] }),
    employeeFk('personnel_employee_order_codes_employee_fk', t),
    index('personnel_employee_order_codes_order').on(t.tenantId, t.orderCode, t.employeeId),
    check('personnel_employee_order_codes_positive', sql`${t.orderCode} > 0 AND ${t.revision} > 0`),
  ],
);
export const personnelOrderRuns = pgTable(
  'personnel_order_runs',
  {
    tenantId: tenantId(),
    commandId: text('command_id').notNull(),
    state: text('state').notNull(),
    attempts: integer('attempts').notNull(),
    error: text('error'),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.commandId] }),
    check('personnel_order_runs_state', sql`${t.state} IN ('succeeded','failed','unknown')`),
    check('personnel_order_runs_attempts', sql`${t.attempts} > 0`),
  ],
);
