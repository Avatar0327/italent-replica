/**
 * 平台运营层（R1-T17，REQ-PLT-001）验收测试的公共装配：平台运营身份 + 平台接口 /api/platform/*。
 * 平台接口与租户内权限隔离：只认平台运营身份，不看任何租户成员关系或管理员身份。
 */
import { randomBytes } from 'node:crypto';
import { createUser, type Db, grantPlatformOperator, type User } from '@italent/db';
import { cmd, type tenantApi } from './tenant-api.js';

export const PLATFORM = '/api/platform';

/** 建一个全局账号并登记为平台运营身份。 */
export async function seedOperator(db: Db, label = 'ops'): Promise<User> {
  const suffix = randomBytes(3).toString('hex');
  const user = await createUser(
    db,
    { email: `${label}-${suffix}@example.com`, displayName: `${label} 平台运营` },
    cmd(),
  );
  await grantPlatformOperator(db, { userId: user.id, expectedRevision: 0 }, cmd());
  return user;
}

export async function newUser(db: Db, label: string): Promise<User> {
  const suffix = randomBytes(3).toString('hex');
  return createUser(db, { email: `${label}-${suffix}@example.com`, displayName: label }, cmd());
}

export interface ProvisionResult {
  readonly tenant: { id: string; code: string; timezone: string; status: string; revision: number };
  readonly admin: { id: string; userId: string; role: string; grantableAdminRoles: string[] };
  readonly profiles: { id: string; code: string; name: string; licenseType: string | null }[];
  readonly processes: { id: string; code: string; approvalType: string; status: string; versionNo: number }[];
  readonly settings: { allowDirectTransfer: boolean; allowDuplicatePositionNames: boolean };
  readonly licenses: { licenseType: string; quota: number; used: number; balance: number; overage: boolean }[];
}

/** 平台开通一个租户（经平台接口）。编码加随机后缀，避免同库重复。 */
export async function provision(
  api: ReturnType<typeof tenantApi>,
  operator: User,
  body: { firstAdminUserId: string; exceptionAdminUserId?: string; timezone?: string; [key: string]: unknown },
  idempotencyKey?: string,
): Promise<Response> {
  const suffix = randomBytes(3).toString('hex');
  return api.request('POST', `${PLATFORM}/tenants`, {
    user: operator.id,
    body: { code: `t-${suffix}`, name: `开通租户${suffix}`, ...body },
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

export async function provisioned(
  api: ReturnType<typeof tenantApi>,
  operator: User,
  body: Parameters<typeof provision>[2],
): Promise<ProvisionResult> {
  const res = await provision(api, operator, body);
  if (res.status !== 201) throw new Error(`开通失败：${res.status} ${await res.text()}`);
  return (await res.json()) as ProvisionResult;
}
