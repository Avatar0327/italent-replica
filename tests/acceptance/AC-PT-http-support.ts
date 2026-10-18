/**
 * BE-7 PT-3b HTTP 验收共用夹具（docs/08_设计/R2-T05_兼职设计.md §4.1 / §7.2 / §13.1）：在 PT-3a 的服务层夹具之上，
 * 经公开路由新增 / 预览 / 读取兼职；另给“可指定数据范围、可拒绝授权项”的受限操作人（§7.2 逐入口映射）。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { eq, orgHierarchyLinks, orgVersions, sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { serviceWorld } from './AC-PT-service-support.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { orgScope, type Request } from './support/revocable-rights.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';

export const HTTP_TODAY = '2026-10-01';
export const BASE = '/api/tenant/employment';

/** 任职记录对象的全部字段编码（无字段限制时可见）。 */
const ALL_FIELDS = new Set<string>([
  ...MODULE_OBJECTS.employmentRecord.fields.map((field) => field.code),
  ...MODULE_OBJECTS.employee.fields.map((field) => field.code),
  'id',
  'revision',
]);

export interface Restriction {
  /** 数据范围；缺省看全部。 */
  readonly scope?: ModuleScope;
  /** 返回 true 的授权请求被拒绝（对象操作 / 按钮 / 字段写权限）。 */
  readonly deny?: (request: Request) => boolean;
  /** 可查看字段；缺省全部。 */
  readonly fields?: readonly string[];
}

/** 受限操作人：授权器与范围 / 字段提供器共用同一份 deny，入口与命令内复核口径一致。 */
export function restricted(restriction: Restriction): Authorizer {
  const allow = (request: Request) => !restriction.deny?.(request);
  const authorize: Authorizer = (request) => allow(request);
  registerScopeProvider(authorize, {
    scope: async () => restriction.scope ?? { ...EMPTY_SCOPE, all: true, hasDataPermission: true },
    authorize: async (request) => allow(request),
    fields: async () => new Set(restriction.fields ?? [...ALL_FIELDS]),
  });
  return authorize;
}

export const denyButton = (code: string) => (request: Request) =>
  request.action === 'object.button' && String(request.resource).includes(`#${code}@`);
export const denyAction = (action: string) => (request: Request) => request.action === action;
export const denyFieldWrite = (field: string) => (request: Request) =>
  (request.action === 'object.create' || request.action === 'object.update') && (request.fields ?? []).includes(field);

/** 兼职接口响应体（读形状 + 列表分页 + 预览 / 新增的附加键）；字段是否出现取决于查看权。 */
export interface PartTimeBody {
  id: string;
  employeeId: string;
  revision: number;
  endDate: string | null;
  serviceType: string;
  serviceStatus: string;
  partTimeView: string[];
  fields: Record<string, unknown>;
  customFields: Record<string, unknown>;
  warnings: { reason: string }[];
  items: PartTimeBody[];
}

export async function httpWorld(db: Parameters<typeof serviceWorld>[0], label: string) {
  const w = await serviceWorld(db, label);
  const employeeBase = `/employees/${w.employeeId}/part-times`;
  const body = (patch: Record<string, unknown> = {}) => ({
    partTimeType: 'part_time',
    startDate: '2026-09-01',
    ...patch,
    fields: { departmentId: w.partTimeOrg.id, ...(patch.fields as object | undefined) },
  });
  const post = (patch: Record<string, unknown> = {}, options: RequestOptions = {}) =>
    w.request('POST', employeeBase, { body: body(patch), ...options });
  const preview = (patch: Record<string, unknown> = {}, options: RequestOptions = {}) =>
    w.request('POST', `${employeeBase}/preview`, { body: body(patch), ...options });
  const list = (query = '') => w.request('GET', `${employeeBase}${query}`);
  const one = (id: string) => w.request('GET', `/part-times/${id}`);

  /** 受限操作人的请求（同一租户 / 用户，换授权器；时钟与会话一致）。 */
  function as(authorize: Authorizer, clock: () => Date = () => new Date(`${HTTP_TODAY}T01:00:00.000Z`)) {
    const api = tenantApi(w.db, { authorize, clock });
    return (method: string, path: string, options: RequestOptions = {}) =>
      api.request(method, `${BASE}${path}`, { user: w.user.id, tenant: w.tenantId, ...options });
  }
  const scopeOf = (...orgIds: string[]) => orgScope(w.tenantId, HTTP_TODAY, ...orgIds);

  /** 成功响应的 JSON（失败时把响应体带进断言信息）。 */
  async function ok<T = PartTimeBody>(response: Response, status = 200): Promise<T> {
    const text = await response.clone().text();
    if (response.status !== status) throw new Error(`预期 ${status}，实际 ${response.status}：${text}`);
    return (await response.json()) as T;
  }
  /** 失败响应：状态码 + 机读错误码 + details.reason。 */
  async function refusal(response: Response) {
    const parsed = (await response.json()) as {
      error: { code: string; message: string; details?: { reason?: string } };
    };
    return {
      status: response.status,
      code: parsed.error.code,
      reason: parsed.error.details?.reason,
      message: parsed.error.message,
    };
  }

  /** 可信夹具：给组织追加一个版本写入负责人（组织入口对负责人有在职等校验，这里只关心兼职预览读到的值）。 */
  async function setOrgHead(orgId: string, headEmployeeId: string) {
    await withTenant(w.db, w.tenantId, async (tx) => {
      const [old] = await tx
        .select()
        .from(orgVersions)
        .where(eq(orgVersions.orgId, orgId))
        .orderBy(sql`version_no DESC`)
        .limit(1);
      const versionId = randomUUID();
      await tx.insert(orgVersions).values({
        ...old!,
        id: versionId,
        versionNo: old!.versionNo + 1,
        previousVersionId: old!.id,
        personInChargeId: headEmployeeId,
      });
      const links = await tx.select().from(orgHierarchyLinks).where(eq(orgHierarchyLinks.versionId, old!.id));
      if (links.length) await tx.insert(orgHierarchyLinks).values(links.map((link) => ({ ...link, versionId })));
    });
  }

  /** 在职的另一名员工（主职在主职部门），用作直线经理 / 部门负责人。 */
  async function colleague(name: string) {
    const created = await w.employee(name);
    await w.business(
      created.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId: w.primaryOrg.id } },
      created.revision,
    );
    return created;
  }

  return { ...w, colleague, setOrgHead, body, post, preview, list, one, as, scopeOf, ok, refusal };
}

export type HttpWorld = Awaited<ReturnType<typeof httpWorld>>;
