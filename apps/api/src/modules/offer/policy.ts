/**
 * Offer 模块路由的现状声明（F-039；R2 BE-14a C1，DEC-581）。子应用挂在 /api/tenant/offers，键用本地路径。
 *
 * 现状骨架（routes.ts / context.ts）：
 * - offerReadContext：objectContext(object.view) + requestScope（页面编码 TenantBase.Offer.list / .detail）；列表 / 详情按录用
 *   部门（组织维度）与创建人（使用用户维度）裁剪，范围外与不存在同为 404；列表的范围谓词在 SQL 内、先于分页。
 *   视图定义与字典下拉只查对象查看权（静态定义 / 无组织字段，不取范围）。
 * - runOfferWrite：要求 If-Match（新建须为 0）；事务外 objectContext + 各入口自己的判定（新建 / 编辑 writeFields，删除 / 复制
 *   只判数据操作开关），事务内经 CommandGuard.before 按当前授权与当前范围再判（#199），重放命中台账后复核结果仍在范围。
 * - 两个字典挂在任职设置配置对象上：写入 = tenant.employment.configuration.write + 配置对象字段编辑权，无数据范围。
 * - 转移状态两项按钮（Offer.StatusTransfer / OfferLineOpStatusTransfer）只登记授权项，入口随 C2（BE-14a2）接入，本表无对应路由。
 * - 发起审批（BE-14a3）：单个 / 批量都走 runOfferWrite（object.update，与编辑同开关）+ 逐份 Offer 的当前范围；审批流转
 *   在同一事务内交审批中心（approval/engine startOrResume），首节点为空等拒绝时整单回滚。
 */
import { OFFER_OBJECT } from '@italent/domain';
import { defineTable, type PolicyBase, type RoutePolicy } from '../../route-policy/index.js';
import {
  admin,
  all,
  BAD_REQUEST,
  commandWrite,
  fixed,
  listScope,
  noButton,
  noFields,
  noScope,
  none,
  NOT_FOUND,
  object,
  pointScope,
  shape,
  write,
} from '../../route-policy/presets.js';

const OFFER = OFFER_OBJECT;
const SETTINGS = 'TenantBase.EmploymentSettings';
const SCOPE = 'offer.departmentOrCreator';
const point = pointScope({ param: 'id' }, 'offer.byId', NOT_FOUND);
const byId = { invalidId: BAD_REQUEST } as const;
const record = shape('offer.record');
const DICTIONARY = fixed(['id', 'code', 'name', 'enabled', 'displayOrder', 'revision'], 'A37 字典项固定键');
const RESULT = { generic: { targets: 'id', locator: 'offer.byId' } } as const;
const bodyWrite = (preconditions: readonly string[]) =>
  write('body', 'offer.commandGuard', RESULT, { ledger: 'single', preconditions });
const commandOnly = (preconditions: readonly string[], result: typeof RESULT | typeof BATCH_RESULT = RESULT) =>
  commandWrite('offer.commandGuard', result, { ledger: 'single', preconditions });
/** 批量发起返回一组 Offer：重放时逐个复核仍在范围（routes.batchVisible）。 */
const BATCH_RESULT = { generic: { targets: 'items[*].id', locator: 'offer.byId' } } as const;
const APPROVAL_PRECONDITIONS = ['offer.approvable', 'approval.processMatched', 'approval.firstNodeAssignee'];

/** 字典写入：配置别名 tenant.employment.configuration.write（admin other_settings）+ 任职设置对象的字段编辑权。 */
function dictionaryWrite(operation: 'create' | 'update', extra: PolicyBase = {}): RoutePolicy {
  return all(
    [
      admin('other_settings', { alias: 'tenant.employment.configuration.write', fields: DICTIONARY }),
      object({
        object: SETTINGS,
        operation,
        button: noButton('配置对象无按钮：只查 object.<op> + 字段目录'),
        scope: noScope('配置对象无数据范围'),
        fields: DICTIONARY,
      }),
    ],
    DICTIONARY,
    {
      write: write('body', 'config.audited:offer_dictionary', none('配置对象无范围，返回固定键'), {
        ledger: 'single',
        preconditions: ['assertOfferRevision'],
      }),
      ...extra,
    },
  );
}

export const OFFER_POLICIES = defineTable('offers', {
  'GET /views': object({
    object: OFFER,
    operation: 'view',
    button: noButton('视图定义只按对象查看权'),
    scope: noScope('静态视图定义（编码、筛选、列序列宽），不含业务数据'),
    fields: noFields('视图定义，无对象字段'),
  }),
  // 下拉读取：持 Offer 查看权即可读，enabled 只能 true / false
  'GET /dictionaries/:kind': object({
    object: OFFER,
    operation: 'view',
    button: noButton('字典下拉按 Offer 查看权'),
    scope: noScope('字典无组织字段，按 Offer 查看权整份可读'),
    fields: DICTIONARY,
  }),
  // body 严格 { code, name, enabled?, displayOrder? }（400）；If-Match 须为 0；编码重复（不分大小写）→ 409
  'POST /dictionaries/:kind': dictionaryWrite('create'),
  // 改编码 → 400 OFFER_DICTIONARY_CODE_IMMUTABLE；项不存在 → 404；:id 非 UUID → 400
  'PUT /dictionaries/:kind/:id': dictionaryWrite('update', byId),
  // view 缺省 pending；未知视图 / 本视图外的筛选 400；筛选字段无查看权 403 FILTER_FIELD_HIDDEN
  'GET /': object({
    object: OFFER,
    operation: 'view',
    button: noButton('列表按对象查看权'),
    scope: listScope(SCOPE),
    fields: shape('offer.list'),
    guards: ['offer.filterFieldVisible'],
  }),
  'POST /': object({
    object: OFFER,
    operation: 'create',
    button: noButton('新建按对象新增开关与字段编辑权'),
    scope: pointScope({ body: 'departmentId' }, 'offer.department', NOT_FOUND),
    fields: record,
    write: bodyWrite(['offer.requiredFields', 'offer.entryRules']),
  }),
  'GET /:id': object({
    ...byId,
    object: OFFER,
    operation: 'view',
    button: noButton('只读'),
    scope: point,
    fields: record,
  }),
  'PUT /:id': object({
    ...byId,
    object: OFFER,
    operation: 'update',
    button: noButton('编辑按对象编辑开关与字段编辑权'),
    scope: point,
    fields: record,
    write: bodyWrite(['offer.editable', 'revision', 'offer.requiredFields']),
  }),
  'DELETE /:id': object({
    ...byId,
    object: OFFER,
    operation: 'delete',
    button: noButton('删除按对象删除开关'),
    scope: point,
    fields: record,
    write: commandOnly(['offer.editable', 'revision']),
  }),
  'POST /:id/copy': object({
    ...byId,
    object: OFFER,
    operation: 'create',
    button: noButton('复制按对象新增开关'),
    scope: point,
    fields: record,
    // 复制写入的字段来自被复制的 Offer：事务内按展开后的实际字段校验编辑权（审查 #394 P2-01）
    write: write({ guard: 'offer.copyWrites' }, 'offer.commandGuard', RESULT, {
      ledger: 'single',
      preconditions: ['offer.copyable', 'revision'],
    }),
  }),
  // BE-14a3：body 只接受 {}；非待发 / 审批中 / 已通过 → 409 OFFER_APPROVAL_NOT_ALLOWED；首节点为空 → 409（DEC-054）
  'POST /:id/approval': object({
    ...byId,
    object: OFFER,
    operation: 'update',
    button: noButton('发起审批按对象编辑开关（行主按钮编码原站未取证）'),
    scope: point,
    fields: record,
    write: commandOnly(['revision', ...APPROVAL_PRECONDITIONS]),
  }),
  // body { offerIds(1～100 不重复), approvalSubjectOrgId?, remark? }（400）；If-Match 须为 0；任一份不满足整单拒绝；
  // 审批主体缺省取申请人主职部门，取不到 400 OFFER_BATCH_SUBJECT_REQUIRED，显式指定须在组织范围内
  'POST /batch-approvals': object({
    object: OFFER,
    operation: 'update',
    button: noButton('批量发起审批按对象编辑开关'),
    scope: pointScope({ body: 'offerIds[*]' }, 'offer.byId', NOT_FOUND),
    fields: record,
    write: commandOnly(['offer.batchSubject', ...APPROVAL_PRECONDITIONS], BATCH_RESULT),
  }),
});
