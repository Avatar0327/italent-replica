/** DEC-327：只取当前账号头像；调用方负责原人员范围与姓名字段裁剪。 */
import { isUuid, sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { rowsOf } from '../employment/record-store.js';

export interface AvatarReference {
  readonly id: string;
  readonly url: string;
}
export const avatarReference = (id: string): AvatarReference => ({ id, url: `/api/tenant/avatars/${id}/content` });

export function avatarSql(tenantId: string | SQL, userId: SQL) {
  return sql`(SELECT jsonb_build_object('id',a.id,'url','/api/tenant/avatars/'||a.id||'/content')
    FROM account_avatar_attachments a JOIN tenant_memberships m ON m.tenant_id=a.tenant_id AND m.user_id=a.user_id
    WHERE a.tenant_id=${tenantId} AND a.user_id=${userId} AND a.status='uploaded' AND m.status='active')`;
}

export function employeeAvatarSql(tenantId: string, employeeId: SQL) {
  return avatarSql(
    tenantId,
    sql`(SELECT l.user_id FROM permission_user_person_links l
    WHERE l.tenant_id=${tenantId} AND l.employee_id=${employeeId})`,
  );
}

export async function userAvatars(tx: Tx, tenantId: string, userIds: readonly string[]) {
  const ids = [...new Set(userIds.filter(isUuid).map((id) => id.toLowerCase()))];
  if (!ids.length) return new Map<string, AvatarReference | null>();
  const rows = rowsOf<{ id: string; avatar: AvatarReference | null }>(
    await tx.execute(sql`
    SELECT m.user_id AS id,${avatarSql(tenantId, sql`m.user_id`)} AS avatar FROM tenant_memberships m
    WHERE m.tenant_id=${tenantId} AND m.user_id=ANY(${`{${ids.join(',')}}`}::uuid[])`),
  );
  return new Map(rows.map((r) => [r.id, r.avatar]));
}

export async function employeeAvatars(tx: Tx, tenantId: string, employeeIds: readonly string[]) {
  const ids = [...new Set(employeeIds.filter(isUuid).map((id) => id.toLowerCase()))];
  if (!ids.length) return new Map<string, AvatarReference | null>();
  const rows = rowsOf<{ id: string; avatar: AvatarReference | null }>(
    await tx.execute(sql`
    SELECT l.employee_id AS id,${avatarSql(tenantId, sql`l.user_id`)} AS avatar
    FROM permission_user_person_links l WHERE l.tenant_id=${tenantId}
      AND l.employee_id=ANY(${`{${ids.join(',')}}`}::uuid[])`),
  );
  return new Map(rows.map((r) => [r.id, r.avatar]));
}

export async function personAvatars(tx: Tx, tenantId: string, personIds: readonly string[]) {
  const ids = [...new Set(personIds.filter(isUuid).map((id) => id.toLowerCase()))];
  if (!ids.length) return new Map<string, AvatarReference | null>();
  const rows = rowsOf<{ id: string; avatar: AvatarReference | null }>(
    await tx.execute(sql`
    SELECT p.id,${avatarSql(tenantId, sql`l.user_id`)} AS avatar FROM survey360_people p
    LEFT JOIN permission_user_person_links l ON l.tenant_id=p.tenant_id AND l.employee_id=p.employee_id
    WHERE p.tenant_id=${tenantId} AND p.id=ANY(${`{${ids.join(',')}}`}::uuid[])`),
  );
  return new Map(rows.map((r) => [r.id, r.avatar]));
}
