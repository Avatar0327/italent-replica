/**
 * 检测器的独立夹具：固定权限、用途、范围与内部角色，不 import 真实登记。
 * 只供正反例；真实登记由各文件的 gateEvidence / registration 单独校验（DEC-416③，#248 P2-1）。
 * 数字分别索引下方用途 / 范围 / 内部角色；-1 表示缺省；证据检查另用其专用夹具。
 */
import type { Evidence, Inner, Need, Obligation, Purpose, RequiredTable } from './required/types.js';
import type { RequiredSemantics } from './required.js';
import { checkEvidence, repoSource, syncedRegistry, type SourceReader } from './evidence.js';

const PURPOSES: readonly Purpose[] = [
  'disclosure:nestedSubsets',
  'guard:personnel.subsetPolicy',
  'when:contracts.importInitializeDelete',
  'disclosure:canApply',
  'disclosure:canViewReporting',
  'guard:approval.canOpen',
  'disclosure:canEdit',
  'disclosure:orgFields',
  'guard:talent.referenced(criterionCategory)',
  'guard:talent.referenced(dimension)',
  'disclosure:nestedDimension',
  'guard:survey360.unrestricted',
  'disclosure:allActivities',
  'guard:survey360.personVisible',
  'guard:survey360.personCreatable',
  'guard:survey360.activityScope',
  'guard:survey360.alsoObjects',
  'when:survey360.syncEmployees',
  'guard:idp.processReference',
  'when:idp.copyNestedWrites',
  'guard:idp.executor',
  'disclosure:responseView',
  'guard:ql.jobLinks(category)',
  'disclosure:conflictName',
  'guard:ql.childScope(target)',
  'guard:ql.childDeletes(targetGradeDescription)',
];

const NEEDS: readonly Need[] = [
  { scope: 'list', predicate: 'personnel.personScope' },
  { scope: 'none' },
  { scope: 'point', locator: 'talent.criterion.byId' },
  { scope: 'list', predicate: 'org.scope' },
  { scope: 'list', predicate: 'talent.ownedScope(talent_dimensions)' },
  { scope: 'guard', guard: 'talent.formScope(operation)' },
  { scope: 'list', predicate: 'survey360.personScope' },
  { scope: 'list', predicate: 'survey360.employeeScope' },
  { scope: 'point', locator: 'survey360.object.byId' },
  { scope: 'point', locator: 'idp.process.byId' },
  { scope: 'point', locator: 'idp.template.byId' },
  { scope: 'point', locator: 'idp.plan.byId' },
  { scope: 'list', predicate: 'idp.planScope' },
  { scope: 'list', predicate: 'ql.openRead(ql_categories)' },
];

const INNERS: readonly Inner[] = [
  { role: 'when', condition: 'qualification.newCategoryRef' },
  { role: 'when', condition: 'qualification.newLevelRef' },
  { role: 'or', group: 'canOpen', alt: 'adminTransfer' },
  { role: 'or', group: 'canOpen', alt: 'adminIntervene' },
  { role: 'when', condition: 'categoryChanged' },
  { role: 'when', condition: 'dimensions.newReference' },
  { role: 'or', group: 'unrestricted', alt: 'allActivities' },
  { role: 'or', group: 'personVisible', alt: 'allActivities' },
  { role: 'or', group: 'activityVisible', alt: 'allActivities' },
  { role: 'required' },
  { role: 'when', condition: 'import.notSync' },
  { role: 'or', group: 'executor', alt: 'hr' },
  { role: 'when', condition: 'jobLinkType=position' },
  { role: 'when', condition: 'jobLinkType=post' },
  { role: 'when', condition: 'jobLinkType=sequence' },
  { role: 'when', condition: 'jobLinkType=level_type' },
  { role: 'when', condition: 'scheme.leftovers' },
  { role: 'when', condition: 'childrenExist' },
];

const OBJECT_SET_1 = [
  'Awards Certificate Education EstimationResult Family Languageability',
  'ProfessionalTechnicalPostInfo ProjectExperience Punish Qualification Skill Training VocationalQualificationInfo',
  'jobhistory',
]
  .flatMap((names) => names.split(' ').map((name) => `TenantBase.${name}`))
  .join(',');
const OBJECT_SET_2 = [
  'TalentCenter.Category',
  'TalentCenter.Dimension',
  'TalentCenter.DimensionLibrary',
  'TalentCenter.TalentCriterion',
  'TalentCenter.TalentCriterionCategory',
].join(',');
const OBJECT_SET_3 = [...OBJECT_SET_2.split(','), 'TalentCenter.DescriptionType'].sort().join(',');

type Row = readonly [string, number?, number?, number?, string?];
const ROWS: readonly Row[] = [
  ['obj:TenantBase.EmployeeInformation:view'],
  ['obj:{mapper:personnel.nestedSubsets}:view', 0, 0],
  [`obj:${OBJECT_SET_1}:view`, -1, 0],
  ['guard:personnel.viewableFilters'],
  [`obj:${OBJECT_SET_1}:update`],
  [`btn:${OBJECT_SET_1}#update@detail`],
  ['guard:personnel.subsetPolicy'],
  ['obj:Qualification.EmploymentCategory:view', 1, -1, 0],
  ['obj:Qualification.EmploymentLevel:view', 1, -1, 1],
  ['btn:TenantBase.EmploymentContract#import@list'],
  ['obj:TenantBase.EmploymentContract:{create,update}'],
  ['guard:contracts.importScope'],
  ['guard:contracts.importInitializeDelete'],
  ['obj:TenantBase.EmploymentContract:delete', 2],
  ['obj:TenantBase.EmploymentRecord:view'],
  ['guard:transfer.managerIdentity'],
  ['btn:TenantBase.EmploymentRecord#Transfer.Manager@detail', 3, 1],
  ['btn:TenantBase.EmploymentRecord#Transfer.Hr@detail', 4, 1],
  ['btn:TenantBase.EmploymentRecord#Transfer.Hr@detail'],
  ['rel:approval.canOpen'],
  ['btn:TenantBase.ApprovalInstance#adminTransfer@detail', 5, -1, 2],
  ['btn:TenantBase.ApprovalInstance#adminIntervene@detail', 5, -1, 3],
  ['obj:TalentCenter.TalentCriterion:view'],
  ['obj:TalentCenter.TalentCriterion:update', 6, 2],
  ['btn:TalentCenter.TalentCriterion#update@detail', 6, 2],
  [`obj:${OBJECT_SET_2}:create`, -1, -1, -1, 'candidate:create'],
  ['obj:TalentCenter.TalentCriterion:update', -1, -1, -1, 'candidate:edit'],
  ['btn:TalentCenter.TalentCriterion#update@detail', -1, -1, -1, 'candidate:edit'],
  ['guard:talent.criterionDimensionsEditable', -1, -1, -1, 'candidate:edit'],
  ['guard:talent.queryObjectIsCriterion', -1, -1, -1, 'candidate:edit'],
  ['obj:TenantBase.Organization:view', 7, 3],
  ['obj:TalentCenter.TalentCriterion:update'],
  ['btn:TalentCenter.TalentCriterion#update@detail'],
  ['guard:talent.referenced(criterionCategory)'],
  ['obj:TalentCenter.TalentCriterionCategory:view', 8, -1, 4],
  ['guard:talent.referenced(dimension)'],
  ['obj:TalentCenter.Dimension:view', 9, -1, 5],
  ['guard:talent.copyCategoryName'],
  ['guard:talent.relationUnit'],
  ['obj:TalentCenter.Dimension:view', 10, 4],
  [`obj:${OBJECT_SET_3}:{create,update}`, -1, 5],
  [`btn:${OBJECT_SET_3}#{create@list,update@detail}`],
  ['guard:talent.formScope(operation)'],
  [`obj:${OBJECT_SET_3}:view`, -1, 1],
  ['obj:Survey360.Person:view', -1, 6],
  ['btn:Survey360.Person#sync@list'],
  ['guard:survey360.unrestricted'],
  ['obj:Survey360.Activity:view', 11, -1, 6],
  ['btn:Survey360.Activity#viewAll@list', 11, -1, 6],
  ['obj:TenantBase.EmployeeInformation:view', -1, 7],
  ['obj:Survey360.Person:view'],
  ['obj:Survey360.Activity:view', 12, 1],
  ['btn:Survey360.Activity#viewAll@list', 12, 1],
  ['guard:survey360.personVisible'],
  ['obj:Survey360.Activity:view', 13, -1, 7],
  ['btn:Survey360.Activity#viewAll@list', 13, -1, 7],
  ['obj:Survey360.Person:create'],
  ['btn:Survey360.Person#create@list'],
  ['guard:survey360.resourceGuard'],
  ['guard:survey360.personCreatable'],
  ['obj:Survey360.Activity:view', 14, -1, 6],
  ['btn:Survey360.Activity#viewAll@list', 14, -1, 6],
  ['guard:survey360.payloadRefs'],
  ['obj:Survey360.Activity:view'],
  ['guard:survey360.activityScope'],
  ['obj:Survey360.Activity:view', 15, -1, 8],
  ['btn:Survey360.Activity#viewAll@list', 15, -1, 8],
  ['obj:Survey360.Activity:delete'],
  ['btn:Survey360.Activity#delete@detail'],
  ['obj:Survey360.Relation:create', -1, 8],
  ['btn:Survey360.Relation#autoAdd@list'],
  ['guard:survey360.alsoObjects'],
  ['obj:Survey360.Person:create', 16, -1, 9],
  ['btn:Survey360.Person#create@list', 16, -1, 9],
  ['guard:survey360.preflight'],
  ['obj:Survey360.Relation:create'],
  ['btn:Survey360.Relation#import@list'],
  ['obj:Survey360.Person:update', 16, -1, 10],
  ['btn:Survey360.Person#update@detail', 16, -1, 10],
  ['guard:survey360.syncEmployees'],
  ['obj:TenantBase.EmployeeInformation:view', 17],
  ['obj:IDP.IDPProcess:delete', -1, 9],
  ['btn:IDP.IDPProcess#delete@detail'],
  ['guard:idp.publicDownReadonly'],
  ['obj:IDP.SubProcess:delete', -1, 1],
  ['obj:IDP.IDPProcess:view', -1, 1],
  ['obj:IDP.IDPProcess:create', -1, 1, -1, 'configure:create'],
  ['obj:IDP.IDPProcess:update', -1, 1, -1, 'configure:update'],
  ['obj:IDP.IDPTemplate:delete', -1, 10],
  ['btn:IDP.IDPTemplate#delete@detail'],
  ['obj:IDP.IDPTemplateModule:delete', -1, 1],
  ['obj:IDP.IDPTemplateCommonGoal:delete', -1, 1],
  ['obj:IDP.IDPTemplate:create', -1, 10],
  ['btn:IDP.IDPTemplate#copy@detail'],
  ['guard:idp.processReference'],
  ['obj:IDP.IDPProcess:view', 18, -1, 9],
  ['obj:IDP.IDPTemplate:view', -1, 1],
  ['obj:IDP.IDPTemplateModule:view', -1, 1],
  ['obj:IDP.IDPTemplateCommonGoal:view', -1, 1],
  ['guard:idp.copyNestedWrites'],
  ['obj:IDP.IDPTemplateModule:create', 19],
  ['obj:IDP.IDPTemplateCommonGoal:create', 19],
  ['obj:IDP.Idp:delete', -1, 11],
  ['btn:IDP.Idp#delete@detail'],
  ['obj:IDP.IdpGoal:delete', -1, 1],
  ['obj:IDP.Task:delete', -1, 1],
  ['obj:IDP.GoalReview:delete', -1, 1],
  ['obj:IDP.Analysis:delete', -1, 1],
  ['obj:IDP.Review:delete', -1, 1],
  ['rel:idp.executor'],
  ['obj:IDP.Idp:view', 20, -1, 11],
  ['obj:IDP.Idp:view', 21, 12],
  ['obj:IDP.Task:create', -1, 12],
  ['btn:IDP.Task#issue@list'],
  ['obj:IDP.Idp:view', -1, 1],
  ['obj:IDP.IdpGoal:view', -1, 1],
  ['obj:Qualification.EmploymentCategory:update'],
  ['btn:Qualification.EmploymentCategory#update@detail'],
  ['guard:ql.jobLinks(category)'],
  ['obj:TenantBase.Position:view', 22, -1, 12],
  ['obj:TenantBase.JobPost:view', 22, -1, 13],
  ['obj:TenantBase.JobSequence:view', 22, -1, 14],
  ['obj:TenantBase.JobLevelType:view', 22, -1, 15],
  ['obj:Qualification.EmploymentCategory:view', 23, 13],
  ['guard:ql.jobLinksDerived'],
  ['obj:Qualification.GradeScheme:delete'],
  ['btn:Qualification.GradeScheme#delete@detail'],
  ['guard:ql.childScope(target)'],
  ['obj:Qualification.Target:view', 24, -1, 16],
  ['guard:ql.childDeletes(targetGradeDescription)'],
  ['obj:Qualification.TargetGradeDescription:delete', 25, -1, 17],
];

const PERS = '/api/tenant/personnel';
const EMP = '/api/tenant/employment';
const APPROVAL = '/api/tenant/approval';
const TALENT = '/api/tenant/talent';
const S360 = '/api/tenant/survey360';
const IDP = '/api/tenant/idp';
const QL = '/api/tenant/qualification';
const CONTRACTS = '/api/tenant/contracts';
// 每种内部角色 / 披露 / 条件都用固定代表端点；真实全表的覆盖与变异检查仍在各测试里执行。
const ENDPOINTS: Readonly<Record<string, readonly number[]>> = {
  [`GET ${PERS}/employees/:id`]: [0, 1],
  [`GET ${PERS}/employees/:employeeId/subsets/:kind`]: [2, 3],
  [`PATCH ${PERS}/employees/:employeeId/subsets/:kind/:id`]: [4, 5, 6, 7, 8],
  [`POST ${CONTRACTS}/imports`]: [9, 10, 11, 12, 13],
  [`GET ${EMP}/transfers/manager`]: [14, 15, 16, 17],
  [`GET ${EMP}/transfers/manager/reporting`]: [14, 15, 18],
  [`GET ${APPROVAL}/instances/:id`]: [19, 20, 21],
  [`GET ${TALENT}/criteria/:id/model-image`]: [22, 23, 24],
  [`GET ${TALENT}/candidates/owner-orgs`]: [25, 26, 27, 28, 29, 30],
  [`PATCH ${TALENT}/criteria/:id`]: [31, 32, 33, 34, 35, 36, 37, 38, 39],
  [`GET ${TALENT}/forms/:object`]: [40, 41, 42, 43],
  [`GET ${S360}/people/sync-conflicts`]: [44, 45, 46, 47, 48, 49],
  [`GET ${S360}/people`]: [50, 51, 52],
  [`GET ${S360}/people/:id`]: [50, 53, 54, 55],
  [`POST ${S360}/people`]: [56, 57, 58, 59, 60, 61, 62],
  [`GET ${S360}/activities/:id`]: [63, 64, 65, 66],
  [`DELETE ${S360}/activities/:id`]: [67, 68, 58, 64, 65, 66],
  [`POST ${S360}/activities/:id/objects/:objectId/appraisers/auto`]: [69, 70, 58, 71, 72, 73, 74, 49, 64, 65, 66],
  [`POST ${S360}/activities/:id/appraisers/import`]: [75, 76, 58, 62, 71, 72, 73, 77, 78, 74, 79, 80, 64, 65, 66],
  [`DELETE ${IDP}/processes/:id`]: [81, 82, 83, 84],
  [`GET ${IDP}/approval-processes`]: [85, 86, 87],
  [`DELETE ${IDP}/templates/:id`]: [88, 89, 83, 90, 91],
  [`POST ${IDP}/templates/:id/copy`]: [92, 93, 94, 95, 96, 97, 98, 99, 100, 101],
  [`DELETE ${IDP}/plans/:id`]: [102, 103, 104, 105, 106, 107, 108],
  [`POST ${IDP}/plans/:id/goals`]: [109, 110, 111],
  [`POST ${IDP}/plans/tasks/issue`]: [112, 113, 114, 96, 97, 98, 115],
  [`PATCH ${QL}/categories/:id`]: [116, 117, 118, 119, 120, 121, 122, 123, 124],
  [`DELETE ${QL}/grade-schemes/:id`]: [125, 126, 127, 128, 129, 130],
};

const FIXTURE_FILE = 'apps/api/src/modules/fixture/detector-gate.ts';
const CALL: Evidence = { role: 'call', unit: `${FIXTURE_FILE}#gate`, anchor: 'return true' };
const HR_AT: readonly Evidence[] = [
  {
    role: 'call',
    unit: 'apps/api/src/modules/transfer/manager-routes.ts#route:GET /transfers/manager/reporting',
    anchor: "if (!(await managerHasHr(ctx, deps))) throw new AppError('FORBIDDEN', '需要人事身份')",
  },
  {
    role: 'impl',
    unit: 'apps/api/src/modules/transfer/manager-routes.ts#managerHasHr',
    anchor: "resource: buttonResource(EMPLOYMENT_OBJECT, 'Transfer.Hr', 'detail')",
  },
  {
    role: 'const',
    unit: 'apps/api/src/modules/employment/context.ts#EMPLOYMENT_OBJECT',
    anchor: "'TenantBase.EmploymentRecord'",
  },
];
function obligation([perm, purpose = -1, need = -1, inner = -1, or]: Row): Obligation {
  return {
    perm,
    purpose: PURPOSES[purpose],
    need: NEEDS[need],
    inner: INNERS[inner],
    or,
    at:
      perm === 'btn:TenantBase.EmploymentRecord#Transfer.Hr@detail' && purpose === -1
        ? HR_AT
        : NEEDS[need] && NEEDS[need]?.scope !== 'none'
          ? [CALL, { ...CALL, role: 'scope' }]
          : [CALL],
  };
}

export const DETECTOR_REQUIRED: RequiredTable = Object.fromEntries(
  Object.entries(ENDPOINTS).map(([key, ids]) => [key, ids.map((id) => obligation(ROWS[id]!))]),
);

export const DETECTOR_CONTRACT = { routes: {}, domains: {} };

/** 证据反例也有自己的完整原始图；不把真实全表的漂移混入夹具 oracle。 */
export function checkDetectorEvidence(table: RequiredTable, options: { readonly read?: SourceReader } = {}) {
  const original: SourceReader = (file) =>
    file === FIXTURE_FILE ? 'export function gate() { return true; }' : repoSource(file);
  const registry = syncedRegistry(table, original, false);
  const read: SourceReader = (file) => (file === FIXTURE_FILE ? original(file) : (options.read ?? repoSource)(file));
  return checkEvidence(table, { branch: false, registry, digests: registry.units, read });
}

const activity = ['obj:Survey360.Activity:view', 'btn:Survey360.Activity#viewAll@list'];
const unrestricted = {
  allActivities: activity,
  finePermissionOff: 'data:survey360.finePermissionOff' as const,
  personScopeAll: 'data:survey360.personScopeAll' as const,
};
export const DETECTOR_SEMANTICS: RequiredSemantics = {
  conditions: Object.fromEntries(INNERS.flatMap((o) => (o.role === 'when' ? [[o.condition, '独立夹具条件']] : []))),
  guardAlts: {
    'approval.canOpen': {
      group: 'canOpen',
      alts: {
        initiator: 'data:approval.initiator',
        participant: 'data:approval.participant',
        adminTransfer: ['btn:TenantBase.ApprovalInstance#adminTransfer@detail'],
        adminIntervene: ['btn:TenantBase.ApprovalInstance#adminIntervene@detail'],
      },
      at: [CALL],
    },
    'idp.executor': {
      group: 'executor',
      alts: { hr: ['obj:IDP.Idp:view'], participant: 'data:idp.planParticipant' },
      at: [CALL],
    },
    'survey360.activityScope': {
      group: 'activityVisible',
      alts: { allActivities: activity, ownerOrGranted: 'data:survey360.activityOwnerOrGrant' },
      at: [CALL],
    },
    'survey360.personVisible': {
      group: 'personVisible',
      alts: { ...unrestricted, personInScope: 'data:survey360.personInPeopleScope' },
      at: [CALL],
    },
    'survey360.unrestricted': { group: 'unrestricted', alts: unrestricted, at: [CALL] },
    'survey360.personCreatable': { group: 'unrestricted', alts: unrestricted, at: [CALL] },
  },
};
