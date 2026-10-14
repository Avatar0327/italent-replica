/**
 * 组织（多维组织）模块路由的现状声明（F-039 PR-A；附录 A「/api/tenant/org」13 条 + DEC-303 补登的
 * POST …/organizations/:id/employment-preview，共 14 条；路由直接挂在租户路由器上，键用完整路径）。
 *
 * 组织按行政 / 业务 / 产品等维度各有上级（硬规则 5），数据范围判定统一落在组织 id 上：
 * - 列表：loadOrgSnapshot 在分页前用 `scopeSql(orgVersions.orgId, creatorSql)` 过滤（谓词 module.scopeSql，
 *   含 DEC-121 创建人规则）；
 * - 单点：`visible(scope, id, '组织不存在', creatorOf)`（定位器 org.byId）——范围外与不存在同为 404 NOT_FOUND；
 * - 写入：write() 的 checkResult 在命令事务内与 runCommand 返回后各跑一次 `authorizeOrgResult`（org.result：新增按
 *   现行上级，其余按组织 id；addEmployment 分支先经 authorizeOrgEmploymentReplay 复核联动足迹），再经
 *   trimModuleResponse 按 Organization 查看权裁剪响应（形状 org.organization）；
 * - 功能权限：context() → objectContext(view / create / update / delete) 先判数据操作开关（403 FORBIDDEN），
 *   settings 两条走 requirePermission('admin.other_settings')；按钮经 button()；字段经 writeFields →
 *   requireObjectWrite（顶层键 − expectedRevision / confirmed / reservationId）；
 * - 标识：`orgId(c)` 非 UUID → 400 VALIDATION_FAILED；写路由先读 If-Match（revision()，缺失 400 REVISION_REQUIRED），
 *   新建类再 requireNew（If-Match ≠ 0 → 409 REVISION_CONFLICT）。
 *
 * 与附录 A 的差异（按现状代码修正，DEC-297④ / DEC-303）：
 * 1. POST …/organizations/:id/employment-preview：附录漏列。代码为 object update + update@detail 按钮 + 字段编辑权 +
 *    point param id（authorizeOrgResult(created=false) ≡ org.byId）；只读预检不进命令，固定键 hasPendingEmployment
 *    （routes.ts:523–550）。
 * 2. PATCH …/organizations/:id：附录「无按钮」→ 代码校验 update@detail 按钮（routes.ts:554，S1-P2-03）。附录范围列的
 *    第二个目标 body.parents.*.parentId（visibleParents，routes.ts:568）登记为 guards org.visibleParents（ScopePolicy
 *    只有一个 point 目标）；addEmployment 分支 authorizeOrgEmploymentReplay → requireLinkedEmploymentRecord
 *    （DEC-178，LINKED_RECORD_OUT_OF_SCOPE，routes.ts:435）登记 guards employment.linkage（§3.2）。
 * 3. POST / DELETE …/code-reservations：附录 footprint org.seeAllCommand（事务内再查 scope.all）→ 代码事务内无范围复核：
 *    看全部只在命令前 visible(scope, undefined) 判一次（routes.ts:231 / :238），write() 对该路径不解析范围、checkResult
 *    空转（routes.ts:424–426）；§10.3 的 org.seeAllCommand 是接管守卫，按现状登记 none；404 文案是 visible 的默认
 *    「对象不存在」。附录 fields none → 代码经 trimModuleResponse 按 Organization 查看权裁剪 id / code / status /
 *    revision（write() trim 默认 true，routes.ts:464），登记 shape org.codeReservation。
 * 4. PUT …/settings：附录 config.audited([org_settings]) → 审计 objectType 实为 org_setting（settings.ts:41；
 *    §10.3 P2-4 残留①）。
 * 5. POST …/import：附录 batch receipt → 任一行冲突 / 出错整批回滚（import-service.ts:79、:87），results 只是成功行回执，
 *    登记 atomic；行字段附录「去 orgId、expectedRevision」→ 代码还去 addEmployment（routes.ts:364）；addEmployment 行
 *    的联动复核同样登记 guards employment.linkage。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { defineTable, type Target } from '../../route-policy/index.js';
import {
  admin,
  BAD_REQUEST,
  button,
  configWrite,
  exception,
  fixed,
  listScope,
  noButton,
  noFields,
  none,
  noScope,
  NOT_FOUND,
  object,
  pointScope,
  seeAll,
  shape,
  write,
} from '../../route-policy/presets.js';

const BASE = '/api/tenant/org';
/** TenantBase.Organization（packages/domain/src/permission/module-actions.ts）。 */
const ORG = MODULE_OBJECTS.organization.code;
/** `orgId(c)`：路径 :id 非 UUID → 400 VALIDATION_FAILED「组织标识必须为 UUID」（范围判断之前先规范化）。 */
const byId = { invalidId: BAD_REQUEST };
/** displayOrganization 记录的出口：trimModuleResponse 按 Organization 查看权保留键（系统字段同在目录内）。 */
const organization = shape('org.organization');
/** `visible(scope, target, '组织不存在', hasCreatorScope ? creatorOf('org.create') : undefined)`：范围外 = 不存在。 */
const orgPoint = (target: Target) => pointScope(target, 'org.byId', NOT_FOUND);
/** writeFields 内置剔除的控制键（module-route-access.ts:47）；creation 结构体另允许 confirmed / reservationId。 */
const CREATE_CONTROLS = ['expectedRevision', 'confirmed', 'reservationId'];
/** 变更 / 在途预检先剥掉 addEmployment（DEC-137 选择项，不是字段）再 writeFields（routes.ts:529 / :557）。 */
const UPDATE_CONTROLS = ['addEmployment'];
/** 导入行剥掉 orgId / expectedRevision / addEmployment 后逐行 writeFields（routes.ts:364）。 */
const IMPORT_CONTROLS = ['orgId', 'expectedRevision', 'addEmployment'];
const settingFields = noFields('组织设置（enabledDimensions / fullNameStartLevel / revision）是租户配置值，无字段目录');
/**
 * 编码预占 / 释放的出口 { id, code, (status), revision }：write() trim 默认 true，经 trimModuleResponse 按 Organization
 * 查看权裁剪（id / status / revision 是目录系统字段，code 是业务字段）。
 */
const reservation = shape('org.codeReservation');
/** 预占 / 释放只认看全部：visible(scope, undefined) 没有组织 id 与创建人可比对，非 scope.all 一律 404「对象不存在」。 */
const seeAllOnly = seeAll(NOT_FOUND);
const noReservationFootprint = none(
  '事务内无范围复核：看全部判定在命令前，write() 对 code-reservations 路径不解析范围',
);
const noReservationResult = none('预占对象无组织归属，返回后不复核，只按 Organization 查看权裁剪');

export const ORG_POLICIES = defineTable('org', {
  // ---- registerQueries：组织列表 / 详情 / 设置 / 视图目录 ----------------------------------------------------------
  // 页面 / 数据源编码 TenantBase.Organization.list；维度未启用 → 200 空列表；hasDataPermission 是协议键
  [`GET ${BASE}/organizations`]: object({
    object: ORG,
    operation: 'view',
    button: noButton('列表只按对象查看权（objectContext view），无按钮'),
    scope: listScope('module.scopeSql'),
    fields: organization,
  }),
  // 页面 / 数据源编码 TenantBase.Organization.detail；asOf 非法 400；ETag = revision
  [`GET ${BASE}/organizations/:id`]: object({
    ...byId,
    object: ORG,
    operation: 'view',
    button: noButton('详情只按对象查看权，无按钮'),
    scope: orgPoint({ param: 'id' }),
    fields: organization,
  }),
  [`GET ${BASE}/settings`]: admin('other_settings', { fields: settingFields }),
  // 静态四视图目录（Q-M0-09 待接入界面）：items 仍经 trimModuleResponse 按 Organization 查看权裁剪
  // （resource / dimension 是目录系统字段，label 不在目录内——现状）
  [`GET ${BASE}/views`]: object({
    object: ORG,
    operation: 'view',
    button: noButton('静态目录，无按钮'),
    scope: noScope('静态四视图目录，不读组织数据，不查数据范围'),
    fields: shape('org.views'),
  }),
  // DEC-135：不经 objectContext，只要 object.create / update 对 personInChargeId / hrbpId / shopOwnerId 任一字段可写
  // （anyPersonFieldEditable，否则 403）；全租户生效日在职内部员工，不按操作人范围过滤；asOf / keyword / page 非法 400
  [`GET ${BASE}/person-candidates`]: exception(
    'org.anyPersonFieldEditable',
    'DEC-135',
    fixed(['id', 'name', 'code', 'departmentId', 'departmentName'], 'DEC-135 / DEC-057（OrgPersonCandidate）'),
  ),
  // ---- registerReservations：编码预占（REQ-ORG-002）--------------------------------------------------------------
  // requireNew（If-Match 必须为 0）；请求体 strictObject({})，writeFields 以空集合调 requireObjectWrite(create)；
  // reserveCode 只写预占行 + org_code_reservation 审计
  [`POST ${BASE}/code-reservations`]: object({
    object: ORG,
    operation: 'create',
    button: button('reserve', 'list'),
    scope: seeAllOnly,
    fields: reservation,
    write: write('body', noReservationFootprint, noReservationResult),
  }),
  // releaseCode 命令内 ownedReservation：预占行加锁且 userId 须为本人，否则 404「编码预占不存在」；
  // revision 不等 → 409 REVISION_CONFLICT、非 held → 409 CONFLICT（内联比对，没有单独函数名）
  [`DELETE ${BASE}/code-reservations/:id`]: object({
    ...byId,
    object: ORG,
    operation: 'delete',
    button: button('release', 'detail'),
    scope: seeAllOnly,
    fields: reservation,
    write: write(none('释放不读请求体，只按路径 id'), noReservationFootprint, noReservationResult, {
      preconditions: ['ownedReservation'],
    }),
  }),
  // ---- registerWrites：预检 / 新增 / 设置 ---------------------------------------------------------------------
  // AC-ORG-04 只读预检：字段编辑权（writeFields create）先于按钮校验；不开命令事务；validateOrganization 不初始化根、
  // 不预占编码；响应是 valid / errors / warnings / canSubmit / requiresConfirmation / isBeyondEstablishment 信封 + fields
  [`POST ${BASE}/validate`]: object({
    guards: ['org.visibleParents'],
    object: ORG,
    operation: 'create',
    button: button('validate', 'detail'),
    scope: orgPoint({ body: 'parents.*.parentId' }),
    fields: shape('module.validation'),
    write: write(
      'body',
      none('只读校验，不进命令 / 台账'),
      none('只读校验，无返回对象，响应按 Organization 查看权裁剪'),
      {
        controls: CREATE_CONTROLS,
      },
    ),
  }),
  // requireNew；各维度上级都须在范围内（visibleParents）；命令内 assertRevision(0)、assertCanSubmit（超编确认 409）、
  // consumeCode（预占须本人持有且未过期 → 404 / 409，直填编码查 CODE_CONFLICT）；201 + ETag
  [`POST ${BASE}/organizations`]: object({
    guards: ['org.visibleParents'],
    object: ORG,
    operation: 'create',
    button: noButton('新增按数据操作开关授权（objectContext create），无按钮'),
    scope: orgPoint({ body: 'parents.*.parentId' }),
    fields: organization,
    write: write('body', 'org.result', 'org.result', {
      controls: CREATE_CONTROLS,
      preconditions: ['assertRevision', 'assertCanSubmit', 'consumeCode'],
    }),
  }),
  // If-Match 必填（REVISION_REQUIRED）；writeOrgSettings 命令内内联比对 revision → 409 REVISION_CONFLICT；
  // 审计 org.settings.update（objectType org_setting）；write() trim=false，响应不裁剪
  [`PUT ${BASE}/settings`]: admin('other_settings', {
    fields: settingFields,
    write: configWrite('config.audited:org_setting'),
  }),
  // ---- registerUpdate / registerEmploymentPreview / registerCorrection：变更 / 在途预检 / 更正 -------------------
  // DEC-080 / S1-P2-03：数据操作 update 与 update@detail 按钮独立判定；org.result 事务内含 DEC-129 级联停用每个下级的
  // authorizeOrgResult（authorizeCascade）与 addEmployment 分支的 authorizeOrgEmploymentReplay；命令内 F-008 先锁联动员工
  [`PATCH ${BASE}/organizations/:id`]: object({
    ...byId,
    object: ORG,
    operation: 'update',
    button: button('update', 'detail'),
    scope: orgPoint({ param: 'id' }),
    fields: organization,
    guards: ['org.visibleParents', 'employment.linkage'],
    write: write('body', 'org.result', 'org.result', {
      controls: UPDATE_CONTROLS,
      preconditions: [
        'lockOrgEmploymentTargets',
        'assertRevision',
        'rejectEarlierThanFutureVersion',
        'assertEstablishedOnUnchanged',
        'validateEmploymentChoice',
        'planDeactivation',
      ],
    }),
  }),
  // 附录 A 漏列（DEC-303）。与变更同样的对象 / 按钮 / 字段 / 范围授权，不读 If-Match、不开命令事务；
  // hasPendingOrgEmployment 按操作人对 EmploymentRecord 的当前范围（employmentVisibilitySql）只回答是否存在，不泄露记录
  [`POST ${BASE}/organizations/:id/employment-preview`]: object({
    ...byId,
    object: ORG,
    operation: 'update',
    button: button('update', 'detail'),
    scope: orgPoint({ param: 'id' }),
    fields: fixed(['hasPendingEmployment'], 'DEC-137（employment-linkage.ts hasPendingOrgEmployment：只返回布尔）'),
    // 不进命令 / 台账；预检事务内仍按 authorizeOrgResult（created = false，即 org.byId 范围）复核目标组织
    write: write('body', 'org.result', none('只读预检，无返回对象（单个布尔）'), {
      controls: UPDATE_CONTROLS,
      preconditions: ['validateEmploymentChoice'],
    }),
  }),
  // DEC-147「编辑」：只收 establishedOn；权限按 update 数据操作开关 + 字段编辑权，现状不校验 update@detail 按钮；
  // 命令内 assertRevision、planEstablishedOnCorrection（两条拦截 → 400）；不产生新版本
  [`PATCH ${BASE}/organizations/:id/correction`]: object({
    ...byId,
    object: ORG,
    operation: 'update',
    button: noButton('DEC-147 更正只按 update 数据操作开关与字段编辑权授权，现状未校验按钮'),
    scope: orgPoint({ param: 'id' }),
    fields: organization,
    write: write('body', 'org.result', 'org.result', {
      preconditions: ['assertRevision', 'planEstablishedOnCorrection'],
    }),
  }),
  // ---- registerOrgImport：组织导入（DEC-060 / DEC-199 / DEC-207）------------------------------------------------
  // 任务构造在 body 校验之前（rawImportRows），按钮 / 字段 / 范围 / 行数（1–100）失败都在 withFailedImportLog 包内；
  // 逐行 operation 由 sourceCode 映射 ?? row.orgId 决定（有目标且非同命令重放 created → update，否则 create）；
  // 命令前只读事务 authorizeOrgImportRows 与命令内 importOrganizations 的 authorizeRow 各跑一遍逐行 guard
  // （事务内 writeFields + 上级 visible + 已映射目标 authorizeOrgResult）；rows.fields 'body' = 行顶层键 − controls；
  // 一条外层 runCommand；行内 createOrganization / updateOrganization 的前提同单条路由
  [`POST ${BASE}/import`]: object({
    object: ORG,
    operation: 'view',
    button: button('import', 'list'),
    scope: orgPoint({ body: 'rows[*].parentId' }),
    fields: shape('org.importReceipt'),
    guards: ['employment.linkage'],
    rows: {
      path: 'rows[*]',
      operation: { from: 'mapper', mapper: 'org.importRowOperation', domain: ['create', 'update'] },
      fields: 'body',
      target: { body: 'rows[*].parentId' },
      batch: 'atomic',
    },
    write: write({ rows: 'rows[*]' }, 'org.importRows', 'org.result', {
      controls: IMPORT_CONTROLS,
      preconditions: ['planImportEmployment', 'assertRequiredRevisions', 'preflightConflict'],
      ledger: 'single',
    }),
    failureAudit: { kind: 'import', rows: 'rows', objectType: 'organization', anchors: 'org.importAnchors' },
  }),
});
