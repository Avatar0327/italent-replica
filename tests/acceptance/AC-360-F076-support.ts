/**
 * F-076 PR-1 验收夹具：凭据配置覆盖、链接 / 邀请 / 安全事件读取。
 * 测试数据一律合成；序列号、密码只在测试进程内存里出现（从 outbox 的 sealed 解封），不写日志。
 */
import { sql, withTenant } from '@italent/db';
import {
  credentialConfig,
  overrideCredentialConfig,
  type CredentialConfig,
} from '../../apps/api/src/modules/survey360/credential-config.js';
import { openSealed } from '../../apps/api/src/modules/survey360/secret-box.js';
import type { World360 } from './AC-360-support.js';

export const rowsOf = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

/** 打开 / 关闭作答凭据开关（SURVEY360_PORTAL_CREDENTIALS）；其余配置沿用测试进程的随机密钥。 */
export function portalCredentials(on: boolean, patch: Partial<CredentialConfig> = {}): void {
  overrideCredentialConfig({ portalCredentials: on, ...patch });
}

export function resetCredentialConfig(): void {
  overrideCredentialConfig(undefined);
}

export interface LinkRow {
  id: string;
  person_id: string;
  kind: string;
  revoked: boolean;
  credential_state: string;
  serial_lookup: string | null;
  password_hash: string | null;
  credential_key_version: number | null;
  credential_key_versions: number[];
  credential_claimed_at: string | null;
  credential_attempts: number;
  credential_error: string | null;
}

export async function linkRows(w: World360, activityId: string, kind = 'answer'): Promise<LinkRow[]> {
  return rowsOf<LinkRow>(
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`SELECT id, person_id, kind, revoked, credential_state, serial_lookup, password_hash,
          credential_key_version, credential_key_versions, credential_claimed_at, credential_attempts, credential_error
        FROM survey360_links WHERE activity_id = ${activityId}::uuid AND kind = ${kind} ORDER BY created_at, id`),
    ),
  );
}

export interface Mail {
  id: string;
  state: string;
  event_type: string;
  payload: Record<string, unknown>;
  /** 解封后的秘密字段；没有 sealed（如 report_forward）时为空对象。 */
  secrets: { token?: string; serial?: string; password?: string };
}

/** 邀请 outbox 行（按创建顺序），sealed 用测试进程的当前配置解封。 */
export async function invitations(
  w: World360,
  eventType = 'survey360.answer_invitation',
  config: CredentialConfig = credentialConfig(),
): Promise<Mail[]> {
  const list = rowsOf<Omit<Mail, 'secrets'>>(
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`SELECT id, state, event_type, payload FROM survey360_outbox
        WHERE event_type = ${eventType} ORDER BY created_at, id`),
    ),
  );
  return list.map((row) => {
    const sealed = row.payload['sealed'];
    const secrets = sealed
      ? openSealed(config, sealed as never, { tenantId: w.tenantId, outboxId: row.id, eventType: row.event_type })
      : {};
    return { ...row, secrets };
  });
}

export interface SecurityEvent {
  kind: string;
  link_id: string | null;
  old_link_id: string | null;
  activity_id: string | null;
  run_id: string | null;
  credential_key_version: number | null;
  compromised: boolean | null;
  detail: Record<string, unknown>;
}

export async function securityEvents(w: World360, kind?: string): Promise<SecurityEvent[]> {
  return rowsOf<SecurityEvent>(
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`SELECT kind, link_id, old_link_id, activity_id, run_id, credential_key_version, compromised, detail
        FROM survey360_security_events WHERE (${kind ?? null}::text IS NULL OR kind = ${kind ?? null})
        ORDER BY occurred_at, id`),
    ),
  );
}

/** 租户内所有可能落明文的位置，拼成一个字符串供“查不到明文”类断言扫描。 */
export async function leakSurface(w: World360): Promise<string> {
  const queries = [
    sql`SELECT coalesce(string_agg(to_jsonb(a)::text, ' '), '') AS t FROM audit_events a`,
    sql`SELECT coalesce(string_agg(to_jsonb(c)::text, ' '), '') AS t FROM command_ledger c`,
    sql`SELECT coalesce(string_agg((o.payload - 'sealed')::text || o.event_type || o.state, ' '), '') AS t
      FROM survey360_outbox o`,
    sql`SELECT coalesce(string_agg(to_jsonb(e)::text, ' '), '') AS t FROM survey360_security_events e`,
  ];
  const parts = await withTenant(w.db, w.tenantId, async (tx) => {
    const out: string[] = [];
    for (const query of queries) out.push(rowsOf<{ t: string }>(await tx.execute(query))[0]!.t);
    return out;
  });
  return parts.join('\n');
}

export const FAR_FUTURE = '2026-11-01T00:00:00Z';

/** 把一条链接行直接写成指定凭据状态（绕过发放，用于构造密钥版本 / 退役场景；约束仍生效）。 */
export async function setCredential(
  w: World360,
  linkId: string,
  state: { state: 'pending' | 'issued' | 'retired'; version?: number; versions?: number[]; revoked?: boolean },
): Promise<void> {
  const { state: credentialState, version, versions = version === undefined ? [] : [version], revoked = false } = state;
  const digest = credentialState === 'issued';
  await withTenant(w.db, w.tenantId, (tx) =>
    tx.execute(sql`UPDATE survey360_links SET credential_state = ${credentialState},
        serial_lookup = ${digest ? `lookup-${linkId}` : null}, password_hash = ${digest ? 'scrypt$x' : null},
        credential_key_version = ${version ?? null}::smallint,
        credential_key_versions = ${`{${versions.join(',')}}`}::smallint[], revoked = ${revoked}
      WHERE id = ${linkId}::uuid`),
  );
}

/** 给链接签一个会话（只记 link_id 与摘要）。 */
export async function addSession(w: World360, linkId: string, token: string): Promise<string> {
  const [row] = rowsOf<{ id: string }>(
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`INSERT INTO survey360_answer_sessions (tenant_id, link_id, token_hash, created_at, expires_at)
        VALUES (${w.tenantId}::uuid, ${linkId}::uuid, ${`hash-${token}`}, now(), now() + interval '8 hours')
        RETURNING id`),
    ),
  );
  return row!.id;
}

export async function sessionStates(w: World360, linkId: string): Promise<boolean[]> {
  return rowsOf<{ revoked: boolean }>(
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`SELECT revoked_at IS NOT NULL AS revoked FROM survey360_answer_sessions
        WHERE link_id = ${linkId}::uuid ORDER BY token_hash`),
    ),
  ).map((r) => r.revoked);
}
