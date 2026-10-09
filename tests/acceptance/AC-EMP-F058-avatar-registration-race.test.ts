/** AC-EMP（补）F-058：登记提交后的回包延迟不能把其它标签页的 revision 授予自动上传。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as commands from '../../apps/api/src/commands.js';
import { imageFixture } from './AC-TC-model-image-support.js';
import { seedTenantWithMember, tenantApi, type RequestOptions } from './support/tenant-api.js';

const testDb = useTestDb();
const BASE = '/api/tenant/account/avatar';
interface Registration {
  revision: number;
  attachment: { id: string; status: string };
}
interface AvatarView {
  revision: number;
  name: string;
  avatar: { id: string; url: string } | null;
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 只暂停已经提交的原命令回包；所有验权、事务、台账和后续 HTTP 请求仍执行真实代码。 */
function holdCommittedReply(commandId: string) {
  const entered = signal();
  const release = signal();
  const execute = commands.runCommand;
  vi.spyOn(commands, 'runCommand').mockImplementation(async (db, ctx, command) => {
    const result = await execute(db, ctx, command);
    if (command.id === commandId) {
      entered.resolve();
      await release.promise;
    }
    return result;
  });
  return { entered: entered.promise, release: release.resolve };
}

async function json<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
  const result = await response;
  expect(result.status, await result.clone().text()).toBe(status);
  return (await result.json()) as T;
}

async function scene(label: string) {
  const db = testDb().db;
  const { tenant, user } = await seedTenantWithMember(db, label);
  const api = tenantApi(db, { authorize: undefined });
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, path, { ...options, user: user.id, tenant: tenant.id });
  return { db, tenant, user, request };
}

async function writeEvidence(s: Awaited<ReturnType<typeof scene>>) {
  return withTenant(s.db, s.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT
      (SELECT count(*)::int FROM audit_events WHERE tenant_id=${s.tenant.id}
        AND object_type='Account.Avatar' AND object_id=${s.user.id}) AS audit,
      (SELECT count(*)::int FROM command_ledger WHERE tenant_id=${s.tenant.id}) AS ledger`);
    return (Array.isArray(result) ? result : result.rows) as { audit: number; ledger: number }[];
  });
}

afterEach(() => vi.restoreAllMocks());

describe('AC-EMP（补）F-058 登记命令自己的 revision', () => {
  for (const replay of [false, true]) {
    it(`${replay ? '登记重放' : '首次登记'}回包前 B 已登记并上传，A 自动上传必须 409 且 B 图片仍可读`, async () => {
      const s = await scene(`f058-registration-${replay ? 'replay' : 'first'}`);
      const key = randomUUID();
      const a = imageFixture();
      const options = { ifMatch: 1, body: a.metadata, idempotencyKey: key };
      if (replay) await json<Registration>(s.request('POST', `${BASE}/attachments`, options), 201);
      const gate = holdCommittedReply(key);
      const delayed = s.request('POST', `${BASE}/attachments`, options);
      try {
        await Promise.race([
          gate.entered,
          delayed.then(() => {
            throw new Error('A 未在真实命令提交后进入回包屏障');
          }),
        ]);
        expect((await json<AvatarView>(s.request('GET', BASE))).revision).toBe(2);
        const b = imageFixture('bmp');
        const bRegistration = await json<Registration>(
          s.request('POST', `${BASE}/attachments`, { ifMatch: 2, body: b.metadata }),
          201,
        );
        expect(bRegistration.revision).toBe(3);
        const bView = await json<AvatarView>(
          s.request('POST', `${BASE}/attachments/${bRegistration.attachment.id}/upload`, {
            ifMatch: bRegistration.revision,
            body: { base64: b.base64 },
          }),
        );
        expect(bView.revision).toBe(4);
        const beforeUpload = await writeEvidence(s);
        expect(beforeUpload).toEqual([{ audit: 3, ledger: 3 }]);
        gate.release();
        const aResponse = await delayed;
        const aRegistration = await json<Registration>(aResponse, 201);
        // 模拟 UI 的实际链路：直接使用登记回执 revision，不另读头像当前状态。
        const automaticUpload = await s.request('POST', `${BASE}/attachments/${aRegistration.attachment.id}/upload`, {
          ifMatch: aRegistration.revision,
          body: { base64: a.base64 },
        });
        expect(automaticUpload.status, await automaticUpload.clone().text()).toBe(409);
        expect(await automaticUpload.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
        expect(aRegistration.revision).toBe(2);
        expect(aResponse.headers.get('etag')).toBe('"2"');
        expect(await json<AvatarView>(s.request('GET', BASE))).toEqual(bView);
        expect(await writeEvidence(s)).toEqual(beforeUpload);
        const content = await s.request('GET', bView.avatar!.url);
        expect(content.status).toBe(200);
        expect(Buffer.from(await content.arrayBuffer())).toEqual(b.bytes);
        const ledger = await withTenant(s.db, s.tenant.id, async (tx) => {
          const result = await tx.execute(sql`SELECT response_body FROM command_ledger WHERE command_id=${key}`);
          return (Array.isArray(result) ? result : result.rows) as { response_body: unknown }[];
        });
        expect(ledger[0]!.response_body).toMatchObject({ revision: 2 });
      } finally {
        gate.release();
        await delayed;
      }
    });
  }

  it('旧登记台账缺 revision 时按原请求 revision + 1 回执，附件仍重读删除后的元数据', async () => {
    const s = await scene('f058-registration-legacy');
    const key = randomUUID();
    const options = { ifMatch: 1, body: imageFixture().metadata, idempotencyKey: key };
    const registered = await json<Registration>(s.request('POST', `${BASE}/attachments`, options), 201);
    // 用库所有者模拟升级前已持久化的台账格式；生产路径仍只允许 INSERT。
    await s.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${s.tenant.id}, true)`);
      await tx.execute(sql`UPDATE command_ledger SET response_body=response_body-'revision'
        WHERE tenant_id=${s.tenant.id} AND command_id=${key}`);
    });
    const deleted = await json<AvatarView>(s.request('DELETE', BASE, { ifMatch: 2 }));
    expect(deleted.revision).toBe(3);
    const response = await s.request('POST', `${BASE}/attachments`, options);
    const replayed = await json<Registration>(response, 201);
    expect(replayed).toEqual({
      revision: 2,
      attachment: { id: registered.attachment.id, ...options.body, status: 'pending_cleanup' },
    });
    expect(response.headers.get('etag')).toBe('"2"');
    expect(await json<AvatarView>(s.request('GET', BASE))).toEqual(deleted);
    expect((await s.request('GET', `/api/tenant/avatars/${registered.attachment.id}/content`)).status).toBe(404);
  });
});
