/**
 * 授权请求 ↔ 权限键映射（F-039 PR-B4a，docs/08_设计/F-039_PR-B_设计.md B-08「请求 ↔ 权限键映射」）。
 * 授权替身收到的每个请求先映射成显式表（required/types.ts）的权限键语言，再与表里的义务比较：
 *   object.<op> + 资源        → obj:<对象>:<op>
 *   object.button + 按钮资源   → btn:<对象>#<按钮>@<层级>
 *   admin.<能力>              → admin:<能力>
 *   tenant.* 别名             → 取 @italent/domain 的 MODULE_ACTIONS（授权器用同一常量，不手抄）
 *   data.scope.all           → 范围查询，不是权限键（scope:…）
 * 映射不了的动作报 PROBE_ACTION_UNMAPPED（由发现探测检查器报出）。审计用的 action 字段不经授权器，不受影响。
 */
import type { AuthorizationRequest } from '@italent/api';
import { BUTTON_LEVELS, MODULE_ACTIONS, type ModuleAction } from '@italent/domain';

export type MappedRequest =
  | { readonly kind: 'perm'; readonly key: string }
  | { readonly kind: 'scope'; readonly key: string }
  | { readonly kind: 'unmapped'; readonly reason: string };

const OBJECT_ACTIONS: Readonly<Record<string, string>> = {
  'object.view': 'view',
  'object.create': 'create',
  'object.update': 'update',
  'object.delete': 'delete',
};
const BUTTON_RESOURCE = new RegExp(`^([^#]+)#([^@]+)@(${BUTTON_LEVELS.join('|')})$`);
const SCOPE_ACTION = 'data.scope.all';

/** `aliases` 缺省取 MODULE_ACTIONS；夹具传 `{}` 模拟"删掉映射"。 */
export function mapRequest(
  request: Pick<AuthorizationRequest, 'action' | 'resource'>,
  aliases: Readonly<Record<string, ModuleAction>> = MODULE_ACTIONS,
): MappedRequest {
  const { action, resource } = request;
  if (action === SCOPE_ACTION) return { kind: 'scope', key: `scope:${SCOPE_ACTION}:${resource ?? ''}` };
  if (action.startsWith('admin.')) {
    const capability = action.slice('admin.'.length);
    return capability ? { kind: 'perm', key: `admin:${capability}` } : unmapped(`${action}：缺能力名`);
  }
  if (action === 'object.button') {
    return BUTTON_RESOURCE.test(resource ?? '')
      ? { kind: 'perm', key: `btn:${resource}` }
      : unmapped(`object.button 资源格式不对：${resource ?? '（空）'}`);
  }
  const operation = OBJECT_ACTIONS[action];
  if (operation !== undefined) {
    return resource ? { kind: 'perm', key: `obj:${resource}:${operation}` } : unmapped(`${action}：缺资源`);
  }
  const alias = aliases[action];
  if (!alias) return unmapped(`${action}：不在 MODULE_ACTIONS`);
  return alias.kind === 'admin'
    ? { kind: 'perm', key: `admin:${alias.capability}` }
    : { kind: 'perm', key: `obj:${alias.objectCode}:${alias.operation}` };
}

const unmapped = (reason: string): MappedRequest => ({ kind: 'unmapped', reason });

/** 在大括号之外按第一个分隔符切开（`{mapper:x}` 里的冒号不算）。 */
function splitTop(text: string, separator: string): readonly [string, string] | undefined {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === separator && depth === 0) return [text.slice(0, i), text.slice(i + 1)];
  }
  return undefined;
}

/** 表里的一个位置：单值、`{a,b}` 集合，或 `{mapper:…}` / `{record:…}`（运行时求值，认领任意取值）。 */
function specMatches(spec: string, value: string): boolean {
  if (!spec.startsWith('{')) return spec === value;
  const inner = spec.slice(1, -1);
  if (inner.startsWith('mapper:') || inner.startsWith('record:')) return true;
  return inner.split(',').includes(value);
}

/**
 * 表里的权限键 `tablePerm` 是否认领（即登记了）请求键 `requestKey`。非授权器维度（rel / guard / own / self /
 * exception）从不认领授权器请求。`btn:self#…` 是本人叠加授权的按钮：认领任意对象的同名按钮。
 */
export function permClaims(tablePerm: string, requestKey: string): boolean {
  const [dim = '', rest = ''] = splitTop(tablePerm, ':') ?? [];
  const [requestDim = '', requestRest = ''] = splitTop(requestKey, ':') ?? [];
  if (dim !== requestDim) return false;
  if (dim === 'admin') return rest === requestRest;
  const separators: Readonly<Record<string, string>> = { obj: ':', btn: '#' };
  const separator = separators[dim];
  if (!separator) return false;
  const table = splitTop(rest, separator);
  const request = splitTop(requestRest, separator);
  if (!table || !request) return false;
  const objectMatches = dim === 'btn' && table[0] === 'self' ? true : specMatches(table[0], request[0]);
  return objectMatches && specMatches(table[1], request[1]);
}
