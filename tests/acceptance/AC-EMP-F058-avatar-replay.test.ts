/** F-058 R2 / DEC-327：旧业务命令只重新投影当前头像，不改变原业务回执和命令台账。 */
import { randomUUID } from 'node:crypto';
import { commandLedger, eq, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { imageFixture } from './AC-TC-model-image-support.js';
import { seedTenantWithMember, tenantApi, type RequestOptions } from './support/tenant-api.js';

const database = useTestDb();
const USERS = '/api/tenant/permission/users';
const AVATAR = '/api/tenant/account/avatar';
interface AvatarReference {
  id: string;
  url: string;
}
type Receipt = Record<string, unknown> & { avatar: AvatarReference | null };

async function ok<T>(response: Promise<Response> | Response, status = 200): Promise<T> {
  const resolved = await response;
  expect(resolved.status, await resolved.clone().text()).toBe(status);
  return (await resolved.json()) as T;
}

async function scene(label: string) {
  const db = database().db;
  const { tenant, user } = await seedTenantWithMember(db, label);
  const api = tenantApi(db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, path, { ...options, tenant: tenant.id, user: user.id });
  const owner =
    (userId: string) =>
    (method: string, path: string, options: RequestOptions = {}) =>
      api.request(method, path, { ...options, tenant: tenant.id, user: userId });
  async function ledger(commandId: string) {
    const [entry] = await withTenant(db, tenant.id, (tx) =>
      tx.select().from(commandLedger).where(eq(commandLedger.commandId, commandId)),
    );
    expect(entry).toBeDefined();
    return entry!.responseBody;
  }
  return { db, tenant, user, request, owner, ledger };
}

async function upload(request: ReturnType<Awaited<ReturnType<typeof scene>>['owner']>, format: 'png' | 'bmp') {
  const current = await ok<{ revision: number }>(request('GET', AVATAR));
  const fixture = imageFixture(format);
  const registered = await ok<{ revision: number; attachment: { id: string } }>(
    request('POST', `${AVATAR}/attachments`, { ifMatch: current.revision, body: fixture.metadata }),
    201,
  );
  return ok<{ revision: number; avatar: AvatarReference }>(
    request('POST', `${AVATAR}/attachments/${registered.attachment.id}/upload`, {
      ifMatch: registered.revision,
      body: { base64: fixture.base64 },
    }),
  );
}

describe('AC-EMP（补）F-058 R2 旧命令头像投影', () => {
  it('人员档案 PATCH 重放随替换与删除投影当前头像，仍保留首次字段、revision、ETag 和台账', async () => {
    const s = await scene('f058-personnel-replay');
    const created = await ok<{ id: string }>(
      s.request('POST', '/api/tenant/employment/employees', {
        ifMatch: 0,
        body: { code: `E_${randomUUID()}`, name: '合成头像员工', loginEmail: `${randomUUID()}@example.com` },
      }),
      201,
    );
    const users = await ok<{ items: { userId: string; employeeId: string | null }[] }>(s.request('GET', USERS));
    const target = users.items.find((user) => user.employeeId === created.id)!;
    expect(target).toBeDefined();
    const own = s.owner(target.userId);
    const originalAvatar = await upload(own, 'png');
    const path = `/api/tenant/personnel/employees/${created.id}`;
    const commandId = randomUUID();
    const input = { ifMatch: 0, body: { engName: 'Original' }, idempotencyKey: commandId };
    const firstResponse = await s.request('PATCH', path, input);
    const first = await ok<Receipt>(firstResponse);
    expect(first.avatar).toEqual(originalAvatar.avatar);
    const firstLedger = await s.ledger(commandId);
    await ok(s.request('PATCH', path, { ifMatch: first.revision as number, body: { engName: 'Later' } }));
    const replacement = await upload(own, 'bmp');
    const replay = await s.request('PATCH', path, input);
    expect(await ok<Receipt>(replay)).toEqual({ ...first, avatar: replacement.avatar });
    expect(replay.headers.get('etag')).toBe(firstResponse.headers.get('etag'));
    expect(await s.ledger(commandId)).toEqual(firstLedger);
    expect(await ok(s.request('GET', path))).toMatchObject({ engName: 'Later', avatar: replacement.avatar });
    await ok(own('DELETE', AVATAR, { ifMatch: replacement.revision }));
    expect(await ok<Receipt>(s.request('PATCH', path, input))).toEqual({ ...first, avatar: null });
    expect(await s.ledger(commandId)).toEqual(firstLedger);
  });

  it('外部用户登记 POST 重放只更新头像，保留登记时的业务身份与成员 revision；移出后投影为空', async () => {
    const s = await scene('f058-register-replay');
    const commandId = randomUUID();
    const input = {
      body: {
        email: `${randomUUID()}@example.com`,
        displayName: '合成外部登记用户',
        userType: 'external',
        businessIdentity: '原登记身份',
      },
      idempotencyKey: commandId,
    };
    const first = await ok<Receipt & { userId: string; membershipRevision: number }>(
      s.request('POST', USERS, input),
      201,
    );
    expect(first.avatar).toBeNull();
    const firstLedger = await s.ledger(commandId);
    const own = s.owner(first.userId);
    const uploaded = await upload(own, 'png');
    expect(await ok<Receipt>(s.request('POST', USERS, input), 201)).toEqual({ ...first, avatar: uploaded.avatar });
    const changed = await ok<{ membershipRevision: number }>(
      s.request('PUT', `${USERS}/${first.userId}`, {
        ifMatch: first.membershipRevision,
        body: { userType: 'external', businessIdentity: '后来的身份' },
      }),
    );
    const replacement = await upload(own, 'bmp');
    expect(await ok<Receipt>(s.request('POST', USERS, input), 201)).toEqual({ ...first, avatar: replacement.avatar });
    expect(await s.ledger(commandId)).toEqual(firstLedger);
    expect(await ok(s.request('GET', `${USERS}/${first.userId}`))).toMatchObject({ businessIdentity: '后来的身份' });
    await ok(s.request('POST', `${USERS}/${first.userId}/remove`, { ifMatch: changed.membershipRevision, body: {} }));
    expect(await ok<Receipt>(s.request('POST', USERS, input), 201)).toEqual({ ...first, avatar: null });
    expect(await s.ledger(commandId)).toEqual(firstLedger);
  });

  it('外部用户修改 PUT 重放随替换与删除投影当前头像，业务回执、ETag 与台账保留首次结果', async () => {
    const s = await scene('f058-update-replay');
    const external = await ok<{ userId: string; membershipRevision: number }>(
      s.request('POST', USERS, {
        body: {
          email: `${randomUUID()}@example.com`,
          displayName: '合成外部修改用户',
          userType: 'external',
          businessIdentity: '登记身份',
        },
      }),
      201,
    );
    const own = s.owner(external.userId);
    const originalAvatar = await upload(own, 'png');
    const commandId = randomUUID();
    const path = `${USERS}/${external.userId}`;
    const input = {
      ifMatch: external.membershipRevision,
      body: { userType: 'external', businessIdentity: '首次修改身份' },
      idempotencyKey: commandId,
    };
    const firstResponse = await s.request('PUT', path, input);
    const first = await ok<Receipt>(firstResponse);
    expect(first.avatar).toEqual(originalAvatar.avatar);
    const firstLedger = await s.ledger(commandId);
    await ok(
      s.request('PUT', path, {
        ifMatch: first.membershipRevision as number,
        body: { userType: 'external', businessIdentity: '后来的身份' },
      }),
    );
    const replacement = await upload(own, 'bmp');
    const replay = await s.request('PUT', path, input);
    expect(await ok<Receipt>(replay)).toEqual({ ...first, avatar: replacement.avatar });
    expect(replay.headers.get('etag')).toBe(firstResponse.headers.get('etag'));
    expect(await s.ledger(commandId)).toEqual(firstLedger);
    expect(await ok(s.request('GET', path))).toMatchObject({ businessIdentity: '后来的身份' });
    await ok(own('DELETE', AVATAR, { ifMatch: replacement.revision }));
    expect(await ok<Receipt>(s.request('PUT', path, input))).toEqual({ ...first, avatar: null });
    expect(await s.ledger(commandId)).toEqual(firstLedger);
  });
});
