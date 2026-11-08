/**
 * F-478 S3 验收夹具：管理员记录、成员停用 / 解绑账号都用可信 SQL 写合成数据（所有租户读写放进 withTenant，DEC-568），
 * 审批与任职走真实接口。来源保存统一走 POST /processes，读回走 GET /processes/:id。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { PRESET_PROCESSES } from '@italent/domain';
import { expect } from 'vitest';
import { installPresets, publishProcess, replaceDraft } from '../../apps/api/src/modules/approval/definitions.js';
import { uniqueSuffix } from './support/unique.js';
import type { ApprovalWorld, NodeInput, ProcessView } from './AC-APV-support.js';

export const APV = '/api/tenant/approval';

/** 追加一条管理员记录；createdAt 显式给出，用来固定“按开通先后取第一位”的顺序。 */
export async function addAdminRecord(
  w: ApprovalWorld,
  userId: string,
  role: 'system_admin' | 'tenant_admin',
  createdAt: string,
  status: 'active' | 'revoked' = 'active',
) {
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`INSERT INTO permission_admins (tenant_id,user_id,role,status,created_at,updated_at)
      VALUES (${w.tenant.id},${userId}::uuid,${role},${status},${createdAt}::timestamptz,${createdAt}::timestamptz)`),
  );
}

/** 成员停用（账号不可作审批人）。 */
export async function revokeMember(w: ApprovalWorld, userId: string) {
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`UPDATE tenant_memberships SET status='revoked'
      WHERE tenant_id=${w.tenant.id} AND user_id=${userId}::uuid`),
  );
}

/** 解除账号与人员的绑定：人员没有账号。 */
export async function unlinkAccount(w: ApprovalWorld, userId: string) {
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`DELETE FROM permission_user_person_links
      WHERE tenant_id=${w.tenant.id} AND user_id=${userId}::uuid`),
  );
}

/** 经公开接口保存一条单节点草稿流程，返回原始响应（节点 key 固定为 one）。 */
export function saveSingleNode(
  w: ApprovalWorld,
  approvalType: string,
  approver: { type: string; value: string },
  actions: Record<string, unknown> = {},
) {
  return w.request(w.hr.id, 'POST', `${APV}/processes`, {
    ifMatch: 0,
    body: {
      code: `F478S3_${uniqueSuffix()}`,
      name: '合成来源流程',
      approvalType,
      isFallback: true,
      conditions: { items: [] },
      nodes: [{ key: 'one', name: '合成节点', approver, actions }],
    },
  });
}

export async function readProcess(w: ApprovalWorld, id: string): Promise<ProcessView> {
  return w.json<ProcessView>(await w.request(w.hr.id, 'GET', `${APV}/processes/${id}`));
}

export const subjectEmployeeSource = { type: 'object_field', value: 'subject_employee' } as const;
export const systemAdminSource = { type: 'identity', value: 'system_admin' } as const;

/** 调动流程：单节点（或前置指定人员节点）的合成流程节点，回避默认关闭。 */
export function node(key: string, approver: NodeInput['approver'], actions: Record<string, unknown> = {}): NodeInput {
  return { key, name: `节点${key}`, approver, actions: { avoidSelf: false, avoidSubjects: false, ...actions } };
}

/** 错误响应的 reason 与首条违规文字。 */
export async function failureOf(response: Response) {
  const body = (await response.json()) as {
    error: { code: string; details?: { reason?: string; violations?: string[] } };
  };
  expect(body.error).toBeDefined();
  return { status: response.status, code: body.error.code, ...body.error.details };
}

/** 安装全部预置，只把指定 presetKey 补上异常管理员并发布（与开通时 provisioning 同一路径）。 */
export async function publishPreset(w: ApprovalWorld, presetKey: string) {
  await withTenant(w.db, w.tenant.id, async (tx) => {
    const ctx = {
      tenantId: w.tenant.id,
      userId: w.hr.id,
      timezone: 'Asia/Shanghai',
      now: new Date(),
      commandId: randomUUID(),
    };
    for (const installed of await installPresets(tx, { ...ctx, expectedRevision: 0 })) {
      if (installed.presetKey !== presetKey) continue;
      const preset = PRESET_PROCESSES.find((p) => p.presetKey === presetKey)!;
      const definition = { ...preset.definition, exceptionAdminUserId: w.exceptionAdmin };
      const draft = await replaceDraft(tx, { ...ctx, expectedRevision: installed.revision }, installed.id, definition);
      await publishProcess(tx, { ...ctx, expectedRevision: draft.revision }, installed.id);
    }
  });
}
