/**
 * 人员信息与子集路由的现状声明（F-039 PR-A；附录 A「/api/tenant/personnel」18 条：routes 6 / subset-routes 7 /
 * request-routes 2 / order-code-routes 3）。
 *
 * 现状链路（access.ts / http.ts）：`access` 做功能权（create / update 走 requireObjectWrite，字段 = 载荷顶层键）、按钮、
 * 页面范围解析（view 按 `<对象>.list / .detail`，create 把 using_user 维度换成管理范围 personnelCreationScope）；
 * `preflight → requirePerson` 用 `personScope` 做人员点校验（404「人员不存在」）；`write()` 在事务内再做
 * requirePerson + authorizeTx（足迹 personnel.write），返回后再 requirePerson（generic → personnel.employee），
 * 出口按对象查看权 `trim / trimWithFields / trimSubset` 裁剪。
 *
 * 与附录 A 的差异（按现状代码修正）：
 * 1. 子集 `:kind`（及 change-requests 的 body.subset）不在 SUBSETS → `validation.subsetKind` 抛 404 NOT_FOUND
 *    「人员子集不存在」，附录 A 写 400；PR-A 的 Selector 不表达选择器落空码，`invalidId` 只登记 uuidParam 的 400。
 * 2. 两条子集列表路由同样调用 `lists.listOptions`（按不可见字段排序 / 筛选 → 403），附录 A 只在 GET /employees
 *    登记守卫 personnel.viewableFilters，这里三条列表都登记。
 * 3. `GET …/subsets/:kind/:id` 用 `trim`（只按子集对象查看权裁剪；`loadSubset` 不带员工属性列），不是 `trimSubset`，
 *    登记 shape personnel.subset 而非 projector。
 * 4. `POST /change-requests` 的响应 `c.json(result.body, 201)` 不经任何裁剪（含 values / tenantId / commandId），
 *    附录 A 写 shape personnel.changeRequest，登记 noFields。
 * 5. 子集 / 附件写路由返回后复核（`write()` 的 requirePerson）的目标是路径 `employeeId`，附录 A 写 id；
 *    `result.generic.targets` 据此登记（PATCH /employees/:id 的目标才是 id）。
 * 6. 按员工的子集列表既有列表谓词又有 employeeId 点校验，单个 ObjectPolicy 放不下，用 all([列表分支, 点校验分支])
 *    表达（附录 A 类型列写 object）；`write.fields` 没有 body.values 形式，变更申请用 { guard } 登记。
 */
import { PERSONNEL_OBJECT, PERSONNEL_REQUEST_OBJECT, SUBSETS } from '@italent/domain';
import {
  defineTable,
  type FieldsFrom,
  type ObjectSelector,
  type RoutePolicy,
  type ScopePolicy,
  type WritePolicy,
} from '../../route-policy/index.js';
import {
  admin,
  all,
  BAD_REQUEST,
  button,
  listScope,
  noButton,
  noFields,
  none,
  noScope,
  NOT_FOUND,
  object,
  pointScope,
  projector,
  self,
  shape,
  write,
} from '../../route-policy/presets.js';

const BASE = '/api/tenant/personnel';
const EMPLOYEES = `${BASE}/employees`;
const SUBSET = `${EMPLOYEES}/:employeeId/subsets/:kind`;
const REQUESTS = `${BASE}/change-requests`;
const ORDER_CODE = `${BASE}/order-code`;

/** `job/context.uuidParam`：路径标识非 UUID → 400 VALIDATION_FAILED「对象标识必须为 UUID」。 */
const byUuid = { invalidId: BAD_REQUEST };
/** 子集对象由 `:kind` 决定（SUBSETS[kind].objectCode）；分支清单 = SUBSETS 全部键。 */
const SUBSET_OBJECT: ObjectSelector = {
  from: 'param',
  path: 'kind',
  map: Object.fromEntries(Object.entries(SUBSETS).map(([kind, subset]) => [kind, subset.objectCode])),
};
/** `preflight → requirePerson`：目标人员须命中 personScope（含子集创建人维度），否则 404 NOT_FOUND「人员不存在」。 */
const employeePoint = (param: string) => pointScope({ param }, 'personnel.employee', NOT_FOUND);
/** `personScope` 注入列表 SQL（employment_employees / 子集表），过滤先于分页。 */
const employeeList = listScope('personnel.personScope');
const employeeShape = shape('personnel.employee');
const subsetShape = shape('personnel.subset');
/** `trimSubset`：子集字段按子集对象查看权、随行员工属性列按 EmployeeInformation 查看权（listFieldVisibility）。 */
const subsetProjection = projector('personnel.subset', 'personnel.subset');
const requestShape = shape('personnel.changeRequest');
const listButton = noButton('列表只按对象查看权（页面 list），无按钮');
const detailButton = noButton('详情只按对象查看权，无按钮');

/**
 * `http.write()`：事务内 requirePerson + authorizeTx（足迹 personnel.write），返回后再 requirePerson
 * （幂等重放也按当前权限）；preconditions 是 appendEmployee / saveSubset 在命令内的顺序。
 */
function personnelWrite(fields: FieldsFrom, targets: string, preconditions?: readonly string[]): WritePolicy {
  const result = { generic: { targets, locator: 'personnel.employee' } };
  return write(fields, 'personnel.write', result, preconditions ? { preconditions } : {});
}
/** 子集列表（两条路径共用处理函数）：`listOptions` 守卫 + `listSubsets` 的 personScope 谓词 + trimSubset。 */
function subsetList(scope: ScopePolicy): RoutePolicy {
  return object({
    object: SUBSET_OBJECT,
    operation: 'view',
    button: listButton,
    scope,
    fields: subsetProjection,
    guards: ['personnel.viewableFilters'],
  });
}
/**
 * 序码命令（resource personnel.order_code）：事务内 `requirePermission(authorizeInTransaction)` 复核，
 * 返回后再 `requirePermission`（幂等重放仍以本次请求的权限为准）；命令内先 lockOrderSettings 再 assertRevision。
 */
function orderCommand(fieldsReason: string): WritePolicy {
  return write(none(fieldsReason), 'personnel.permissionRecheck', 'personnel.permissionRecheck', {
    preconditions: ['lockOrderSettings', 'assertRevision'],
  });
}
const orderSettingsFields = noFields('序码排序规则配置值（enabled / items / revision），无字段目录');

export const PERSONNEL_POLICIES = defineTable('personnel', {
  // ---- order-code-routes.ts：人员序码配置与重算（tenant.settings.* → 管理员能力 other_settings）--------------------
  [`GET ${ORDER_CODE}/settings`]: admin('other_settings', {
    alias: 'tenant.settings.read',
    fields: orderSettingsFields,
  }),
  [`PUT ${ORDER_CODE}/settings`]: admin('other_settings', {
    alias: 'tenant.settings.write',
    fields: orderSettingsFields,
    write: orderCommand('序码排序规则 DTO（orderSettingsInput），无字段目录'),
  }),
  [`POST ${ORDER_CODE}/recompute`]: admin('other_settings', {
    alias: 'tenant.settings.write',
    scope: noScope('全租户派生投影由系统在库内一次计算，响应只返回计数，不泄露范围外人员'),
    fields: noFields('只返回计数（revision / changed / businessDate / outcome）'),
    write: orderCommand('请求体只接受空对象 {}，无字段'),
  }),
  // ---- routes.ts：员工信息（EmployeeInformation）---------------------------------------------------------------
  [`GET ${EMPLOYEES}`]: object({
    object: PERSONNEL_OBJECT,
    operation: 'view',
    button: listButton,
    scope: employeeList,
    fields: employeeShape,
    // listOptions：排序 / 筛选字段不可查看 → 403 FORBIDDEN「员工排序或筛选字段不可查看」
    guards: ['personnel.viewableFilters'],
  }),
  [`GET ${EMPLOYEES}/:id`]: object({
    object: PERSONNEL_OBJECT,
    operation: 'view',
    button: detailButton,
    scope: employeePoint('id'),
    // includeSubsets=true 时嵌套各子集（nestedSubsets）：逐对象 object.view（无权限的子集跳过）+ 各自范围 + trimSubset
    fields: projector('personnel.employeeWithSubsets', 'personnel.employeeDetail'),
    ...byUuid,
  }),
  [`PATCH ${EMPLOYEES}/:id`]: object({
    object: PERSONNEL_OBJECT,
    operation: 'update',
    button: button('update', 'detail'),
    scope: employeePoint('id'),
    fields: employeeShape,
    write: personnelWrite('body', 'id', ['lockPerson', 'validateAttachments', 'assertRevision']),
    ...byUuid,
  }),
  [`POST ${EMPLOYEES}/:id/attachments`]: object({
    object: PERSONNEL_OBJECT,
    operation: 'update',
    button: button('update', 'detail'),
    scope: employeePoint('id'),
    fields: noFields('附件登记回执不是人员字段；现状 write() 仍按 EmployeeInformation 查看权过滤回执键'),
    write: personnelWrite(none('附件元数据不是人员字段，requireObjectWrite 收到空字段集合'), 'employeeId'),
    ...byUuid,
  }),
  [`GET ${EMPLOYEES}/:id/tenure`]: object({
    object: PERSONNEL_OBJECT,
    operation: 'view',
    button: detailButton,
    scope: employeePoint('id'),
    // asOf 查询参数非法日期另报 400 VALIDATION_FAILED（dateValue），不是 invalidId
    fields: shape('personnel.tenure'),
    ...byUuid,
  }),
  [`GET ${EMPLOYEES}/:id/history`]: object({
    object: PERSONNEL_OBJECT,
    operation: 'view',
    button: button('history', 'detail'),
    scope: employeePoint('id'),
    fields: employeeShape,
    ...byUuid,
  }),
  // ---- subset-routes.ts：人员子集（对象由 :kind 决定）------------------------------------------------------------
  // 按员工：列表谓词 + employeeId 点校验同时成立（preflight 在 listSubsets 之前）
  [`GET ${SUBSET}`]: all(
    [
      subsetList(employeeList),
      object({
        object: SUBSET_OBJECT,
        operation: 'view',
        button: noButton('按钮与守卫在列表分支'),
        scope: employeePoint('employeeId'),
        fields: noFields('范围点校验分支，出口字段由组合层声明'),
      }),
    ],
    subsetProjection,
    byUuid,
  ),
  [`GET ${BASE}/subsets/:kind`]: subsetList(employeeList),
  // 详情 / 版本：先 preflight，再 loadSubset（按 tenant + employee + id 取记录，缺 → 404「子集记录不存在」）
  [`GET ${SUBSET}/:id`]: object({
    object: SUBSET_OBJECT,
    operation: 'view',
    button: detailButton,
    scope: employeePoint('employeeId'),
    guards: ['personnel.subset.byId'],
    fields: subsetShape,
    ...byUuid,
  }),
  [`GET ${SUBSET}/:id/history`]: object({
    object: SUBSET_OBJECT,
    operation: 'view',
    button: button('history', 'detail'),
    scope: employeePoint('employeeId'),
    // loadSubset(includeDeleted = true)：已删记录的版本仍可读
    guards: ['personnel.subset.byId'],
    fields: subsetShape,
    ...byUuid,
  }),
  // 新增：access 把 using_user 维度换成管理范围（personnelCreationScope）后再做 employeeId 点校验
  [`POST ${SUBSET}`]: object({
    object: SUBSET_OBJECT,
    operation: 'create',
    button: button('create', 'list'),
    scope: employeePoint('employeeId'),
    fields: subsetShape,
    write: personnelWrite('body', 'employeeId', ['lockPerson', 'validateAttachments', 'assertRevision']),
    ...byUuid,
  }),
  [`PATCH ${SUBSET}/:id`]: object({
    object: SUBSET_OBJECT,
    operation: 'update',
    button: button('update', 'detail'),
    scope: employeePoint('employeeId'),
    fields: subsetShape,
    write: personnelWrite('body', 'employeeId', ['lockPerson', 'validateAttachments', 'loadSubset', 'assertRevision']),
    ...byUuid,
  }),
  [`DELETE ${SUBSET}/:id`]: object({
    object: SUBSET_OBJECT,
    operation: 'delete',
    button: button('delete', 'detail'),
    scope: employeePoint('employeeId'),
    fields: subsetShape,
    // 本单位经历（isThisCompany）由任职记录维护，删除 → 409 CONFLICT（saveSubset）
    write: personnelWrite(none('删除不提取字段'), 'employeeId', ['lockPerson', 'loadSubset', 'assertRevision']),
    ...byUuid,
  }),
  // ---- request-routes.ts：个人信息变更申请（PersonalInformationChange，DEC-085）-----------------------------------
  // 现状顺序：按钮 self-service-submit（缺 → 403）→ requireSelf（未绑定 → 404 NOT_FOUND「个人信息不存在」）
  // → assertSelfServiceFields（403「字段不在员工自助修改清单内」）→ 命令内 createChange + 审批实例同事务
  [`POST ${REQUESTS}`]: self({
    target: { body: 'employeeId' },
    // 按钮资源 buttonResource(PERSONNEL_REQUEST_OBJECT, 'self-service-submit', 'list')，不要求子集写权与管理范围
    button: button('self-service-submit', 'list'),
    // 字段集合 = keys(body.values) ⊆ 租户设置 personnel.self_service_fields[kind]
    guards: ['personnel.selfServiceFields'],
    fields: noFields('处理函数直接返回申请行（含 values），不经裁剪'),
    write: write(
      { guard: 'personnel.selfServiceFields' },
      'personnel.selfRequest',
      none('申请行无范围复核，返回后不裁剪直接输出'),
      // createChange：assertRevision(If-Match = 0) → requireSelf 再查 → lockPerson → 带 recordId 时 loadSubset
      // 并核对 targetRevision
      { preconditions: ['assertRevision', 'requireSelf', 'lockPerson', 'loadSubset'] },
    ),
  }),
  // 现状顺序：object.view → loadChange（缺 → 404「个人信息变更申请不存在」）→ requireSelf（404）→ preflight（404）
  // → trim(PERSONNEL_REQUEST_OBJECT)：values 不在对象字段目录内，申请元数据接口不暴露变更内容
  [`GET ${REQUESTS}/:id`]: all(
    [
      object({
        object: PERSONNEL_REQUEST_OBJECT,
        operation: 'view',
        button: noButton('申请元数据只按对象查看权，无按钮'),
        scope: pointScope(
          { record: 'personnel.changeRequest', attribute: 'employeeId' },
          'personnel.employee',
          NOT_FOUND,
        ),
        fields: requestShape,
      }),
      self({ target: { record: 'personnel.changeRequest', attribute: 'employeeId' }, fields: requestShape }),
    ],
    requestShape,
    byUuid,
  ),
});
