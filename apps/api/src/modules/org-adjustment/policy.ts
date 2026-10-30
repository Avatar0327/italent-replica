/**
 * 组织调整申请路由的现状声明（F-039；R2-T08 §9.3 路由 1～3、7，BE-10b1 头字段与调整范围）。对象 OrganizationApproval：
 * 主体组织按 OrganizationApproval 范围，调整范围所选组织逐个按组织对象范围（`authorizeHead`，§6.3）；范围外与不存在同为 404。
 * 写入口经 runCommand（同键同内容重放），守卫 before 在命令事务内（首次与重放都经过）跑 `authorizeHead`，改头 / 作废先锁行读现值，
 * 现值与改后值两侧都判；replayed 再按当前 OrganizationApproval 范围复核结果的主体组织。
 *
 * 与附录 A 的差异 / 本片取舍：
 * 1. 组织明细（4～6、8～9）与提交 / 撤回（10～）本片不注册，访问为 404。
 * 2. POST /adjustments：路由层 requireNew（If-Match 须为 0）。
 * 3. POST /:id/check：只读校验，不进台账、不写数据；结果为校验信封（valid / errors / warnings），不裁剪。
 *    现值的调整范围逐个按组织范围复核（authorizeOrgResult），登记为结果复核 orgAdjustment.rangeOrgs。
 * 4. 申请人、状态（0 / 6 可改）与 revision 在命令内锁行后判定（service.editable），登记为 preconditions。
 * 本文件新起的登记名：守卫 orgAdjustment.head（authorizeHead / authorizeHeadAction）、orgAdjustment.headReplay
 * （replayed 复核）、校验复核 orgAdjustment.rangeOrgs、形状 orgAdjustment.adjustment、
 * 前提 orgAdjustment.lock / assertRevision / applicant / editableStatus / orgsActive。
 */
import { ORG_ADJUSTMENT_OBJECT_CODE } from '@italent/domain';
import { defineTable, type FieldsFrom } from '../../route-policy/index.js';
import {
  BAD_REQUEST,
  button,
  guardScope,
  noFields,
  none,
  NOT_FOUND,
  object,
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

export const ORG_ADJUSTMENT_POLICIES = defineTable('org-adjustment', {
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
});
