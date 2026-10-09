/**
 * 中间件层 HTTP 边界探测（现状必测基准的来源 (b)，F-039 PR-A §4.2 限定版）：对每条已声明端点用三种身份各发一次
 * 合法形状的最小请求——匿名、存在但非本租户成员的用户、仅有成员关系的用户——记录状态码与机器可读错误码
 * （含 details.reason）。路径参数用稳定占位（UUID 位用固定 UUID，其余用 `probe`），写请求体 `{}`。
 * 只探测"成员身份之上是否还要别的权限"这一维；多维身份探测（范围 / 字段 / 按钮样本）按 DEC-303 留给 PR-B。
 */
import type { RouteManifest } from '@italent/api';
import type { Db } from '@italent/db';
import { newUser } from '../platform-api.js';
import { seedTenantWithMember, type tenantApi } from '../tenant-api.js';

export interface EdgeObservation {
  readonly status: number;
  readonly code?: string;
  readonly reason?: string;
}
export interface EdgeFacts {
  readonly anonymous: EdgeObservation;
  readonly nonMember: EdgeObservation;
  readonly member: EdgeObservation;
}

const PLACEHOLDER_UUID = '00000000-0000-4000-8000-000000000001';
const UUID_PARAM = /(^id$|Id$)/;

/** `:id` / `:userId` 一类换成固定 UUID，其他参数换成 `probe`。 */
export function instantiatePath(path: string): string {
  return path.replace(/:([A-Za-z]+)/g, (_match, name: string) => (UUID_PARAM.test(name) ? PLACEHOLDER_UUID : 'probe'));
}

async function observe(response: Response): Promise<EdgeObservation> {
  const text = await response.text();
  if (!text) return { status: response.status };
  try {
    const body = JSON.parse(text) as { error?: { code?: string; details?: { reason?: string } } };
    const code = body.error?.code;
    const reason = body.error?.details?.reason;
    return { status: response.status, ...(code ? { code } : {}), ...(reason ? { reason } : {}) };
  } catch {
    return { status: response.status };
  }
}

/** 对清单里的每条端点做三身份探测；返回 `METHOD 最终路径` → 观测。 */
export async function probeEdges(
  db: Db,
  api: ReturnType<typeof tenantApi>,
  manifest: RouteManifest,
): Promise<Record<string, EdgeFacts>> {
  const { tenant, user: member } = await seedTenantWithMember(db, 'fw-probe');
  const outsider = await newUser(db, 'fw-outsider');
  const out: Record<string, EdgeFacts> = {};
  for (const route of manifest.declared) {
    const path = instantiatePath(route.path);
    const body = route.method === 'GET' ? undefined : {};
    const [anonymous, nonMember, memberOnly] = await Promise.all([
      api.request(route.method, path, { tenant: tenant.id, body }),
      api.request(route.method, path, { tenant: tenant.id, user: outsider.id, body }),
      api.request(route.method, path, { tenant: tenant.id, user: member.id, body }),
    ]);
    out[`${route.method} ${route.path}`] = {
      anonymous: await observe(anonymous),
      nonMember: await observe(nonMember),
      member: await observe(memberOnly),
    };
  }
  return out;
}
