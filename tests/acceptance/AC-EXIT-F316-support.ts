/** F-316 合成夹具：真实交接引擎 + 既有流程配置 HTTP 接口。 */
import { randomUUID } from 'node:crypto';
import { withTenant, type Db } from '@italent/db';
import { PRESET_PROCESSES, type ApprovalNode, type ProcessDefinition } from '@italent/domain';
import { expect } from 'vitest';
import { createProcess, publishProcess, type ProcessView } from '../../apps/api/src/modules/approval/definitions.js';
import { handoverWorld, TODAY, type HandoverWorld } from './AC-EXIT-handover-support.js';

export type Policy = 'stop' | 'exception_admin' | 'auto_approve' | 'specified';
export type Key = 'work_handover' | 'other_handover';
export const KEYS: readonly Key[] = ['work_handover', 'other_handover'];
export const POLICIES = {
  work_handover: ['stop', 'auto_approve', 'specified'],
  other_handover: ['exception_admin', 'auto_approve', 'specified'],
} as const;

export async function world(db: Db, label: string, hrAdmin = true) {
  const x = await handoverWorld(db, `f316-${label}`, { hrAdmin });
  await x.addSettingItems();
  return x;
}

export function definition(x: HandoverWorld, patches: Partial<Record<Key, Record<string, unknown>>> = {}) {
  const preset = PRESET_PROCESSES.find((item) => item.approvalType === 'exit_handover')!;
  return {
    ...preset.definition,
    exceptionAdminUserId: x.exceptionAdmin.id,
    nodes: preset.definition.nodes.map((node) => ({ ...node, ...patches[node.key as Key] })),
  };
}

/** 直接走存储服务，旧代码会丢掉新字段，运行断言必须判红而不止停在请求格式错误。 */
export async function publish(x: HandoverWorld, input: ProcessDefinition) {
  return withTenant(x.db, x.tenantId, async (tx) => {
    const ctx = {
      tenantId: x.tenantId,
      userId: x.processAdmin.id,
      timezone: 'Asia/Shanghai',
      now: new Date(`${TODAY}T01:00:00Z`),
      commandId: randomUUID(),
      expectedRevision: 0,
    };
    const created = await createProcess(tx, ctx, { code: 'AAA_F316', approvalType: 'exit_handover' }, input);
    return publishProcess(tx, { ...ctx, expectedRevision: created.revision, commandId: randomUUID() }, created.id);
  });
}

export async function reach(x: HandoverWorld, key: Key, primary: boolean) {
  const { approved } = await x.approvedApplication(x.employee.id, {
    exit: key === 'work_handover' && !primary ? { handoverEmployeeId: undefined } : {},
  });
  const [request] = await x.requestRows(approved.id);
  expect(request).toBeDefined();
  if (key === 'other_handover') {
    expect((await x.pendingNode(request!.instanceId!))?.nodeKey).toBe('work_handover');
    const response = await x.decide(request!.instanceId!);
    expect(response.status, await response.clone().text()).toBe(200);
  }
  return { exitId: approved.id, request: request!, instanceId: request!.instanceId! };
}

export const api = (x: HandoverWorld, method: string, path: string, revision?: number, body?: unknown) =>
  x.api.request(method, `/api/tenant/approval/processes${path}`, {
    ...x.tenantAs(x.processAdmin.id),
    ifMatch: revision,
    body,
  });

export async function view(response: Response, status = 200) {
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as ProcessView;
}

export function inputOf(version: ProcessView['latestVersion']): ProcessDefinition {
  const { id: _id, versionNo: _version, status: _status, publishedAt: _published, ...input } = version;
  return input;
}

export const policyOf = (node: ApprovalNode) =>
  (node as ApprovalNode & { emptyApproverPolicy?: Policy }).emptyApproverPolicy;
