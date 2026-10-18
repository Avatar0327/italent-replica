/**
 * 前台应用 → 菜单对象目录（DEC-456 / DEC-469）：后端权限快照与前端菜单共用同一份，避免两边各写一份而漂移。
 * 应用键与前端 APP_ROUTES 一致；对象编码取自各模块的共享对象目录，按展示顺序排列（第一个是应用的主入口对象）。
 * 本目录只登记“应用 → 对象”的归属，不授予权限：approval / self / manager / settings 的可见性另按专用口径判定。
 */
import { APPROVAL_OBJECTS } from '../approval/catalog.js';
import { EVALUATION_OBJECTS } from '../evaluation/catalog.js';
import { EVALUATION_FLOW_OBJECTS } from '../evaluation/flow-catalog.js';
import { IDP_OBJECTS } from '../idp/catalog.js';
import { PERSONNEL_OBJECTS, PERSONNEL_REQUEST_OBJECT } from '../personnel/catalog.js';
import { QUALIFICATION_OBJECTS, QUALIFICATION_PAGES } from '../qualification/catalog.js';
import { SUCCESSION_OBJECTS } from '../succession/catalog.js';
import { SURVEY360_OBJECTS } from '../survey360/catalog.js';
import { TALENT_OBJECTS } from '../talent/catalog.js';
import { TALENT_REVIEW_OBJECTS } from '../talent-review/catalog.js';
import { MODULE_OBJECTS } from './module-actions.js';

export const APP_IDS = [
  'org',
  'job',
  'staff',
  'transfer',
  'approval',
  'self',
  'manager',
  'settings',
  'talent',
  'qualification',
  'evaluation',
  'survey360',
  'talent-review',
  'succession',
  'idp',
] as const;
export type AppId = (typeof APP_IDS)[number];

const codes = (objects: readonly { readonly code: string }[]): readonly string[] => objects.map((o) => o.code);
/** 主入口对象排第一（与前端路由登记的 objectCode 一致，由验收测试核对），其余保持目录顺序、去重。 */
const withPrimary = (primary: string, objects: readonly { readonly code: string }[]): readonly string[] => [
  ...new Set([primary, ...codes(objects)]),
];

export const APP_OBJECT_DIRECTORY: Readonly<Record<AppId, readonly string[]>> = {
  org: withPrimary('TenantBase.Organization', [MODULE_OBJECTS.organization, MODULE_OBJECTS.establishment]),
  job: withPrimary('TenantBase.JobPost', [
    MODULE_OBJECTS.jobLayer,
    MODULE_OBJECTS.jobGrade,
    MODULE_OBJECTS.jobLevelType,
    MODULE_OBJECTS.jobLevel,
    MODULE_OBJECTS.jobSequence,
    MODULE_OBJECTS.jobProfessionalLine,
    MODULE_OBJECTS.jobPost,
    MODULE_OBJECTS.jobPosition,
  ]),
  staff: withPrimary('TenantBase.Employee', [
    MODULE_OBJECTS.employee,
    ...PERSONNEL_OBJECTS.filter((object) => object.code !== PERSONNEL_REQUEST_OBJECT),
    MODULE_OBJECTS.contract,
    MODULE_OBJECTS.contractType,
    MODULE_OBJECTS.contractCompany,
    MODULE_OBJECTS.offer,
    MODULE_OBJECTS.offerBatchApproval,
  ]),
  transfer: withPrimary('TenantBase.EmploymentRecord', [
    MODULE_OBJECTS.employmentRecord,
    MODULE_OBJECTS.probationAssessment,
  ]),
  approval: codes(APPROVAL_OBJECTS),
  self: [PERSONNEL_REQUEST_OBJECT],
  manager: [],
  settings: codes([
    MODULE_OBJECTS.employmentSettings,
    MODULE_OBJECTS.employmentCustomField,
    MODULE_OBJECTS.contractSettings,
    MODULE_OBJECTS.contractRules,
  ]),
  talent: withPrimary('TalentCenter.DimensionLibrary', Object.values(TALENT_OBJECTS)),
  qualification: withPrimary('Qualification.EmploymentCategory', [
    ...Object.values(QUALIFICATION_OBJECTS),
    QUALIFICATION_PAGES,
  ]),
  evaluation: withPrimary('TEvaluation.EvaluationActivity', [
    ...Object.values(EVALUATION_OBJECTS),
    ...Object.values(EVALUATION_FLOW_OBJECTS),
  ]),
  survey360: withPrimary('Survey360.Activity', Object.values(SURVEY360_OBJECTS)),
  'talent-review': withPrimary('TalentReview.Project', Object.values(TALENT_REVIEW_OBJECTS)),
  succession: withPrimary('Succession.Map', Object.values(SUCCESSION_OBJECTS)),
  idp: withPrimary('IDP.IDPTemplate', Object.values(IDP_OBJECTS)),
};
