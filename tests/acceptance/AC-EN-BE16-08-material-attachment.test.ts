/**
 * AC-EN-BE16-08（16a-4b0）材料附件契约：独立用途、受信绑定 / 释放、下载再验权、与离职 / 人员子集的隔离。
 * 作用对象：复刻系统（合成数据 ZZ_BE16_*）。材料用途不挂任何 HTTP 路由（设计 §11），所以直接在租户事务里调用服务与受信端口。
 * 本片只覆盖附件隔离；材料元数据登记、接收、补交、催办与作业（AC-EN-BE16-07 与 08 的其余断言）归 16a-4b。
 */
import { attachmentFiles, sql, withTenant } from '@italent/db';
import { describe, expect, it, vi } from 'vitest';
import {
  EXIT_CARRIER,
  EXIT_BUSINESS_TYPE,
  bindAttachmentRefs,
} from '../../apps/api/src/modules/attachments/binding.js';
import { PgBlobStore } from '../../apps/api/src/modules/attachments/blob-store.js';
import { attachmentSummaries, readCarrierAttachment } from '../../apps/api/src/modules/attachments/carrier-read.js';
import {
  MATERIAL_BUSINESS_TYPE as PORT_BUSINESS_TYPE,
  MATERIAL_CARRIER,
  MATERIAL_PURPOSE as PORT_PURPOSE,
  materialTargetTag,
} from '../../apps/api/src/modules/attachments/material-read.js';
import type { FileRow } from '../../apps/api/src/modules/attachments/audit.js';
import * as service from '../../apps/api/src/modules/attachments/service.js';
import { bindSubsetAttachments } from '../../apps/api/src/modules/attachments/subset-binding.js';
import {
  SUBSET_BUSINESS_TYPE,
  SUBSET_PURPOSE,
  subsetTargetTag,
} from '../../apps/api/src/modules/attachments/subset-read.js';
import { attachmentWorld, png, registration, PURPOSE as EXIT_PURPOSE } from './AC-ATT-support.js';
import {
  materialInput,
  materialTag,
  materialWorld,
  MATERIAL_BUSINESS_TYPE,
  MATERIAL_PURPOSE,
  useDb,
  type MaterialWorld,
} from './AC-EN-BE16-08-material-support.js';

const CARRIER = 'onboarding.material';
const failure = async (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    (error: unknown) => error as Error & { code?: string },
  );

/** 受信绑定：材料提交（businessId）绑定一组材料附件；材料项标记与员工归属由调用方给定。 */
function bindMaterial(
  w: MaterialWorld,
  opts: {
    itemId: string;
    submissionId: string;
    previous?: string[];
    next: unknown;
    actor?: string;
    employeeId?: string;
  },
) {
  const actor = opts.actor ?? w.hr.id;
  return w.tenantTx((tx) =>
    bindAttachmentRefs(tx, w.ctxOf(actor), {
      carrier: CARRIER,
      businessType: MATERIAL_BUSINESS_TYPE,
      businessId: opts.submissionId,
      targetTag: materialTag(opts.itemId),
      employeeId: opts.employeeId ?? w.employeeA,
      previous: opts.previous ?? [],
      next: opts.next,
      actor,
    }),
  );
}

describe('AC-EN-BE16-08 材料附件：独立用途（登记 → 上传）', () => {
  it('契约常量与验收夹具口径一致（16a-4b 经这些常量接线）', () => {
    expect([PORT_PURPOSE, MATERIAL_CARRIER, PORT_BUSINESS_TYPE]).toEqual([
      MATERIAL_PURPOSE,
      CARRIER,
      MATERIAL_BUSINESS_TYPE,
    ]);
    expect(materialTargetTag('item-1')).toBe(materialTag('item-1'));
  });

  it('材料用途可登记并上传：未绑定行带材料项标记、有临时有效期；只收图片，pdf 被拒', async () => {
    const w = await materialWorld(useDb().db, 'be16m-purpose');
    const itemId = w.newItemId();
    const uploaded = await w.stored({ itemId });
    expect(uploaded).toMatchObject({ purpose: MATERIAL_PURPOSE, status: 'uploaded', contentType: 'image/png' });
    const row = await w.fileRow(uploaded.id);
    expect(row).toMatchObject({
      purpose: MATERIAL_PURPOSE,
      businessType: materialTag(itemId),
      businessId: null,
      ownerUserId: w.hr.id,
      ownerEmployeeId: w.employeeA,
    });
    expect(row!.expiresAt).not.toBeNull();
    const bytes = png();
    const pdf = await failure(
      w.tenantTx((tx) =>
        service.registerFile(
          tx,
          w.ownerOf(w.hr.id, w.employeeA),
          w.ctxOf(w.hr.id),
          { ...materialInput(bytes, 'ZZ_BE16_CERT.pdf'), contentType: 'application/pdf' },
          MATERIAL_PURPOSE,
          materialTag(itemId),
        ),
      ),
    );
    expect(pdf?.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('AC-EN-BE16-08 材料附件：受信绑定 / 释放', () => {
  it('绑定后文件转 bound，归属（类型 + 提交 ID）写入；摘要与下载按提交 ID 取得；撤出引用后待清理、不可读', async () => {
    const w = await materialWorld(useDb().db, 'be16m-bind');
    const itemId = w.newItemId();
    const submissionId = w.newItemId();
    const file = await w.stored({ itemId });
    const refs = await bindMaterial(w, { itemId, submissionId, next: [file.id] });
    expect(refs).toEqual([file.id]);
    expect(await w.fileRow(file.id)).toMatchObject({
      status: 'bound',
      businessType: MATERIAL_BUSINESS_TYPE,
      businessId: submissionId,
      expiresAt: null,
    });
    const summaries = await w.tenantTx((tx) =>
      attachmentSummaries(tx, w.tenant.id, submissionId, refs, MATERIAL_BUSINESS_TYPE),
    );
    expect(summaries.map((s) => s.id)).toEqual([file.id]);
    const read = await w.tenantTx((tx) =>
      readCarrierAttachment(
        tx,
        w.tenant.id,
        submissionId,
        refs,
        file.id,
        { mode: 'live' },
        MATERIAL_BUSINESS_TYPE,
        async () => true,
      ),
    );
    expect(Buffer.from(read.bytes).equals(png())).toBe(true);
    // 释放：把引用列表改成空，本提交名下的文件转待清理（从未封存）
    await bindMaterial(w, { itemId, submissionId, previous: refs, next: [] });
    expect(await w.fileRow(file.id)).toMatchObject({ status: 'pending_cleanup' });
    const gone = await failure(
      w.tenantTx((tx) =>
        readCarrierAttachment(tx, w.tenant.id, submissionId, refs, file.id, { mode: 'live' }, MATERIAL_BUSINESS_TYPE),
      ),
    );
    expect(gone?.code).toBe('NOT_FOUND');
  });

  it('绑定条件逐项拒绝（400 ATTACHMENT_INVALID，同一错误体）：别人上传、别的员工、别的材料项、已过期、别单已绑定', async () => {
    const w = await materialWorld(useDb().db, 'be16m-refuse');
    const itemId = w.newItemId();
    const submissionId = w.newItemId();
    const mine = await w.stored({ itemId });
    const otherEmployee = await w.stored({ itemId, employeeId: w.employeeB });
    const otherItem = await w.stored({ itemId: w.newItemId() });
    const byOther = await w.stored({ itemId, userId: w.otherHr.id });
    const attempt = (id: string, extra: Partial<Parameters<typeof bindMaterial>[1]> = {}) =>
      failure(bindMaterial(w, { itemId, submissionId, next: [id], ...extra }));
    for (const [name, error] of [
      ['别人上传的', await attempt(byOther.id)],
      ['别的员工名下的', await attempt(otherEmployee.id)],
      ['别的材料项的', await attempt(otherItem.id)],
      ['不存在的', await attempt(w.newItemId())],
    ] as const) {
      expect(error?.code, name).toBe('ATTACHMENT_INVALID');
    }
    // 别的提交已绑定的文件不能再绑到本提交
    await bindMaterial(w, { itemId, submissionId: w.newItemId(), next: [mine.id] });
    expect((await attempt(mine.id))?.code).toBe('ATTACHMENT_INVALID');
    // 临时文件过期后不能绑定
    const stale = await w.stored({ itemId });
    w.advance(25 * 3_600_000);
    expect((await attempt(stale.id))?.code).toBe('ATTACHMENT_INVALID');
  });

  it('一个提交最多 5 个附件（ATTACHMENT_LIMIT）；重复 ID、非 UUID 一律拒绝', async () => {
    const w = await materialWorld(useDb().db, 'be16m-limit');
    const itemId = w.newItemId();
    const files = [];
    for (let i = 0; i < 6; i += 1) files.push((await w.stored({ itemId, filename: `ZZ_BE16_${i}.png` })).id);
    const over = await failure(bindMaterial(w, { itemId, submissionId: w.newItemId(), next: files }));
    expect(over?.code).toBe('ATTACHMENT_LIMIT');
    const dup = await failure(bindMaterial(w, { itemId, submissionId: w.newItemId(), next: [files[0], files[0]] }));
    expect(dup?.code).toBe('ATTACHMENT_INVALID');
    const garbage = await failure(bindMaterial(w, { itemId, submissionId: w.newItemId(), next: ['not-a-uuid'] }));
    expect(garbage?.code).toBe('ATTACHMENT_INVALID');
    const ok = await bindMaterial(w, { itemId, submissionId: w.newItemId(), next: files.slice(0, 5) });
    expect(ok).toHaveLength(5);
  });

  it('释放只动本提交名下的文件：别的提交的绑定文件原样不动', async () => {
    const w = await materialWorld(useDb().db, 'be16m-release');
    const itemId = w.newItemId();
    const [first, second] = [w.newItemId(), w.newItemId()];
    const a = await w.stored({ itemId });
    const b = await w.stored({ itemId });
    await bindMaterial(w, { itemId, submissionId: first, next: [a.id] });
    await bindMaterial(w, { itemId, submissionId: second, next: [b.id] });
    // 第二个提交把别单的文件当成“原有引用”撤出：不属于它，原样不动；它自己的文件不受影响
    const kept = await bindMaterial(w, { itemId, submissionId: second, previous: [a.id, b.id], next: [b.id] });
    expect(kept).toEqual([b.id]);
    expect((await w.fileRow(b.id))!.status).toBe('bound');
    expect((await w.fileRow(a.id))!.status).toBe('bound');
    expect((await w.fileRow(a.id))!.businessId).toBe(first);
  });
});

describe('AC-EN-BE16-08 材料附件：下载再验权（隐藏材料不能下载）', () => {
  it('再验权回调返回否（材料被隐藏 / 范围外 / 无字段权）：同一个 404，字节不读出；回调只在文件归属通过后才调用', async () => {
    const w = await materialWorld(useDb().db, 'be16m-reauth');
    const itemId = w.newItemId();
    const submissionId = w.newItemId();
    const file = await w.stored({ itemId });
    const refs = await bindMaterial(w, { itemId, submissionId, next: [file.id] });
    const reauthorize = vi.fn(async (_row: FileRow) => false);
    const readBytes = vi.spyOn(PgBlobStore, 'read');
    const denied = await failure(
      w.tenantTx((tx) =>
        readCarrierAttachment(
          tx,
          w.tenant.id,
          submissionId,
          refs,
          file.id,
          { mode: 'live' },
          MATERIAL_BUSINESS_TYPE,
          reauthorize,
        ),
      ),
    );
    expect(denied?.code).toBe('NOT_FOUND');
    expect(reauthorize).toHaveBeenCalledTimes(1);
    expect(reauthorize.mock.calls[0]![0]).toMatchObject({ id: file.id, purpose: MATERIAL_PURPOSE });
    expect(readBytes).not.toHaveBeenCalled(); // 先验权后读字节：被拒时字节从未读出
    readBytes.mockRestore();
    // 不在本提交引用列表里的 ID：不触发回调，也不泄露存在性
    reauthorize.mockClear();
    const unlisted = await failure(
      w.tenantTx((tx) =>
        readCarrierAttachment(
          tx,
          w.tenant.id,
          submissionId,
          [],
          file.id,
          { mode: 'live' },
          MATERIAL_BUSINESS_TYPE,
          reauthorize,
        ),
      ),
    );
    expect(unlisted?.code).toBe('NOT_FOUND');
    expect(reauthorize).not.toHaveBeenCalled();
    const allowed = await w.tenantTx((tx) =>
      readCarrierAttachment(
        tx,
        w.tenant.id,
        submissionId,
        refs,
        file.id,
        { mode: 'live' },
        MATERIAL_BUSINESS_TYPE,
        async () => true,
      ),
    );
    expect(allowed.row.id).toBe(file.id);
  });

  it('孤儿不可读：未绑定（仅上传）、别的提交、按离职载体类型读，一律 404', async () => {
    const w = await materialWorld(useDb().db, 'be16m-orphan');
    const itemId = w.newItemId();
    const submissionId = w.newItemId();
    const orphan = await w.stored({ itemId });
    const bound = await w.stored({ itemId });
    await bindMaterial(w, { itemId, submissionId, next: [bound.id] });
    const read = (id: string, businessId: string, type?: string) =>
      failure(w.tenantTx((tx) => readCarrierAttachment(tx, w.tenant.id, businessId, [id], id, { mode: 'live' }, type)));
    expect((await read(orphan.id, submissionId, MATERIAL_BUSINESS_TYPE))?.code).toBe('NOT_FOUND');
    expect((await read(bound.id, w.newItemId(), MATERIAL_BUSINESS_TYPE))?.code).toBe('NOT_FOUND');
    expect((await read(bound.id, submissionId))?.code).toBe('NOT_FOUND'); // 默认按离职载体类型：读不到材料
  });

  it('跨租户：别的租户读不到、绑不了本租户的材料附件', async () => {
    const w = await materialWorld(useDb().db, 'be16m-tenant-a');
    const other = await materialWorld(useDb().db, 'be16m-tenant-b');
    const itemId = w.newItemId();
    const submissionId = w.newItemId();
    const file = await w.stored({ itemId });
    const refs = await bindMaterial(w, { itemId, submissionId, next: [file.id] });
    const crossRead = await failure(
      other.tenantTx((tx) =>
        readCarrierAttachment(
          tx,
          other.tenant.id,
          submissionId,
          refs,
          file.id,
          { mode: 'live' },
          MATERIAL_BUSINESS_TYPE,
        ),
      ),
    );
    expect(crossRead?.code).toBe('NOT_FOUND');
    const crossBind = await failure(bindMaterial(other, { itemId, submissionId: other.newItemId(), next: [file.id] }));
    expect(crossBind?.code).toBe('ATTACHMENT_INVALID');
    const visible = await other.tenantTx((tx) =>
      tx
        .select()
        .from(attachmentFiles)
        .where(sql`${attachmentFiles.id} = ${file.id}`),
    );
    expect(visible).toEqual([]);
  });
});

describe('AC-EN-BE16-08 材料附件：与离职申请 / 人员子集隔离，且不挂任何路由', () => {
  it('材料文件不能经离职、子集的绑定端口绑定；离职、子集的文件也不能绑成材料附件', async () => {
    const w = await materialWorld(useDb().db, 'be16m-cross');
    const itemId = w.newItemId();
    const file = await w.stored({ itemId });
    const exit = await failure(
      w.tenantTx((tx) =>
        bindAttachmentRefs(tx, w.ctxOf(w.hr.id), {
          carrier: 'employment.exit',
          businessId: w.newItemId(),
          previous: [],
          next: [file.id],
          actor: w.hr.id,
        }),
      ),
    );
    expect(exit?.code).toBe('ATTACHMENT_INVALID');
    const subset = await failure(
      w.tenantTx((tx) =>
        bindSubsetAttachments(tx, w.ctxOf(w.hr.id), {
          kind: 'education',
          source: { type: 'hr_direct' },
          employeeId: w.employeeA,
          recordId: w.newItemId(),
          previous: null,
          next: { attachmentId: file.id },
        }),
      ),
    );
    expect(subset?.code).toBe('ATTACHMENT_INVALID');
    expect((await w.fileRow(file.id))!.status).toBe('uploaded');
    // 反向：离职用途文件（本人登记上传）不能绑成材料附件
    const exitBytes = png();
    const exitFile = await w.tenantTx(async (tx) => {
      const self = w.ownerOf(w.hr.id, w.employeeA);
      const registered = await service.registerFile(tx, self, w.ctxOf(w.hr.id), {
        ...materialInput(exitBytes),
        purpose: EXIT_PURPOSE,
      });
      return service.uploadFile(
        tx,
        self,
        w.ctxOf(w.hr.id),
        registered.id,
        registered.revision,
        exitBytes.toString('base64'),
      );
    });
    expect((await failure(bindMaterial(w, { itemId, submissionId: w.newItemId(), next: [exitFile.id] })))?.code).toBe(
      'ATTACHMENT_INVALID',
    );
  });

  it('HTTP 入口不暴露材料用途：通用登记 400；材料文件的所有人按 ID 读 / 下载 / 删除都是 404（用途过滤）', async () => {
    const db = useDb().db;
    const a = await attachmentWorld(db, 'be16m-http');
    const me = await a.person('ZZ_BE16_本人');
    const refused = await a.register(me, { ...registration(png()), purpose: MATERIAL_PURPOSE });
    expect(refused.status).toBe(400);
    const bytes = png();
    const self = { ctx: { tenantId: a.w.tenant.id, userId: me.userId }, employee: { id: me.employeeId } };
    const ctx = {
      tenantId: a.w.tenant.id,
      userId: me.userId,
      timezone: 'Asia/Shanghai',
      now: new Date(),
      commandId: crypto.randomUUID(),
    };
    const file = await withTenant(db, a.w.tenant.id, async (tx) => {
      const registered = await service.registerFile(
        tx,
        self,
        ctx,
        materialInput(bytes),
        MATERIAL_PURPOSE,
        materialTag(crypto.randomUUID()),
      );
      return service.uploadFile(
        tx,
        self,
        ctx,
        registered.id,
        registered.revision,
        bytes.toString('base64'),
        MATERIAL_PURPOSE,
      );
    });
    expect((await a.meta(me, file.id)).status).toBe(404);
    expect((await a.content(me, file.id)).status).toBe(404);
    expect((await a.remove(me, file.id, file.revision)).status).toBe(404);
  });
});

/** 返工 P2-1：材料绑定的归属类型由载体固定，目标员工与材料项标记是必填；保留 / 释放同样核对用途与本提交归属。 */
describe('AC-EN-BE16-08 材料附件：受信绑定缺参即拒（返工 P2-1）', () => {
  const rawBind = (w: MaterialWorld, input: Record<string, unknown>) =>
    w.tenantTx((tx) =>
      bindAttachmentRefs(tx, w.ctxOf(w.hr.id), {
        carrier: CARRIER,
        businessType: MATERIAL_BUSINESS_TYPE,
        previous: [],
        actor: w.hr.id,
        ...input,
      } as unknown as Parameters<typeof bindAttachmentRefs>[2]),
    );

  it('省略 employeeId：拒绝，文件仍是 uploaded（不会替别的员工绑定）', async () => {
    const w = await materialWorld(useDb().db, 'be16m-miss-employee');
    const itemId = w.newItemId();
    const forB = await w.stored({ itemId, employeeId: w.employeeB });
    const error = await failure(
      rawBind(w, { businessId: w.newItemId(), targetTag: materialTag(itemId), next: [forB.id] }),
    );
    expect(error?.code).toBe('VALIDATION_FAILED');
    expect(await w.fileRow(forB.id)).toMatchObject({ status: 'uploaded', businessId: null });
  });

  it('省略 targetTag：拒绝，无登记标记的文件不能被绑定，带标记的也不行（标记是必填）', async () => {
    const w = await materialWorld(useDb().db, 'be16m-miss-tag');
    const itemId = w.newItemId();
    const tagged = await w.stored({ itemId });
    const untagged = await w.stored({ itemId });
    // 无登记标记的材料用途文件（直接改行造出）
    await w.tenantTx((tx) =>
      tx.execute(sql`UPDATE attachment_files SET business_type = NULL WHERE id = ${untagged.id}`),
    );
    const bind = (id: string) =>
      failure(rawBind(w, { businessId: w.newItemId(), employeeId: w.employeeA, next: [id] }));
    expect((await bind(untagged.id))?.code).toBe('VALIDATION_FAILED');
    expect((await bind(tagged.id))?.code).toBe('VALIDATION_FAILED');
    expect(await w.fileRow(untagged.id)).toMatchObject({ status: 'uploaded', businessType: null });
    expect(await w.fileRow(tagged.id)).toMatchObject({ status: 'uploaded', businessId: null });
  });

  it('省略 businessType：材料载体必须显式提供且与载体一致，拒绝后文件仍是 uploaded、没有绑定行', async () => {
    const w = await materialWorld(useDb().db, 'be16m-omit-type');
    const itemId = w.newItemId();
    const submissionId = w.newItemId();
    const file = await w.stored({ itemId });
    const base = { businessId: submissionId, targetTag: materialTag(itemId), employeeId: w.employeeA, next: [file.id] };
    expect((await failure(rawBind(w, { ...base, businessType: undefined })))?.code).toBe('VALIDATION_FAILED');
    // 与载体不一致同样拒绝（不是静默改写成载体的类型）
    expect((await failure(rawBind(w, { ...base, businessType: EXIT_BUSINESS_TYPE })))?.code).toBe('VALIDATION_FAILED');
    expect(await w.fileRow(file.id)).toMatchObject({
      status: 'uploaded',
      businessType: materialTag(itemId),
      businessId: null,
    });
  });

  it('显式传入与载体一致的类型：绑定成功，归属固定为材料；默认离职摘要读不到材料文件', async () => {
    const w = await materialWorld(useDb().db, 'be16m-miss-type');
    const itemId = w.newItemId();
    const submissionId = w.newItemId();
    const file = await w.stored({ itemId });
    const refs = await rawBind(w, {
      businessId: submissionId,
      targetTag: materialTag(itemId),
      employeeId: w.employeeA,
      businessType: MATERIAL_BUSINESS_TYPE,
      next: [file.id],
    });
    expect(await w.fileRow(file.id)).toMatchObject({ status: 'bound', businessType: MATERIAL_BUSINESS_TYPE });
    const asExit = await w.tenantTx((tx) => attachmentSummaries(tx, w.tenant.id, submissionId, refs));
    expect(asExit).toEqual([]);
    const asMaterial = await w.tenantTx((tx) =>
      attachmentSummaries(tx, w.tenant.id, submissionId, refs, MATERIAL_BUSINESS_TYPE),
    );
    expect(asMaterial.map((s) => s.id)).toEqual([file.id]);
  });

  it('保留 / 释放都核对用途：同提交 ID、同归属类型但用途不是材料的行，不能当作本提交材料文件保留或释放', async () => {
    const w = await materialWorld(useDb().db, 'be16m-release-purpose');
    const submissionId = w.newItemId();
    const bytes = png();
    // 造出串位行：离职用途文件，经离职载体绑定后把归属类型改成材料（模拟脏数据 / 别的写入口误写）
    const stray = await w.tenantTx(async (tx) => {
      const self = w.ownerOf(w.hr.id, w.employeeA);
      const input = { ...materialInput(bytes), purpose: EXIT_PURPOSE };
      const registered = await service.registerFile(tx, self, w.ctxOf(w.hr.id), input);
      return service.uploadFile(
        tx,
        self,
        w.ctxOf(w.hr.id),
        registered.id,
        registered.revision,
        bytes.toString('base64'),
      );
    });
    await w.tenantTx((tx) =>
      bindAttachmentRefs(tx, w.ctxOf(w.hr.id), {
        carrier: EXIT_CARRIER,
        businessId: submissionId,
        previous: [],
        next: [stray.id],
        actor: w.hr.id,
      }),
    );
    await w.tenantTx((tx) =>
      tx.execute(sql`UPDATE attachment_files SET business_type = ${MATERIAL_BUSINESS_TYPE} WHERE id = ${stray.id}`),
    );
    const itemId = w.newItemId();
    const released = await bindMaterial(w, { itemId, submissionId, previous: [stray.id], next: [] });
    expect(released).toEqual([]);
    expect(await w.fileRow(stray.id)).toMatchObject({ status: 'bound', purpose: EXIT_PURPOSE });
    const kept = await failure(bindMaterial(w, { itemId, submissionId, previous: [stray.id], next: [stray.id] }));
    expect(kept?.code).toBe('ATTACHMENT_INVALID');
  });
});

/** 返工 P2-1：同一业务 ID 下，离职、人员子集、材料三种载体的绑定与读取互不串位。 */
describe('AC-EN-BE16-08 材料附件：同一业务 ID 下三种载体互相隔离（返工 P2-1）', () => {
  it('同一个业务 ID 分别绑定离职、子集、材料附件：各按自己的类型读取，互相读不到对方', async () => {
    const w = await materialWorld(useDb().db, 'be16m-same-id');
    const shared = w.newItemId();
    const itemId = w.newItemId();
    const material = await w.stored({ itemId });
    const materialRefs = await bindMaterial(w, { itemId, submissionId: shared, next: [material.id] });
    const bytes = png();
    const register = (purpose: string, tag?: string) =>
      w.tenantTx(async (tx) => {
        const self = w.ownerOf(w.hr.id, w.employeeA);
        const input = { ...materialInput(bytes), purpose };
        const registered = await service.registerFile(tx, self, w.ctxOf(w.hr.id), input, purpose, tag);
        return service.uploadFile(
          tx,
          self,
          w.ctxOf(w.hr.id),
          registered.id,
          registered.revision,
          bytes.toString('base64'),
          purpose,
        );
      });
    const exitFile = await register(EXIT_PURPOSE);
    const exitRefs = await w.tenantTx((tx) =>
      bindAttachmentRefs(tx, w.ctxOf(w.hr.id), {
        carrier: EXIT_CARRIER,
        businessId: shared,
        previous: [],
        next: [exitFile.id],
        actor: w.hr.id,
      }),
    );
    const subsetFile = await register(SUBSET_PURPOSE, subsetTargetTag('education', 'attachmentId'));
    await w.tenantTx((tx) =>
      bindSubsetAttachments(tx, w.ctxOf(w.hr.id), {
        kind: 'education',
        source: { type: 'hr_direct' },
        employeeId: w.employeeA,
        recordId: shared,
        previous: null,
        next: { attachmentId: subsetFile.id },
      }),
    );
    expect(await w.fileRow(exitFile.id)).toMatchObject({ status: 'bound', businessType: EXIT_BUSINESS_TYPE });
    expect(await w.fileRow(subsetFile.id)).toMatchObject({ status: 'bound', businessType: SUBSET_BUSINESS_TYPE });
    expect(await w.fileRow(material.id)).toMatchObject({ status: 'bound', businessType: MATERIAL_BUSINESS_TYPE });
    const all = [exitFile.id, subsetFile.id, material.id];
    const names = async (type?: string) =>
      (await w.tenantTx((tx) => attachmentSummaries(tx, w.tenant.id, shared, all, type))).map((s) => s.id);
    expect(await names()).toEqual([exitFile.id]);
    expect(await names(MATERIAL_BUSINESS_TYPE)).toEqual([material.id]);
    expect(await names(SUBSET_BUSINESS_TYPE)).toEqual([subsetFile.id]);
    const download = (id: string, type?: string) =>
      failure(
        w.tenantTx((tx) =>
          readCarrierAttachment(tx, w.tenant.id, shared, all, id, { mode: 'live' }, type, async () => true),
        ),
      );
    expect((await download(material.id))?.code).toBe('NOT_FOUND'); // 默认离职类型读不到材料
    expect((await download(exitFile.id, MATERIAL_BUSINESS_TYPE))?.code).toBe('NOT_FOUND');
    expect((await download(subsetFile.id, MATERIAL_BUSINESS_TYPE))?.code).toBe('NOT_FOUND');
    expect(materialRefs).toEqual([material.id]);
    expect(exitRefs).toEqual([exitFile.id]);
  });
});

/** 返工 P2-2：材料下载必须经过再验权；缺回调与回调返回否同为 404，且都在读字节前。旧载体的回调仍是可选。 */
describe('AC-EN-BE16-08 材料附件：下载必须再验权（返工 P2-2）', () => {
  it('缺回调：同一个 404，字节存储未被读取；回调返回否同样未读字节；回调返回是才放行', async () => {
    const w = await materialWorld(useDb().db, 'be16m-reauth-required');
    const itemId = w.newItemId();
    const submissionId = w.newItemId();
    const file = await w.stored({ itemId });
    const refs = await bindMaterial(w, { itemId, submissionId, next: [file.id] });
    const readBytes = vi.spyOn(PgBlobStore, 'read');
    const download = (reauthorize?: (row: FileRow) => Promise<boolean>) =>
      failure(
        w.tenantTx((tx) =>
          readCarrierAttachment(
            tx,
            w.tenant.id,
            submissionId,
            refs,
            file.id,
            { mode: 'live' },
            MATERIAL_BUSINESS_TYPE,
            reauthorize,
          ),
        ),
      );
    const missing = await download();
    const denied = await download(async () => false);
    expect(missing?.code).toBe('NOT_FOUND');
    expect(denied?.code).toBe('NOT_FOUND');
    expect(missing?.message).toBe(denied?.message);
    expect(readBytes).not.toHaveBeenCalled();
    expect(await download(async () => true)).toBeUndefined();
    expect(readBytes).toHaveBeenCalledTimes(1);
    readBytes.mockRestore();
  });

  it('旧载体（离职）的回调仍是可选：不传照常读出', async () => {
    const w = await materialWorld(useDb().db, 'be16m-reauth-exit-optional');
    const bytes = png();
    const exitFile = await w.tenantTx(async (tx) => {
      const self = w.ownerOf(w.hr.id, w.employeeA);
      const input = { ...materialInput(bytes), purpose: EXIT_PURPOSE };
      const registered = await service.registerFile(tx, self, w.ctxOf(w.hr.id), input);
      return service.uploadFile(
        tx,
        self,
        w.ctxOf(w.hr.id),
        registered.id,
        registered.revision,
        bytes.toString('base64'),
      );
    });
    const businessId = w.newItemId();
    const refs = await w.tenantTx((tx) =>
      bindAttachmentRefs(tx, w.ctxOf(w.hr.id), {
        carrier: EXIT_CARRIER,
        businessId,
        previous: [],
        next: [exitFile.id],
        actor: w.hr.id,
      }),
    );
    const read = await w.tenantTx((tx) => readCarrierAttachment(tx, w.tenant.id, businessId, refs, exitFile.id));
    expect(Buffer.from(read.bytes).equals(bytes)).toBe(true);
  });
});
