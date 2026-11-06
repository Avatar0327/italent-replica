/**
 * F-479 S1 附件验收的公共夹具：合成位图（测试运行时生成，不放真实图片）、登记 / 上传 / 读取请求包装、
 * 员工身份权限修改（一律走权限配置入口 PUT /api/tenant/permission/profiles/:id/objects/:code，不直写权限表）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { deflateSync } from 'node:zlib';
import { sql, withTenant, type Db } from '@italent/db';
import { STANDARD_PROFILES } from '@italent/domain';
import { approvalWorld, permissionAdmin, type Person } from './AC-APV-support.js';
import { createProfile, setObjectPermission, type ProfileBody } from './AC-PRM-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { tenantApi } from './support/tenant-api.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';

export const ATTACHMENTS = '/api/tenant/attachments';
export const PURPOSE = 'exit.handwritten_application';
export const MIB10 = 10 * 1024 * 1024;
export const SELF_EXIT = 'TenantBase.SelfExit';
export const EMPLOYMENT = 'TenantBase.EmploymentRecord';

export type Kind = 'jpeg' | 'png' | 'gif' | 'bmp';
export const MIME: Record<Kind, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

/** 运行时生成的 w×h 灰度 PNG（合法位图）。 */
export function png(width = 2, height = 2): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 0; // 灰度
  const rows = Buffer.concat(
    Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 0x7f)])),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 2×2 24 位 BMP。 */
export function bmp(): Buffer {
  const pixels = Buffer.alloc(16, 0x80); // 每行 6 字节补到 8
  const head = Buffer.alloc(54);
  head.write('BM', 0, 'ascii');
  head.writeUInt32LE(54 + pixels.length, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(2, 18);
  head.writeInt32LE(2, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(24, 28);
  head.writeUInt32LE(pixels.length, 34);
  return Buffer.concat([head, pixels]);
}

/** 1×1 GIF89a；`animated` 追加第二帧（动画 GIF）。 */
export function gif(animated = false): Buffer {
  const frame = Buffer.from('2c00000000010001000002024401', 'hex'); // 图像描述 + 数据
  const header = Buffer.from('47494638396101000100800000ffffff000000', 'hex');
  const control = Buffer.from('21f9040100000000', 'hex');
  return Buffer.concat([
    header,
    ...(animated ? [control, frame, control, frame] : [control, frame]),
    Buffer.from([0x3b]),
  ]);
}

/** JPEG：SOI + 可选 APP1（EXIF 方向）或 Adobe APP14（CMYK）+ EOI。只测文件头判定与原字节保存，不要求可解码。 */
export function jpeg(variant: 'plain' | 'exif' | 'cmyk' = 'plain'): Buffer {
  const app = (marker: number, payload: Buffer) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(payload.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
  };
  const segments =
    variant === 'exif'
      ? [
          app(
            0xe1,
            Buffer.concat([
              Buffer.from('Exif\0\0', 'ascii'),
              Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0]),
            ]),
          ),
        ]
      : variant === 'cmyk'
        ? [app(0xee, Buffer.from('Adobe\0\x64\0\0\0\0\0', 'binary'))]
        : [];
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]), ...segments, Buffer.from([0xff, 0xd9])]);
}

/** 动画 PNG（APNG）：在 IDAT 前插入 acTL。 */
export function apng(): Buffer {
  const base = png();
  const ctl = Buffer.alloc(8);
  ctl.writeUInt32BE(2, 0);
  const at = base.indexOf('IDAT') - 4;
  return Buffer.concat([base.subarray(0, at), chunk('acTL', ctl), base.subarray(at)]);
}

export function sample(kind: Kind): Buffer {
  return { png: png(), jpeg: jpeg(), gif: gif(), bmp: bmp() }[kind];
}

/** 用文件头 + 填充凑到指定字节数（边界测试），PNG 文件头保持有效。 */
export function padded(size: number, kind: Kind = 'png'): Buffer {
  const head = sample(kind);
  if (size < head.length) throw new RangeError('目标大小小于文件头');
  return Buffer.concat([head, Buffer.alloc(size - head.length, 0x20)]);
}

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export interface Receipt {
  id: string;
  revision: number;
  kind: string;
  status: string;
  purpose: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  expiresAt?: string | null;
  uploadedAt?: string | null;
  base64?: unknown;
}

export function registration(bytes: Buffer, filename = 'note.png', contentType?: string) {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  const guessed = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp' }[
    extension
  ];
  return {
    purpose: PURPOSE,
    filename,
    contentType: contentType ?? guessed ?? 'application/octet-stream',
    byteSize: bytes.length,
    sha256: sha256(bytes),
  };
}

export async function attachmentWorld(db: Db, label: string) {
  const w = await approvalWorld(db, label);
  await installExitSeeds(db, w.tenant.id);
  const api = tenantApi(db, { authorize: undefined, clock: w.clock });
  const department = await w.org(`合成部门${label}`);
  const person = (name = '测试员工甲') => w.person(name, department);

  const as = (actor: Person | { userId: string }) => w.as(actor.userId);
  const register = (actor: Person, body: object, key?: string) =>
    api.request('POST', ATTACHMENTS, { ...as(actor), body, idempotencyKey: key });
  const upload = (actor: Person, id: string, bytes: Buffer, revision: number, key?: string) =>
    api.request('POST', `${ATTACHMENTS}/${id}/upload`, {
      ...as(actor),
      body: { base64: bytes.toString('base64') },
      ifMatch: revision,
      idempotencyKey: key,
    });
  const remove = (actor: Person, id: string, revision: number) =>
    api.request('DELETE', `${ATTACHMENTS}/${id}`, { ...as(actor), ifMatch: revision });
  const meta = (actor: Person, id: string) => api.request('GET', `${ATTACHMENTS}/${id}`, as(actor));
  const content = (actor: Person, id: string) => api.request('GET', `${ATTACHMENTS}/${id}/content`, as(actor));

  /** 登记并上传一张，返回上传后的回执。 */
  async function stored(actor: Person, bytes: Buffer, filename = 'note.png') {
    const registered = await w.json<Receipt>(await register(actor, registration(bytes, filename)), 201);
    return w.json<Receipt>(await upload(actor, registered.id, bytes, registered.revision), 200);
  }

  /** 员工身份副本：先按标准预设建好全部 TenantBase 对象，再按需收回某对象 / 字段（权限配置入口）。 */
  let selfService: ReturnType<typeof buildSelfServiceProfile> | undefined;
  /** 同一租户只建一次员工身份副本（再建会撞身份编码）；各用例改完要恢复。 */
  const selfServiceProfile = () => (selfService ??= buildSelfServiceProfile());
  async function buildSelfServiceProfile() {
    const admin = await permissionAdmin(w);
    const profile = await createProfile(admin, 'employee_self_service');
    const preset = STANDARD_PROFILES.find((p) => p.code === 'employee_self_service')!;
    for (const object of preset.objects.filter((o) => o.objectCode.startsWith('TenantBase.')))
      await w.json(
        await setObjectPermission(
          admin,
          profile,
          { dataOperations: object.dataOperations, fields: [...object.fields], buttons: [...object.buttons] },
          object.objectCode,
        ),
      );
    const put = (code: string, change: (o: (typeof preset.objects)[number]) => object) => {
      const object = preset.objects.find((o) => o.objectCode === code)!;
      return setObjectPermission(admin, profile, change(object) as never, code);
    };
    return {
      profile: profile as ProfileBody,
      preset,
      /** 把 SelfExit.attachmentRefs 改成给定的 view / edit */
      setAttachmentField: (view: boolean, edit: boolean) =>
        put(SELF_EXIT, (o) => ({
          dataOperations: o.dataOperations,
          buttons: [...o.buttons],
          fields: [
            ...o.fields.filter((f) => f.fieldCode !== 'attachmentRefs').map((f) => ({ ...f })),
            { fieldCode: 'attachmentRefs', view, edit }, // 目录里没有该字段时保存被拒（UNKNOWN_FIELD）
          ],
        })),
      setExitButton: (granted: boolean) =>
        put(EMPLOYMENT, (o) => ({
          dataOperations: o.dataOperations,
          fields: [...o.fields],
          buttons: o.buttons.filter((b) => granted || b.buttonCode !== 'Exit.Self'),
        })),
    };
  }

  /** 可信夹具：删除账号 ↔ 员工档案绑定（模拟解绑 / 离开）。 */
  const unbind = (who: Person) =>
    withTenant(db, w.tenant.id, (tx) =>
      tx.execute(
        sql`DELETE FROM permission_user_person_links WHERE tenant_id=${w.tenant.id} AND user_id=${who.userId}::uuid`,
      ),
    );
  // 表还不存在时（红灯阶段）按“没有行”处理，让用例落在 HTTP 行为断言上而不是缺表报错
  const tableExists = async (name: string) =>
    rowsOf<{ ok: boolean }>(await db.execute(sql`SELECT to_regclass(${name}) IS NOT NULL AS ok`))[0]!.ok;
  const fileRows = async (userId?: string) => {
    if (!(await tableExists('attachment_files'))) return [];
    const result = await withTenant(db, w.tenant.id, (tx) =>
      tx.execute(sql`SELECT id,status,owner_user_id,owner_employee_id,filename,content_type,byte_size,revision
        FROM attachment_files WHERE tenant_id=${w.tenant.id} ${userId ? sql`AND owner_user_id=${userId}::uuid` : sql``}
        ORDER BY created_at,id`),
    );
    return rowsOf<Record<string, unknown>>(result);
  };
  const blobCount = async () => {
    if (!(await tableExists('attachment_blobs'))) return 0;
    const result = await withTenant(db, w.tenant.id, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM attachment_blobs WHERE tenant_id=${w.tenant.id}`),
    );
    return Number(rowsOf<{ n: number }>(result)[0]!.n);
  };
  const auditActions = async () => {
    const result = await withTenant(db, w.tenant.id, (tx) =>
      tx.execute(sql`SELECT action,object_type,after FROM audit_events WHERE tenant_id=${w.tenant.id}
        AND action LIKE 'attachment.file.%' ORDER BY occurred_at,id`),
    );
    return rowsOf<{ action: string; object_type: string; after: unknown }>(result);
  };

  return {
    w,
    api,
    person,
    register,
    upload,
    remove,
    meta,
    content,
    stored,
    selfServiceProfile,
    unbind,
    fileRows,
    blobCount,
    auditActions,
    key: () => randomUUID(),
  };
}
