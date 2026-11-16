import { randomUUID } from 'node:crypto';
import { createUser, grantMembership } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { simulatedProvider } from '../../apps/api/src/modules/esign/provider.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { recordsWorld, json, zipNames, RECORD, BASE, COLUMNS } from './AC-TRF-F481-s3b-support.js';
import { tenantApi, seedTenantWithMember, cmd } from './support/tenant-api.js';

const database = useTestDb();
describe('AC-TRF-F481-16 / 19 / 22 文件', () => {
  it('16 单份 PDF、多份与多任务 ZIP，模板正文修改不改变快照，每次一条 export 日志', async () => {
    const w = await recordsWorld(database().db, 'files');
    const done = await w.complete(w.task);
    const download = (ids: string) => w.call('GET', `${BASE}/records/files?ids=${ids}`);
    const provider = vi.spyOn(simulatedProvider, 'signedFiles');
    let pdf: Response;
    try {
      pdf = await download(done.id);
      const input = provider.mock.calls[0]![0];
      expect(input.documents[0]!.blocks).toContainEqual({ kind: 'text', text: (await w.files(done.id))[0]!.content });
      expect(JSON.stringify(input.documents)).toContain('复刻模拟签署，无电子印章');
      expect(JSON.stringify(input.documents)).toContain('员工本人：ZZ_F481_EMP_01');
      expect(JSON.stringify(input.documents)).toContain(w.session.tenant.name);
    } finally {
      provider.mockRestore();
    }
    expect(pdf.status, await pdf.clone().text()).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(decodeURIComponent(pdf.headers.get('content-disposition')!)).toContain('ZZ_F481_A.pdf');
    const bytes = Buffer.from(await pdf.arrayBuffer());
    expect(bytes.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(await w.exports()).toHaveLength(1);
    await w.api.request('PATCH', `${BASE}/templates/${w.templates[0]!.id}`, {
      ...w.as,
      ifMatch: 1,
      body: { body: 'SYN_CHANGED_BODY', name: 'ZZ_F481_changed' },
    });
    expect(Buffer.from(await (await download(done.id)).arrayBuffer())).toEqual(bytes);
    const second = await w.complete(await w.next([w.templates[1]!.id, w.templates[2]!.id]));
    const zip = await download(second.id);
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(decodeURIComponent(zip.headers.get('content-disposition')!)).toContain('电子签署文件_20261010.zip');
    expect(zipNames(Buffer.from(await zip.arrayBuffer()))).toEqual([
      'ZZ_F481_EMP_01_ZZ_F481_B.pdf',
      'ZZ_F481_EMP_01_ZZ_F481_C.pdf',
    ]);
    const multi = await download(`${done.id},${second.id}`);
    expect(multi.status).toBe(200);
    expect(zipNames(Buffer.from(await multi.arrayBuffer()))).toHaveLength(3);
    expect(await w.exports()).toHaveLength(4);
    const signing = await w.next();
    const rejected = await json(await download(`${done.id},${signing.id}`), 409);
    expect(rejected.error.details).toMatchObject({ reason: 'ESIGN_NOT_COMPLETED', ids: [signing.id] });
    expect(await w.exports()).toHaveLength(4);
  });

  it('22 files 读权先于状态检查；列表同步裁剪，撤权后下一次请求立即拒绝', async () => {
    const w = await recordsWorld(database().db, 'field');
    const done = await w.complete(w.task);
    const pending = await w.next();
    const grants = { fields: { [RECORD]: [...COLUMNS] } };
    const request = w.request(grants);
    const path = `${BASE}/records/files?ids=${done.id}`;
    expect((await request('GET', path)).status).toBe(200);
    const count = (await w.exports()).length;
    grants.fields[RECORD] = COLUMNS.filter((f) => f !== 'files');
    for (const ids of [done.id, pending.id, `${done.id},${pending.id}`]) {
      const response = await request('GET', `${BASE}/records/files?ids=${ids}`);
      expect(response.headers.has('content-disposition')).toBe(false);
      const body = await json(response, 403);
      expect(body.error.code).toBe('FIELD_FORBIDDEN');
      for (const secret of [done.id, pending.id, 'ZZ_F481_A', 'ZZ_F481_EMP_01'])
        expect(JSON.stringify(body)).not.toContain(secret);
    }
    for (const row of (await json(await request('GET', `${BASE}/records`))).items)
      expect(row).not.toHaveProperty('files');
    expect(await w.exports()).toHaveLength(count);
    const noOwner = w.request({ fields: { [RECORD]: COLUMNS.filter((f) => f !== 'owner') } });
    const end = await w.complete(pending);
    const zip = await noOwner('GET', `${BASE}/records/files?ids=${done.id},${end.id}`);
    expect(zip.status).toBe(200);
    expect(zipNames(Buffer.from(await zip.arrayBuffer()))).toEqual([
      `${done.id.slice(0, 8)}_ZZ_F481_A.pdf`,
      `${end.id.slice(0, 8)}_ZZ_F481_A.pdf`,
    ]);
  });

  it('16 / 22 本人签署下载绕过记录按钮/字段/范围，第三人和跨租户一律 404', async () => {
    const w = await recordsWorld(database().db, 'mine');
    const done = await w.complete(w.task);
    const grants = { deny: () => true, fields: { [RECORD]: [] }, scopes: { [RECORD]: EMPTY_SCOPE } };
    for (const user of [done.employeeSignerUserId!, done.initiatorUserId]) {
      const response = await w.request(grants, user)('GET', `${BASE}/mine/${done.id}/files`);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/pdf');
    }
    const outsider = await seedTenantWithMember(w.db, 'ZZ_F481_other');
    const third = await createUser(
      w.db,
      { email: `syn_${randomUUID()}@example.com`, displayName: 'ZZ_F481_THIRD' },
      cmd(),
    );
    await grantMembership(w.db, { tenantId: w.tenantId, userId: third.id, expectedRevision: 0 }, cmd());
    expect((await w.request({}, third.id)('GET', `${BASE}/mine/${done.id}/files`)).status).toBe(404);
    const response = await tenantApi(w.db).request('GET', `${BASE}/mine/${done.id}/files`, {
      user: outsider.user.id,
      tenant: outsider.tenant.id,
    });
    expect(response.status).toBe(404);
    expect((await w.call('GET', `${BASE}/mine/${randomUUID()}/files`)).status).toBe(404);
    expect((await w.call('GET', `${BASE}/mine/not-uuid/files`)).status).toBe(400);
    const pending = await w.next();
    expect((await w.call('GET', `${BASE}/mine/${pending.id}/files`)).status).toBe(409);
    expect(await w.exports()).toHaveLength(2);
  });

  it('16 下载空集、51 条、重复或非法 ID 拒绝；缺按钮或范围不生成文件', async () => {
    const w = await recordsWorld(database().db, 'limits');
    const done = await w.complete(w.task);
    for (const ids of [
      '',
      'invalid',
      `${done.id},${done.id}`,
      Array.from({ length: 51 }, () => randomUUID()).join(','),
    ])
      expect((await w.call('GET', `${BASE}/records/files?ids=${ids}`)).status).toBe(400);
    const noButton = w.request({ deny: (q) => q.action === 'object.button' });
    expect((await noButton('GET', `${BASE}/records/files?ids=${done.id}`)).status).toBe(403);
    const noScope = w.request({ scopes: { [RECORD]: EMPTY_SCOPE } });
    expect((await noScope('GET', `${BASE}/records/files?ids=${done.id}`)).status).toBe(404);
    expect(await w.exports()).toEqual([]);
  });

  it('22 单独验证 files 列裁剪与无 owner 读权的 ZIP 命名', async () => {
    const w = await recordsWorld(database().db, 'trim-name');
    const done = await w.complete(w.task);
    const noFiles = w.request({ fields: { [RECORD]: COLUMNS.filter((f) => f !== 'files') } });
    const list = await json(await noFiles('GET', `${BASE}/records`));
    expect(list.items[0]).not.toHaveProperty('files');
    expect(JSON.stringify(list)).not.toContain('ZZ_F481_A');
    const second = await w.complete(await w.next());
    const noOwner = w.request({ fields: { [RECORD]: COLUMNS.filter((f) => f !== 'owner') } });
    const response = await noOwner('GET', `${BASE}/records/files?ids=${done.id},${second.id}`);
    expect(response.status).toBe(200);
    expect(zipNames(Buffer.from(await response.arrayBuffer()))).toEqual([
      `${done.id.slice(0, 8)}_ZZ_F481_A.pdf`,
      `${second.id.slice(0, 8)}_ZZ_F481_A.pdf`,
    ]);
  });

  it('16 ZIP 同名加序号并清理路径/控制字符，不改变签署正文快照', async () => {
    const w = await recordsWorld(database().db, 'filename');
    await w.complete(w.task);
    const renamed = await w.api.request('PATCH', `${BASE}/templates/${w.templates[0]!.id}`, {
      ...w.as,
      ifMatch: 1,
      body: { name: '../ZZ_F481_\r\n模板' },
    });
    expect(renamed.status).toBe(200);
    const done = await w.complete(await w.next());
    const second = await w.complete(await w.next());
    const response = await w.call('GET', `${BASE}/records/files?ids=${done.id},${second.id}`);
    expect(response.status).toBe(200);
    const names = zipNames(Buffer.from(await response.arrayBuffer()));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const name of names) expect(name).not.toMatch(/[\\/\r\n]/);
    expect(names[1]).toBe(names[0]!.replace('.pdf', '_2.pdf'));
  });
});
