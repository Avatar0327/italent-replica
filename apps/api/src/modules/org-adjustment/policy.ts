/**
 * 组织调整申请路由的现状声明（F-039；R2-T08 §9.3 路由 1～9、12～15，BE-10b1 头字段与调整范围，BE-10b2 组织明细与基线，
 * BE-10d 读取）。对象 OrganizationApproval：
 * 主体组织按 OrganizationApproval 范围，调整范围所选组织逐个按组织对象范围（`authorizeHead`，§6.3）；范围外与不存在同为 404。
 * 写入口经 runCommand（同键同内容重放），守卫 before 在命令事务内（首次与重放都经过）跑 `authorizeHead`，改头 / 作废先锁行读现值，
 * 现值与改后值两侧都判；replayed 再按当前 OrganizationApproval 范围复核结果的主体组织。
 *
 * 与附录 A 的差异 / 本片取舍：
 * 1. 提交 / 撤回（10～）本片不注册，访问为 404。
 * 2. POST /adjustments：路由层 requireNew（If-Match 须为 0）。
 * 3. POST /:id/check：只读校验，不进台账、不写数据；结果为校验信封（valid / errors / warnings），看不到
 *    `orgItems.targetOrgId` 时隐去明细问题里的组织 ID。
 *    现值的调整范围逐个按组织范围复核（authorizeOrgResult），登记为结果复核 orgAdjustment.rangeOrgs。
 * 4. 申请人、状态（0 / 6 可改）与 revision 在命令内锁行后判定（service.editable），登记为 preconditions。
 * 5. 组织明细（4～6、8～9）：数据操作为主对象 update，字段按主对象 `orgItems.*`；按钮由入口决定（路由 4：编辑器入口挂
 *    主对象 app_page、明细列表入口挂明细对象 list，九选一），改 / 刷新单行为明细对象 EditOrgApprovalDetail@list_row，
 *    删行为 DelteOrgApprovalDetail@list_row，整单刷新为主对象编辑按钮。命令守卫 before 锁申请单后经 `authorizeItem`
 *    再判同一按钮、主体组织与行涉及的组织（请求里的与库里现有行及其连带行的；停用连带下级在写服务内逐个判），
 *    范围外与不存在同为 404；replayed 按当前组织范围复核结果行涉及的组织。响应按 `orgItems.*` 查看权裁剪。
 * 6. 读取（BE-10d，路由 12～15）：列表为主对象 view + 主体组织列表范围（谓词 orgAdjustment.subjectScope）；详情 / 明细 /
 *    预览为 any（主对象 view + 守卫 orgAdjustment.disclosure，或关系 orgAdjustment.approvalCanOpen），都不是 → 404。
 *    §4.5 写“无查看权或范围外 → 404”，列表无对象查看权按 objectContext 现行口径 403（偏离记结果文件）。
 * 本文件新起的登记名：守卫 orgAdjustment.head（authorizeHead / authorizeHeadAction）、orgAdjustment.headReplay
 * （replayed 复核）、校验复核 orgAdjustment.rangeOrgs、形状 orgAdjustment.adjustment、
 * 前提 orgAdjustment.lock / assertRevision / applicant / editableStatus / orgsActive；BE-10b2 起：守卫 orgAdjustment.item
 * （authorizeItem）、orgAdjustment.itemReplay（replayed 复核）、形状 orgAdjustment.items、前提 orgAdjustment.itemLimits
 * （上限 / 范围 / 叠树 / 引用，写服务内判定）。
 */
import { ORG_ADJUSTMENT_DETAIL_OBJECT_CODE, ORG_ADJUSTMENT_OBJECT_CODE, ORG_ITEM_ENTRY_BUTTONS } from '@italent/domain';
import { defineTable, type FieldsFrom, type RoutePolicy } from '../../route-policy/index.js';
import {
  all,
  any,
  BAD_REQUEST,
  button,
  buttonOnly,
  FORBIDDEN,
  guardScope,
  listScope,
  noButton,
  noFields,
  none,
  NOT_FOUND,
  object,
  projector,
  relation,
  shape,
  write,
} from '../../route-policy/presets.js';

const BASE = '/api/tenant/org-adjustment/adjustments';
const OBJECT = ORG_ADJUSTMENT_OBJECT_CODE;
/** `uuidParam` 路径 id 非法 → 400 VALIDATION_FAILED。 */
const byId = { invalidId: BAD_REQUEST };
const adjustmentShape = shape('orgAdjustment.adjustment');
/** `authorizeHead`：主体组织不在 OrganizationApproval 范围 → 404「组织调整申请不存在」；范围组织不在组织范围 → 404。 */
const headScope = guardScope('orgAdjustment.head', NOT_FOUND);
const CREATE = ['orgAdjustment.orgsActive'];
const EDIT = [
  'orgAdjustment.lock',
  'orgAdjustment.assertRevision',
  'orgAdjustment.applicant',
  'orgAdjustment.editableStatus',
];
const headWrite = (fields: FieldsFrom, preconditions: readonly string[]) =>
  write(fields, 'orgAdjustment.head', 'orgAdjustment.headReplay', { ledger: 'single', preconditions });

const DETAIL = ORG_ADJUSTMENT_DETAIL_OBJECT_CODE;
const ITEMS = `${BASE}/:id/org-items`;
const itemsShape = shape('orgAdjustment.items');
/** `authorizeItem`：主体组织不在 OrganizationApproval 范围 → 404「组织调整申请不存在」；行涉及的组织不在组织范围 → 404。 */
const itemScope = guardScope('orgAdjustment.item', NOT_FOUND);
const ITEM_EDIT = [...EDIT, 'orgAdjustment.itemLimits'];
const itemWrite = (fields: FieldsFrom) =>
  write(fields, 'orgAdjustment.item', 'orgAdjustment.itemReplay', { ledger: 'single', preconditions: ITEM_EDIT });
/** 明细写入口：主对象 update（按钮另由 `buttons` 声明）AND 按钮；字段 / 范围 / 写都挂在主对象节点上。 */
const itemRoute = (buttons: RoutePolicy, fields: FieldsFrom) =>
  all(
    [
      object({
        object: OBJECT,
        operation: 'update',
        button: noButton('按钮由入口 / 行操作决定，在 buttonOnly 分支'),
        scope: itemScope,
        fields: itemsShape,
      }),
      buttons,
    ],
    itemsShape,
    { write: itemWrite(fields), ...byId },
  );

// ---- 读取（BE-10d，路由 12～15）----------------------------------------------------------------------------------
/** 读接口投影：头列按 OrganizationApproval 字段查看权，明细按 `orgItems.*`，派生列跟随源字段（§4.5）。 */
const readView = projector('orgAdjustment.readView', 'orgAdjustment.read');
/**
 * 详情 / 明细 / 预览共用 `orgAdjustmentDisclosure`：HR（主对象 view + 主体组织在 OrganizationApproval 范围），或可打开
 * 最新审批实例（assertCanOpen：发起人 / 审批人 / 抄送人 / 范围内流程管理员）；都不是 → 404，文案与不存在相同。
 */
const reader = any(
  [
    object({
      object: OBJECT,
      operation: 'view',
      button: noButton('读接口按对象查看权，不设按钮'),
      scope: guardScope('orgAdjustment.disclosure', NOT_FOUND),
      fields: readView,
    }),
    relation({
      relation: 'orgAdjustment.approvalCanOpen',
      target: { param: 'id' },
      denied: NOT_FOUND,
      fields: readView,
    }),
  ],
  byId,
);

export const ORG_ADJUSTMENT_POLICIES = defineTable('org-adjustment', {
  // 路由 12：主对象 view（无权 403）；主体组织范围在 SQL 里先过滤再分页，没有范围为空
  [`GET ${BASE}`]: object({
    object: OBJECT,
    operation: 'view',
    button: noButton('列表按对象查看权，不设按钮'),
    scope: listScope('orgAdjustment.subjectScope'),
    fields: readView,
  }),
  [`GET ${BASE}/:id`]: reader,
  // 路由 14：section 只认 org，其它 404
  [`GET ${BASE}/:id/items/:section`]: reader,
  [`GET ${BASE}/:id/preview`]: reader,
  [`POST ${BASE}`]: object({
    object: OBJECT,
    operation: 'create',
    button: button('AddAdjustOrgApprovalBtn', 'list'),
    scope: headScope,
    fields: adjustmentShape,
    write: headWrite('body', CREATE),
  }),
  [`PATCH ${BASE}/:id`]: object({
    object: OBJECT,
    operation: 'update',
    button: button('EditAdjustOrgDetailBtn', 'detail'),
    scope: headScope,
    fields: adjustmentShape,
    write: headWrite('body', [...EDIT, 'orgAdjustment.orgsActive']),
    ...byId,
  }),
  // 作废：0 / 6 → 5，不物理删除；按钮 OrganizationApprovalDelete@list_row，空请求体
  [`POST ${BASE}/:id/void`]: object({
    object: OBJECT,
    operation: 'update',
    button: button('OrganizationApprovalDelete', 'list_row'),
    scope: headScope,
    fields: adjustmentShape,
    write: headWrite(none('作废无请求体，不提取字段'), EDIT),
    ...byId,
  }),
  // 只读校验：编辑按钮 + 主体组织 / 范围组织都在范围；信封不裁剪、不进台账
  [`POST ${BASE}/:id/check`]: object({
    object: OBJECT,
    operation: 'update',
    button: button('EditAdjustOrgDetailBtn', 'detail'),
    scope: headScope,
    fields: noFields('校验结果信封（valid / errors / warnings），不是对象字段'),
    write: write(none('只读校验，空请求体'), none('只读校验，不进台账'), 'orgAdjustment.rangeOrgs'),
    ...byId,
  }),
  // 路由 4：入口九选一决定调整类型与按钮；入口与类型不符 400（在按钮之前）
  [`POST ${ITEMS}`]: itemRoute(
    any(
      Object.values(ORG_ITEM_ENTRY_BUTTONS).map((entry) =>
        buttonOnly(entry.objectCode, button(entry.code, entry.level), FORBIDDEN),
      ),
    ),
    'body',
  ),
  [`PATCH ${ITEMS}/:itemId`]: itemRoute(
    buttonOnly(DETAIL, button('EditOrgApprovalDetail', 'list_row'), FORBIDDEN),
    'body',
  ),
  // 删行：连带行随发起行删；被引用 / 连带行本身 409
  [`DELETE ${ITEMS}/:itemId`]: itemRoute(
    buttonOnly(DETAIL, button('DelteOrgApprovalDetail', 'list_row'), FORBIDDEN),
    none('删行无请求体，不提取字段'),
  ),
  // 路由 8：单行刷新基线；section 只认 org，其它 404
  [`POST ${BASE}/:id/items/:section/:itemId/rebase`]: itemRoute(
    buttonOnly(DETAIL, button('EditOrgApprovalDetail', 'list_row'), FORBIDDEN),
    none('刷新基线无请求体，不提取字段'),
  ),
  // 路由 9：整单刷新基线；按钮同改头
  [`POST ${BASE}/:id/rebase`]: object({
    object: OBJECT,
    operation: 'update',
    button: button('EditAdjustOrgDetailBtn', 'detail'),
    scope: itemScope,
    fields: itemsShape,
    write: itemWrite(none('刷新基线无请求体，不提取字段')),
    ...byId,
  }),
});
