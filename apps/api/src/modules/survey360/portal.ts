/**
 * 通用网址作答门户 /api/survey360/portal（F-076 设计 §3.5、§4.1、§5；PR-2a：登录与登出，会话入口归 PR-2b）。
 * 评价者凭“序列号 + 密码”换取 8 小时的作答会话；令牌只存 SHA-256，经 x-survey360-session 头传递，不放 Cookie 与路径。
 * 登录不走命令台账（DEC-377③，设计 §4.8）：重试即重新登录，每次都经过同样的限频与恒定工作量的 KDF。
 *
 * 换取流程（§3.5）：
 *   0 租户无效 → 401（不做 KDF）；1 并发闸 G；
 *   2 T1 原子检查与预扣（throttle.admit，短事务，不做 KDF）；
 *   3 事务外 KDF 恰好一次（找不到凭据时用哑摘要，结果恒为假）；
 *   4 T2 落定：取锁顺序 IP 行 → 序列号 × IP 行 → 链接行，成功则签发会话并退回预扣，失败则确认预扣；
 *   5 成功提交后才做登录时密钥迁移（第二次 KDF），失败分支不会多出 KDF；6 释放闸。
 */
import { randomBytes } from 'node:crypto';
import { getTenant, isUuid, sql, survey360AnswerSessions, type Tx, withTenant } from '@italent/db';
import { survey360 } from '@italent/domain';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { AppError, errorResponse, handleError } from '../../errors.js';
import { policedSub } from '../../route-policy/index.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { requestBucket } from './client-ip.js';
import { jsonOrEmpty, mapDbError, rows } from './context.js';
import { credentialConfig, type CredentialConfig } from './credential-config.js';
import { assertIssuableVersion } from './credential-key-registry.js';
import { dummyDigest, hashPassword, serialLookup, verifyPassword } from './credentials.js';
import { hashToken } from './links.js';
import { acquireLoginSlot } from './login-gate.js';
import { SURVEY360_PORTAL_POLICIES } from './policy.js';
import { recordSecurityEvent } from './security-events.js';
import { hasTask } from './tasks.js';
import {
  admit,
  confirmFailure,
  ipKey,
  lockRows,
  pairKey,
  recordTenantFailure,
  refundPair,
  type Rejection,
  TENANT_FAILURE_ALERT,
} from './throttle.js';

export const PORTAL_BASE = '/api/survey360/portal';
export const SESSION_HEADER = 'x-survey360-session';
/** DEC-401 Q9：签发起 8 小时绝对过期，不滑动。 */
export const SESSION_TTL_MS = 8 * 3_600_000;
/** 同一链接同时有效的会话上限；超出时作废最早的（设计 §4.1）。 */
const SESSION_CAP = 5;
/** D4：单个凭据每小时至多签发 20 个会话（设计 §3.2），资源保护，不构成存在性探针（密码正确后才判）。 */
const D4_LIMIT = 20;
const D4_WINDOW_MS = 3_600_000;
/** DEC-401⑥：原站同文案；所有失败逐字节相同，客户端按 error.code 判断。 */
export const LOGIN_FAILED_MESSAGE = '您输入的密码和序列号不匹配，请重新输入';

interface LoginHookContext {
  readonly tenantId: string;
}
/** 只供测试注入崩溃 / 屏障（预扣后、T2 取锁后、迁移前）；生产不设。 */
export interface LoginHooks {
  afterPrewrite?: ((context: LoginHookContext) => void | Promise<void>) | undefined;
  afterT2Locks?: ((context: LoginHookContext) => void | Promise<void>) | undefined;
  beforeMigration?: ((context: LoginHookContext) => void | Promise<void>) | undefined;
}
export const loginHooks: LoginHooks = {};
export function resetLoginHooks(): void {
  loginHooks.afterPrewrite = undefined;
  loginHooks.afterT2Locks = undefined;
  loginHooks.beforeMigration = undefined;
}

const unauthenticated = () => new AppError('UNAUTHENTICATED', LOGIN_FAILED_MESSAGE);

const loginBody = z.strictObject({ serial: z.string().min(1).max(64), password: z.string().min(1).max(64) });

/** 校验失败只给字段路径与错误类别，不回显任何输入值（凭据明文不得进入错误对象，设计 §2.6）。 */
function parseLoginBody(value: unknown): z.infer<typeof loginBody> {
  const parsed = loginBody.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new AppError(
    'VALIDATION_FAILED',
    '请求字段不合法',
    parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
  );
}

interface FoundLink {
  readonly id: string;
  readonly password_hash: string;
  readonly credential_key_version: number;
}

/** 按配置里每个版本各算一次 serial_lookup，一次查询取链接行；不按状态过滤，找到 / 找不到走同一条索引路径。 */
async function findCredential(tx: Tx, tenantId: string, config: CredentialConfig, normalizedSerial: string) {
  const pairs = [...config.credentialKeys].map(
    ([version, key]) => sql`(${version}::smallint, ${serialLookup(key, normalizedSerial)})`,
  );
  const [row] = rows<FoundLink>(
    await tx.execute(sql`SELECT id, password_hash, credential_key_version FROM survey360_links
      WHERE tenant_id = ${tenantId}::uuid AND serial_lookup IS NOT NULL
        AND (credential_key_version, serial_lookup) IN (${sql.join(pairs, sql`, `)})`),
  );
  return row;
}

interface LockedLink {
  readonly id: string;
  readonly activity_id: string;
  readonly person_id: string;
  readonly kind: string;
  readonly revoked: boolean;
  readonly credential_state: string;
  readonly credential_key_version: number | null;
  readonly credential_key_versions: number[];
}

type Outcome =
  | { readonly kind: 'granted'; readonly token: string; readonly expiresAt: Date; readonly migrate: LockedLink | null }
  | { readonly kind: 'failed'; readonly tenantFailures: number }
  | { readonly kind: 'sessionLimit'; readonly retryAfter: number };

/** T2 成功复核（§3.5 第 4 步）：与会话预检同一组条件，另加“凭据可登录”。 */
async function isLoginable(tx: Tx, config: CredentialConfig, link: LockedLink): Promise<boolean> {
  if (link.kind !== 'answer' || link.revoked || link.credential_state !== 'issued') return false;
  // 曾暴露于已泄露版本的凭据一律拒绝（部署即生效，DEC-379 Q14）
  if (link.credential_key_versions.some((version) => config.compromisedVersions.has(version))) return false;
  const [activity] = rows<{ id: string }>(
    await tx.execute(sql`SELECT id FROM survey360_activities WHERE id = ${link.activity_id}::uuid AND NOT deleted`),
  );
  // 评价者在本活动仍有有效评价关系（设计 §4.2）；活动停用不拒绝（DEC-401⑦）
  return Boolean(activity) && (await hasTask(tx, link.activity_id, link.person_id));
}

/** D4：1 小时内已签发的会话数 ≥ 20 → 返回最早释放名额的时刻对应的 Retry-After（秒）。 */
async function sessionLimitRetry(tx: Tx, linkId: string, now: Date): Promise<number | undefined> {
  const since = new Date(now.getTime() - D4_WINDOW_MS);
  const issued = rows<{ created_at: Date | string }>(
    await tx.execute(sql`SELECT created_at FROM survey360_answer_sessions
      WHERE link_id = ${linkId}::uuid AND created_at > ${since.toISOString()}::timestamptz ORDER BY created_at, id`),
  );
  if (issued.length < D4_LIMIT) return undefined;
  const frees = new Date(issued[issued.length - D4_LIMIT]!.created_at).getTime() + D4_WINDOW_MS;
  return Math.max(1, Math.ceil((frees - now.getTime()) / 1000));
}

async function issueSession(tx: Tx, tenantId: string, link: LockedLink, ipPrefix: string, now: Date) {
  // now = 取得链接锁之后的实际签发时刻（不是请求开始时间）：较早发起、较晚完成的登录不会被排到“最早”而被淘汰
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const [session] = await tx
    .insert(survey360AnswerSessions)
    .values({ tenantId, linkId: link.id, tokenHash: hashToken(token), createdAt: now, expiresAt })
    .returning({ id: survey360AnswerSessions.id });
  // 有效会话超过 5 个时作废最早的（按链接行加锁串行签发）；本次新签发的会话一定保留：它加上其余最新的 4 个
  await tx.execute(sql`UPDATE survey360_answer_sessions SET revoked_at = ${now.toISOString()}::timestamptz
    WHERE id IN (SELECT id FROM survey360_answer_sessions WHERE link_id = ${link.id}::uuid AND revoked_at IS NULL
      AND expires_at > ${now.toISOString()}::timestamptz AND id <> ${session!.id}::uuid
      ORDER BY created_at DESC, id DESC OFFSET ${SESSION_CAP - 1})`);
  await recordSecurityEvent(tx, {
    tenantId,
    kind: 'login_success',
    occurredAt: now,
    linkId: link.id,
    activityId: link.activity_id,
    sessionId: session!.id,
    ...(link.credential_key_version === null ? {} : { credentialKeyVersion: link.credential_key_version }),
    ipPrefix,
  });
  return { token, expiresAt };
}

interface Attempt {
  readonly tenantId: string;
  readonly now: Date;
  /** 注入时钟：T2 取得链接锁后重取实际签发时刻（会话时间、D4 窗口、期限都按它）。 */
  readonly clock: () => Date;
  readonly config: CredentialConfig;
  readonly ipKey: string;
  readonly pairKey: string;
  readonly pairMark: Date;
  readonly found: FoundLink | undefined;
  readonly matched: boolean;
}

/** T2：IP 行 → 序列号 × IP 行 → 链接行；成功退回预扣并签发会话，失败确认预扣并计入租户失败数（D5）。 */
async function settle(tx: Tx, a: Attempt): Promise<Outcome> {
  await lockRows(tx, a.tenantId, { ip: a.ipKey, pair: a.pairKey });
  await loginHooks.afterT2Locks?.({ tenantId: a.tenantId });
  if (a.matched && a.found) {
    const [link] = rows<LockedLink>(
      await tx.execute(sql`SELECT id, activity_id, person_id, kind, revoked, credential_state, credential_key_version,
          credential_key_versions FROM survey360_links WHERE id = ${a.found.id}::uuid FOR UPDATE`),
    );
    if (link && (await isLoginable(tx, a.config, link))) {
      const issuedAt = a.clock();
      const retryAfter = await sessionLimitRetry(tx, link.id, issuedAt);
      if (retryAfter !== undefined) return { kind: 'sessionLimit', retryAfter };
      const { token, expiresAt } = await issueSession(tx, a.tenantId, link, a.ipKey.slice(0, 8), issuedAt);
      await refundPair(tx, a.tenantId, a.pairKey, a.pairMark, issuedAt);
      return {
        kind: 'granted',
        token,
        expiresAt,
        migrate: link.credential_key_version === a.config.currentVersion ? null : link,
      };
    }
  }
  await confirmFailure(tx, a.tenantId, a.pairKey, a.pairMark, a.now);
  return { kind: 'failed', tenantFailures: await recordTenantFailure(tx, a.tenantId, a.now) };
}

/**
 * 登录时密钥迁移（§2.4）：T2 成功提交之后才做，事务外按 CURRENT 重算摘要（第二次 KDF），再用短事务按版本 CAS 写回。
 * 期间被重发 / 退役 / 别的请求抢先迁移，或与别的序列号撞唯一索引，都只是这次没迁移，登录结果不受影响。
 */
async function migrateCredential(
  deps: TenantRouteDeps,
  tenantId: string,
  link: LockedLink,
  secrets: { serial: string; password: string },
  config: CredentialConfig,
  now: Date,
): Promise<void> {
  await loginHooks.beforeMigration?.({ tenantId });
  const key = config.credentialKeys.get(config.currentVersion)!;
  const lookup = serialLookup(key, secrets.serial);
  const digest = await hashPassword(key, secrets.password, config.kdf);
  try {
    await withTenant(deps.db, tenantId, async (tx) => {
      // 与轮换登记协调：旧于全局已登记最高版本的摘要一条也写不进去（设计 §2.5 防回退）
      await assertIssuableVersion(tx, config.currentVersion);
      await tx.execute(sql`UPDATE survey360_links SET serial_lookup = ${lookup}, password_hash = ${digest},
          credential_key_version = ${config.currentVersion}::smallint,
          credential_key_versions = (SELECT array_agg(DISTINCT v ORDER BY v)
            FROM unnest(credential_key_versions || ARRAY[${config.currentVersion}]::smallint[]) AS v)
        WHERE id = ${link.id}::uuid AND credential_key_version = ${link.credential_key_version}::smallint
          AND credential_state = 'issued' AND NOT revoked`);
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'survey360.login.migration_skipped',
        linkId: link.id,
        now: now.toISOString(),
        error: errorName(error),
      }),
    );
  }
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'unknown');

function rejectionResponse(c: Context, rejection: Rejection): Response {
  c.header('Retry-After', String(rejection.retryAfter));
  c.header('Cache-Control', 'no-store');
  if (rejection.kind === 'locked') {
    return errorResponse(c, 'AUTH_LOCKED', '尝试次数过多，请稍后再试', { unlockAt: rejection.unlockAt.toISOString() });
  }
  return errorResponse(c, 'REQUEST_RATE_LIMITED', '请求过于频繁，请稍后再试');
}

async function loginTenant(c: Context, deps: TenantRouteDeps) {
  const tenantId = c.req.header('x-tenant-id');
  if (!tenantId || !isUuid(tenantId)) throw unauthenticated();
  const tenant = await getTenant(deps.db, tenantId);
  if (!tenant || tenant.status !== 'active') throw unauthenticated();
  return tenant;
}

async function login(c: Context<TenantEnv>, deps: TenantRouteDeps): Promise<Response> {
  const body = parseLoginBody(await jsonOrEmpty(c));
  const tenant = await loginTenant(c, deps);
  const release = acquireLoginSlot(tenant.id);
  if (!release) throw new AppError('SERVICE_UNAVAILABLE', '登录人数过多，请稍后再试', { reason: 'LOGIN_BUSY' });
  try {
    return await attemptLogin(c, deps, tenant.id, body);
  } finally {
    release();
  }
}

async function attemptLogin(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  tenantId: string,
  body: z.infer<typeof loginBody>,
): Promise<Response> {
  const config = credentialConfig();
  const serial = survey360.normalizeCredentialInput(body.serial);
  const password = survey360.normalizeCredentialInput(body.password);
  const bucket = requestBucket(c, config.trustedProxyCidrs);
  const keys = { ip: ipKey(config, bucket), pair: pairKey(config, serial, bucket) };
  const now = deps.clock();

  const admission = await withTenant(deps.db, tenantId, (tx) =>
    admit(tx, {
      tenantId,
      now,
      ipKey: keys.ip,
      pairKey: keys.pair,
      lookup: (inner) => findCredential(inner, tenantId, config, serial),
    }),
  );
  if (!admission.ok) return rejectionResponse(c, admission.rejection);
  await loginHooks.afterPrewrite?.({ tenantId });

  // 恰好一次 KDF：找不到凭据时用哑摘要，各失败分支工作量一致（设计 §3.8）
  const found = admission.found;
  const key = config.credentialKeys.get(found?.credential_key_version ?? config.currentVersion)!;
  const matched = await verifyPassword(found?.password_hash ?? (await dummyDigest(config.kdf)), key, password);

  const outcome = await withTenant(deps.db, tenantId, (tx) =>
    settle(tx, {
      tenantId,
      now,
      clock: deps.clock,
      config,
      ipKey: keys.ip,
      pairKey: keys.pair,
      pairMark: admission.pairMark,
      found,
      matched: matched && found !== undefined,
    }),
  );
  if (outcome.kind === 'sessionLimit') return rejectionResponse(c, { kind: 'rate', retryAfter: outcome.retryAfter });
  if (outcome.kind === 'failed') {
    if (outcome.tenantFailures === TENANT_FAILURE_ALERT) {
      // D5 只告警，不拒绝：发现分布式撒网（结构化运行日志，不含任何输入值）
      console.warn(
        JSON.stringify({
          event: 'survey360.login.tenant_failures',
          tenantId,
          failures: outcome.tenantFailures,
          windowMinutes: 15,
        }),
      );
    }
    throw unauthenticated();
  }
  if (outcome.migrate) await migrateCredential(deps, tenantId, outcome.migrate, { serial, password }, config, now);
  c.header('Cache-Control', 'no-store');
  return c.json({ session: outcome.token, expiresAt: outcome.expiresAt.toISOString() }, 201);
}

/** 登出：按令牌摘要作废会话（不论状态）；无效 / 缺失令牌、二次登出一律 204，只有作废了有效会话才写 logout 事件。 */
async function logout(c: Context<TenantEnv>, deps: TenantRouteDeps): Promise<Response> {
  const tenantId = c.req.header('x-tenant-id');
  const token = c.req.header(SESSION_HEADER);
  if (tenantId && isUuid(tenantId) && token && token.length <= 200) {
    const now = deps.clock();
    await withTenant(deps.db, tenantId, async (tx) => {
      const [revoked] = rows<{ id: string; link_id: string; expires_at: Date | string }>(
        await tx.execute(sql`UPDATE survey360_answer_sessions SET revoked_at = ${now.toISOString()}::timestamptz
          WHERE token_hash = ${hashToken(token)} AND revoked_at IS NULL RETURNING id, link_id, expires_at`),
      );
      if (revoked && new Date(revoked.expires_at) > now) {
        await recordSecurityEvent(tx, {
          tenantId,
          kind: 'logout',
          occurredAt: now,
          linkId: revoked.link_id,
          sessionId: revoked.id,
        });
      }
    });
  }
  return c.body(null, 204);
}

export function registerPortalRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  // F-039：门户子应用套登记表（SURVEY360_PORTAL_POLICIES）
  const module = policedSub(router, SURVEY360_PORTAL_POLICIES, () => new Hono<TenantEnv>());
  module.onError((error, c) => handleError(mapDbError(error) ?? error, c));
  module.post('/login', (c) => login(c, deps));
  module.post('/logout', (c) => logout(c, deps));
  router.route(PORTAL_BASE, module);
}
