/**
 * 登记表的常用构造器（F-039 PR-A）：让 228 条现状声明写得短而一致。只是 §2.1 类型的对象字面量快捷写法，
 * 不含任何授权逻辑；每个名称（守卫 / 定位器 / 谓词 / 投影器 / 前提）都只是登记，实现随接管 PR（§10）。
 */
import type { AdminCapability } from '@italent/domain';
import type {
  ButtonLevel,
  ButtonPolicy,
  ButtonRef,
  Denial,
  FieldsFrom,
  FieldsPolicy,
  LedgerPolicy,
  ObjectPolicy,
  PolicyBase,
  RoutePolicy,
  ScopePolicy,
  Target,
  WritePolicy,
  WritePolicyBase,
} from './types.js';

// ---- 拒绝码 ---------------------------------------------------------------------------------------------------
export const NOT_FOUND: Denial = { status: 404, code: 'NOT_FOUND' };
export const BAD_REQUEST: Denial = { status: 400, code: 'VALIDATION_FAILED' };
export const FORBIDDEN: Denial = { status: 403, code: 'FORBIDDEN' };
export function denied(status: Denial['status'], code: Denial['code'], reason?: string): Denial {
  return reason === undefined ? { status, code } : { status, code, reason };
}

// ---- 各维度的「无」：都要写明原因 -----------------------------------------------------------------------------------
export function none(reason: string): { readonly none: true; readonly reason: string } {
  return { none: true, reason };
}
export function noFields(reason: string): FieldsPolicy {
  return { mode: 'none', reason };
}
export function noScope(reason: string): ScopePolicy {
  return { mode: 'none', reason };
}
export function noButton(reason: string): ButtonPolicy {
  return { none: true, reason };
}

// ---- 字段 / 范围 / 按钮 -----------------------------------------------------------------------------------------
export function shape(name: string): FieldsPolicy {
  return { mode: 'shape', shape: name };
}
export function projector(name: string, shapeName: string, format?: 'text/csv'): FieldsPolicy {
  return format
    ? { mode: 'projector', projector: name, shape: shapeName, format }
    : { mode: 'projector', projector: name, shape: shapeName };
}
export function fixed(keys: readonly string[], dec: string, intersect?: string): FieldsPolicy {
  return intersect ? { mode: 'fixed', keys, dec, intersect } : { mode: 'fixed', keys, dec };
}
export function allFields(dec: string): FieldsPolicy {
  return { mode: 'all', dec };
}
export function listScope(predicate: string, view?: string): ScopePolicy {
  return view ? { mode: 'list', predicate, view } : { mode: 'list', predicate };
}
export function pointScope(target: Target, locator: string, deniedAs: Denial, view?: string): ScopePolicy {
  return view
    ? { mode: 'point', target, locator, denied: deniedAs, view }
    : { mode: 'point', target, locator, denied: deniedAs };
}
export function seeAll(
  deniedAs: Denial | { readonly status: 200; readonly empty: true },
  options: { readonly view?: string; readonly creatorLocator?: string } = {},
): ScopePolicy {
  return { mode: 'see-all', denied: deniedAs, ...options };
}
export function guardScope(guard: string, deniedAs: Denial): ScopePolicy {
  return { mode: 'guard', guard, denied: deniedAs };
}
export const EMPTY_LIST = { status: 200, empty: true } as const;
export function button(code: string, level: ButtonLevel): ButtonRef {
  return { code, level };
}

// ---- 写策略 ---------------------------------------------------------------------------------------------------
export type WriteExtra = Partial<Pick<WritePolicyBase, 'controls' | 'commandOnly' | 'preconditions'>> & LedgerPolicy;
export function write(
  fields: FieldsFrom,
  footprint: WritePolicy['footprint'],
  result: WritePolicy['result'],
  extra: WriteExtra = {},
): WritePolicy {
  return { fields, footprint, result, ...extra };
}
/** 配置类写入口的现状：请求体是配置 DTO（无字段目录），事务内只有审计写入，配置对象无范围故返回后不复核。 */
export function configWrite(footprint: string, extra: WriteExtra = {}): WritePolicy {
  return write(none('配置 DTO，无字段目录'), footprint, none('配置对象无范围，返回后只投影'), extra);
}
/** 命令式按钮（submit / withdraw / revoke …）：不提取字段，只登记按钮与命令。 */
export function commandWrite(
  footprint: WritePolicy['footprint'],
  result: WritePolicy['result'],
  extra: WriteExtra = {},
): WritePolicy {
  return write(none('命令式按钮，不提取字段'), footprint, result, { commandOnly: true, ...extra });
}

// ---- 整条策略 -------------------------------------------------------------------------------------------------
export function publicRoute(
  reason: string,
  dec: string,
  guards: readonly string[],
  extra: PolicyBase = {},
): RoutePolicy {
  return { kind: 'public', reason, dec, guards, ...extra };
}
export function platform(extra: PolicyBase & { readonly fields?: FieldsPolicy } = {}): RoutePolicy {
  const { fields = noFields('平台 DTO，无字段目录'), ...rest } = extra;
  return { kind: 'platform', fields, ...rest };
}
export function member(reason: string, fields: FieldsPolicy, extra: PolicyBase = {}): RoutePolicy {
  return { kind: 'member', reason, fields, ...extra };
}
export function admin(
  capability: AdminCapability,
  extra: PolicyBase & { readonly alias?: string; readonly scope?: ScopePolicy; readonly fields?: FieldsPolicy } = {},
): RoutePolicy {
  const { fields = noFields('权限 / 配置 DTO 无字段目录，按能力整对象可见'), ...rest } = extra;
  return { kind: 'admin', capability, fields, ...rest };
}
export function object(spec: Omit<ObjectPolicy, 'kind'>): ObjectPolicy {
  return { kind: 'object', ...spec };
}
export function self(
  spec: PolicyBase & { readonly target?: Target; readonly button?: ButtonPolicy; readonly fields: FieldsPolicy },
): RoutePolicy {
  return { kind: 'self', ...spec };
}
export function own(
  spec: PolicyBase & {
    readonly predicate: string;
    readonly target?: Target;
    readonly locator?: string;
    readonly denied?: Denial;
    readonly fields: FieldsPolicy;
  },
): RoutePolicy {
  return { kind: 'own', ...spec };
}
export function relation(
  spec: PolicyBase & {
    readonly relation: string;
    readonly target: Target;
    readonly denied: Denial;
    readonly rows?: ObjectPolicy['rows'];
    readonly fields: FieldsPolicy;
  },
): RoutePolicy {
  return { kind: 'relation', ...spec };
}
export function exception(guard: string, dec: string, fields: FieldsPolicy, extra: PolicyBase = {}): RoutePolicy {
  return { kind: 'exception', guard, dec, fields, ...extra };
}
export function buttonOnly(
  objectCode: ObjectPolicy['object'],
  ref: Exclude<ButtonPolicy, { none: true }>,
  deniedAs: Denial,
  extra: PolicyBase = {},
): RoutePolicy {
  return { kind: 'button', object: objectCode, button: ref, denied: deniedAs, ...extra };
}
export function any(of: readonly RoutePolicy[], extra: PolicyBase = {}): RoutePolicy {
  return { kind: 'any', of, ...extra };
}
export function all(of: readonly RoutePolicy[], fields: FieldsPolicy, extra: PolicyBase = {}): RoutePolicy {
  return { kind: 'all', of, fields, ...extra };
}
