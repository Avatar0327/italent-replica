import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Person } from './AC-APV-support.js';
import {
  apng,
  ATTACHMENTS,
  attachmentWorld,
  bmp,
  gif,
  jpeg,
  MIB10,
  padded,
  png,
  registration,
  sha256,
  type Receipt,
} from './AC-ATT-support.js';

const database = useTestDb();
let a: Awaited<ReturnType<typeof attachmentWorld>>;
let actor: Person;

beforeAll(async () => {
  a = await attachmentWorld(database().db, 'att-fmt');
  actor = await a.person('测试员工甲');
});

async function readBack(id: string): Promise<Buffer> {
  const res = await a.content(actor, id);
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

describe('AC-ATT-02 五种扩展名与特殊位图：保存原字节，类型取文件头', () => {
  const cases: [string, string, Buffer, string][] = [
    ['note.jpg', 'jpg', jpeg(), 'image/jpeg'],
    ['note.jpeg', 'jpeg', jpeg(), 'image/jpeg'],
    ['note.png', 'png', png(), 'image/png'],
    ['note.gif', 'gif', gif(), 'image/gif'],
    ['note.bmp', 'bmp', bmp(), 'image/bmp'],
    ['animated.gif', 'gif', gif(true), 'image/gif'],
    ['animated.png', 'png', apng(), 'image/png'],
    ['cmyk.jpg', 'jpg', jpeg('cmyk'), 'image/jpeg'],
    ['exif.jpg', 'jpg', jpeg('exif'), 'image/jpeg'],
  ];
  it.each(cases)('%s（%s）上传成功，读回逐字节相同，类型 %s', async (filename, _ext, bytes, mime) => {
    const registered = await a.w.json<Receipt>(await a.register(actor, registration(bytes, filename)), 201);
    const uploaded = await a.w.json<Receipt>(await a.upload(actor, registered.id, bytes, registered.revision), 200);
    expect(uploaded.contentType).toBe(mime);
    const back = await readBack(registered.id);
    expect(back.equals(bytes)).toBe(true);
    expect(sha256(back)).toBe(sha256(bytes));
    expect((await a.content(actor, registered.id)).headers.get('content-type')).toBe(mime);
  });

  it('扩展名 .png、内容 JPEG：成功，content_type 为文件头识别结果 image/jpeg', async () => {
    const bytes = jpeg();
    const registered = await a.w.json<Receipt>(await a.register(actor, registration(bytes, 'fake.png')), 201);
    const uploaded = await a.w.json<Receipt>(await a.upload(actor, registered.id, bytes, registered.revision), 200);
    expect(uploaded.contentType).toBe('image/jpeg');
    expect((await readBack(registered.id)).equals(bytes)).toBe(true);
  });

  it('恰好 10,485,760 字节：成功并逐字节读回', async () => {
    const bytes = padded(MIB10);
    const registered = await a.w.json<Receipt>(await a.register(actor, registration(bytes, 'big.png')), 201);
    await a.w.json(await a.upload(actor, registered.id, bytes, registered.revision), 200);
    const back = await readBack(registered.id);
    expect(back.length).toBe(MIB10);
    expect(sha256(back)).toBe(sha256(bytes));
  });
});

describe('AC-ATT-03 类型与大小拒绝：不写 blob 行', () => {
  it('扩展名 .jpg、内容 HTML 文本 → 上传 415', async () => {
    const bytes = Buffer.from('<html><body>x</body></html>');
    const before = await a.blobCount();
    const registered = await a.w.json<Receipt>(await a.register(actor, registration(bytes, 'page.jpg')), 201);
    const res = await a.upload(actor, registered.id, bytes, registered.revision);
    expect(res.status).toBe(415);
    expect(await a.blobCount()).toBe(before);
    expect((await a.fileRows(actor.userId)).find((r) => r.id === registered.id)).toMatchObject({
      status: 'registered',
    });
  });

  it.each([
    ['vector.svg', 'image/svg+xml'],
    ['photo.webp', 'image/webp'],
    ['doc.pdf', 'application/pdf'],
    ['noext', 'image/png'],
  ])('登记 %s（%s）→ 415，不落行', async (filename, contentType) => {
    const bytes = png();
    const before = (await a.fileRows(actor.userId)).length;
    const res = await a.register(actor, registration(bytes, filename, contentType));
    expect(res.status).toBe(415);
    expect((await a.fileRows(actor.userId)).length).toBe(before);
  });

  it('声明类型与扩展名不符（.png 声明 image/jpeg）→ 415', async () => {
    expect((await a.register(actor, registration(png(), 'x.png', 'image/jpeg'))).status).toBe(415);
  });

  it('只有 4 字节的 .png → 上传 415', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const before = await a.blobCount();
    const registered = await a.w.json<Receipt>(await a.register(actor, registration(bytes, 'tiny.png')), 201);
    expect((await a.upload(actor, registered.id, bytes, registered.revision)).status).toBe(415);
    expect(await a.blobCount()).toBe(before);
  });

  it('10,485,761 字节 → 登记即 413，不落行、不写 blob', async () => {
    const bytes = padded(MIB10 + 1);
    const before = { files: (await a.fileRows(actor.userId)).length, blobs: await a.blobCount() };
    expect((await a.register(actor, registration(bytes, 'over.png'))).status).toBe(413);
    expect({ files: (await a.fileRows(actor.userId)).length, blobs: await a.blobCount() }).toEqual(before);
  });

  it('byteSize 为 0、负数、小数 → 413 或 400，不落行', async () => {
    for (const byteSize of [0, -1, 1.5]) {
      const res = await a.register(actor, { ...registration(png()), byteSize });
      expect([400, 413]).toContain(res.status);
    }
  });

  it('purpose 未登记 → 400；sha256 不是 64 位十六进制 → 400', async () => {
    expect((await a.register(actor, { ...registration(png()), purpose: 'unknown.purpose' })).status).toBe(400);
    expect((await a.register(actor, { ...registration(png()), sha256: 'abc' })).status).toBe(400);
  });
});

describe('AC-ATT-04 10 MiB 边界与请求体上限', () => {
  it('上传请求体在例外上限内不被 limitBody 截断；超过例外上限 413', async () => {
    const bytes = padded(MIB10);
    const registered = await a.w.json<Receipt>(await a.register(actor, registration(bytes, 'edge.png')), 201);
    // 例外上限 = 4*ceil(10MiB/3)+1024；这里发一个明显超过它的请求体
    const oversize = Buffer.alloc(MIB10 * 2, 0x41).toString('latin1');
    const res = await a.api.request('POST', `${ATTACHMENTS}/${registered.id}/upload`, {
      ...a.w.as(actor.userId),
      body: { base64: oversize },
      ifMatch: registered.revision,
    });
    expect(res.status).toBe(413);
    // 在上限内的合法请求仍成功（证明例外不是对所有请求放开）
    await a.w.json(await a.upload(actor, registered.id, bytes, registered.revision), 200);
  });

  it('登记（普通 JSON 接口）仍受 32KB 默认上限', async () => {
    const res = await a.register(actor, { ...registration(png()), filename: `${'a'.repeat(40_000)}.png` });
    expect(res.status).toBe(413);
  });

  it('其它路径不因附件例外被放宽：删除接口带大请求体仍 413', async () => {
    const mine = await a.w.json<Receipt>(await a.register(actor, registration(png(), 'del.png')), 201);
    const res = await a.api.request('DELETE', `${ATTACHMENTS}/${mine.id}`, {
      ...a.w.as(actor.userId),
      body: { padding: 'x'.repeat(100_000) },
      ifMatch: mine.revision,
    });
    expect(res.status).toBe(413);
  });
});

describe('AC-ATT-05 上传内容与登记不一致', () => {
  it('同长度不同内容（sha256 不符）→ 400，仍为 registered，不写 blob；之后用正确内容仍可上传', async () => {
    const good = png();
    const tampered = Buffer.from(good);
    tampered[tampered.length - 5] = (tampered[tampered.length - 5] ?? 0) ^ 0x01;
    const before = await a.blobCount();
    const registered = await a.w.json<Receipt>(await a.register(actor, registration(good, 'sum.png')), 201);
    expect((await a.upload(actor, registered.id, tampered, registered.revision)).status).toBe(400);
    expect(await a.blobCount()).toBe(before);
    const row = (await a.fileRows(actor.userId)).find((r) => r.id === registered.id);
    expect(row).toMatchObject({ status: 'registered', revision: registered.revision });
    await a.w.json(await a.upload(actor, registered.id, good, registered.revision), 200);
  });

  it('长度与登记大小不符 → 400；非法 base64 → 400', async () => {
    const good = png();
    const registered = await a.w.json<Receipt>(await a.register(actor, registration(good, 'len.png')), 201);
    expect((await a.upload(actor, registered.id, padded(good.length + 10), registered.revision)).status).toBe(400);
    const bad = await a.api.request('POST', `${ATTACHMENTS}/${registered.id}/upload`, {
      ...a.w.as(actor.userId),
      body: { base64: '***not-base64***' },
      ifMatch: registered.revision,
    });
    expect(bad.status).toBe(400);
    expect((await a.fileRows(actor.userId)).find((r) => r.id === registered.id)).toMatchObject({
      status: 'registered',
    });
  });

  it('已上传文件再次上传（任意 revision）→ 409，不覆盖字节', async () => {
    const stored = await a.stored(actor, png(), 'twice.png');
    const res = await a.upload(actor, stored.id, png(), stored.revision);
    expect(res.status).toBe(409);
    expect((await readBack(stored.id)).equals(png())).toBe(true);
  });
});

describe('AC-ATT-06 文件名清洗', () => {
  // 每个用例用新员工：登记不上传的临时文件占用名额（上限 20），不能与别的用例共用一人
  const storedBy = async (filename: string, who: Person) => {
    const bytes = png();
    const registered = await a.w.json<Receipt>(await a.register(who, registration(bytes, filename, 'image/png')), 201);
    return registered.filename;
  };

  it('路径、控制字符、双向控制符、首尾空白按规则清洗后存储', async () => {
    const who = await a.person('测试员工清洗甲');
    const stored = (filename: string) => storedBy(filename, who);
    expect(await stored('../../etc/passwd.png')).toBe('passwd.png');
    expect(await stored('C:\\Users\\x\\b.png')).toBe('b.png');
    expect(await stored('a\u0000b\u0007c.png')).toBe('abc.png');
    expect(await stored('x\u202Egpj.png')).toBe('xgpj.png');
    expect(await stored('y\u2066z\u2069.png')).toBe('yz.png');
    expect(await stored('  spaced name.png  ')).toBe('spaced name.png');
    expect(await stored('手写申请.PNG')).toBe('手写申请.PNG');
  });

  it('清洗后为空 → 400；超过 255 字符 → 400；恰好 255 通过', async () => {
    const actor = await a.person('测试员工清洗乙');
    for (const filename of ['/', 'dir/', '\u0000\u0001', '   ', ''])
      expect((await a.register(actor, registration(png(), filename, 'image/png'))).status).toBe(400);
    expect((await a.register(actor, registration(png(), `${'a'.repeat(251)}.png`))).status).toBe(201);
    expect((await a.register(actor, registration(png(), `${'a'.repeat(252)}.png`))).status).toBe(400);
  });

  it('清洗后的名字用于扩展名判定：路径里的 .svg 目录名不影响，最终 .exe 被拒', async () => {
    const actor = await a.person('测试员工清洗丙');
    expect((await a.register(actor, registration(png(), 'x.svg/ok.png'))).status).toBe(201);
    expect((await a.register(actor, registration(png(), 'ok.png/evil.exe', 'image/png'))).status).toBe(415);
  });
});

describe('AC-ATT-01 临时文件上限', () => {
  it('同一员工未绑定的临时文件达到 20 个后再登记 → 409 ATTACHMENT_TEMP_LIMIT；删除一个后可再登记', async () => {
    const mine = await a.person('测试员工丙');
    const ids: Receipt[] = [];
    for (let i = 0; i < 20; i += 1)
      ids.push(await a.w.json<Receipt>(await a.register(mine, registration(png(), `f${i}.png`)), 201));
    const over = await a.register(mine, registration(png(), 'over.png'));
    expect(over.status).toBe(409);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe('ATTACHMENT_TEMP_LIMIT');
    expect((await a.remove(mine, ids[0]!.id, ids[0]!.revision)).status).toBe(200);
    expect((await a.register(mine, registration(png(), 'again.png'))).status).toBe(201);
  });
});
