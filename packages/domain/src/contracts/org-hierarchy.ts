/**
 * 车道契约：组织层级只读接口（docs/09_派发/R1-第1轮派发单.md §2）。
 * R1-T02 数据范围用它展开“包含下级”、判断组织是否启用；R1-T03 组织对象负责真实实现并附契约测试。
 * 本文件只放类型，不放实现；修改须走契约 PR。
 */
import type { IsoDate } from '../tenant-time.js';

/**
 * 组织内部主键。与业务编码（如 zz10224）分离，业务编码按租户唯一（DEC-060）。
 * 带品牌标记，防止与租户 ID、人员 ID 等其他字符串混用；由组织模块在读库时断言为 OrgId。
 */
export type OrgId = string & { readonly __brand: 'OrgId' };

/**
 * 组织维度：1 个恒在的行政维度 + 4 个可由租户开关的扩展维度（docs/02_业务建模/10 §8.2，G-013）。
 * 每个维度各自有上级与顺序号（AGENTS.md §2：不得只用单一 parent_id）。
 * 成本中心不是组织维度（SwitchType 90 为独立对象），不在此列。
 */
export const ORG_DIMENSIONS = [
  'admin', // 行政维度 POIdOrgAdmin（恒在）
  'business', // 业务维度 POIdOrgReserve2（SwitchType 88「业务组织」）
  'product', // 产品维度 POIdOrgReserve3（SwitchType 89「利润中心」，新建表单称「财务维度上级」，G-037）
  'reserve4', // 预留维度4 POIdOrgReserve4（SwitchType 91）
  'reserve5', // 预留维度5 POIdOrgReserve5（SwitchType 92）
] as const;

export type OrgDimension = (typeof ORG_DIMENSIONS)[number];

export interface OrgDescendantsQuery {
  readonly tenantId: string;
  readonly dimension: OrgDimension;
  readonly orgId: OrgId;
  /** 业务时点，按租户时区解释（DEC-056）；按该日有效的组织版本与上下级关系计算。 */
  readonly asOf: IsoDate;
}

/**
 * 是否展开已停用的组织。必填、不设默认值，调用方须按用途显式选择。
 * - false：已停用的组织及其整棵子树都不展开（若 orgId 本身已停用则返回空数组）；
 * - true：按层级全部展开，不看启用状态。
 * 数据范围展开（R1-T02）按 DEC-146（D-6 已决，`11` §18）一律传 true：范围内组织停用不使数据范围收缩；
 * 选择器等“能否选这个组织”的场景按各自规则过滤停用组织，与数据范围无关。
 */
export interface OrgDescendantsOptions {
  readonly includeDisabled: boolean;
}

export interface OrgEnabledQuery {
  readonly tenantId: string;
  readonly orgId: OrgId;
  /** 业务时点，按租户时区解释（DEC-056）。 */
  readonly asOf: IsoDate;
}

/**
 * 组织层级只读接口。所有方法都必须限定在 tenantId 内（AGENTS.md §2 租户隔离）。
 * 约定（实现方须由契约测试覆盖）：
 * - 组织在 asOf 不存在、属于其他租户、或维度未开启时：listDescendantIds 返回空数组，isEnabled 返回 false（fail-closed）；
 * - listDescendantIds 返回全部层级的下级（传递闭包），不含 orgId 本身，结果不含重复 ID；
 *   已停用组织是否展开由 options.includeDisabled 显式决定（见 OrgDescendantsOptions）；
 * - 是否启用是组织本身的状态，与维度无关。
 */
export interface OrgHierarchyReader {
  listDescendantIds(query: OrgDescendantsQuery, options: OrgDescendantsOptions): Promise<readonly OrgId[]>;
  isEnabled(query: OrgEnabledQuery): Promise<boolean>;
}
