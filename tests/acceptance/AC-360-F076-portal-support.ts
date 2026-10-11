/**
 * F-076 PR-2a 验收夹具：已发放凭据的场景、门户登录 / 登出请求（可指定套接字地址）、限频行与会话读取。
 * 测试数据一律合成；序列号、密码只在测试进程内存里出现（取自 outbox 解封），不写日志。
 */
import { sql, withTenant } from '@italent/db';
import { runCredentialMaintenance } from '../../apps/api/src/modules/survey360/credential-maintenance.js';
import { credentialConfig } from '../../apps/api/src/modules/survey360/credential-config.js';
import { dummyDigest } from '../../apps/api/src/modules/survey360/credentials.js';
import { ipKey, pairKey } from '../../apps/api/src/modules/survey360/throttle.js';
import { sceneB, type SceneB } from './AC-360-B-support.js';
import type { World360 } from './AC-360-support.js';
import { invitations, portalCredentials, rowsOf } from './AC-360-F076-support.js';

export const PORTAL = '/api/survey360/portal';
export const FAST = { N: 1024, r: 8, p: 1 };
export const GENERIC_MESSAGE = '您输入的密码和序列号不匹配，请重新输入';
export const START = '2026-10-01T01:00:00Z';
export const minutes = (n: number) => new Date(new Date(START).getTime() + n * 60_000).toISOString();

export interface Cred {
  readonly linkId: string;
  readonly personId: string;
  readonly serial: string;
  readonly password: string;
  readonly token: string;
}

/** 开关打开、KDF 参数调小，启用活动并跑一轮发放；返回场景和每个评价者（按 personId）的明文凭据。 */
export async function issuedScene(
  db: World360['db'],
  label: string,
  patch: Parameters<typeof portalCredentials>[1] = {},
) {
  portalCredentials(true, { kdf: FAST, ...patch });
  await dummyDigest(FAST);
  const s = await sceneB(db, label);
  await issueAll(s.w);
  return { s, w: s.w, creds: await credsOf(s.w) };
}

export async function issueAll(w: World360): Promise<void> {
  await runCredentialMaintenance(w.db, { tenantId: w.tenantId, clock: () => new Date(START) });
}

/** 当前有效（owner 未作废）的凭据：按邀请 outbox 的创建顺序，同一评价者取最后一封。 */
export async function credsOf(w: World360): Promise<Map<string, Cred>> {
  const out = new Map<string, Cred>();
  for (const mail of await invitations(w)) {
    const { serial, password, token } = mail.secrets;
    if (mail.state !== 'pending' || !serial || !password || !token) continue;
    out.set(mail.payload['personId'] as string, {
      linkId: mail.payload['linkId'] as string,
      personId: mail.payload['personId'] as string,
      serial,
      password,
      token,
    });
  }
  return out;
}

export interface LoginOptions {
  /** 套接字对端地址；缺省 198.51.100.7（TEST-NET-2）。传 null 表示没有套接字。 */
  readonly ip?: string | null;
  readonly headers?: Record<string, string>;
  readonly tenant?: string | null;
  readonly body?: unknown;
}

export async function loginRaw(w: World360, options: LoginOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers };
  const tenant = options.tenant === undefined ? w.tenantId : options.tenant;
  if (tenant) headers['x-tenant-id'] = tenant;
  const ip = options.ip === undefined ? '198.51.100.7' : options.ip;
  const env = ip ? { incoming: { socket: { remoteAddress: ip } } } : undefined;
  return w.api.app.request(`${PORTAL}/login`, { method: 'POST', headers, body: JSON.stringify(options.body) }, env);
}

export function login(w: World360, serial: string, password: string, options: Omit<LoginOptions, 'body'> = {}) {
  return loginRaw(w, { ...options, body: { serial, password } });
}

export async function logout(w: World360, session?: string, options: { tenant?: string | null; ip?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const tenant = options.tenant === undefined ? w.tenantId : options.tenant;
  if (tenant) headers['x-tenant-id'] = tenant;
  if (session) headers['x-survey360-session'] = session;
  const env = { incoming: { socket: { remoteAddress: options.ip ?? '198.51.100.7' } } };
  return w.api.app.request(`${PORTAL}/logout`, { method: 'POST', headers, body: '{}' }, env);
}

export interface Session {
  session: string;
  expiresAt: string;
}

export async function loginOk(w: World360, cred: Cred, options: Omit<LoginOptions, 'body'> = {}): Promise<Session> {
  const res = await login(w, cred.serial, cred.password, options);
  expect201(res.status, await res.clone().text());
  return (await res.json()) as Session;
}

function expect201(status: number, text: string): void {
  if (status !== 201) throw new Error(`登录应为 201，实际 ${status}：${text}`);
}

export const wrongPassword = (cred: Cred) => (cred.password[0] === '2' ? '3' : '2') + cred.password.slice(1);

export interface ThrottleRow {
  scope: string;
  key_hash: string;
  window_started_at: string;
  requests: number;
  failures: number;
  locked_until: string | null;
}

export async function throttleRows(w: World360, scope?: string): Promise<ThrottleRow[]> {
  return rowsOf<ThrottleRow>(
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`SELECT scope, key_hash, window_started_at, requests, failures, locked_until
        FROM survey360_login_throttle WHERE (${scope ?? null}::text IS NULL OR scope = ${scope ?? null})
        ORDER BY scope, key_hash`),
    ),
  );
}

export async function pairRow(w: World360, serial: string, ip = '198.51.100.7'): Promise<ThrottleRow | undefined> {
  const key = pairKey(credentialConfig(), serial, ip);
  return (await throttleRows(w, 'pair')).find((row) => row.key_hash === key);
}

export async function ipRow(w: World360, ip = '198.51.100.7'): Promise<ThrottleRow | undefined> {
  const key = ipKey(credentialConfig(), ip);
  return (await throttleRows(w, 'ip')).find((row) => row.key_hash === key);
}

/** 直接写一行限频记录（构造“已满 3000 次”“已锁定”等状态，不用真的发几千个请求）。 */
export async function seedThrottle(
  w: World360,
  row: {
    scope: 'ip' | 'pair' | 'tenant';
    key: string;
    startedAt?: string;
    requests?: number;
    failures?: number;
    lockedUntil?: string | null;
  },
): Promise<void> {
  const startedAt = row.startedAt ?? START;
  await withTenant(w.db, w.tenantId, (tx) =>
    tx.execute(sql`INSERT INTO survey360_login_throttle
        (tenant_id, scope, key_hash, window_started_at, requests, failures, locked_until, updated_at)
      VALUES (${w.tenantId}::uuid, ${row.scope}, ${row.key}, ${startedAt}::timestamptz, ${row.requests ?? 0},
        ${row.failures ?? 0}, ${row.lockedUntil ?? null}::timestamptz, ${startedAt}::timestamptz)
      ON CONFLICT (tenant_id, scope, key_hash) DO UPDATE SET window_started_at = EXCLUDED.window_started_at,
        requests = EXCLUDED.requests, failures = EXCLUDED.failures, locked_until = EXCLUDED.locked_until`),
  );
}

export interface SessionRow {
  id: string;
  link_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export async function sessionRows(w: World360, linkId?: string): Promise<SessionRow[]> {
  return rowsOf<SessionRow>(
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`SELECT id, link_id, token_hash, created_at, expires_at, revoked_at
        FROM survey360_answer_sessions WHERE (${linkId ?? null}::uuid IS NULL OR link_id = ${linkId ?? null}::uuid)
        ORDER BY created_at, id`),
    ),
  );
}

export async function sql1(w: World360, statement: ReturnType<typeof sql>): Promise<void> {
  await withTenant(w.db, w.tenantId, (tx) => tx.execute(statement));
}

export { sceneB, type SceneB };
