import type { Page, Route } from '@playwright/test';
import { employee, tenant, selfServiceButtons } from './fixtures.js';
export const id = '50000000-0000-4000-8000-000000000020';
export const department = '60000000-0000-4000-8000-000000000020';
export const base = '/api/tenant/self-service';
export const kinds = ['exit', 'partTime'] as const;
export const titles = { exit: '本人离职', partTime: '新增兼职' };

type Kind = (typeof kinds)[number];
function makeWorld(kind: Kind, recovery: boolean) {
  const path = `${base}/${kind === 'exit' ? 'exit' : 'part-time'}-requests`;
  const modes =
    kind === 'exit'
      ? { lastWorkDate: 'editable', reasonCode: 'editable', whereaboutsCode: 'editable' }
      : {
          partTimeType: 'editable',
          effectiveDate: 'editable',
          endDate: 'editable',
          departmentId: 'editable',
          directManagerId: 'editable',
          requestRemark: 'editable',
          postId: 'readonly',
        };
  const row: Record<string, unknown> = {};
  const employeeRevision = 7;
  const conflicts = new Set<string>();
  const receipts = new Map<string, Record<string, unknown>>();
  const writes: { path: string; body: Record<string, unknown>; revision?: string; key?: string }[] = [];

  return { path, modes, row, employeeRevision, conflicts, receipts, writes, kind, recovery };
}
type World = ReturnType<typeof makeWorld>;
export async function installSelfRequest(page: Page, kind: Kind, recovery: boolean) {
  const world = makeWorld(kind, recovery);
  await page.route('**/api/tenant/**', (route) => readSelfRequest(route, world));
  return world;
}
function readSelfRequest(route: Route, world: World) {
  const { path, modes, row, employeeRevision, kind } = world;
  const req = route.request();
  const url = new URL(req.url());
  let result: unknown;
  if (url.pathname === `${base}/profile`)
    result = {
      employee: { id: employee, name: '合成本人', code: 'DEMO-F020', revision: employeeRevision },
      timezone: 'Asia/Shanghai',
      today: '2026-11-03',
      record: null,
      selfServiceButtons: [
        ...selfServiceButtons,
        ...['Exit.Self', 'PartTime.Self'].map((buttonCode) => ({ buttonCode, level: 'detail' })),
      ],
    };
  else if (url.pathname === `${path}/form`)
    result = {
      employee: { id: employee, name: '合成本人', code: 'DEMO-F020', revision: employeeRevision },
      dataOperations: { create: true, update: true },
      fieldModes: modes,
      updateFieldModes: modes,
      values: kind === 'exit' ? { reasonCode: 'personal' } : {},
    };
  else if (url.pathname === `${path}/references/departmentId`)
    result = {
      items: [
        { id: tenant, name: '合成根', parentId: null, selectable: false },
        { id: department, name: '合成兼职部门', parentId: tenant, selectable: true },
      ],
    };
  else if (url.pathname === `${path}/references/directManagerId`) result = { items: [] };
  else if (url.pathname.startsWith(path) && req.method() !== 'GET') {
    return writeSelfRequest(route, world);
  } else if (url.pathname === `${path}/${id}`) result = row;
  else if (url.pathname === `${base}/applications`)
    result = {
      items:
        row.status === 'in_review'
          ? [
              {
                id,
                businessId: id,
                revision: row.revision,
                title: titles[kind],
                category: titles[kind],
                applicationKind: kind,
                initiator: '合成本人',
                currentHandlers: ['合成审批人'],
                status: '审批中',
                createdAt: '2026-11-03T01:00:00Z',
              },
            ]
          : [],
      page: 1,
      pageSize: 15,
    };
  else if (url.pathname === `${base}/applications/${id}`) result = { status: '审批中', record: row };
  else if (url.pathname === `/api/tenant/approval/instances/${id}`)
    result = {
      id,
      revision: 1,
      title: titles[kind],
      status: 'running',
      approvalType: kind === 'exit' ? 'leave' : 'part_time_add',
      actions: [],
      form: { values: {} },
      recordsHidden: false,
      logs: [],
      tasks: [{ id, nodeName: '合成审批节点', status: 'pending' }],
    };
  return result === undefined ? route.fallback() : route.fulfill({ json: result });
}
function writeSelfRequest(route: Route, world: World) {
  const { path, conflicts, receipts, writes, kind, recovery } = world;
  let { row } = world;
  const req = route.request();
  const url = new URL(req.url());
  const body = req.postDataJSON() as Record<string, unknown>;
  writes.push({
    path: url.pathname,
    body,
    revision: req.headers()['if-match'],
    key: req.headers()['idempotency-key'],
  });
  let action = url.pathname.endsWith('/submit') ? 'submit' : 'edit';
  if (url.pathname === path) action = 'create';
  const key = req.headers()['idempotency-key']!;
  if (receipts.has(key)) return route.fulfill({ status: action === 'create' ? 201 : 200, json: receipts.get(key) });
  if (recovery && !conflicts.has(action)) {
    conflicts.add(action);
    if (action === 'create') world.employeeRevision++;
    else
      world.row = row = {
        ...row,
        revision: Number(row.revision) + 1,
        ...(action === 'edit' ? { [kind === 'exit' ? 'lastWorkDate' : 'endDate']: '2026-12-03' } : {}),
      };
    return route.fulfill({
      status: 409,
      json: { error: { code: 'REVISION_CONFLICT', message: '请核对最新版本' } },
    });
  }
  if (kind === 'exit' && !recovery && url.pathname === path && !body.pendingTransferAck)
    return route.fulfill({
      status: 409,
      json: {
        error: {
          code: 'CONFLICT',
          message: '存在在途调动，请确认',
          details: { reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED', ackToken: 'synthetic-confirmation' },
        },
      },
    });
  world.row = row = {
    ...row,
    ...body,
    id,
    employeeId: employee,
    employeeRevision: world.employeeRevision,
    revision: Number(row.revision ?? 0) + 1,
    status: url.pathname.endsWith('/submit') ? 'in_review' : 'draft',
    kind: kind === 'exit' ? 'exit' : 'add',
    fields: body.fields ?? row.fields ?? {},
    ...(kind === 'partTime'
      ? {
          serviceType: body.partTimeType ?? row.serviceType,
          effectiveDate: body.startDate ?? row.effectiveDate,
        }
      : {}),
  };
  delete row.pendingTransferAck;
  delete row.partTimeType;
  delete row.startDate;
  receipts.set(key, structuredClone(row));
  if (recovery) return route.abort('failed');
  return route.fulfill({ status: url.pathname === path ? 201 : 200, json: row });
}
