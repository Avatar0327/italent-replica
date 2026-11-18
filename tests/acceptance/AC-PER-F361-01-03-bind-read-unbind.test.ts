/**
 * F-361② 验收 01～03：HR 登记 → 上传 → 保存子集绑定 → 读取展开 → 下载；替换 / 删除解绑；仅登记的文件不可绑。
 * 作用对象：复刻系统（合成数据）。真实 HTTP + 真实授权器，PGlite 与 PG16 app_owner 两套都过。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { runAttachmentCleanup } from '../../apps/api/src/modules/attachments/cleanup.js';
import { png, sha256, type Receipt } from './AC-ATT-support.js';
import { FIELD, OTHER_FIELD, personnelWorld, PURPOSE, type As, type F361World } from './AC-PER-F361-support.js';

const database = useTestDb();
let w: F361World;
let hr: { as: As };
type Expanded = { id: string; filename: string; contentType: string; byteSize: number } | null;
type Subset = { id: string; revision: number } & Record<string, unknown>;

beforeAll(async () => {
  w = await personnelWorld(database().db);
  hr = await w.actor('hr-a');
});

describe('AC-PER-F361-01 HR 上传 → 绑定 → 读取展开 → 下载', () => {
  it('登记回执用新用途；保存子集后文件 bound，详情 / 列表 / 嵌套读取展开为 {id, filename, contentType, byteSize}，下载字节一致', async () => {
    const bytes = png(3, 3);
    const registered = await w.json<Receipt>(await w.register(hr.as, w.target.id, bytes), 201);
    expect(registered).toMatchObject({ kind: 'attachment_file', status: 'registered', purpose: PURPOSE, revision: 1 });
    const uploaded = await w.json<Receipt>(await w.upload(hr.as, w.target.id, registered.id, bytes, 1), 200);
    expect(uploaded).toMatchObject({ status: 'uploaded', contentType: 'image/png', revision: 2 });

    const created = await w.json<Subset>(
      await w.createSubset(hr.as, w.target.id, { school: '合成大学', [FIELD]: uploaded.id }),
      201,
    );
    expect(await w.row(uploaded.id)).toMatchObject({
      status: 'bound',
      businessType: 'personnel.subset',
      businessId: created.id,
      expiresAt: null,
    });
    // 写回执：附件字段展开，不再是裸 UUID
    expect(created[FIELD]).toEqual({
      id: uploaded.id,
      filename: 'cert.png',
      contentType: 'image/png',
      byteSize: bytes.length,
    });

    const detail = await w.json<Subset>(await w.detail(hr.as, w.target.id, created.id), 200);
    expect(detail[FIELD]).toEqual({
      id: uploaded.id,
      filename: 'cert.png',
      contentType: 'image/png',
      byteSize: bytes.length,
    });
    expect(detail[OTHER_FIELD]).toBeNull();

    const list = await w.json<{ items: Subset[] }>(await w.api.request('GET', `${w.base(w.target.id)}`, hr.as), 200);
    expect(list.items.find((i) => i.id === created.id)?.[FIELD]).toMatchObject({
      id: uploaded.id,
      byteSize: bytes.length,
    });
    const global = await w.json<{ items: Subset[] }>(
      await w.api.request('GET', '/api/tenant/personnel/subsets/education', hr.as),
      200,
    );
    expect(global.items.find((i) => i.id === created.id)?.[FIELD]).toMatchObject({ id: uploaded.id });
    const nested = await w.json<{ subsets?: Record<string, Subset[]> }>(
      await w.api.request('GET', `/api/tenant/personnel/employees/${w.target.id}?includeSubsets=true`, hr.as),
      200,
    );
    expect(nested.subsets?.education?.find((i) => i.id === created.id)?.[FIELD]).toMatchObject({ id: uploaded.id });

    const content = await w.download(hr.as, w.target.id, created.id, uploaded.id);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(content.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(content.headers.get('cache-control')).toBe('private, no-store');
    const received = Buffer.from(await content.arrayBuffer());
    expect(sha256(received)).toBe(sha256(bytes));
  });
});

describe('AC-PER-F361-02 替换 / 删除附件字段与删除记录：解绑进清理', () => {
  it('替换：旧文件 pending_cleanup、新文件 bound；清空字段与删除记录同样解绑；清理任务按期释放字节', async () => {
    const first = await w.stored(hr.as, w.target.id, png(2, 3));
    const record = await w.json<Subset>(
      await w.createSubset(hr.as, w.target.id, { school: '替换用', [FIELD]: first.id }),
      201,
    );
    const second = await w.stored(hr.as, w.target.id, png(4, 2));
    const replaced = await w.json<Subset>(
      await w.patchSubset(hr.as, w.target.id, record.id, record.revision, { [FIELD]: second.id }),
      200,
    );
    expect(await w.row(first.id)).toMatchObject({ status: 'pending_cleanup' });
    expect(await w.row(second.id)).toMatchObject({ status: 'bound', businessId: record.id });
    // 旧文件不再能经该记录下载
    expect((await w.download(hr.as, w.target.id, record.id, first.id)).status).toBe(404);
    expect((await w.download(hr.as, w.target.id, record.id, second.id)).status).toBe(200);

    const cleared = await w.json<Subset>(
      await w.patchSubset(hr.as, w.target.id, record.id, replaced.revision, { [FIELD]: null }),
      200,
    );
    expect(cleared[FIELD]).toBeNull();
    expect(await w.row(second.id)).toMatchObject({ status: 'pending_cleanup' });

    const third = await w.stored(hr.as, w.target.id, png(5, 5));
    const again = await w.json<Subset>(
      await w.patchSubset(hr.as, w.target.id, record.id, cleared.revision, { [FIELD]: third.id }),
      200,
    );
    expect(await w.row(third.id)).toMatchObject({ status: 'bound' });
    await w.json(await w.deleteSubset(hr.as, w.target.id, record.id, again.revision), 200);
    expect(await w.row(third.id)).toMatchObject({ status: 'pending_cleanup' });

    // 清理任务：宽限期过后三个文件字节都释放（purged）
    const later = new Date(Date.now() + 3 * 3_600_000);
    await runAttachmentCleanup({ db: w.db, clock: () => later, tenantId: w.tenant.id });
    for (const id of [first.id, second.id, third.id]) expect((await w.row(id))?.status).toBe('purged');
  });

  it('保存时不带附件字段、或附件字段值未变：已绑定文件不动', async () => {
    const file = await w.stored(hr.as, w.target.id);
    const record = await w.json<Subset>(
      await w.createSubset(hr.as, w.target.id, { school: '不动', [FIELD]: file.id }),
      201,
    );
    const edited = await w.json<Subset>(
      await w.patchSubset(hr.as, w.target.id, record.id, record.revision, { major: '合成专业' }),
      200,
    );
    expect(edited[FIELD]).toMatchObject({ id: file.id });
    expect(await w.row(file.id)).toMatchObject({ status: 'bound', businessId: record.id, revision: 3 });
  });
});

describe('AC-PER-F361-03 仅登记未上传 / 非本功能登记的文件不可绑定', () => {
  it('随手编的 UUID 写进子集 → 400 ATTACHMENT_INVALID（只回显字段名），记录不落库', async () => {
    const res = await w.createSubset(hr.as, w.target.id, { school: '乱编', [FIELD]: randomUUID() });
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('ATTACHMENT_INVALID');
    expect(body.error.message).toContain(FIELD);
    const listed = await w.json<{ items: Subset[] }>(await w.api.request('GET', w.base(w.target.id), hr.as), 200);
    expect(listed.items.filter((i) => i.school === '乱编')).toEqual([]);
  });

  it('registered 文件 ID 写进子集 → 400 ATTACHMENT_INVALID，记录与文件状态不变', async () => {
    const registered = await w.json<Receipt>(await w.register(hr.as, w.target.id, png(2, 5)), 201);
    const res = await w.createSubset(hr.as, w.target.id, { school: '只登记', [FIELD]: registered.id });
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('ATTACHMENT_INVALID');
    expect(JSON.stringify(body)).not.toContain(registered.id);
    expect(await w.row(registered.id)).toMatchObject({ status: 'registered', businessId: null });
    const listed = await w.json<{ items: Subset[] }>(await w.api.request('GET', w.base(w.target.id), hr.as), 200);
    expect(listed.items.filter((i) => i.school === '只登记')).toEqual([]);
  });
});
