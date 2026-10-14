/** DEC-409⑦ / F-089：只规范集合型权限项，不把其他业务数组当集合。 */
import type { ObjectPermission } from '@italent/domain';

const PROFILE_SETS = { apps: [], fields: ['fieldCode'], buttons: ['buttonCode', 'level'] } as const;
const ORG_SETS = { orgRanges: ['orgId', 'dimension'] } as const;
const PERMISSION_SETS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  permission_profile: PROFILE_SETS,
  permission_admin: { grantableAdminRoles: [], grantableProfileIds: [] },
  permission_mou: ORG_SETS,
  permission_user_app_scope: ORG_SETS,
  permission_scope_app: { allowedKinds: [] },
  permission_scope_policy: { rules: ['dimension', 'roleCode', 'relationMode'] },
};

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

/** 成员的完整值参与去重；同编码但权限值、级别、维度或关系不同的成员不能被吞掉。 */
export function permissionSet<T>(items: readonly T[], keys: readonly string[] = []): T[] {
  const members = items.map((item) => {
    // 集合成员是标量或固定字段记录；统一属性顺序，避免 JSON 差异比较受对象键顺序影响。
    const value = isRecord(item)
      ? (Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        ) as T)
      : item;
    return { value, text: JSON.stringify(value) };
  });
  const unique = [...new Map(members.map((member) => [member.text, member])).values()];
  unique.sort((a, b) => {
    for (const key of keys) {
      const left = isRecord(a.value) ? String(a.value[key] ?? '') : '';
      const right = isRecord(b.value) ? String(b.value[key] ?? '') : '';
      const order = compare(left, right);
      if (order) return order;
    }
    return compare(a.text, b.text);
  });
  return unique.map((member) => member.value);
}

export function objectPermissionSets<T extends ObjectPermission>(permission: T): T {
  return {
    ...permission,
    fields: permissionSet(permission.fields, PROFILE_SETS.fields),
    buttons: permissionSet(permission.buttons, PROFILE_SETS.buttons),
  };
}

/** 权限审计和范围版本快照共用一个入口；技术字段、非集合字段保持原值。 */
export function permissionSnapshot(objectType: string, snapshot: unknown): unknown {
  const sets = PERMISSION_SETS[objectType];
  if (!sets || !isRecord(snapshot)) return snapshot;
  const normalized = { ...snapshot };
  for (const [field, keys] of Object.entries(sets)) {
    const value = normalized[field];
    if (Array.isArray(value)) normalized[field] = permissionSet(value, keys);
  }
  return normalized;
}
