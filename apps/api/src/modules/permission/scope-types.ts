/** Relational scope results; approval participation is deliberately absent (DEC-057). */
export interface ScopeTerm {
  readonly dimension: 'management' | 'organization' | 'reporting' | 'using_user';
  readonly orgIds: readonly string[];
  readonly personIds: readonly string[];
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
}
