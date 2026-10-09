/**
 * 职务体系路由的现状声明（F-039 PR-A；附录 A「/api/tenant/job」14 条：routes.ts 11 / sequence-routes.ts 3）。
 * 对象由 `:kind`（导入由 body.kind）经 JOB_OBJECT_CODES 决定；职位按所属组织范围，其余职务对象没有组织字段，只认看全部 /
 * 创建人（DEC-121）。路径 / 查询标识非法走 job/context.uuidParam 等 → 400 VALIDATION_FAILED。两个序列同步回执入口只认
 * 本人（recipientUserId），不查对象权限（own）。写入口经 job/context.runWrite：authorizeJobResult 在命令事务内（提交前）
 * 与返回后各复核一次，故 footprint 与 result 都登记 job.result。
 *
 * 与附录 A 的差异（按现状代码修正）：
 * 1. POST /:kind（非职位）：附录「see-all（创建人）」；代码 `visible(scope, orgId, msg)` 未传 creatorId（routes.ts:290），
 *    前置判定只有看全部通过，创建人规则只在返回后 job.result 里按 creatorOf 判断 → 登记 seeAll 不带 creatorLocator。
 * 2. GET /:kind 职位列表：附录「module.scopeSql(orgId)」；代码 scopeSql 同时带 org 与 creator 列（read-model.ts:150–156），
 *    谓词名沿用 module.scopeSql。
 * 3. GET /:kind：附录「其他」只记 kind 非法 400；代码还校验 orgId 查询参数（routes.ts:253）→ 登记 invalidId 400。
 * 4. PATCH /:kind/:id：附录 guards 只有 job.employmentPersonnel；代码 sequenceId 变化时 queueSequenceSync →
 *    authorizeSequenceTargets 按任职范围验权（write-service.ts:93–100）→ 另登记 job.employmentScope。
 * 5. POST /posts/sync-sequence：附录未标「命令前 + 事务内」；代码两类对象都是命令前 + 事务内 visibleJob
 *    （sequence-routes.ts:97–104）。
 * 6. PUT /settings：footprint 按 tenant-settings 范例写 config.audited:job_settings；代码审计动作 job.settings.update、
 *    objectType job_setting（settings.ts:101）。
 * 7. POST /validate-assignment：附录写足迹「—」；按简报每条 POST 都登记 write（全部 none：只读校验，不进台账）。
 * 附录未命名、本文件新起的登记名：job.requester（导入以请求人作创建人）、job.sequenceTask.byId、job.importRowOperation。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import {
  defineTable,
  type ObjectSelector,
  type RoutePolicy,
  type ScopePolicy,
  type Target,
} from '../../route-policy/index.js';
import {
  admin,
  BAD_REQUEST,
  button,
  guardScope,
  listScope,
  noButton,
  noFields,
  none,
  NOT_FOUND,
  object,
  own,
  pointScope,
  projector,
  seeAll,
  shape,
  write,
} from '../../route-policy/presets.js';
import { JOB_OBJECT_CODES } from '../permission/module-route-access.js';
import { JOB_KINDS } from './metadata.js';

const BASE = '/api/tenant/job';
const POSITION = MODULE_OBJECTS.jobPosition.code;
/** `visible / visibleJob / authorizeJobResult`：不存在与范围外同码同文案「职务体系对象不存在或已失效」，无 details.reason。 */
const NF_JOB = NOT_FOUND;
/** `job/context.uuidParam`、候选接口的 postId / levelId、列表的 orgId、序列任务 id 非法 → 400 VALIDATION_FAILED。 */
const byId = { invalidId: BAD_REQUEST };
/** `:kind` / body.kind 动态选择器：分支域 = JOB_KINDS 八种职务对象；kind 不在域内由 objectKind / zod 报 400。 */
const kindParam: ObjectSelector = { from: 'param', path: 'kind', map: JOB_OBJECT_CODES };
const kindBody: ObjectSelector = { from: 'body', path: 'kind', map: JOB_OBJECT_CODES };
const jobShape = shape('job.object');
const receiptProjector = projector('job.sequenceReceipt', 'job.sequenceReceipt');
/**
 * 回执行可见（visibleSequenceReceipts）：EmploymentRecord 查看权 + sequenceId / id 字段可见 + 任职范围，否则整行裁掉；
 * 只决定出口，不参与准入。
 */
const RECEIPT_VISIBILITY = {
  optional: {
    receiptRows: object({
      object: MODULE_OBJECTS.employmentRecord.code,
      operation: 'view',
      button: noButton('只判查看权'),
      scope: listScope('employment.scopeSql'),
      fields: noFields('只决定回执行是否可见'),
    }),
  },
};
const settingFields = noFields('职务体系配置值，无字段目录');
const viewOnly = noButton('列表 / 详情按对象查看权，无按钮');
const dataOperationOnly = noButton(
  '职务体系新增 / 编辑按数据操作开关授权（现状 objectContext create / update），无按钮',
);

/** 单对象范围按 kind 取定位器 job.<kind>.byId（visibleJob：职位看当前版本 orgId ∪ 创建人，其余只看创建人）。 */
function pointByKind(target: Target): { readonly byObject: Readonly<Record<string, ScopePolicy>> } {
  return {
    byObject: Object.fromEntries(
      Object.entries(JOB_OBJECT_CODES).map(([kind, code]) => [code, pointScope(target, `job.${kind}.byId`, NF_JOB)]),
    ),
  };
}

/** 职级 / 职等候选：看全部 ∪ 创建人（无则 200 空列表）；postId / levelId 引用在 assignmentReferences 内逐对象 view + visibleJob。 */
function candidates(objectCode: string): RoutePolicy {
  return object({
    object: objectCode,
    operation: 'view',
    button: viewOnly,
    scope: listScope('job.globalVisible'),
    fields: jobShape,
    guards: ['job.assignmentReferences'],
    ...byId,
  });
}

/**
 * 序列同步：view + syncSequence(list，目录 requires update)；requireNew（If-Match 0）；items[*].id 命令前与事务内各
 * visibleJob 一次；sequenceId 来自库，事务内逐项 writeFields（{ guard }）；任职目标按 job.employmentScope 验权；
 * 返回 202 { taskId, state } 信封。命令内 lockJobTenant 后逐项比对 revision（REVISION_CONFLICT 409，内联未具名）。
 */
function syncSequence(kind: 'posts' | 'positions'): RoutePolicy {
  return object({
    object: JOB_OBJECT_CODES[kind],
    operation: 'view',
    button: button('syncSequence', 'list'),
    scope: pointScope({ body: 'items[*].id' }, `job.${kind}.byId`, NF_JOB),
    fields: noFields('返回 { taskId, state } 任务信封，不是对象字段'),
    guards: ['job.employmentScope', 'employment.linkage'],
    rows: { path: 'items[*]', fields: { guard: 'job.sequenceSyncSources' }, target: { body: 'id' }, batch: 'atomic' },
    write: write({ guard: 'job.sequenceSyncSources' }, 'job.sequenceSyncSources', none('返回任务信封，无对象可复核'), {
      preconditions: ['job.lockJobTenant'],
    }),
  });
}

export const JOB_POLICIES = defineTable('job', {
  // ---- routes.ts registerSettings：职务体系设置（readContext admin.other_settings；租户配置无范围）------------------
  [`GET ${BASE}/settings`]: admin('other_settings', { fields: settingFields }),
  // DEC-133：先命中台账再按新规则校验；命令内 lockJobTenant 后比对 revision（内联，409）
  [`PUT ${BASE}/settings`]: admin('other_settings', {
    fields: settingFields,
    write: write(
      none('设置命令 DTO，无字段目录'),
      'config.audited:job_settings',
      none('配置对象无范围，返回后不复核'),
      {
        preconditions: ['job.lockJobTenant'],
      },
    ),
  }),
  // ---- registerCandidates：候选与任职校验（引用对象逐个授权，不能用自身看全部放行另一个对象）---------------------
  [`GET ${BASE}/candidates/levels`]: candidates(MODULE_OBJECTS.jobLevel.code),
  [`GET ${BASE}/candidates/grades`]: candidates(MODULE_OBJECTS.jobGrade.code),
  // 只读校验：JobPost view + validate(detail)；postId / levelId / gradeId 逐对象 view + visibleJob；信封不裁剪、不进台账
  [`POST ${BASE}/validate-assignment`]: object({
    object: MODULE_OBJECTS.jobPost.code,
    operation: 'view',
    button: button('validate', 'detail'),
    scope: guardScope('job.assignmentReferences', NF_JOB),
    fields: noFields('校验结果信封（valid / errors / warnings），不是对象字段'),
    write: write(none('只读校验，请求体是引用参数不是字段'), none('只读校验，不进台账'), none('只读校验，无返回对象')),
  }),
  // ---- registerImport：整批一条 runWrite 命令，逐行回执；withFailedImportLog 包住按钮 / 字段 / 范围 / 行校验失败 ------
  // 行守卫（guard）命令前经 authorizeJobImportRows、事务内经 authorizeRow 各跑一次：逐行 writeFields（去 objectId /
  // expectedRevision）+ visible（职位 rows[*].orgId；其余以请求人作创建人）+ 更新行再 visibleJob 既有对象。
  // 行操作：sourceCode 已有映射或传了 objectId → update，否则 create（映射与 objectId 不一致 → 回执 SOURCE_MAPPING_CONFLICT）。
  // kind 不在 JOB_KINDS 时任务 objectType 'job'、total 0，不记失败日志。
  [`POST ${BASE}/import`]: object({
    guards: ['employment.linkage', 'job.employmentScope'],
    object: kindBody,
    operation: 'view',
    button: button('import', 'list'),
    scope: {
      byObject: {
        [POSITION]: pointScope({ body: 'rows[*].orgId' }, 'org.id', NF_JOB),
        '*': seeAll(NF_JOB, { creatorLocator: 'job.requester' }),
      },
    },
    fields: shape('job.importReceipt'),
    rows: {
      path: 'rows[*]',
      operation: { from: 'mapper', mapper: 'job.importRowOperation', domain: ['create', 'update'] },
      fields: 'body',
      batch: 'receipt',
    },
    write: write({ rows: 'rows[*]' }, 'job.importRows', 'job.result', {
      controls: ['objectId', 'expectedRevision'],
      ledger: 'single',
      preconditions: ['job.lockJobTenant', 'job.assertUpdateRevisions'],
    }),
    failureAudit: {
      kind: 'import',
      rows: 'rows',
      objectType: { from: 'body', path: 'kind', map: Object.fromEntries(JOB_KINDS.map((kind) => [kind, kind])) },
      anchors: 'job.importAnchors',
    },
  }),
  // ---- sequence-routes.ts：序列同步回执（只认本人 recipientUserId；visibleSequenceReceipts 按任职范围与字段权裁剪）----
  [`GET ${BASE}/sequence-sync/messages`]: own({
    predicate: 'job.sequenceReceiptRecipient',
    fields: receiptProjector,
    ...RECEIPT_VISIBILITY,
  }),
  // outbox 任务按 id + 本人定位，不存在 → 404「任务不存在」
  [`GET ${BASE}/sequence-sync/tasks/:id`]: own({
    predicate: 'job.sequenceReceiptRecipient',
    target: { param: 'id' },
    locator: 'job.sequenceTask.byId',
    denied: NOT_FOUND,
    fields: receiptProjector,
    ...RECEIPT_VISIBILITY,
    ...byId,
  }),
  [`POST ${BASE}/posts/sync-sequence`]: syncSequence('posts'),
  [`POST ${BASE}/positions/sync-sequence`]: syncSequence('positions'),
  // ---- registerObjects / registerObjectWrites：八种职务对象的列表 / 详情 / 新增 / 变更 ------------------------------
  // 列表：职位 scopeSql(org ∪ creator)；其余看全部 ∪ 创建人；orgId 查询参数只适用于职位
  [`GET ${BASE}/:kind`]: object({
    object: kindParam,
    operation: 'view',
    button: viewOnly,
    scope: { byObject: { [POSITION]: listScope('module.scopeSql'), '*': listScope('job.globalVisible') } },
    fields: jobShape,
    ...byId,
  }),
  [`GET ${BASE}/:kind/:id`]: object({
    object: kindParam,
    operation: 'view',
    button: viewOnly,
    scope: pointByKind({ param: 'id' }),
    fields: jobShape,
    ...byId,
  }),
  // 新增：requireNew（If-Match 0）；职位 body.orgId 须在范围内，其余只有看全部通过（差异 1）
  [`POST ${BASE}/:kind`]: object({
    object: kindParam,
    operation: 'create',
    button: dataOperationOnly,
    scope: { byObject: { [POSITION]: pointScope({ body: 'orgId' }, 'org.id', NF_JOB), '*': seeAll(NF_JOB) } },
    fields: jobShape,
    write: write('body', 'job.result', 'job.result', { preconditions: ['job.assertRevision', 'job.lockJobTenant'] }),
  }),
  // 变更：命令前与事务内各一次 visibleJob（按 effectiveDate）+ body.orgId 范围；「调整员工直线经理」与「同步序列」是
  // 本次变更的选项不是字段；同步任职由人员端口 / 序列同步在事务内按任职对象另行验权；回执 managerSync 按任职范围裁剪
  [`PATCH ${BASE}/:kind/:id`]: object({
    object: kindParam,
    operation: 'update',
    button: dataOperationOnly,
    scope: pointByKind({ param: 'id' }),
    fields: projector('job.managerSyncReceipt', 'job.object'),
    guards: ['employment.linkage', 'job.orgIdInScope', 'job.employmentPersonnel', 'job.employmentScope'],
    write: write('body', 'job.result', 'job.result', {
      controls: ['adjustEmployeeDirectManager', 'syncSequenceToAssignments'],
      preconditions: ['job.lockJobTenant', 'job.lockObject', 'job.assertRevision', 'job.assertTemporalOrder'],
    }),
    ...byId,
  }),
});
