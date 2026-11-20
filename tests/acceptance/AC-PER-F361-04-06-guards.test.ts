/**
 * F-361② 验收 04～06：归属（上传人 + 目标员工）、范围 / 编辑权 / 撤权重放、查看权裁剪与下载。
 * 作用对象：复刻系统（合成数据）。全部走真实授权器。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { png } from './AC-ATT-support.js';
import { FIELD, newKey, personnelWorld, type As, type F361World } from './AC-PER-F361-support.js';

const database = useTestDb();
let w: F361World;
type Subset = { id: string; revision: number } & Record<string, unknown>;
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

beforeAll(async () => {
  w = await personnelWorld(database().db);
});

describe('AC-PER-F361-04 他人上传的 / 他处已绑定的文件不可见、不可绑', () => {
  it('另一位 HR 的未绑定文件：删除 404、写进子集 400；已绑在别的记录上的文件不可再绑到另一条', async () => {
    const a = await w.actor('hr-own');
    const b = await w.actor('hr-other');
    const theirs = await w.stored(b.as, w.target.id);
    expect((await w.remove(a.as, w.target.id, theirs.id, theirs.revision)).status).toBe(404);
    const stolen = await w.createSubset(a.as, w.target.id, { school: '偷绑', [FIELD]: theirs.id });
    expect(stolen.status).toBe(400);
    expect(await code(stolen)).toBe('ATTACHMENT_INVALID');
    expect(await w.row(theirs.id)).toMatchObject({ status: 'uploaded', businessId: null });
    expect((await w.upload(a.as, w.target.id, theirs.id, png(), theirs.revision)).status).toBe(404);

    const mine = await w.stored(a.as, w.target.id);
    const first = await w.json<Subset>(
      await w.createSubset(a.as, w.target.id, { school: '先绑', [FIELD]: mine.id }),
      201,
    );
    const second = await w.createSubset(a.as, w.target.id, { school: '再绑', [FIELD]: mine.id });
    expect(second.status).toBe(400);
    expect(await code(second)).toBe('ATTACHMENT_INVALID');
    expect(await w.row(mine.id)).toMatchObject({ status: 'bound', businessId: first.id });
  });

  it('上传给员工甲的文件不能绑到另一名员工（同一范围内）名下的记录', async () => {
    const hr = await w.actor('hr-two', { orgs: 'both' });
    const forStranger = await w.stored(hr.as, w.stranger.id);
    const wrong = await w.createSubset(hr.as, w.target.id, { school: '串员工', [FIELD]: forStranger.id });
    expect(wrong.status).toBe(400);
    expect(await code(wrong)).toBe('ATTACHMENT_INVALID');
  });
});

describe('AC-PER-F361-05 范围 / 编辑权 / 撤权', () => {
  it('目标员工在范围外 → 404 人员不存在；无附件字段编辑权 → 403；缺人员主对象 update → 403', async () => {
    const hr = await w.actor('hr-scope');
    const outOfScope = await w.register(hr.as, w.stranger.id, png());
    expect(outOfScope.status).toBe(404);
    expect(((await outOfScope.json()) as { error: { code: string; message: string } }).error).toMatchObject({
      code: 'NOT_FOUND',
      message: '人员不存在',
    });

    const readOnly = await w.actor('hr-readonly', { attachmentEdit: false });
    expect((await w.register(readOnly.as, w.target.id, png())).status).toBe(403);
    const noPersonnel = await w.actor('hr-nopersonnel', { personnelUpdate: false });
    expect((await w.register(noPersonnel.as, w.target.id, png())).status).toBe(403);
    const missingField = await w.register(hr.as, w.target.id, png(), { field: 'school' });
    expect(missingField.status).toBe(400);
  });

  it('撤销附件字段编辑权后，同一 Idempotency-Key 重放登记 / 上传都得 403，不当作旧命令凭证', async () => {
    const hr = await w.actor('hr-revoke');
    const bytes = png(6, 2);
    const key = newKey();
    const registered = await w.json<{ id: string; revision: number }>(
      await w.register(hr.as, w.target.id, bytes, {}, key),
      201,
    );
    const uploadKey = newKey();
    await w.json(await w.upload(hr.as, w.target.id, registered.id, bytes, registered.revision, uploadKey), 200);
    await hr.reconfigure({ attachmentEdit: false });
    expect((await w.register(hr.as, w.target.id, bytes, {}, key)).status).toBe(403);
    expect((await w.upload(hr.as, w.target.id, registered.id, bytes, registered.revision, uploadKey)).status).toBe(403);
  });
});

describe('AC-PER-F361-06 查看权与下载', () => {
  it('无附件字段查看权：读取不出现该键、下载 404（不暴露存在性）；范围外员工下载 404', async () => {
    const hr = await w.actor('hr-writer', { orgs: 'both' });
    const file = await w.stored(hr.as, w.target.id);
    const record = await w.json<Subset>(
      await w.createSubset(hr.as, w.target.id, { school: '查看权', [FIELD]: file.id }),
      201,
    );
    const strangerFile = await w.stored(hr.as, w.stranger.id);
    const strangerRecord = await w.json<Subset>(
      await w.createSubset(hr.as, w.stranger.id, { school: '范围外', [FIELD]: strangerFile.id }),
      201,
    );

    const blind: { as: As } = await w.actor('hr-blind', { attachmentView: false, attachmentEdit: false });
    const detail = await w.json<Record<string, unknown>>(await w.detail(blind.as, w.target.id, record.id), 200);
    expect(detail.school).toBe('查看权');
    expect(detail).not.toHaveProperty(FIELD);
    const list = await w.json<{ items: Record<string, unknown>[] }>(
      await w.api.request('GET', w.base(w.target.id), blind.as),
      200,
    );
    for (const item of list.items) expect(item).not.toHaveProperty(FIELD);
    const denied = await w.download(blind.as, w.target.id, record.id, file.id);
    expect(denied.status).toBe(404);
    expect(await code(denied)).toBe('NOT_FOUND');

    const viewer: { as: As; reconfigure: (o: object) => Promise<void> } = await w.actor('hr-viewer');
    expect((await w.download(viewer.as, w.target.id, record.id, file.id)).status).toBe(200);
    expect((await w.download(viewer.as, w.stranger.id, strangerRecord.id, strangerFile.id)).status).toBe(404);
    // 撤销查看权后原地址再读即 404
    await viewer.reconfigure({ attachmentView: false, attachmentEdit: false });
    expect((await w.download(viewer.as, w.target.id, record.id, file.id)).status).toBe(404);
    // 文件 ID 不属于该记录 → 404
    const other = await w.actor('hr-other-file');
    expect((await w.download(other.as, w.target.id, record.id, strangerFile.id)).status).toBe(404);
  });
});
