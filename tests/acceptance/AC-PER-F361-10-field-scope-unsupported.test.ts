/**
 * F-361② 第 2 轮返工 · 验收 10～12（作用对象：复刻系统，合成数据，全部走真实授权器）：
 * 10 字段级精确复核（P1-1）：只撤“学历证书”编辑权、保留“学位证书”，上传 / 删除 / 同键重放均 403；
 * 11 事务内范围（P1-2）：入口授权后、命令事务检查前收回目标部门范围（对象 / 字段权保留）→ 404，不新增文件、不交旧回执；
 * 12 不支持附件的子集（P2-2）：training 调上传 / 删除入口返回 400，而不是 503。
 */
import { randomUUID } from 'node:crypto';
import { SUBSETS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { png, sha256, type Receipt } from './AC-ATT-support.js';
import { FIELD, OTHER_FIELD, newKey, personnelWorld, type F361World } from './AC-PER-F361-support.js';
import type * as ModuleAccess from '../../apps/api/src/modules/permission/module-access.js';

// 在“入口解析范围”之后注入撤权：包一层范围提供者，入口（无 tx）算出旧范围后立刻收回，再把旧结果交回入口
const hook = vi.hoisted(() => ({ armed: false, objectCode: '', fire: null as null | (() => Promise<void>) }));
vi.mock('../../apps/api/src/modules/permission/module-access.js', async (original) => {
  const mod = (await original()) as typeof ModuleAccess;
  return {
    ...mod,
    registerScopeProvider: (authorize: never, provider: Parameters<typeof mod.registerScopeProvider>[1]) =>
      mod.registerScopeProvider(authorize, {
        ...provider,
        scope: async (query, tx) => {
          const result = await provider.scope(query, tx);
          if (hook.armed && !tx && query.objectCode === hook.objectCode) {
            hook.armed = false;
            await hook.fire?.();
          }
          return result;
        },
      }),
  };
});

const database = useTestDb();
let w: F361World;
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

beforeAll(async () => {
  w = await personnelWorld(database().db);
  hook.objectCode = SUBSETS.education.objectCode;
});

const registered = async (as: { tenant: string; user: string }, bytes: Buffer, field: string) =>
  w.json<Receipt>(await w.register(as, w.target.id, bytes, { field }), 201);

describe('AC-PER-F361-10 字段级精确复核（P1-1）', () => {
  it('只撤“学历证书”编辑权、保留“学位证书”：上传 / 删除 / 同键重放均 403，学位证书的文件照常可用', async () => {
    const hr = await w.actor('hr-field');
    const replayBytes = png(5, 5);
    const replayFile = await registered(hr.as, replayBytes, FIELD);
    const replayKey = newKey();
    await w.json(await w.upload(hr.as, w.target.id, replayFile.id, replayBytes, replayFile.revision, replayKey), 200);
    const pendingBytes = png(6, 6);
    const pending = await registered(hr.as, pendingBytes, FIELD);
    const deletable = await w.stored(hr.as, w.target.id, png(7, 7), FIELD);
    const otherBytes = png(8, 8);
    const other = await registered(hr.as, otherBytes, OTHER_FIELD);

    await hr.reconfigure({ attachmentEditFields: [OTHER_FIELD] });

    expect((await w.upload(hr.as, w.target.id, pending.id, pendingBytes, pending.revision)).status).toBe(403);
    expect((await w.remove(hr.as, w.target.id, deletable.id, deletable.revision)).status).toBe(403);
    const replay = await w.upload(hr.as, w.target.id, replayFile.id, replayBytes, replayFile.revision, replayKey);
    expect(replay.status).toBe(403);
    expect(await w.row(pending.id)).toMatchObject({ status: 'registered' });
    expect(await w.row(deletable.id)).toMatchObject({ status: 'uploaded' });

    // 对照：保留编辑权的字段不受影响
    expect((await w.upload(hr.as, w.target.id, other.id, otherBytes, other.revision)).status).toBe(200);
    expect((await w.register(hr.as, w.target.id, png(9, 9), { field: OTHER_FIELD })).status).toBe(201);
    expect((await w.register(hr.as, w.target.id, png(9, 8), { field: FIELD })).status).toBe(403);
  });
});

describe('AC-PER-F361-11 事务内范围（P1-2）', () => {
  const race = async (hr: { revokeScope: () => Promise<void> }, call: () => Promise<Response>) => {
    hook.fire = () => hr.revokeScope();
    hook.armed = true;
    try {
      return await call();
    } finally {
      hook.armed = false;
    }
  };

  it('登记：入口授权后收回目标部门范围 → 404 人员不存在，不新增文件', async () => {
    const hr = await w.actor('hr-race-register');
    const res = await race(hr, () => w.register(hr.as, w.target.id, png(10, 1)));
    expect(res.status, await res.clone().text()).toBe(404);
    expect(await code(res)).toBe('NOT_FOUND');
    expect(await w.filesOf(hr.as.user)).toHaveLength(0);
  });

  it('同键重放：范围在入口后被收回 → 404，不交出旧回执', async () => {
    const hr = await w.actor('hr-race-replay');
    const bytes = png(10, 2);
    const key = newKey();
    await w.json(await w.register(hr.as, w.target.id, bytes, {}, key), 201);
    const res = await race(hr, () => w.register(hr.as, w.target.id, bytes, {}, key));
    expect(res.status, await res.clone().text()).toBe(404);
    expect(await w.filesOf(hr.as.user)).toHaveLength(1);
  });

  it('上传 / 删除：入口后收回范围 → 404，文件状态不变', async () => {
    const uploadHr = await w.actor('hr-race-upload');
    const bytes = png(10, 3);
    const toUpload = await registered(uploadHr.as, bytes, FIELD);
    const uploading = await race(uploadHr, () =>
      w.upload(uploadHr.as, w.target.id, toUpload.id, bytes, toUpload.revision),
    );
    expect(uploading.status, await uploading.clone().text()).toBe(404);
    expect(await w.row(toUpload.id)).toMatchObject({ status: 'registered' });

    const deleteHr = await w.actor('hr-race-delete');
    const toDelete = await w.stored(deleteHr.as, w.target.id, png(10, 4), FIELD);
    const deleting = await race(deleteHr, () => w.remove(deleteHr.as, w.target.id, toDelete.id, toDelete.revision));
    expect(deleting.status, await deleting.clone().text()).toBe(404);
    expect(await w.row(toDelete.id)).toMatchObject({ status: 'uploaded' });
  });
});

describe('AC-PER-F361-12 不支持附件的子集（P2-2）', () => {
  it('training 没有附件字段：上传 / 删除入口返回 400 VALIDATION_FAILED，而不是 503', async () => {
    const hr = await w.actor('hr-training', { extraObjects: [SUBSETS.training.objectCode] });
    const base = `/api/tenant/personnel/employees/${w.target.id}/subsets/training/attachments`;
    const upload = await w.api.request('POST', `${base}/${randomUUID()}/upload`, {
      ...hr.as,
      ifMatch: 1,
      body: { base64: Buffer.from('x').toString('base64') },
    });
    expect(upload.status, await upload.clone().text()).toBe(400);
    expect(await code(upload)).toBe('VALIDATION_FAILED');
    const removed = await w.api.request('DELETE', `${base}/${randomUUID()}`, { ...hr.as, ifMatch: 1 });
    expect(removed.status, await removed.clone().text()).toBe(400);
    expect(await code(removed)).toBe('VALIDATION_FAILED');
    const register = await w.api.request('POST', base, {
      ...hr.as,
      body: {
        field: 'school',
        filename: 'a.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: sha256(Buffer.from('x')),
      },
    });
    expect(register.status).toBe(400);
  });
});
