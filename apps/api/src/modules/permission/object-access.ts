/**
 * 对象访问判定的唯一入口（DEC-469）：/me/objects/:objectCode、/me/snapshot 与授权器的 object.view 共用这一份口径。
 *   - 配置类对象（任职 / 合同设置）不走身份对象清单，按企业管理员能力判定（authorizer 历来如此），
 *     允许时可查看全部字段、可新增 / 编辑非系统字段，不可删除、没有按钮；
 *   - 其他对象按用户全部有效身份（含经理默认身份）的对象清单并集判定，只认身份登记了对象所属应用的权限（应用边界）。
 */
import { and, eq, permissionAdmins, type Tx } from '@italent/db';
import {
  decide,
  MODULE_OBJECTS,
  type ObjectCatalog,
  type ObjectDefinition,
  type PermissionSubject,
  type ResolvedObjectPermission,
  resolveObjectPermission,
} from '@italent/domain';

export const CONFIG_OBJECTS: ReadonlySet<string> = new Set<string>([
  MODULE_OBJECTS.employmentSettings.code,
  MODULE_OBJECTS.employmentCustomField.code,
  MODULE_OBJECTS.contractSettings.code,
  MODULE_OBJECTS.contractRules.code,
]);
const CONTRACT_CONFIG_OBJECTS: ReadonlySet<string> = new Set<string>([
  MODULE_OBJECTS.contractSettings.code,
  MODULE_OBJECTS.contractRules.code,
]);

/** 配置类对象的访问判定：合同设置类另认“合同配置”管理员记录，其余按 admin.other_settings。 */
export async function configAllowed(
  tx: Tx,
  userId: string,
  objectCode: string,
  subject: PermissionSubject,
  catalog: ObjectCatalog,
): Promise<boolean> {
  if (!CONTRACT_CONFIG_OBJECTS.has(objectCode)) return decide(subject, { action: 'admin.other_settings' }, catalog);
  if (subject.adminRoles.includes('tenant_admin')) return true;
  const records = await tx
    .select({ id: permissionAdmins.id })
    .from(permissionAdmins)
    .where(
      and(
        eq(permissionAdmins.userId, userId),
        eq(permissionAdmins.status, 'active'),
        eq(permissionAdmins.contractConfiguration, true),
      ),
    )
    .limit(1);
  return records.length > 0;
}

export type ObjectAccess =
  | { readonly kind: 'config'; readonly definition: ObjectDefinition }
  | { readonly kind: 'granted'; readonly resolved: ResolvedObjectPermission };

export interface ObjectAccessResolver {
  /** 当前用户对对象有查看权时返回访问详情；对象未登记、无权限一律返回 undefined。 */
  resolve(objectCode: string): Promise<ObjectAccess | undefined>;
}

/** subject 须由同一用户、同一请求内加载（含经理默认身份）；同一解析器内配置类判定按种类只查一次库。 */
export function createObjectAccess(
  tx: Tx,
  userId: string,
  subject: PermissionSubject,
  catalog: ObjectCatalog,
): ObjectAccessResolver {
  const config = new Map<boolean, Promise<boolean>>();
  const configGate = (objectCode: string) => {
    const contract = CONTRACT_CONFIG_OBJECTS.has(objectCode);
    if (!config.has(contract)) config.set(contract, configAllowed(tx, userId, objectCode, subject, catalog));
    return config.get(contract)!;
  };
  return {
    async resolve(objectCode) {
      const definition = catalog.get(objectCode);
      if (!definition) return undefined;
      if (CONFIG_OBJECTS.has(objectCode))
        return (await configGate(objectCode)) ? { kind: 'config', definition } : undefined;
      const resolved = resolveObjectPermission(objectCode, subject.objectPermissions, catalog);
      return resolved ? { kind: 'granted', resolved } : undefined;
    },
  };
}
