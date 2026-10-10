/**
 * AC-360-F076-13（F-076 PR-2a，设计 §3.5、§3.7、§9；DEC-401⑥⑦、DEC-409③④）：登录换取会话，各种失败不可区分。
 * 登录成功 201 { session, expiresAt }；序列号不存在 / 密码错 / 凭据不可用 / 曾暴露 / 活动已删 / 已无有效评价关系 /
 * 另一租户的序列号 / 租户无效，状态码与响应体逐字节相同（401，文案照原站）。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { getTenant, setTenantStatus, sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialConfig } from '../../apps/api/src/modules/survey360/credential-config.js';
import { hashToken } from '../../apps/api/src/modules/survey360/links.js';
import { cmd } from './support/tenant-api.js';
import { setCredential, resetCredentialConfig, portalCredentials } from './AC-360-F076-support.js';
import {
  GENERIC_MESSAGE,
  issuedScene,
  login,
  loginRaw,
  sessionRows,
  sql1,
  wrongPassword,
} from './AC-360-F076-portal-support.js';

const testDb = useTestDb();
afterEach(() => resetCredentialConfig());

async function failure(res: Response): Promise<string> {
  expect(res.status).toBe(401);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ error: { code: 'UNAUTHENTICATED', message: GENERIC_MESSAGE } });
  return text;
}

describe('AC-360-F076-13 登录成功', () => {
  it('201 { session, expiresAt }，no-store，会话 8 小时绝对过期，库里只存令牌摘要', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-13-ok');
    const cred = creds.get(s.person.P1.id)!;
    const res = await login(w, cred.serial, cred.password);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = (await res.json()) as { session: string; expiresAt: string };
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'session']);
    expect(body.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBe('2026-10-01T09:00:00.000Z');
    const [row] = await sessionRows(w, cred.linkId);
    expect(row).toMatchObject({ link_id: cred.linkId, token_hash: hashToken(body.session), revoked_at: null });
    expect(new Date(row!.expires_at).toISOString()).toBe(body.expiresAt);
  });

  it('DEC-409④ 输入容错：全角字母数字、各种横线、空白、小写都归一后通过', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-13-fold');
    const cred = creds.get(s.person.P2.id)!;
    const fullwidth = (text: string) =>
      [...text].map((ch) => (/[A-Za-z0-9]/.test(ch) ? String.fromCharCode(ch.charCodeAt(0) + 0xfee0) : ch)).join('');
    const spaced = (text: string, dash: string) => `${text.slice(0, 4)}${dash}${text.slice(4)}`;
    for (const [serial, password] of [
      [fullwidth(cred.serial), fullwidth(cred.password)],
      [spaced(cred.serial.toLowerCase(), '—'), spaced(cred.password.toLowerCase(), '‑')],
      [` ${spaced(cred.serial, '－')} `, `${spaced(cred.password, '　')} `],
      [spaced(fullwidth(cred.serial.toLowerCase()), '―'), spaced(cred.password, '­')],
    ] as const) {
      const res = await login(w, serial, password, { ip: `203.0.113.${randomBytes(1)[0]}` });
      expect(res.status, `${serial.length}:${await res.clone().text()}`).toBe(201);
    }
  });

  it('请求体不合格 → 400 VALIDATION_FAILED，只给字段路径，不回显值', async () => {
    const { w } = await issuedScene(testDb().db, 'f076-13-400');
    const secret = 'TOPSECRET-VALUE';
    for (const body of [{}, { serial: 'ABC' }, { serial: 'x'.repeat(65), password: secret }, { serial: 1, password: 2 }]) {
      const res = await loginRaw(w, { body });
      const text = await res.text();
      expect(res.status, text).toBe(400);
      expect(text).not.toContain(secret);
      expect(JSON.parse(text).error.code).toBe('VALIDATION_FAILED');
    }
    const extra = await loginRaw(w, { body: { serial: 'A', password: 'B', note: secret } });
    expect(extra.status).toBe(400);
    expect(await extra.text()).not.toContain(secret);
  });
});

describe('AC-360-F076-13 失败不可区分（401）', () => {
  it('各类失败状态码与响应体逐字节相同', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-13-same');
    const { P1, P2, T, M, X } = s.person;
    const cred = (p: { id: string }) => creds.get(p.id)!;
    const bodies: string[] = [];
    const ip = (n: number) => ({ ip: `203.0.113.${n}` });

    // 序列号不存在
    bodies.push(await failure(await login(w, 'ZZZZZZZZZZ', 'ZZZZZZZZ', ip(1))));
    // 密码错
    bodies.push(await failure(await login(w, cred(P1).serial, wrongPassword(cred(P1)), ip(2))));
    // pending / retired：摘要都已清空（CHECK），与不存在同一路径
    await setCredential(w, cred(P2).linkId, { state: 'pending' });
    bodies.push(await failure(await login(w, cred(P2).serial, cred(P2).password, ip(3))));
    // 已作废（重发 / 最后一条关系被移除）：密码正确也 401
    await sql1(w, sql`UPDATE survey360_links SET revoked = true WHERE id = ${cred(T).linkId}::uuid`);
    bodies.push(await failure(await login(w, cred(T).serial, cred(T).password, ip(4))));
    // 曾暴露于 COMPROMISED 版本
    const version = credentialConfig().currentVersion;
    portalCredentials(true, { retiredVersions: new Set([version]), compromisedVersions: new Set([version]) });
    bodies.push(await failure(await login(w, cred(M).serial, cred(M).password, ip(5))));
    resetCredentialConfig();
    portalCredentials(true, { kdf: { N: 1024, r: 8, p: 1 } });
    // 已无有效评价关系（直接改库，绕过移除入口的写侧，只验证读侧兜底）
    await sql1(
      w,
      sql`UPDATE survey360_relations SET removed = true WHERE activity_id = ${s.activity.id}::uuid
        AND appraiser_person_id = ${X.id}::uuid`,
    );
    bodies.push(await failure(await login(w, cred(X).serial, cred(X).password, ip(6))));
    // 另一租户的序列号
    const other = await issuedScene(testDb().db, 'f076-13-other');
    bodies.push(await failure(await login(w, other.creds.get(other.s.person.P1.id)!.serial, 'ZZZZZZZZ', ip(7))));
    // 租户不存在 / 非 UUID / 缺失
    for (const tenant of [randomUUID(), 'not-a-uuid', null]) {
      bodies.push(await failure(await login(w, cred(P1).serial, cred(P1).password, { ...ip(8), tenant })));
    }
    // 租户停用
    const tenant = (await getTenant(w.db, w.tenantId))!;
    await setTenantStatus(w.db, { tenantId: w.tenantId, status: 'suspended', expectedRevision: tenant.revision }, cmd());
    bodies.push(await failure(await login(w, cred(P1).serial, cred(P1).password, ip(10))));
    await setTenantStatus(w.db, { tenantId: w.tenantId, status: 'active', expectedRevision: tenant.revision + 1 }, cmd());
    // 活动已删
    await sql1(w, sql`UPDATE survey360_activities SET deleted = true WHERE id = ${s.activity.id}::uuid`);
    bodies.push(await failure(await login(w, cred(P1).serial, cred(P1).password, ip(9))));

    expect(new Set(bodies).size).toBe(1);
  });
});

describe('AC-360-F076-13 活动停用后仍可登录（DEC-401⑦）', () => {
  it('停用活动后用正确凭据仍 201', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-13-stopped');
    await w.transition(s.activity.id, 'disable');
    const res = await login(w, creds.get(s.person.P1.id)!.serial, creds.get(s.person.P1.id)!.password);
    expect(res.status, await res.clone().text()).toBe(201);
  });
});
