/**
 * 审计日志路由的现状声明（F-039 PR-A；附录 A「/api/tenant/audit」4 条，直接挂在租户路由器，键用完整路径）。
 * 四条都只读：auditContext → requirePermission('admin.audit_log')（8 类管理员矩阵，06 §7.1；AC-AUD-06，每次请求重验）。
 * 入口之内按 DEC-197 / DEC-203 由 visibility.ts 的 auditViewer 解析每种对象类型的查看权 + 当前数据范围 + 查看字段，
 * 把行级谓词放进 SQL WHERE、分页之前生效（谓词 audit.visibility；未登记的对象类型一律不返回，fail-closed），再按该对象
 * 的查看字段裁剪 changes / before / after / errorReport，并按可见明细重算汇总（投影器 audit.visibility）。时间条件按租户
 * 时区的业务日期并受保留期约束（queryWindow）。
 *
 * 与附录 A 的差异（按现状代码修正）：
 * - GET /command-failures：附录 A 写 list audit.failures；代码只有 failureFilters + 保留期窗口 + 游标（routes.ts），没有
 *   任何范围谓词——失败命令审计不含业务字段值、不按数据范围筛选（DEC-197），路径里的对象编号由 failureView 打码为 :id，
 *   故登记 noScope，打码归投影器 audit.failureView。
 * - GET /data-changes/:id：404 文案是「日志不存在或已超出保留期」（超出保留期、范围外、只涉及隐藏字段的日志与不存在同样
 *   处理），附录 A 简写为「日志不存在」。
 * 查询筛选（objectType / objectId / action / operation / actorUserId / field / commandId / behavior / outcome / cursor /
 * limit / from / to）格式非法 → 400 VALIDATION_FAILED：是筛选参数校验而非对象标识，列表路由不登记 invalidId。
 */
import { defineTable } from '../route-policy/index.js';
import { admin, BAD_REQUEST, listScope, noScope, NOT_FOUND, pointScope, projector } from '../route-policy/presets.js';

const BASE = '/api/tenant/audit';
/** 数据变更日志：changes 为 fieldEntries（field / from / to），content 由已裁剪的 changes 派生（derivedText，§3.5）。 */
const dataChange = projector('audit.visibility', 'audit.dataChange');

export const AUDIT_POLICIES = defineTable('audit', {
  // registerDataChanges：viewer.dataChanges 谓词（对象查看权 + 当前范围 + 未登记对象拒绝 + 至少一个可见字段变化；
  // field 筛选也进可见性）；visibleCount 让序码重算 / 组织调整的汇总人数按可见逐人日志重算（recounted）
  [`GET ${BASE}/data-changes`]: admin('audit_log', { scope: listScope('audit.visibility'), fields: dataChange }),
  // :id 非 UUID → 400 VALIDATION_FAILED「日志编号必须是 UUID」；同一谓词作用于单行 + notBefore(earliest) → 查不到 404；
  // 详情另带 before / after（visibleValue 按可见字段）与删除时的 snapshot
  [`GET ${BASE}/data-changes/:id`]: admin('audit_log', {
    invalidId: BAD_REQUEST,
    scope: pointScope({ param: 'id' }, 'audit.event', NOT_FOUND),
    fields: dataChange,
  }),
  // registerTaskLogs：viewer.operationLogs 谓词（逐行归属的任务至少一行可见；配置类型持能力即可见）；visibleRows 让
  // 汇总条数 / 结果 / 文案与 errorReport 只按可见行计算（visibleTask / visibleErrorReport）
  [`GET ${BASE}/operation-logs`]: admin('audit_log', {
    scope: listScope('audit.visibility'),
    fields: projector('audit.visibility', 'audit.operationLog'),
  }),
  // 失败命令三类审计（业务失败 / 存储不可写 / 结果未知）：无业务字段值；failureView 把 path 里的 UUID 打码为 :id
  [`GET ${BASE}/command-failures`]: admin('audit_log', {
    scope: noScope('失败命令审计不按数据范围筛选（DEC-197）：只有查询筛选、保留期窗口与游标；对象编号在投影器打码'),
    fields: projector('audit.failureView', 'audit.commandFailure'),
  }),
});
