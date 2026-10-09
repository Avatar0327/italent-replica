/**
 * AC-EMP（补）/ F-058 / DEC-327：头像属于租户内账号，由本人设置，员工与 360 人员只读引用。
 * 证件照不是头像；头像内容可供当前有效租户成员读取，接口不返回账号或员工的其他字段。
 */
import { randomUUID } from 'node:crypto';
import { createUser, grantMembership, revokeMembership, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { world360, type PersonView } from './AC-360-support.js';
import { personnelSession } from './AC-SUB-support.js';
import {
  fixtureFromBytes,
  imageFixture,
  malformedPng,
  MODEL_IMAGE_LIMIT,
  pngBytes,
  type ImageFixture,
  type ImageMetadata,
} from './AC-TC-model-image-support.js';
import { cmd, seedTenantWithMember, tenantApi, type RequestOptions } from './support/tenant-api.js';

const testDb = useTestDb();
const BASE = '/api/tenant/account/avatar';
const contentPath = (id: string) => `/api/tenant/avatars/${id}/content`;
type AvatarRequest = (method: string, path: string, options?: RequestOptions) => Promise<Response>;
interface AvatarRef {
  id: string;
  url: string;
}
interface AvatarView {
  revision: number;
  name: string;
  avatar: AvatarRef | null;
}
interface RegisteredAvatar {
  revision: number;
  attachment: ImageMetadata & { id: string; status: 'registered' };
}

async function json<T>(response: Promise<Response> | Response, status = 200): Promise<T> {
  const resolved = await response;
  expect(resolved.status, await resolved.clone().text()).toBe(status);
  return (await resolved.json()) as T;
}

async function error(response: Promise<Response> | Response, status: number, code?: string) {
  const resolved = await response;
  expect(resolved.status, await resolved.clone().text()).toBe(status);
  if (code) expect(await resolved.json()).toMatchObject({ error: { code } });
}

async function scene(label: string) {
  const db = testDb().db;
  const { tenant, user } = await seedTenantWithMember(db, label);
  // 不注入 allowAll：本人头像不需要企业或业务身份，仍由真实成员中间件验权。
  const api = tenantApi(db, { authorize: undefined });
  const request: AvatarRequest = (method, path, options = {}) =>
    api.request(method, path, { ...options, user: user.id, tenant: tenant.id });
  return { db, tenant, user, api, request };
}

const read = (request: AvatarRequest) => json<AvatarView>(request('GET', BASE));

async function register(request: AvatarRequest, revision: number, fixture = imageFixture(), idempotencyKey?: string) {
  const registered = await json<RegisteredAvatar>(
    request('POST', `${BASE}/attachments`, { ifMatch: revision, body: fixture.metadata, idempotencyKey }),
    201,
  );
  expect(registered).toEqual({
    revision: revision + 1,
    attachment: { id: expect.any(String), ...fixture.metadata, status: 'registered' },
  });
  return registered;
}

async function upload(
  request: AvatarRequest,
  registered: RegisteredAvatar,
  fixture = imageFixture(),
  idempotencyKey?: string,
) {
  const uploaded = await json<AvatarView>(
    request('POST', `${BASE}/attachments/${registered.attachment.id}/upload`, {
      ifMatch: registered.revision,
      body: { base64: fixture.base64 },
      idempotencyKey,
    }),
  );
  expect(uploaded).toEqual({
    revision: registered.revision + 1,
    name: expect.any(String),
    avatar: { id: registered.attachment.id, url: contentPath(registered.attachment.id) },
  });
  expect(JSON.stringify(uploaded)).not.toContain(fixture.base64);
  return uploaded;
}

async function status(tenantId: string, attachmentId: string) {
  const result = await withTenant(testDb().db, tenantId, (tx) =>
    tx.execute(sql`SELECT status FROM account_avatar_attachments
      WHERE tenant_id=${tenantId} AND id=${attachmentId}::uuid`),
  );
  const rows = (Array.isArray(result) ? result : (result as { rows: { status: string }[] }).rows) as {
    status: string;
  }[];
  return rows[0]?.status;
}

describe('AC-EMP（补）F-058 本人头像与租户授权', () => {
  it('无业务身份的有效成员可读写本人头像，初始响应仅有 revision、姓名与空头像', async () => {
    const s = await scene('f058-self');
    expect(await read(s.request)).toEqual({ revision: 1, name: s.user.displayName, avatar: null });
    const registered = await register(s.request, 1);
    expect(await read(s.request)).toEqual({ revision: 2, name: s.user.displayName, avatar: null });
    await error(s.request('GET', contentPath(registered.attachment.id)), 404, 'NOT_FOUND');
    const uploaded = await upload(s.request, registered);
    expect(await read(s.request)).toEqual(uploaded);
    const content = await s.request('GET', uploaded.avatar!.url);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(content.headers.get('content-disposition')).toMatch(/^inline(?:;|$)/);
    expect(content.headers.get('x-content-type-options')).toBe('nosniff');
    expect(content.headers.get('cache-control')).toContain('private');
    expect(content.headers.get('cache-control')).toContain('no-store');
    expect(Buffer.from(await content.arrayBuffer())).toEqual(imageFixture().bytes);
  });

  it('登记新图保留原图，替换后旧图与删除后新图统一 404，元数据进入待清理', async () => {
    const s = await scene('f058-lifecycle');
    const first = await register(s.request, 1);
    const firstView = await upload(s.request, first);
    const nextFixture = imageFixture('bmp');
    const second = await register(s.request, firstView.revision, nextFixture);
    expect((await read(s.request)).avatar).toEqual(firstView.avatar);
    expect((await s.request('GET', contentPath(first.attachment.id))).status).toBe(200);
    const secondView = await upload(s.request, second, nextFixture);
    await error(s.request('GET', contentPath(first.attachment.id)), 404, 'NOT_FOUND');
    expect(await status(s.tenant.id, first.attachment.id)).toBe('pending_cleanup');
    expect(await json<AvatarView>(s.request('DELETE', BASE, { ifMatch: secondView.revision }))).toEqual({
      revision: secondView.revision + 1,
      name: s.user.displayName,
      avatar: null,
    });
    await error(s.request('GET', contentPath(second.attachment.id)), 404, 'NOT_FOUND');
    expect(await status(s.tenant.id, second.attachment.id)).toBe('pending_cleanup');
    const missing = await s.request('GET', contentPath(randomUUID()));
    const old = await s.request('GET', contentPath(first.attachment.id));
    expect(await old.json()).toEqual(await missing.json());
  });

  it('删除同时取消孤儿登记附件，旧登记无法在删除后上传复活', async () => {
    const s = await scene('f058-orphan');
    const registered = await register(s.request, 1);
    const deleted = await json<AvatarView>(s.request('DELETE', BASE, { ifMatch: registered.revision }));
    expect(deleted.avatar).toBeNull();
    expect(await status(s.tenant.id, registered.attachment.id)).toBe('pending_cleanup');
    await error(
      s.request('POST', `${BASE}/attachments/${registered.attachment.id}/upload`, {
        ifMatch: deleted.revision,
        body: { base64: imageFixture().base64 },
      }),
      404,
      'NOT_FOUND',
    );
    await error(s.request('GET', contentPath(registered.attachment.id)), 404, 'NOT_FOUND');
    expect(await read(s.request)).toEqual(deleted);
  });

  it('同租户其他有效成员能读头像，不能上传本人未登记的附件；响应不带账号或员工其他资料', async () => {
    const s = await scene('f058-reader');
    const registered = await register(s.request, 1);
    const uploaded = await upload(s.request, registered);
    const viewer = await createUser(s.db, { email: `${randomUUID()}@example.com`, displayName: '无身份查看人' }, cmd());
    await grantMembership(s.db, { tenantId: s.tenant.id, userId: viewer.id, expectedRevision: 0 }, cmd());
    const asViewer: AvatarRequest = (method, path, options = {}) =>
      s.api.request(method, path, { ...options, user: viewer.id, tenant: s.tenant.id });
    const content = await asViewer('GET', uploaded.avatar!.url);
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(imageFixture().bytes);
    expect(await read(asViewer)).toEqual({ revision: 1, name: viewer.displayName, avatar: null });
    await error(
      asViewer('POST', `${BASE}/attachments/${registered.attachment.id}/upload`, {
        ifMatch: 1,
        body: { base64: imageFixture().base64 },
      }),
      404,
      'NOT_FOUND',
    );
    expect(await read(s.request)).toEqual(uploaded);
    for (const marker of [s.user.email, s.user.id, s.tenant.id, 'content_base64', 'employeeId', 'userId'])
      expect(JSON.stringify(uploaded)).not.toContain(marker);
  });

  it('同一账号在两个租户有独立头像，外租户 ID 与不存在 ID 同样 404', async () => {
    const s = await scene('f058-tenant-a');
    const other = await seedTenantWithMember(s.db, 'f058-tenant-b');
    await grantMembership(s.db, { tenantId: other.tenant.id, userId: s.user.id, expectedRevision: 0 }, cmd());
    const inOther: AvatarRequest = (method, path, options = {}) =>
      s.api.request(method, path, { ...options, user: s.user.id, tenant: other.tenant.id });
    const first = await upload(s.request, await register(s.request, 1));
    expect(await read(inOther)).toEqual({ revision: 1, name: s.user.displayName, avatar: null });
    const nextFixture = imageFixture('bmp');
    const second = await upload(inOther, await register(inOther, 1, nextFixture), nextFixture);
    expect(second.avatar!.id).not.toBe(first.avatar!.id);
    for (const [request, id] of [
      [s.request, second.avatar!.id],
      [inOther, first.avatar!.id],
    ] as const) {
      const foreign = await request('GET', contentPath(id));
      const missing = await request('GET', contentPath(randomUUID()));
      expect([foreign.status, missing.status]).toEqual([404, 404]);
      expect(await foreign.json()).toEqual(await missing.json());
    }
    await json(inOther('DELETE', BASE, { ifMatch: second.revision }));
    expect(await read(s.request)).toEqual(first);
    expect((await s.request('GET', first.avatar!.url)).status).toBe(200);
  });

  it('管理员不能通过 userId、employeeId 或头像字段代改他人；失败不改变本人状态', async () => {
    const s = await scene('f058-owner-input');
    const before = await read(s.request);
    for (const extra of [{ userId: randomUUID() }, { employeeId: randomUUID() }, { avatar: null }]) {
      await error(
        s.request('POST', `${BASE}/attachments`, {
          ifMatch: before.revision,
          body: { ...imageFixture().metadata, ...extra },
        }),
        400,
        'VALIDATION_FAILED',
      );
      expect(await read(s.request)).toEqual(before);
    }
  });

  it('未登录、非成员与已撤销成员不能读写头像；成功命令重放也重新检查当前成员', async () => {
    const s = await scene('f058-revoke');
    const registerKey = randomUUID();
    const uploadKey = randomUUID();
    const deleteKey = randomUUID();
    const registered = await register(s.request, 1, imageFixture(), registerKey);
    const uploaded = await upload(s.request, registered, imageFixture(), uploadKey);
    await json(s.request('DELETE', BASE, { ifMatch: uploaded.revision, idempotencyKey: deleteKey }));
    await error(s.api.request('GET', BASE, { tenant: s.tenant.id }), 401, 'UNAUTHENTICATED');
    const stranger = await createUser(s.db, { email: `${randomUUID()}@example.com`, displayName: '非成员' }, cmd());
    await error(
      s.api.request('GET', contentPath(registered.attachment.id), { user: stranger.id, tenant: s.tenant.id }),
      403,
      'TENANT_NOT_MEMBER',
    );
    await revokeMembership(s.db, { tenantId: s.tenant.id, userId: s.user.id, expectedRevision: 1 }, cmd());
    const commands = [
      ['GET', BASE, {}],
      ['GET', contentPath(registered.attachment.id), {}],
      ['POST', `${BASE}/attachments`, { ifMatch: 1, idempotencyKey: registerKey, body: imageFixture().metadata }],
      [
        'POST',
        `${BASE}/attachments/${registered.attachment.id}/upload`,
        { ifMatch: registered.revision, idempotencyKey: uploadKey, body: { base64: imageFixture().base64 } },
      ],
      ['DELETE', BASE, { ifMatch: uploaded.revision, idempotencyKey: deleteKey }],
    ] as const;
    for (const [method, path, options] of commands)
      await error(s.request(method, path, options), 403, 'TENANT_NOT_MEMBER');
  });
});

describe('AC-EMP（补）F-058 图片内容、并发、幂等与审计', () => {
  it('5 MiB 有效图片可上传，登记或实际内容超上限均 413且原头像不变', async () => {
    const s = await scene('f058-size');
    const maximum = fixtureFromBytes(pngBytes(MODEL_IMAGE_LIMIT));
    const first = await upload(s.request, await register(s.request, 1, maximum), maximum);
    const oversized = fixtureFromBytes(pngBytes(MODEL_IMAGE_LIMIT + 1));
    await error(
      s.request('POST', `${BASE}/attachments`, { ifMatch: first.revision, body: oversized.metadata }),
      413,
      'PAYLOAD_TOO_LARGE',
    );
    const registered = await register(s.request, first.revision);
    const before = await read(s.request);
    await error(
      s.request('POST', `${BASE}/attachments/${registered.attachment.id}/upload`, {
        ifMatch: registered.revision,
        body: { base64: oversized.base64 },
      }),
      413,
      'PAYLOAD_TOO_LARGE',
    );
    expect(await read(s.request)).toEqual(before);
    expect((await s.request('GET', first.avatar!.url)).status).toBe(200);
    expect(await status(s.tenant.id, registered.attachment.id)).toBe('registered');
  });

  it.each([
    ['损坏 PNG CRC', () => malformedPng('crc')],
    ['损坏 PNG 长度', () => malformedPng('length')],
    ['普通文本伪装图片', () => fixtureFromBytes(Buffer.from('合成文本，不能作为头像'))],
    ['真实格式与 MIME 不同', () => fixtureFromBytes(imageFixture('gif').bytes, 'png')],
  ] as const)('%s 即使大小与哈希吻合也拒绝 415且不关联附件', async (_label, make) => {
    const s = await scene('f058-decoding');
    const fixture = make();
    const registered = await register(s.request, 1, fixture);
    const before = await read(s.request);
    await error(
      s.request('POST', `${BASE}/attachments/${registered.attachment.id}/upload`, {
        ifMatch: registered.revision,
        body: { base64: fixture.base64 },
      }),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
    expect(await read(s.request)).toEqual(before);
    expect(await status(s.tenant.id, registered.attachment.id)).toBe('registered');
    await error(s.request('GET', contentPath(registered.attachment.id)), 404, 'NOT_FOUND');
  });

  it.each(['sha256', 'size', 'empty', 'base64'] as const)('%s 不符拒绝 400且不增加 revision', async (kind) => {
    const s = await scene('f058-integrity');
    const fixture = imageFixture();
    const declared: ImageFixture = {
      ...fixture,
      metadata: {
        ...fixture.metadata,
        ...(kind === 'sha256' ? { sha256: '0'.repeat(64) } : {}),
        ...(kind === 'size' ? { byteSize: fixture.bytes.length + 1 } : {}),
      },
    };
    const registered = await register(s.request, 1, declared);
    const before = await read(s.request);
    const base64 = kind === 'empty' ? '' : kind === 'base64' ? '%%%not-base64%%%' : fixture.base64;
    await error(
      s.request('POST', `${BASE}/attachments/${registered.attachment.id}/upload`, {
        ifMatch: registered.revision,
        body: { base64 },
      }),
      400,
      'VALIDATION_FAILED',
    );
    expect(await read(s.request)).toEqual(before);
  });

  it('过期 revision、缺失命令 ID与同键不同载荷拒绝，不覆盖已上传的头像', async () => {
    const s = await scene('f058-conflict');
    const key = randomUUID();
    const registered = await register(s.request, 1, imageFixture(), key);
    const uploaded = await upload(s.request, registered);
    await error(s.request('DELETE', BASE, { ifMatch: 1 }), 409);
    await error(
      s.request('POST', `${BASE}/attachments`, {
        ifMatch: uploaded.revision,
        body: imageFixture().metadata,
        idempotencyKey: null,
      }),
      400,
    );
    await error(
      s.request('POST', `${BASE}/attachments`, { ifMatch: 1, body: imageFixture('bmp').metadata, idempotencyKey: key }),
      409,
    );
    expect(await read(s.request)).toEqual(uploaded);
  });

  it('登记、上传与删除同键重放只写一次；旧上传重放不复活头像，审计和台账不含图片字节', async () => {
    const s = await scene('f058-replay');
    const fixture = imageFixture();
    const keys = [randomUUID(), randomUUID(), randomUUID()] as const;
    const registered = await register(s.request, 1, fixture, keys[0]);
    expect(await register(s.request, 1, fixture, keys[0])).toEqual(registered);
    const uploaded = await upload(s.request, registered, fixture, keys[1]);
    expect(await upload(s.request, registered, fixture, keys[1])).toEqual(uploaded);
    const deletion = { ifMatch: uploaded.revision, idempotencyKey: keys[2] };
    const deleted = await json<AvatarView>(s.request('DELETE', BASE, deletion));
    expect(await json(s.request('DELETE', BASE, deletion))).toEqual(deleted);
    await json(
      s.request('POST', `${BASE}/attachments/${registered.attachment.id}/upload`, {
        ifMatch: registered.revision,
        body: { base64: fixture.base64 },
        idempotencyKey: keys[1],
      }),
    );
    expect(await read(s.request)).toEqual(deleted);
    await error(s.request('GET', contentPath(registered.attachment.id)), 404, 'NOT_FOUND');
    const evidence = await withTenant(s.db, s.tenant.id, async (tx) => {
      const audit = await tx.execute(sql`SELECT action, "before", "after", changes FROM audit_events
        WHERE tenant_id=${s.tenant.id} AND action LIKE 'account.avatar.%'`);
      const ledger = await tx.execute(sql`SELECT response_body FROM command_ledger
        WHERE tenant_id=${s.tenant.id} AND command_id IN (${keys[0]}, ${keys[1]}, ${keys[2]})`);
      return {
        audit: Array.isArray(audit) ? audit : (audit as { rows: unknown[] }).rows,
        ledger: Array.isArray(ledger) ? ledger : (ledger as { rows: unknown[] }).rows,
      };
    });
    expect(evidence.audit).toHaveLength(3);
    expect(evidence.ledger).toHaveLength(3);
    const serialized = JSON.stringify(evidence);
    for (const forbidden of [fixture.base64, 'content_base64', '"base64"']) expect(serialized).not.toContain(forbidden);
    expect(serialized).toContain(fixture.metadata.sha256);
  });

  it('跨站 Origin 与 Sec-Fetch-Site 拒绝登记、上传和删除，当前头像保持不变', async () => {
    const s = await scene('f058-origin');
    const registered = await register(s.request, 1);
    const uploaded = await upload(s.request, registered);
    const operations = [
      ['POST', `${BASE}/attachments`, imageFixture('bmp').metadata],
      ['POST', `${BASE}/attachments/${registered.attachment.id}/upload`, { base64: imageFixture().base64 }],
      ['DELETE', BASE, undefined],
    ] as const;
    const crossSiteHeaders: Readonly<Record<string, string>>[] = [
      { origin: 'https://cross-site.example.com' },
      { 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of crossSiteHeaders) {
      for (const [method, path, body] of operations) {
        await error(s.request(method, path, { ifMatch: uploaded.revision, body, headers }), 403, 'FORBIDDEN');
        expect(await read(s.request)).toEqual(uploaded);
      }
    }
  });
});

describe('AC-EMP（补）F-058 员工档案与人员头像引用', () => {
  it('员工头像按账号人员绑定同步，证件照字段不能作为头像，也不能经员工档案手改', async () => {
    const s = await personnelSession(testDb().db, 'f058-personnel');
    await withTenant(testDb().db, s.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO permission_user_person_links(tenant_id,user_id,employee_id)
        VALUES(${s.tenant.id},${s.user.id},${s.employee.id})`),
    );
    const idPhoto = randomUUID();
    // 已有档案证件照是独立夹具，不经本任务头像路由生成。
    await testDb().db.execute(sql`INSERT INTO personnel_attachments
      (id,tenant_id,employee_id,purpose,filename,content_type,byte_size,sha256,created_by)
      VALUES (${idPhoto},${s.tenant.id},${s.employee.id},'photo','synthetic-id-photo.png','image/png',
        ${imageFixture().metadata.byteSize},${imageFixture().metadata.sha256},${s.user.id})`);
    await testDb().db.execute(sql`INSERT INTO personnel_employee_versions
      (id,tenant_id,employee_id,revision,command_id,created_by,name,id_photo)
      VALUES (${randomUUID()},${s.tenant.id},${s.employee.id},1,${randomUUID()},${s.user.id},
        ${s.employee.name},${idPhoto})`);
    const account: AvatarRequest = (method, path, options = {}) => s.api.request(method, path, { ...options, ...s.as });
    const before = await json<Record<string, unknown>>(s.request('GET', `/employees/${s.employee.id}`));
    expect(before.idPhoto).toBe(idPhoto);
    expect(before.avatar).toBeNull();
    const registered = await register(account, 1);
    const uploaded = await upload(account, registered);
    expect(await json(s.request('GET', `/employees/${s.employee.id}`))).toMatchObject({ avatar: uploaded.avatar });
    expect(await json(account('GET', `/api/tenant/employment/employees/${s.employee.id}`))).toMatchObject({
      avatar: uploaded.avatar,
    });
    expect(await json(account('GET', '/api/tenant/self-service/profile'))).toMatchObject({
      employee: { id: s.employee.id, avatar: uploaded.avatar },
    });
    await error(
      s.request('PATCH', `/employees/${s.employee.id}`, { ifMatch: before.revision as number, body: { avatar: null } }),
      400,
      'VALIDATION_FAILED',
    );
    await json(account('DELETE', BASE, { ifMatch: uploaded.revision }));
    expect(await json(s.request('GET', `/employees/${s.employee.id}`))).toMatchObject({ avatar: null });
  });

  it('360 人员和上级摘要引用实时头像，替换与删除无需重新同步人员', async () => {
    const w = await world360(testDb().db, 'f058-survey');
    const org = await w.session.org('头像测试部门', { establishedOn: '2025-01-01' });
    const boss = await w.session.employee('头像上级');
    const child = await w.session.employee('头像下属');
    for (const [employee, directManagerId] of [
      [boss, undefined],
      [child, boss.id],
    ] as const) {
      await w.session.business(
        employee.id,
        {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: '2025-01-01',
          fields: { departmentId: org.id, ...(directManagerId ? { directManagerId } : {}) },
        },
        employee.revision,
      );
    }
    const links = await withTenant(testDb().db, w.tenantId, (tx) =>
      tx.execute(sql`SELECT user_id FROM permission_user_person_links
        WHERE tenant_id=${w.tenantId} AND employee_id=${boss.id}::uuid`),
    );
    const bossUser = (Array.isArray(links) ? links : (links as { rows: { user_id: string }[] }).rows) as {
      user_id: string;
    }[];
    expect(bossUser).toHaveLength(1);
    await w.ok(w.request('POST', '/people/sync', { body: {} }));
    const people = (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items;
    const bossPerson = people.find((person) => person.employeeId === boss.id)!;
    const childPerson = people.find((person) => person.employeeId === child.id)!;
    const api = tenantApi(testDb().db, { authorize: undefined });
    const account: AvatarRequest = (method, path, options = {}) =>
      api.request(method, path, { ...options, user: bossUser[0]!.user_id, tenant: w.tenantId });
    const first = await upload(account, await register(account, 1));
    const assertReferences = async (avatar: AvatarRef | null) => {
      expect(await w.ok(w.request('GET', `/people/${bossPerson.id}`))).toMatchObject({ avatar });
      expect(await w.ok(w.request('GET', `/people/${childPerson.id}`))).toMatchObject({
        superior: { id: bossPerson.id, name: bossPerson.name, avatar },
      });
    };
    await assertReferences(first.avatar);
    const fixture = imageFixture('bmp');
    const second = await upload(account, await register(account, first.revision, fixture), fixture);
    await assertReferences(second.avatar);
    await json(account('DELETE', BASE, { ifMatch: second.revision }));
    await assertReferences(null);
  });
});
