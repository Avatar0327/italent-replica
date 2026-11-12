/** F-326 S4 夹具：合成数据；变量 / 矩阵 / 流程全部经真实 HTTP 入口创建，租户数据读取走 withTenant。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import type { ApproverSource } from '@italent/domain';
import { expect } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { relationWorld, type RelationWorld } from './AC-APV-F318c-support.js';
import type { NodeInput, ProcessView } from './AC-APV-support.js';
import { uniqueSuffix } from './support/unique.js';

export const VARIABLES = '/api/tenant/approval/variables';
export const MATRICES = '/api/tenant/approval/matrices';
export const APPROVAL = '/api/tenant/approval';

export type S4World = RelationWorld;
export const s4World = (db: Parameters<typeof relationWorld>[0], label: string) =>
  relationWorld(db, `s4-${label}-${uniqueSuffix()}`);

export interface VariableView {
  id: string;
  code: string;
  status: 'draft' | 'enabled' | 'disabled';
  revision: number;
}

/** 变量：缺省公共人员变量并启用；应用变量缺省归“调动”应用（transfer）。 */
export async function variable(w: S4World, over: Record<string, unknown> = {}): Promise<VariableView> {
  const application = over.scope === 'application';
  return w.json<VariableView>(
    await w.request(w.hr.id, 'POST', VARIABLES, {
      ifMatch: 0,
      body: {
        scope: 'public',
        codeSuffix: `V${uniqueSuffix()}`,
        name: '合成变量',
        dataType: 'person',
        defaultValue: w.near.userId,
        usageScopes: application ? [] : ['process'],
        enable: true,
        ...(application ? { appId: 'transfer' } : {}),
        ...over,
      },
    }),
    201,
  );
}

export async function variableCommand(
  w: S4World,
  v: { id: string; revision: number },
  action: 'enable' | 'disable',
  body: Record<string, unknown> = {},
) {
  return w.request(w.hr.id, 'POST', `${VARIABLES}/${v.id}/${action}`, { ifMatch: v.revision, body });
}

export const readVariable = async (w: S4World, id: string) =>
  w.json<VariableView>(await w.request(w.hr.id, 'GET', `${VARIABLES}/${id}`));

export interface MatrixView {
  id: string;
  revision: number;
  status: string;
  columns: { id: string; kind: 'condition' | 'role'; seq: number }[];
  rows: { id: string; seq: number; cells: Record<string, string[]> }[];
}
export interface MatrixHandle extends MatrixView {
  conditionId: string;
  roleId: string;
}
interface RowSpec {
  /** 条件列单元（人员 / 组织 ID）；空数组 = 不限制 */
  cond: string[];
  role: string[];
}
interface MatrixSpec {
  rows: RowSpec[];
  dimension?: 'department' | 'position' | 'job';
  includeChildren?: boolean;
  allowMultiple?: boolean;
  enable?: boolean;
}

function structureBody(spec: MatrixSpec, revision: number, existing?: MatrixHandle, order?: number[]) {
  const indexes = order ?? spec.rows.map((_, i) => i);
  return {
    revision,
    columns: [
      {
        ...(existing ? { id: existing.conditionId } : {}),
        key: 'c',
        kind: 'condition',
        dimension: spec.dimension ?? 'department',
        includeChildren: spec.includeChildren ?? false,
        name: '条件',
        allowMultiple: false,
      },
      {
        ...(existing ? { id: existing.roleId } : {}),
        key: 'r',
        kind: 'role',
        dimension: null,
        includeChildren: false,
        name: '角色',
        allowMultiple: spec.allowMultiple ?? true,
      },
    ],
    rows: indexes.map((i) => ({
      ...(existing ? { id: existing.rows[i]!.id } : {}),
      cells: { c: spec.rows[i]!.cond, r: spec.rows[i]!.role },
    })),
  };
}

const handle = (view: MatrixView): MatrixHandle => ({
  ...view,
  conditionId: view.columns.find((column) => column.kind === 'condition')!.id,
  roleId: view.columns.find((column) => column.kind === 'role')!.id,
});

/** 一条条件列 + 一条角色列的矩阵，按行顺序决定 seq。 */
export async function matrix(w: S4World, spec: MatrixSpec): Promise<MatrixHandle> {
  const created = await w.json<MatrixView>(
    await w.request(w.hr.id, 'POST', MATRICES, {
      body: { code: `M${uniqueSuffix()}`, name: '合成矩阵', enable: spec.enable ?? true },
    }),
    201,
  );
  return handle(
    await w.json<MatrixView>(
      await w.request(w.hr.id, 'PUT', `${MATRICES}/${created.id}/structure`, {
        body: structureBody(spec, created.revision),
      }),
    ),
  );
}

/** 换行顺序（order 为原行下标的新排列），同一批列 / 行 ID 保持不变。 */
export async function reorderRows(w: S4World, m: MatrixHandle, spec: MatrixSpec, order: number[]) {
  return handle(
    await w.json<MatrixView>(
      await w.request(w.hr.id, 'PUT', `${MATRICES}/${m.id}/structure`, {
        body: structureBody(spec, m.revision, m, order),
      }),
    ),
  );
}

export async function matrixStatus(w: S4World, m: { id: string; revision: number }, action: string, extra = {}) {
  return w.request(w.hr.id, 'POST', `${MATRICES}/${m.id}/${action}`, { body: { revision: m.revision, ...extra } });
}

export const readMatrix = async (w: S4World, id: string) =>
  handle(await w.json<MatrixView>(await w.request(w.hr.id, 'GET', `${MATRICES}/${id}`)));

/** 删角色列：只保留条件列。 */
export function dropRoleColumn(w: S4World, m: MatrixHandle) {
  return w.request(w.hr.id, 'PUT', `${MATRICES}/${m.id}/structure`, {
    body: {
      revision: m.revision,
      columns: [
        {
          id: m.conditionId,
          key: 'c',
          kind: 'condition',
          dimension: 'department',
          includeChildren: false,
          name: '条件',
          allowMultiple: false,
        },
      ],
      rows: m.rows.map((row) => ({ id: row.id, cells: { c: row.cells[m.conditionId] ?? [] } })),
    },
  });
}

export const varSource = (type: 'public_variable' | 'application_variable', id: string): ApproverSource => ({
  type,
  value: id,
});
export const matrixSource = (m: { id: string }, columnId: string): ApproverSource => ({
  type: 'matrix',
  value: `${m.id}:${columnId}`,
});

/** 保存一个仅含给定节点的兜底流程（不发布）。 */
export function saveNodes(w: S4World, nodes: NodeInput[], approvalType = 'transfer') {
  return w.request(w.hr.id, 'POST', `${APPROVAL}/processes`, {
    ifMatch: 0,
    body: {
      code: `P_${randomUUID().replaceAll('-', '')}`,
      name: '合成来源流程',
      approvalType,
      isFallback: true,
      exceptionAdminUserId: w.exceptionAdmin,
      conditions: { items: [] },
      nodes: nodes.map((node) => ({ ...node, actions: { avoidSelf: true, ...node.actions } })),
    },
  });
}

/** 单个会签节点。 */
export const counter = (sources: ApproverSource[], over: Partial<NodeInput> = {}): NodeInput => ({
  key: 'n1',
  kind: 'countersign',
  approvers: sources,
  transitionRule: { type: 'all' },
  ...over,
});

export async function rejected(response: Response, status: number, reason?: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  const body = (await response.json()) as { error: { code: string; message: string; details: { reason?: string } } };
  if (reason) expect(body.error.details.reason).toBe(reason);
  return body.error;
}

/** 新建版本 → 替换草稿节点 → 发布。返回新的已发布流程视图。 */
export async function republish(w: S4World, process: ProcessView, nodes: NodeInput[]): Promise<ProcessView> {
  const base = `${APPROVAL}/processes/${process.id}`;
  const current = await w.json<ProcessView>(await w.request(w.hr.id, 'GET', base));
  const draft = await w.json<ProcessView>(
    await w.request(w.hr.id, 'POST', `${base}/versions`, { ifMatch: current.revision, body: {} }),
    201,
  );
  const version = draft.latestVersion;
  const replaced = await w.json<ProcessView>(
    await w.request(w.hr.id, 'PUT', `${base}/draft`, {
      ifMatch: draft.revision,
      body: {
        name: version.name,
        priority: version.priority,
        isFallback: version.isFallback,
        exceptionAdminUserId: version.exceptionAdminUserId,
        conditions: version.conditions,
        nodes: nodes.map((node) => ({ ...node, actions: { avoidSelf: true, ...node.actions } })),
      },
    }),
  );
  return w.publish(replaced);
}

export interface ReferenceItem {
  processId: string;
  processCode: string;
  processName: string;
  approvalType: string;
  versionKind: 'draft' | 'current' | 'in_flight';
  versionNo: number;
  nodeKey: string;
  nodeName: string;
  position: 'approver' | 'empty_approver';
  columnId: string | null;
  instanceCount: number | null;
}
export interface References {
  items: ReferenceItem[];
  total: number;
}

export async function references(w: S4World, kind: 'variables' | 'matrices', id: string): Promise<References> {
  return w.json<References>(await w.request(w.hr.id, 'GET', `${APPROVAL}/${kind}/${id}/references`));
}

/** 个人信息变更申请：员工本人提交教育经历修改，得到 personnel_change 实例。 */
export async function personnelChange(w: S4World) {
  const settings = await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
    ifMatch: 0,
    body: { value: { education: ['school'] } },
  });
  expect(settings.status, await settings.clone().text()).toBe(200);
  const path = `/api/tenant/personnel/employees/${w.subject.employeeId}/subsets/education`;
  const record = await w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', path, { ifMatch: 0, body: { school: '甲校', educationLevel: '本科' } }),
    201,
  );
  return {
    submit: async () => {
      const created = await w.request(w.subject.userId, 'POST', '/api/tenant/personnel/change-requests', {
        ifMatch: 0,
        body: {
          employeeId: w.subject.employeeId,
          subset: 'education',
          recordId: record.id,
          targetRevision: record.revision,
          values: { school: `乙校${uniqueSuffix()}` },
        },
      });
      expect(created.status, await created.clone().text()).toBe(201);
      const request = (await created.json()) as { id: string };
      return { requestId: request.id, instance: await w.instanceOf(request.id, w.subject.userId) };
    },
  };
}

export async function instanceRow(w: S4World, instanceId: string) {
  return withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf<{ status: string; version_id: string }>(
      await tx.execute(sql`SELECT status, version_id FROM approval_instances
        WHERE tenant_id=${w.tenant.id} AND id=${instanceId}::uuid`),
    ),
  ).then((rows) => rows[0]!);
}

export const transferNodes = (sources: ApproverSource[]): NodeInput[] => [counter(sources)];
