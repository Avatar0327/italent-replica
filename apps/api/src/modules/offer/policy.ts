/**
 * Offer 模块路由的现状声明（F-039；R2 BE-14a）。子应用挂在 /api/tenant/offers，键用本地路径。
 *
 * 现状骨架（routes.ts / context.ts）：
 * - offerReadContext：objectContext(object.view) + requestScope（页面编码 TenantBase.Offer.list / .detail）；读接口按录用
 *   部门（组织维度）与创建人（使用用户维度）裁剪，范围外与不存在同为 404；列表的范围谓词在 SQL 内、先于分页。
 * - runOfferWrite：要求 If-Match（新建须为 0）；事务外 objectContext + writeFields（实际写入字段）+ 可选按钮，事务内经
 *   CommandGuard.before 按当前授权与当前范围再判一次（#199），重放命中台账后复核结果 Offer 仍在当前范围。
 * - 转移状态按请求体 entry 选按钮：toolbar → Offer.StatusTransfer@list，row → OfferLineOpStatusTransfer@list_row（DEC-533④），
 *   只按这两项按钮控制，不另设管理员越权（DEC-503）。
 * - 两个字典挂在任职设置配置对象上：写入 = tenant.employment.configuration.write + 配置对象字段编辑权，无数据范围。
 */
import { OFFER_BUTTONS, OFFER_OBJECT } from '@italent/domain';
import { defineTable, type ButtonPolicy } from '../../route-policy/index.js';
import {
  BAD_REQUEST,
  button,
  commandWrite,
  configWrite,
  fixed,
  listScope,
  noButton,
  noFields,
  noScope,
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
const TRANSFER_BUTTON: ButtonPolicy = {
  from: 'body',
  path: 'entry',
  map: {
    toolbar: button(OFFER_BUTTONS.statusTransfer.code, OFFER_BUTTONS.statusTransfer.level),
    row: button(OFFER_BUTTONS.lineStatusTransfer.code, OFFER_BUTTONS.lineStatusTransfer.level),
  },
};
const RESULT = { generic: { targets: 'id', locator: 'offer.byId' } } as const;
const bodyWrite = (preconditions: readonly string[]) =>
  write('body', 'offer.commandGuard', RESULT, { ledger: 'single', preconditions });
const commandOnly = (preconditions: readonly string[]) =>
  commandWrite('offer.commandGuard', RESULT, { ledger: 'single', preconditions });

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
  'POST /dictionaries/:kind': object({
    object: SETTINGS,
    operation: 'create',
    button: noButton('配置对象写入按配置能力与字段编辑权'),
    scope: noScope('配置对象无范围'),
    fields: DICTIONARY,
    guards: ['tenant.employment.configuration.write'],
    write: configWrite('offer.commandGuard', { ledger: 'single' }),
  }),
  'PUT /dictionaries/:kind/:id': object({
    ...byId,
    object: SETTINGS,
    operation: 'update',
    button: noButton('配置对象写入按配置能力与字段编辑权'),
    scope: noScope('配置对象无范围'),
    fields: DICTIONARY,
    guards: ['tenant.employment.configuration.write'],
    write: configWrite('offer.commandGuard', { ledger: 'single' }),
  }),
  // view 缺省 pending；未知视图 / 本视图外的筛选 400；筛选字段无查看权 403 FILTER_FIELD_HIDDEN
  'GET /': object({
    object: OFFER,
    operation: 'view',
    button: noButton('列表按对象查看权；行操作按按钮与数据操作权限过滤'),
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
    fields: noFields('删除回执 { id, deleted }'),
    write: commandOnly(['offer.editable', 'revision']),
  }),
  'POST /:id/copy': object({
    ...byId,
    object: OFFER,
    operation: 'create',
    button: noButton('复制按对象新增开关'),
    scope: point,
    fields: record,
    write: commandOnly(['offer.copyable', 'revision']),
  }),
  'GET /:id/transfer-form': object({
    ...byId,
    object: OFFER,
    operation: 'view',
    button: noButton('只读'),
    scope: point,
    fields: shape('offer.transferForm'),
  }),
  'POST /:id/transfer': object({
    ...byId,
    object: OFFER,
    operation: 'update',
    button: TRANSFER_BUTTON,
    scope: point,
    fields: record,
    write: commandOnly(['revision', 'offer.transition', 'offer.refusalReasonEnabled']),
  }),
  'POST /:id/invalidate': object({
    ...byId,
    object: OFFER,
    operation: 'update',
    button: noButton('失效按对象编辑开关'),
    scope: point,
    fields: record,
    write: commandOnly(['revision', 'offer.invalidation', 'offer.invalidReasonEnabled']),
  }),
  'GET /:id/send-check': object({
    ...byId,
    object: OFFER,
    operation: 'view',
    button: noButton('只读判定'),
    scope: point,
    fields: fixed(['id', 'offerType', 'allowed', 'reason'], 'OF-R3 发送判定固定键'),
  }),
});
