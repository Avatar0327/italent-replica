/**
 * 员工自助模块的两份策略：
 * 1. DEC-205：自动员工身份 employee_self_service 的出厂字段权限与协议键（employeeFieldPolicy / PROTOCOL_FIELDS），
 *    供 access.ts 的叠加授权器使用——它是权限默认值，不是表单白名单，租户可用身份配置接口覆盖；
 * 2. F-039 PR-A：路由现状声明 SELF_SERVICE_POLICIES（附录 A「/api/tenant/self-service」7 条；子应用挂在
 *    /api/tenant/self-service，键用本地路径）。七条都先经 selfAccess：未绑定员工 → 403 FORBIDDEN「当前用户未绑定员工」，
 *    事务内 self.check 再查绑定 → 403 FORBIDDEN「员工绑定已变化，请刷新」（§2.4）；叠加授权器 selfService 把本人范围
 *    （personIds = 绑定本人）、DEC-205 字段权限并集与按钮白名单注册为 scope provider，任职对象的查看 / 字段 / 范围都走它。
 *
 * 与附录 A 的差异（按现状代码修正）：
 * - GET /transfer/references/:code：directManagerId 分支由 managerChoices 返回 id / name / orgPath
 *   （transfer/employee-managers.ts:43），附录 A「一般引用 id / name」漏了 orgPath，fixed 键并入；:code 不可见 → 403
 *   先于「字段不是引用字段」400（references.ts:53 / :76），乱填的 :code 观测码是 403，故不登记 invalidId。
 * - POST /transfer、POST /transfer/preview：按钮 Transfer.Self（requireTransferSource → requireTransferButton）仍按
 *   button(...) 登记；
 *   三个本人调动按钮（Transfer.Self / Employment.Create / Employment.Submit）自 C1-2b（DEC-402②）起由“员工”身份里是否勾选决定，
 *   管理员可关闭；检查 requireSelfServiceButtons 在预览事务第一步、提交的 CommandGuard.before（命令事务内、查台账前），
 *   两个按钮 Employment.Create / Employment.Submit 没有单独的 button(...) 观测，按前提原语登记（契约 §2.3.2）。
 * - POST /transfer/preview：附录 A 写足迹列为「只读预览」；代码在 ownTransferInput 内经 requireTransferWrite →
 *   requireEmploymentWrite('create', writable)（transfer.ts:46），提取规则就是 body.fields+customFields，故 write.fields
 *   照登，footprint / result 为 none（不开命令事务）。
 * - GET /applications/:id：除 ownApplication 的 404「申请不存在」，loadEmploymentBusiness 按本人范围取不到也 404 同文案
 *   （routes.ts:159）。
 * - 顺序：selfAccess（未绑定 403）先于 uuidParam / pageQuery 的 400（routes.ts:50–52、148）。
 */
import { EMPLOYEE_READONLY_FIELDS } from '../transfer/employee-policy.js';
import { sql, type Tx } from '@italent/db';
import {
  EMPLOYEE_DEFAULT_CREATE,
  EMPLOYEE_DEFAULT_EDIT_FIELDS,
  EMPLOYEE_SELF_SERVICE_BUTTONS,
  EMPLOYEE_SELF_SERVICE_CODE,
} from '@italent/domain';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { rowsOf } from '../employment/read-model.js';
import { loadObjectPermissions } from '../permission/subject.js';
import { defineTable } from '../../route-policy/index.js';
import { BAD_REQUEST, button, fixed, none, projector, self, write } from '../../route-policy/presets.js';

// DEC-205：这是自动员工身份的出厂权限，不是表单白名单。租户可用现有身份配置接口覆盖，另有身份按并集合并。
// 出厂默认值的唯一来源在 domain（platform/employee-self-service.ts，C1-2b）：开通时装的标准身份行与这里没有行时的兜底值同出一处。
export const EMPLOYEE_PROFILE_CODE = EMPLOYEE_SELF_SERVICE_CODE;
export { EMPLOYEE_READONLY_FIELDS } from '../transfer/employee-policy.js';
const DEFAULT_BUTTONS = EMPLOYEE_SELF_SERVICE_BUTTONS.map((b) => b.buttonCode);
export const PROTOCOL_FIELDS = [
  'id',
  'employeeId',
  'revision',
  'employeeRevision',
  'status',
  'kind',
  'stopDate',
  'isCurrent',
  'isLatest',
];

export interface EmployeeFieldPolicy {
  readonly view: Set<string>;
  readonly edit: Set<string>;
  readonly create: boolean;
  /** 员工身份在任职对象上授予的 detail 级按钮编码（本人调动三个按钮的实际开关，DEC-402②）。 */
  readonly buttons: Set<string>;
}

export async function employeeFieldPolicy(tx: Tx, tenantId: string): Promise<EmployeeFieldPolicy> {
  const [profile] = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT p.id FROM permission_profiles p
    JOIN permission_profile_apps a ON a.tenant_id=p.tenant_id AND a.profile_id=p.id AND a.app_code='TenantBase'
    WHERE p.tenant_id=${tenantId} AND p.code=${EMPLOYEE_PROFILE_CODE}
  `),
  );
  if (!profile) {
    return {
      view: new Set([...EMPLOYEE_DEFAULT_EDIT_FIELDS, ...EMPLOYEE_READONLY_FIELDS]),
      edit: new Set(EMPLOYEE_DEFAULT_EDIT_FIELDS),
      create: EMPLOYEE_DEFAULT_CREATE,
      buttons: new Set(DEFAULT_BUTTONS),
    };
  }
  const [permission] = await loadObjectPermissions(tx, [profile.id], EMPLOYMENT_OBJECT);
  return {
    buttons: new Set(permission?.buttons.filter((b) => b.level === 'detail').map((b) => b.buttonCode) ?? []),
    view: new Set(permission?.fields.filter((field) => field.view).map((field) => field.fieldCode) ?? []),
    edit: new Set(permission?.fields.filter((field) => field.view && field.edit).map((field) => field.fieldCode) ?? []),
    create: permission?.dataOperations.create ?? false,
  };
}

// ---- F-039 PR-A：路由现状声明（§2.1 self；§3.2「selfAccess / employeeFieldPolicy / transferFieldAccess …」行）---------

/**
 * 本人任职记录的出口形状：discloseOwnRecord 按 getModuleViewableFields（叠加授权器：PROTOCOL_FIELDS ∪ DEC-205 查看字段 ∪
 * 其他身份字段）裁剪顶层 / fields / customFields（custom:<id>），fieldLabels 只回显该任职已有引用的名称（envelope 协议键）。
 */
const ownRecord = projector('selfService.ownRecord', 'selfService.ownRecord');
/**
 * 自助调动经 requireTransferButton(employee) 校验 Transfer.Self@detail，经叠加授权器 selfService 按“员工”身份里的按钮配置
 * 放行（C1-2b：管理员可关闭，不再恒真）；Employment.Create / Employment.Submit 与它一起由 requireSelfServiceButtons 校验。
 */
const whitelistedButtons = button('Transfer.Self', 'detail');
/**
 * ownTransferInput（transfer.ts）：zod strictObject（effectiveDate / reasonCode / fields / customFields，其余键 400）；
 * effectiveDate 不可见或不可编辑 → 400 SELF_TRANSFER_DATE_UNAVAILABLE；服务端固定 initiator=employee、
 * transferTypeCode=in_department、formId=TenantBase.TransferMultiFormView、mode=application、submit=true，客户端不能借
 * mode / initiator / employeeId 提权；normalizeTransferInput 内 requireEmployeeTransferFields：postId / levelId / sequenceId
 * 只读（DEC-209）→ 403；requireTransferWrite → requireEmploymentWrite('create', writable) 由叠加授权器逐字段判定。
 */
const TRANSFER_INPUT = 'selfService.transferInput';
/**
 * 预览在同一租户事务内：绑定复核、三个本人调动按钮（事务第一步）、表单与字段权限、previewTransfer 内的来源 / 只读字段 /
 * 目标部门范围复核。
 */
const previewPreconditions = [
  'self.check',
  'requireSelfServiceButtons',
  'ownTransferInput',
  'requireTransferSource',
  'requireEmployeeTransferFields',
  'requireScopedEmploymentObject',
];
/**
 * 自助调动命令内（runWrite → runCommand → ledgerExit → CommandGuard.before / execute）：三个本人调动按钮在 guard.before
 * （routes.ts selfTransferGuard，事务内、查台账前，覆盖首次执行 / 直接重放 / 失败后回查）；execute 内绑定复核、ownTransferInput
 * 事务内再算（命令外已先算一次，routes.ts:99），createTransfer 内锁参与人与员工（lockEmploymentEmployee 比对 If-Match
 * revision → 409 REVISION_CONFLICT）、transferTargetContext → requireTransferSource（绑定本人 / 源范围）、
 * requireTransferWrite 复核后再提交审批。
 */
const transferPreconditions = [
  'self.check',
  'requireSelfServiceButtons',
  'ownTransferInput',
  'lockTransferParticipants',
  'lockEmploymentEmployee',
  'assertRevision',
  'requireTransferSource',
  'requireEmployeeTransferFields',
  'requireTransferWrite',
];

export const SELF_SERVICE_POLICIES = defineTable('self-service', {
  // ---- registerProfileRoutes：本人档案与任职记录 -----------------------------------------------------------------
  // 响应 { employee, timezone, today, record }：record 为当前任职（无则 null），经 discloseOwnRecord 裁剪
  'GET /profile': self({ fields: ownRecord }),
  // :id 必须是绑定本人，否则 403 FORBIDDEN「只能查看本人任职记录」；uuidParam 非 UUID → 400 VALIDATION_FAILED
  // （job/context.uuidParam）；ownRecords 按本人范围取业务链，items 每条另带 approvalStatus（协议键）
  'GET /employees/:id/records': self({ target: { param: 'id' }, invalidId: BAD_REQUEST, fields: ownRecord }),
  // ---- registerTransferRoutes：本人调动（DEC-205 / DEC-209）--------------------------------------------------------
  // 只读预览：不开命令事务；ownTransferPreview 按 transferFieldAccess 可见集裁剪 fields / before / customFields、
  // fieldModes（prefixedKeys，可编辑再经叠加授权器判 object.create）、basicFieldModes、reasons、valueLabels / beforeLabels
  'POST /transfer/preview': self({
    button: whitelistedButtons,
    guards: ['transfer.direct', 'transfer.source', TRANSFER_INPUT],
    fields: projector('selfService.transferPreview', 'selfService.transferPreview'),
    write: write(
      'body.fields+customFields',
      none('只读预览：不开命令事务、不写入，没有提交前足迹'),
      none('只读预览：无返回后复核，响应由 ownTransferPreview 按可见字段裁剪'),
      { preconditions: previewPreconditions },
    ),
  }),
  // referenceChoices：:code 不在 transferFieldAccess 可见集 → 403 FORBIDDEN「无权查看此字段」；asOf 非法 → 400；
  // 分支：只读字段 postId / levelId / sequenceId → []（200）；directManagerId → managerChoices（新部门上级链，DEC-209，
  // id / name / orgPath）；dottedManagerId / addedSubordinateIds → 在职员工 id / name，按用户自身身份对 EmploymentRecord
  // 的数据范围（原 deps，不是叠加授权器的本人范围）；departmentId → 组织快照 id / name / parentId / level，
  // unrestrictTargetDepartment 时不限范围；职务字典 → 各自对象的数据范围 id / name；其余可见字段 → 400「字段不是引用字段」
  'GET /transfer/references/:code': self({
    guards: ['selfService.referenceChoices'],
    fields: fixed(['id', 'name', 'orgPath', 'parentId', 'level'], 'DEC-057 / DEC-209；§3.5 固定键（分支见上）'),
  }),
  // Idempotency-Key 必填（400 IDEMPOTENCY_KEY_REQUIRED）、If-Match 必填（400 REVISION_REQUIRED，job/context.revision）；
  // 201 + ETag；响应经 trimEmploymentResponse（self.deps 的叠加授权器）裁剪；authorizeEmploymentResult 在 runWrite 的
  // 命令事务内（提交前足迹）与 runCommand 返回后各跑一次（employment.result），首次 / 重放都复核
  'POST /transfer': self({
    button: whitelistedButtons,
    guards: ['transfer.direct', 'transfer.source', 'employment.linkage', TRANSFER_INPUT],
    fields: projector('employment.response', 'employment.response'),
    write: write('body.fields+customFields', 'employment.result', 'employment.result', {
      preconditions: transferPreconditions,
      ledger: 'single',
    }),
  }),
  // ---- registerApplicationRoutes：本人发起的调动申请 ---------------------------------------------------------------
  // ownApplications：initiator_user_id = 本人用户 ∧ employee_id = 绑定本人（本人前提自带，不另登记 scope）；
  // 固定协议键 id / businessId / revision / title / currentHandlers / createdAt / status / category / initiator，
  // effectiveDate / fields.departmentId 与 reason（reasonCode 可见才查目录名）按 transferFieldAccess 可见集裁剪
  'GET /applications': self({ fields: projector('selfService.application', 'selfService.application') }),
  // uuidParam 非 UUID → 400；ownApplication 非本人发起 / 非绑定本人 / 不存在 → 404 NOT_FOUND「申请不存在」；
  // 响应 { status, record }，record 经 discloseOwnRecord 裁剪
  'GET /applications/:id': self({ invalidId: BAD_REQUEST, guards: ['selfService.ownApplication'], fields: ownRecord }),
});
