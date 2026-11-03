/**
 * DEC-691 D5 / D6：身份来源展开为全部有效成员。成员口径沿用既有身份规则，不另建一套：
 * 手工 / 自动授权读有效授权行（撤权即时生效），标准自动持有“员工”按全体账号成立（auto-held.ts），
 * 经理自助无授权行，按 asOf 当天的负责人 / 直属下级即时派生（manager-identity.ts 的同一口径，此处按集合查）。
 * 来源层不截断（逐批取资格），合并后的 100 人上限由 limitApprovers 统一处理。
 */
import { sql, type Tx } from '@italent/db';
import { identityProfileId, type ApproverSource, type Candidate } from '@italent/domain';
import { isAutoHeld } from '../permission/auto-held.js';
import { MANAGER_PROFILE_CODE } from '../permission/manager-identity.js';
import { currentPersons } from '../permission/scope-persons.js';
import { rowsOf } from './context.js';
import { eligibleDesignerPeople } from './designer-people.js';
import type { RoutingSubject } from './resolver.js';

const BATCH = 500;
const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

async function memberUserIds(tx: Tx, subject: RoutingSubject, profile: { id: string; code: string; source: string }) {
  const { tenantId, asOf } = subject;
  const users = async (query: Promise<unknown>) => rowsOf<{ user_id: string }>(await query).map((row) => row.user_id);
  if (isAutoHeld(profile))
    return users(tx.execute(sql`SELECT user_id FROM permission_user_person_links WHERE tenant_id=${tenantId}`));
  const ids = new Set(
    await users(
      tx.execute(sql`SELECT DISTINCT user_id FROM permission_grants
        WHERE tenant_id=${tenantId} AND profile_id=${profile.id}::uuid AND status='active'`),
    ),
  );
  if (profile.code !== MANAGER_PROFILE_CODE) return [...ids];
  const derived = tx.execute(sql`SELECT l.user_id FROM permission_user_person_links l
    WHERE l.tenant_id=${tenantId} AND (
      l.employee_id IN (SELECT person_in_charge_id FROM (SELECT DISTINCT ON (org_id) org_id,person_in_charge_id
        FROM org_versions WHERE tenant_id=${tenantId} AND start_date<=${asOf}::date AND enabled
        ORDER BY org_id,start_date DESC,version_no DESC) v WHERE person_in_charge_id IS NOT NULL)
      OR l.employee_id IN (SELECT p.direct_manager_id FROM (${currentPersons(tenantId, asOf)}) p
        WHERE p.direct_manager_id IS NOT NULL AND p.direct_manager_id<>p.employee_id
          AND p.kind NOT IN ('leave','retirement')))`);
  for (const userId of await users(derived)) ids.add(userId);
  return [...ids];
}

export async function resolveIdentity(tx: Tx, subject: RoutingSubject, source: ApproverSource): Promise<Candidate[]> {
  const profileId = identityProfileId(source);
  if (!profileId) return [];
  const [profile] = rowsOf<{ id: string; code: string; source: string }>(
    await tx.execute(sql`SELECT id,code,source FROM permission_profiles
      WHERE tenant_id=${subject.tenantId} AND id=${profileId}::uuid`),
  );
  if (!profile) return [];
  const members = await memberUserIds(tx, subject, profile);
  const found: Candidate[] = [];
  for (let from = 0; from < members.length; from += BATCH) {
    const batch = members.slice(from, from + BATCH);
    // 资格与指定人员保存同一入口：在职内部账号；未绑定人员档案的账号不作为审批人（见 DEC-691 D6 假设）。
    const eligible = await eligibleDesignerPeople(tx, subject.tenantId, {
      userIds: batch,
      limit: batch.length,
      offset: 0,
      asOf: subject.asOf,
    });
    const links = rowsOf<{ user_id: string; employee_id: string }>(
      await tx.execute(sql`SELECT user_id,employee_id FROM permission_user_person_links
        WHERE tenant_id=${subject.tenantId} AND user_id=ANY(${uuidArray(eligible.map((p) => p.userId))})`),
    );
    const person = new Map(links.map((link) => [link.user_id, link.employee_id]));
    for (const { userId } of eligible) found.push({ personId: person.get(userId) ?? null, userId });
  }
  return found;
}
