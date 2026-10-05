/** Relational scope results; approval participation is deliberately absent (DEC-057). */
export interface ScopeTerm {
  readonly dimension: 'management' | 'organization' | 'reporting' | 'using_user';
  readonly orgIds: readonly string[];
  readonly personIds: readonly string[];
  /** Parameters for a correlated SQL predicate; personnel sets are never materialized in application memory. */
  readonly personQuery?:
    | { readonly kind: 'organization'; readonly tenantId: string; readonly asOf: string }
    | {
        readonly kind: 'reporting';
        readonly tenantId: string;
        readonly asOf: string;
        readonly managerId: string;
        readonly mode: string;
      };
  readonly creatorId?: string;
}
export interface ModuleScope {
  readonly orgIds: readonly string[];
  readonly personIds: readonly string[];
  readonly all: boolean;
  readonly hasDataPermission: boolean;
  readonly terms?: readonly ScopeTerm[];
  readonly source?: 'identity' | 'entity' | 'page' | 'datasource';
}
export const EMPTY_SCOPE: ModuleScope = {
  orgIds: [],
  personIds: [],
  all: false,
  hasDataPermission: false,
  terms: [],
  source: 'entity',
};
export interface ScopeQuery {
  readonly tenantId: string;
  readonly userId: string;
  readonly appCode: string;
  readonly asOf: string;
  readonly objectCode?: string;
  readonly pageCode?: string;
  readonly dataSourceCode?: string;
  /**
   * 路由自带的附加“看全部”目标（数据源类）：只参与身份看全部判定，不参与页面 / 数据源策略的选择。
   * 编制方案用它承接 DEC-121 的开通预置，而不改变既有的页面 / 数据源编码与其上的配置（PR #60 P2-7）。
   */
  readonly viewCode?: string;
}
