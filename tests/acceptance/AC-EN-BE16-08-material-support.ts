/**
 * AC-EN-BE16-08（16a-4b0）材料附件契约夹具：合成租户、HR 成员、待入职员工与可信端口上下文。
 * 材料用途未挂路由，所以夹具直接在租户事务里调用附件服务与受信端口；数据全部 ZZ_BE16_* 合成，邮箱 example.com。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { attachmentFiles, createUser, grantMembership, sql, withTenant, type Db, type Tx } from '@italent/db';
import type { AttachmentContext, OwnerAccess, RegisterInput } from '../../apps/api/src/modules/attachments/service.js';
import * as service from '../../apps/api/src/modules/attachments/service.js';
import { png, sha256 } from './AC-ATT-support.js';
import { uniqueSuffix } from './support/unique.js';
import { cmd, seedTenantWithMember } from './support/tenant-api.js';

export const useDb = useTestDb();

/** 材料附件用途与载体（设计 §4.2）：字面量写在测试里，红灯阶段不依赖新模块的导出。 */
export const MATERIAL_PURPOSE = 'onboarding.material_attachment';
export const MATERIAL_BUSINESS_TYPE = 'onboarding.material';
export const materialTag = (itemId: string) => `${MATERIAL_BUSINESS_TYPE}:${itemId}`;

export const materialInput = (bytes: Buffer, filename = 'ZZ_BE16_CERT.png'): RegisterInput => ({
  purpose: MATERIAL_PURPOSE,
  filename,
  contentType: 'image/png',
  byteSize: bytes.length,
  sha256: sha256(bytes),
});

async function addEmployee(db: Db, tenantId: string, name: string) {
  const id = randomUUID();
  await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`INSERT INTO employment_employees (id,tenant_id,code,name)
      VALUES (${id},${tenantId},${id},${name})`),
  );
  return id;
}

export async function materialWorld(db: Db, label: string) {
  const { tenant, user: hr } = await seedTenantWithMember(db, label);
  const otherHr = await createUser(
    db,
    { email: `zz-be16-${uniqueSuffix()}@example.com`, displayName: 'ZZ_BE16_HR2' },
    cmd(),
  );
  await grantMembership(db, { tenantId: tenant.id, userId: otherHr.id, expectedRevision: 0 }, cmd());
  const employeeA = await addEmployee(db, tenant.id, 'ZZ_BE16_EMPLOYEE_A');
  const employeeB = await addEmployee(db, tenant.id, 'ZZ_BE16_EMPLOYEE_B');
  let clock = new Date('2026-11-20T02:00:00.000Z');
  const now = () => clock;
  const tenantTx = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db, tenant.id, fn);
  const ctxOf = (userId: string): AttachmentContext => ({
    tenantId: tenant.id,
    userId,
    timezone: 'Asia/Shanghai',
    now: clock,
    commandId: randomUUID(),
  });
  const ownerOf = (userId: string, employeeId: string): OwnerAccess => ({
    ctx: { tenantId: tenant.id, userId },
    employee: { id: employeeId },
  });
  /** 登记 + 上传一张材料图片（HR 为员工代传），返回上传后的回执。 */
  async function stored(opts: { itemId: string; employeeId?: string; userId?: string; filename?: string }) {
    const userId = opts.userId ?? hr.id;
    const employeeId = opts.employeeId ?? employeeA;
    const bytes = png();
    return tenantTx(async (tx) => {
      const registered = await service.registerFile(
        tx,
        ownerOf(userId, employeeId),
        ctxOf(userId),
        materialInput(bytes, opts.filename),
        MATERIAL_PURPOSE,
        materialTag(opts.itemId),
      );
      return service.uploadFile(
        tx,
        ownerOf(userId, employeeId),
        ctxOf(userId),
        registered.id,
        registered.revision,
        bytes.toString('base64'),
        MATERIAL_PURPOSE,
      );
    });
  }
  const fileRow = async (id: string) => {
    const [row] = await tenantTx((tx) =>
      tx
        .select()
        .from(attachmentFiles)
        .where(sql`${attachmentFiles.id} = ${id}`),
    );
    return row;
  };
  return {
    db,
    tenant,
    hr,
    otherHr,
    employeeA,
    employeeB,
    now,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    tenantTx,
    ctxOf,
    ownerOf,
    stored,
    fileRow,
    newItemId: () => randomUUID(),
  };
}
export type MaterialWorld = Awaited<ReturnType<typeof materialWorld>>;
