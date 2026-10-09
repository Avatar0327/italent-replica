/**
 * 编制路由的现状声明（F-039 PR-A；附录 A「/api/tenant/establishment」16 条）。对象统一为 OrganizationEstablishment：
 * 组织编制（capacities）按所属组织范围 ∪ 创建人；编制方案没有组织字段，只认看全部 / 创建人，且看全部另按数据集
 * ESTABLISHMENT_SCHEME_DATASOURCE 授予（DEC-121，scope.view）；复制任务按其每个源编制的组织范围（或任务创建人）判定。
 * 写入口共用 job/context.runWrite：命令事务内有 capacityContext.authorizeCapacity（含联动上级 / 补期 / 复制新对象的
 * visible + writeFields）与路由内 checkScheme / checkCapacity / visibleCapacity / visibleCopyJob 的二次复核；
 * authorizeEstablishmentReplay 在 runCommand 之前按同一命令号已落的 establishment-capacity 审计足迹重验（重放也不能
 * 越过当前范围与字段权），附录统一登记为 establishment.replay（见差异 4）。
 *
 * 与附录 A 的差异（按现状代码修正）：
 * 1. POST /copy-jobs：附录 denied「复制任务不存在」；代码逐个源编制走 visibleCapacity，不存在与范围外都报
 *    404「编制在该时点不存在」（routes.ts:304、381–392）。
 * 2. POST /schemes、/capacities、/copy-jobs：附录「requireNew」；代码路由层不调 requireNew，If-Match 须为 0 由命令内
 *    assertRevision(expected, 0) 判定（schemes.ts:221、capacity-service.ts:163、copy-service.ts:103）→ 登记 preconditions。
 * 3. GET /capacities：附录「其他」为空；代码 orgId / schemeId 查询参数非 UUID → 400（routes.ts:219–220、375–379）
 *    → 登记 invalidId。
 * 4. establishment.replay 只复核 establishment-capacity 足迹，且在命令之前的独立事务里执行（job/context.ts:44–56）：
 *    方案与复制任务入队的写入口虽调用但没有可复核事件；首次执行返回后没有再复核。登记名沿用附录，此处说明实际位置。
 * 5. PUT /settings：footprint 按 tenant-settings 范例写 config.audited:establishment_settings；代码审计动作
 *    establishment.settings.update、objectType establishment-settings（settings.ts:61–69）。
 * 附录未命名、本文件新起的登记名：establishment.requester（新建方案以请求人作创建人）、establishment.orgIdInScope
 * （PATCH capacities 的 body.orgId 范围校验，仿 §2.2 的 job.orgIdInScope）、形状 establishment.copyReportCsv。
 */
import { ESTABLISHMENT_SCHEME_DATASOURCE, MODULE_OBJECTS } from '@italent/domain';
import { defineTable, type FieldsFrom } from '../../route-policy/index.js';
import {
  admin,
  all,
  BAD_REQUEST,
  button,
  commandWrite,
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

const BASE = '/api/tenant/establishment';
const OBJECT = MODULE_OBJECTS.establishment.code;
/** 编制方案的看全部数据集（requestScope 的 view 参数；DEC-121 / PR #60 P2-7）。 */
const SCHEME_VIEW = ESTABLISHMENT_SCHEME_DATASOURCE;
/** 三类 404 都是 `visible / readCapacity / readCopyJob` 的 NOT_FOUND，无 details.reason，文案见各常量注释。 */
const NF_SCHEME = NOT_FOUND; // 「编制方案在该时点不存在」
const NF_CAPACITY = NOT_FOUND; // 「编制在该时点不存在」
const NF_COPY = NOT_FOUND; // 「复制任务不存在」
/** `job/context.uuidParam`（路径 id）、`queryUuid`（orgId / schemeId 查询参数）非法 → 400 VALIDATION_FAILED。 */
const byId = { invalidId: BAD_REQUEST };
const schemeShape = shape('establishment.scheme');
const capacityShape = shape('establishment.capacity');
/** `trimCapacities`：顶层键与 subdivisions[*] 子键都按查看权裁剪。 */
const capacityProjector = projector('establishment.capacities', 'establishment.capacity');
const copyJobShape = shape('establishment.copyJob');
const noticeShape = shape('establishment.notification');
const settingFields = noFields('占用时机配置值，无字段目录');
const viewOnly = noButton('按对象查看权，无按钮');
const dataOperationOnly = noButton('按数据操作开关授权（现状 objectContext create / update），无按钮');
const schemeById = pointScope({ param: 'id' }, 'establishment.scheme.byId', NF_SCHEME, SCHEME_VIEW);
const capacityById = pointScope({ param: 'id' }, 'establishment.capacity.byId', NF_CAPACITY);
/** `visibleCopyJob`：任务不存在 → 404「复制任务不存在」；每个源编制 orgId 须在范围内（或任务创建人命中创建人规则）。 */
const copyJobScope = guardScope('establishment.visibleCopyJob', NF_COPY);
/** 命令内前提的现状顺序：新建先 assertRevision(0) 再锁；更新 / 删除 / 执行先锁再比对 revision。 */
const NEW_THEN_LOCK = ['establishment.assertRevision', 'establishment.lockEstablishment'];
const LOCK_THEN_REVISION = ['establishment.lockEstablishment', 'establishment.assertRevision'];
const replayWrite = (fields: FieldsFrom, preconditions: readonly string[]) =>
  write(fields, 'establishment.replay', 'establishment.replay', { preconditions });

export const ESTABLISHMENT_POLICIES = defineTable('establishment', {
  // ---- registerSchemes / registerSchemeWrites：编制方案（无组织字段，看全部按数据集 SCHEME_VIEW 授予）---------------
  [`GET ${BASE}/schemes`]: object({
    object: OBJECT,
    operation: 'view',
    button: viewOnly,
    scope: listScope('module.scopeSql', SCHEME_VIEW),
    fields: schemeShape,
  }),
  [`GET ${BASE}/schemes/:id`]: object({
    object: OBJECT,
    operation: 'view',
    button: viewOnly,
    scope: schemeById,
    fields: schemeShape,
    ...byId,
  }),
  // 新建：看全部或创建人规则命中请求人（visible 传 ctx.userId）；If-Match 0 由命令内 assertRevision 判定（差异 2）
  [`POST ${BASE}/schemes`]: object({
    object: OBJECT,
    operation: 'create',
    button: dataOperationOnly,
    scope: seeAll(NF_SCHEME, { view: SCHEME_VIEW, creatorLocator: 'establishment.requester' }),
    fields: schemeShape,
    write: replayWrite('body', NEW_THEN_LOCK),
  }),
  // 变更 / 删除：checkScheme 命令前与事务内各一次（存在性 + 创建人范围）
  [`PATCH ${BASE}/schemes/:id`]: object({
    object: OBJECT,
    operation: 'update',
    button: dataOperationOnly,
    scope: schemeById,
    fields: schemeShape,
    write: replayWrite('body', LOCK_THEN_REVISION),
    ...byId,
  }),
  [`DELETE ${BASE}/schemes/:id`]: object({
    object: OBJECT,
    operation: 'delete',
    button: button('delete', 'detail'),
    scope: schemeById,
    fields: schemeShape,
    write: replayWrite(none('删除无请求体，不提取字段'), LOCK_THEN_REVISION),
    ...byId,
  }),
  // ---- registerCapacities：组织编制（scopeSql(org ∪ creator)；写字段含 subdivisions[*] 展开）------------------------
  [`GET ${BASE}/capacities`]: object({
    object: OBJECT,
    operation: 'view',
    button: viewOnly,
    scope: listScope('module.scopeSql'),
    fields: capacityProjector,
    ...byId,
  }),
  [`GET ${BASE}/capacities/:id`]: object({
    object: OBJECT,
    operation: 'view',
    button: viewOnly,
    scope: capacityById,
    fields: capacityProjector,
    ...byId,
  }),
  // 新建：body.orgId 须在范围内；事务内 authorizeCapacity 对本编制与联动上级 / 补期逐个 visible + writeFields
  [`POST ${BASE}/capacities`]: object({
    object: OBJECT,
    operation: 'create',
    button: dataOperationOnly,
    scope: pointScope({ body: 'orgId' }, 'org.id', NF_CAPACITY),
    fields: capacityShape,
    write: replayWrite('body+subdivisions', NEW_THEN_LOCK),
  }),
  // 变更：checkCapacity 命令前与事务内各一次；body.orgId 只在事务内校验（establishment.orgIdInScope）
  [`PATCH ${BASE}/capacities/:id`]: object({
    object: OBJECT,
    operation: 'update',
    button: dataOperationOnly,
    scope: capacityById,
    fields: capacityShape,
    guards: ['establishment.orgIdInScope'],
    write: replayWrite('body+subdivisions', LOCK_THEN_REVISION),
    ...byId,
  }),
  // ---- registerTiming：占用时机设置（readContext admin.other_settings；租户配置无范围）--------------------------------
  [`GET ${BASE}/settings`]: admin('other_settings', { fields: settingFields }),
  [`PUT ${BASE}/settings`]: admin('other_settings', {
    fields: settingFields,
    write: write(
      none('占用时机设置 DTO，无字段目录'),
      'config.audited:establishment_settings',
      none('配置对象无范围'),
      {
        preconditions: LOCK_THEN_REVISION,
      },
    ),
  }),
  // ---- registerCopyJobs：下期编制复制（AC-EST-06；入队与执行两步，执行时 replay 以 copyExecution=true 校验新对象）-----
  // 入队：每个源编制命令前与事务内各 visibleCapacity 一次（差异 1）；If-Match 0 由命令内 assertRevision 判定
  [`POST ${BASE}/copy-jobs`]: object({
    object: OBJECT,
    operation: 'create',
    button: button('copy', 'list'),
    scope: guardScope('establishment.copyJobSources', NF_CAPACITY),
    fields: copyJobShape,
    write: replayWrite('body', NEW_THEN_LOCK),
  }),
  [`GET ${BASE}/copy-jobs/:id`]: object({
    object: OBJECT,
    operation: 'view',
    button: viewOnly,
    scope: copyJobScope,
    fields: copyJobShape,
    ...byId,
  }),
  // 执行：body 须为 {}（writeFields 空集合）；visibleCopyJob 命令前与事务内各一次；复制出的编制逐个过 authorizeCapacity
  [`POST ${BASE}/copy-jobs/:id/execute`]: object({
    object: OBJECT,
    operation: 'update',
    button: button('execute', 'detail'),
    scope: copyJobScope,
    fields: copyJobShape,
    write: commandWrite('establishment.replay', 'establishment.replay', { preconditions: LOCK_THEN_REVISION }),
    ...byId,
  }),
  // 明细下载：text/csv，列 capacityIds / status / failureReason 经查看权过滤；pending → 409 CONFLICT；超 15 天 → 404
  [`GET ${BASE}/copy-jobs/:id/report`]: object({
    object: OBJECT,
    operation: 'view',
    button: button('report', 'detail'),
    scope: copyJobScope,
    fields: projector('establishment.copyReportCsv', 'establishment.copyReportCsv', 'text/csv'),
    ...byId,
  }),
  // 通知：收件人 = 本人 AND 所涉复制任务的全部源编制 / 占编调动的来源与目标组织都在范围内（scopeSql 只带 org 列）
  [`GET ${BASE}/notifications`]: all(
    [
      own({ predicate: 'establishment.notificationRecipient', fields: noticeShape }),
      object({
        object: OBJECT,
        operation: 'view',
        button: viewOnly,
        scope: listScope('module.scopeSql'),
        fields: noticeShape,
      }),
    ],
    noticeShape,
  ),
});
