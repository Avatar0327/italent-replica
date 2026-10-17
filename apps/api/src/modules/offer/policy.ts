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
 * - 转移状态（C2，BE-14a2，transitions.ts）：行主按钮入口只认 OfferLineOpStatusTransfer@list_row，顶部工具栏入口只认
 *   Offer.StatusTransfer@list（DEC-533④ / 537③），不另设管理员越权（DEC-503）；失效按对象编辑开关；转移表单与 OF-R3
 *   发送判定是只读，按对象查看权与当前范围。
 */
import { OFFER_BUTTONS, OFFER_OBJECT } from '@italent/domain';
import { defineTable, type PolicyBase, type RoutePolicy } from '../../route-policy/index.js';
import {
  admin,
  all,
  BAD_REQUEST,
  button,
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
const commandOnly = (preconditions: readonly string[]) =>
  commandWrite('offer.commandGuard', RESULT, { ledger: 'single', preconditions });
const ROW_TRANSFER = button(OFFER_BUTTONS.lineStatusTransfer.code, OFFER_BUTTONS.lineStatusTransfer.level);
const TOOLBAR_TRANSFER = button(OFFER_BUTTONS.statusTransfer.code, OFFER_BUTTONS.statusTransfer.level);

/**
 * 列表 / 详情的行操作与工具栏披露（BE-14a2）：只决定 rowActions / toolbarActions 里出现哪些已接线动作，不参与准入。
 * 转移按行级按钮、工具栏转移按列表级按钮，编辑与失效按编辑开关，删除按删除开关，复制按新增开关。
 */
const disclose = (operation: 'update' | 'delete' | 'create', key: string) =>
  object({
    object: OFFER,
    operation,
    button: noButton('只判数据操作开关'),
    scope: noScope('只判开关，行本身已按范围裁剪'),
    fields: noFields(`只决定 ${key}`),
  });
const ACTION_DISCLOSURE = {
  rowTransfer: object({
    object: OFFER,
    operation: 'button',
    button: ROW_TRANSFER,
    scope: noScope('只判按钮'),
    fields: noFields('只决定行操作 transfer'),
  }),
  toolbarTransfer: object({
    object: OFFER,
    operation: 'button',
    button: TOOLBAR_TRANSFER,
    scope: noScope('只判按钮'),
    fields: noFields('只决定 toolbarActions'),
  }),
  rowUpdate: disclose('update', '行操作 edit / invalidate'),
  rowDelete: disclose('delete', '行操作 delete'),
  rowCopy: disclose('create', '行操作 copy'),
};

/** 转移状态：两个入口各认一项按钮，规则相同（状态守卫、表单必填、拒绝原因须为启用字典项）。 */
function transfer(ref: ReturnType<typeof button>): RoutePolicy {
  return object({
    ...byId,
    object: OFFER,
    operation: 'update',
    button: ref,
    scope: point,
    fields: record,
    write: commandOnly(['revision', 'offer.transition', 'offer.refusalReasonEnabled']),
  });
}

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
    optional: ACTION_DISCLOSURE,
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
    optional: ACTION_DISCLOSURE,
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
  // 转移表单：可选目标 + 已保存的拒绝时间 / 原因 / 备注（退回待发后详情不显示，这里带出原值，DEC-532①）
  'GET /:id/transfer-form': object({
    ...byId,
    object: OFFER,
    operation: 'view',
    button: noButton('只读表单数据'),
    scope: point,
    fields: shape('offer.transferForm'),
  }),
  // OF-R3 发送前拦截判定（发送动作在 BE-14b）：id / offerType 按字段查看权裁剪，allowed / reason 为判定结果
  'GET /:id/send-check': object({
    ...byId,
    object: OFFER,
    operation: 'view',
    button: noButton('只读判定'),
    scope: point,
    fields: shape('offer.sendCheck'),
  }),
  'POST /:id/transfer': transfer(ROW_TRANSFER),
  'POST /:id/toolbar-transfer': transfer(TOOLBAR_TRANSFER),
  // 失效：已发、已接受、非实习类待发可失效（OF-R7）；原因须为启用字典项；有待入职 → 409 OFFER_SYNC_NOT_READY
  'POST /:id/invalidate': object({
    ...byId,
    object: OFFER,
    operation: 'update',
    button: noButton('失效按对象编辑开关'),
    scope: point,
    fields: record,
    write: commandOnly(['revision', 'offer.invalidation', 'offer.invalidReasonEnabled']),
  }),
  // 立即同步待入职（BE-14b2，OF-R8）：已接受（或时机为发送时的已发）才可；已同步重复点击幂等；同步失败也是 200（记在 Offer 上）
  'POST /:id/sync': object({
    ...byId,
    object: OFFER,
    operation: 'update',
    button: noButton('立即同步按对象编辑开关；对人员 / 任职的写入是受控的系统联动，不要求操作人有人员范围（F-201②）'),
    scope: point,
    fields: record,
    write: commandOnly(['revision', 'offer.syncState', 'offer.syncInternConversion']),
  }),
  // 关联 / 解除关联在职实习生：待发 / 已发可改；对象须是实习生且在操作人当前人员范围内
  'POST /:id/link-employee': object({
    ...byId,
    object: OFFER,
    operation: 'update',
    button: noButton('关联按对象编辑开关'),
    scope: point,
    fields: record,
    write: commandOnly(['revision', 'offer.linkable', 'offer.linkedInternScope']),
  }),
});
