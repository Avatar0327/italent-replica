/**
 * 授权替身（F-039 PR-B4a，docs/08_设计/F-039_PR-B_设计.md B-08「授权替身」）：测试内替换 createApp 的 `authorize`，
 * 并经 registerScopeProvider 登记范围 / 字段提供器（只读引用产品内部导出，零行为变化，§1.2）。
 *   authorize(request)      按"授权集"回答：集内允许、集外拒绝（缺省全允许）；记录 action / resource / fields；
 *                           事务内绑定版本（authorizeInTransaction → provider.authorize）同样回答、同样记录；
 *   provider.scope(query)   按配置返回 all / 空 / 指定组织，记录查询；
 *   provider.fields(…)      按配置返回全部 / 去掉某对象或某字段，记录查询；
 *   身份                    由调用方提供一个真实租户成员；关系、本人绑定、成员资格等数据态维度不经授权器。
 * 授权集里的键用显式表的权限键语言（可带 `{a,b}` 集合与 `{mapper:…}`，按 permClaims 认领），所以探测器可以直接
 * 把表备选的准入权限当授权集。映射不了的动作：全允许模式下放行并记入 unmapped（由发现检查报
 * PROBE_ACTION_UNMAPPED），授权集模式下一律拒绝（fail-closed）。
 */
import type { AuthorizationRequest, Authorizer } from '@italent/api';
import { objectCatalog } from '../../../../apps/api/src/modules/permission/catalog.js';
import { registerScopeProvider } from '../../../../apps/api/src/modules/permission/module-access.js';
import {
  EMPTY_SCOPE,
  type ModuleScope,
  type ScopeQuery,
} from '../../../../apps/api/src/modules/permission/scope-types.js';
import { type MappedRequest, mapRequest, permClaims } from './request-perms.js';

export interface DoubleConfig {
  /**
   * 可信注入兼容分支（data.scope.all 经 authorize 直接问）的回答，缺省 false：真实 decide() 对该动作返回 false，
   * 全范围走 provider.scope（第 2 轮 P2-2）。要测可信注入分支时显式置 true。
   */
  readonly trustedScopeAll?: boolean;
  /** 缺省 / 'all' = 全允许；数组 = 授权集（表权限键语言）。 */
  readonly grants?: 'all' | readonly string[];
  /** 缺省 'all'。 */
  readonly scope?: 'all' | 'empty' | { readonly orgIds: readonly string[] };
  readonly fields?: {
    /** 这些对象的全部字段都不可见。 */
    readonly hideObjects?: readonly string[];
    /** 对象 → 不可见的字段。 */
    readonly hideFields?: Readonly<Record<string, readonly string[]>>;
  };
}

export interface DoubleRequest {
  readonly via: 'authorize' | 'transaction';
  readonly action: string;
  readonly resource?: string;
  readonly fields?: readonly string[];
  readonly mapped: MappedRequest;
  readonly allowed: boolean;
}
export interface FieldQuery {
  readonly objectCode: string;
  readonly inTransaction: boolean;
}

export interface AuthorizerDouble {
  readonly authorize: Authorizer;
  /** 替换整个配置（含清空 revoke）；不清记录。 */
  configure(config: DoubleConfig): void;
  /** 单独撤一个键（表权限键语言）：全允许与授权集模式都生效。 */
  revoke(key: string): void;
  /** 只清记录，不清配置。 */
  reset(): void;
  readonly requests: readonly DoubleRequest[];
  readonly scopeQueries: readonly ScopeQuery[];
  readonly fieldQueries: readonly FieldQuery[];
  /** 被问到的授权器权限键（排序去重，不论是否允许）。 */
  permKeys(): string[];
  /** 范围类问题：data.scope.all 请求与范围提供器查询，规范成稳定字符串（排序去重）。 */
  scopeKeys(): string[];
  fieldKeys(): string[];
  /** 映射不了的授权动作（排序去重）。 */
  unmapped(): string[];
}

const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort();

export function createAuthorizerDouble(initial: DoubleConfig = {}): AuthorizerDouble {
  let config = initial;
  let revoked: readonly string[] = [];
  const requests: DoubleRequest[] = [];
  const scopeQueries: ScopeQuery[] = [];
  const fieldQueries: FieldQuery[] = [];

  const scopeAnswer = (): ModuleScope => {
    const scope = config.scope ?? 'all';
    if (scope === 'all') return { ...EMPTY_SCOPE, all: true, hasDataPermission: true, source: 'identity' };
    if (scope === 'empty') return EMPTY_SCOPE;
    const term = { dimension: 'organization' as const, orgIds: scope.orgIds, personIds: [] };
    return {
      ...EMPTY_SCOPE,
      orgIds: scope.orgIds,
      hasDataPermission: true,
      terms: [term],
      source: 'identity',
    };
  };

  /**
   * 字段语义与真实 decide() 一致：object.create / update（含 tenant.* 写别名）必须给出字段集，且每个字段都可编辑
   * （对象已登记、非系统字段、未被隐藏）；缺字段集即拒绝。全允许的发现模式且没有字段配置时不按静态目录限制
   * （租户自定义字段不在静态目录里，B4b / B5 接入样本前补齐），其余情况一律严格判定。
   */
  const fieldsAllowed = (mapped: MappedRequest, request: AuthorizationRequest): boolean => {
    if (mapped.kind !== 'perm' || !/^obj:.+:(create|update)$/.test(mapped.key)) return true;
    if ((config.grants ?? 'all') === 'all' && config.fields === undefined) return true;
    if (request.fields === undefined) return false;
    const objectCode = mapped.key.slice('obj:'.length, mapped.key.lastIndexOf(':'));
    const editable = visibleFields(objectCode, true);
    return request.fields.every((field) => editable.has(field));
  };

  const allowed = (mapped: MappedRequest): boolean => {
    const grants = config.grants ?? 'all';
    if (mapped.kind === 'scope') return config.trustedScopeAll === true;
    if (mapped.kind === 'unmapped') return grants === 'all';
    if (revoked.some((key) => permClaims(key, mapped.key))) return false;
    return grants === 'all' || grants.some((key) => permClaims(key, mapped.key));
  };

  const answer = (request: AuthorizationRequest, via: DoubleRequest['via']): boolean => {
    const mapped = mapRequest(request);
    const verdict = allowed(mapped) && fieldsAllowed(mapped, request);
    requests.push({
      via,
      action: request.action,
      ...(request.resource === undefined ? {} : { resource: request.resource }),
      ...(request.fields === undefined ? {} : { fields: request.fields }),
      mapped,
      allowed: verdict,
    });
    return verdict;
  };

  const visibleFields = (objectCode: string, editable: boolean): ReadonlySet<string> => {
    const { hideObjects = [], hideFields = {} } = config.fields ?? {};
    if (hideObjects.includes(objectCode)) return new Set();
    const hidden = new Set(hideFields[objectCode] ?? []);
    const definition = objectCatalog.get(objectCode);
    // 系统字段只读：可查看但不可编辑（与真实授权器的有效字段口径一致）
    return new Set(
      (definition?.fields ?? []).filter((f) => !hidden.has(f.code) && !(editable && f.system)).map((f) => f.code),
    );
  };

  const authorize: Authorizer = (request) => answer(request, 'authorize');
  registerScopeProvider(authorize, {
    authorize: async (request) => answer(request, 'transaction'),
    scope: async (query) => {
      scopeQueries.push(query);
      return scopeAnswer();
    },
    fields: async (_tenantId, _userId, objectCode, tx) => {
      fieldQueries.push({ objectCode, inTransaction: tx !== undefined });
      return visibleFields(objectCode, false);
    },
    editableFields: async (_tenantId, _userId, objectCode) => visibleFields(objectCode, true),
  });

  return {
    authorize,
    configure(next) {
      config = next;
      revoked = [];
    },
    revoke(key) {
      revoked = [...revoked, key];
    },
    reset() {
      requests.length = 0;
      scopeQueries.length = 0;
      fieldQueries.length = 0;
    },
    requests,
    scopeQueries,
    fieldQueries,
    permKeys: () => sortedUnique(requests.flatMap((r) => (r.mapped.kind === 'perm' ? [r.mapped.key] : []))),
    scopeKeys: () =>
      sortedUnique([
        ...requests.flatMap((r) => (r.mapped.kind === 'scope' ? [r.mapped.key] : [])),
        ...scopeQueries.map((q) => `scope:${q.appCode}/${q.objectCode ?? '-'}/${q.pageCode ?? '-'}`),
      ]),
    fieldKeys: () => sortedUnique(fieldQueries.map((q) => `fields:${q.objectCode}`)),
    unmapped: () => sortedUnique(requests.filter((r) => r.mapped.kind === 'unmapped').map((r) => r.action)),
  };
}
