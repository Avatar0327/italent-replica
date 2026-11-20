/**
 * F-361② 验收 07～08：类型与大小（只收图片、单张 10MiB）、登记命令幂等。
 * 作用对象：复刻系统（合成数据）。真实 HTTP + 真实授权器。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { MIB10, padded, png, sha256, type Receipt } from './AC-ATT-support.js';
import { newKey, personnelWorld, type As, type F361World } from './AC-PER-F361-support.js';

const database = useTestDb();
let w: F361World;
let hr: { as: As };
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

beforeAll(async () => {
  w = await personnelWorld(database().db);
  hr = await w.actor('hr-types');
});

describe('AC-PER-F361-07 类型与大小', () => {
  it('PDF 与 Office 一律 415；扩展名与声明类型不符 415；文件头不是位图 415', async () => {
    const bytes = png();
    for (const [filename, contentType] of [
      ['a.pdf', 'application/pdf'],
      ['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['a.png', 'image/jpeg'],
    ] as const) {
      const res = await w.register(hr.as, w.target.id, bytes, { filename, contentType });
      expect(res.status, filename).toBe(415);
      expect(await code(res)).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
    const fake = Buffer.from('%PDF-1.4 合成内容，冒充图片');
    const registered = await w.json<Receipt>(await w.register(hr.as, w.target.id, fake, {}), 201);
    expect((await w.upload(hr.as, w.target.id, registered.id, fake, registered.revision)).status).toBe(415);
  });

  it('超过 10MiB 413；恰好 10MiB 登记并上传成功', async () => {
    const over = await w.register(hr.as, w.target.id, png(), { byteSize: MIB10 + 1 });
    expect(over.status).toBe(413);
    const exact = padded(MIB10);
    const registered = await w.json<Receipt>(await w.register(hr.as, w.target.id, exact), 201);
    const uploaded = await w.upload(hr.as, w.target.id, registered.id, exact, registered.revision);
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    expect(await w.row(registered.id)).toMatchObject({ status: 'uploaded', byteSize: MIB10 });
  });
});

describe('AC-PER-F361-08 登记命令幂等', () => {
  it('同 Idempotency-Key 同内容重放得同一回执、不重复建行；同键异内容 409', async () => {
    const bytes = png(7, 7);
    const key = newKey();
    const first = await w.json<Receipt>(await w.register(hr.as, w.target.id, bytes, {}, key), 201);
    const replay = await w.json<Receipt>(await w.register(hr.as, w.target.id, bytes, {}, key), 201);
    expect(replay.id).toBe(first.id);
    expect(replay.sha256).toBe(sha256(bytes));
    const different = await w.register(hr.as, w.target.id, png(8, 8), {}, key);
    expect(different.status).toBe(409);
    expect(await code(different)).toBe('IDEMPOTENCY_CONFLICT');
  });
});
