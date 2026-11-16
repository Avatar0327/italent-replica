/** F-481 S3b：只用已合入 S1/S2 构造任务；HTTP 经 createApp + app.request。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import type { SignEvent } from '@italent/domain';
import { expect } from 'vitest';
import { applySignEvent, type SignTask } from '../../apps/api/src/modules/esign/sign-events.js';
import { initiateTransferSign } from '../../apps/api/src/modules/esign/transfer-sign.js';
import { controlledApi, type ControlledGrants } from './AC-LNK-support.js';
import { signWorld, SIGN_AT, rows } from './AC-TRF-F481-s2-support.js';

export const RECORD = 'TenantBase.ESignRecord';
export const BASE = '/api/tenant/esign';
export const COLUMNS = [
  'initiator',
  'owner',
  'ownerDepartment',
  'scene',
  'initiatedAt',
  'completedAt',
  'status',
  'files',
];
export async function recordsWorld(db: Db, label: string) {
  const w = await signWorld(db, `s3b-${label}`);
  const business = await w.direct({ linkage: w.linkage([w.templates[0]!.id]) });
  const ctx = () => ({
    tenantId: w.tenantId,
    tenantName: w.session.tenant.name,
    userId: w.session.user.id,
    timezone: w.session.tenant.timezone,
    now: new Date(SIGN_AT),
    commandId: randomUUID(),
    expectedRevision: 0,
  });
  const event = (task: SignTask, e: SignEvent) =>
    withTenant(db, w.tenantId, (tx) => applySignEvent(tx, ctx(), task, e));
  const employeeSign = (task: SignTask) =>
    event(task, {
      type: 'node_signed',
      node: 'employee',
      actorUserId: task.employeeSignerUserId,
      at: new Date(SIGN_AT),
    });
  async function complete(task: SignTask) {
    const ready = await employeeSign(task);
    return event(ready, {
      type: 'node_signed',
      node: 'enterprise',
      actorUserId: ready.initiatorUserId,
      at: new Date(SIGN_AT),
    });
  }
  const next = (ids = [w.templates[0]!.id]) =>
    withTenant(db, w.tenantId, (tx) =>
      initiateTransferSign(tx, ctx(), {
        businessId: business.id,
        templateIds: ids,
        initiatorUserId: w.session.user.id,
        origin: 'manual',
      }),
    );
  const request = (grants: ControlledGrants = {}, user = w.session.user.id) =>
    controlledApi(db, w.tenantId, user, grants, SIGN_AT);
  const call = request();
  const batch = (action: string, tasks: Pick<SignTask, 'id' | 'revision'>[], key?: string) =>
    call('POST', `${BASE}/records/${action}`, {
      body: { items: tasks.map(({ id, revision }) => ({ id, revision })) },
      key,
    });
  const audits = (id: string) =>
    withTenant(db, w.tenantId, async (tx) =>
      rows<{ action: string; after: Record<string, unknown> }>(
        await tx.execute(sql`
      SELECT action,after FROM audit_events WHERE tenant_id=${w.tenantId} AND object_id=${id} ORDER BY action`),
      ),
    );
  const exports = () =>
    withTenant(db, w.tenantId, async (tx) =>
      rows(await tx.execute(sql`SELECT * FROM operation_logs WHERE tenant_id=${w.tenantId} AND behavior='export'`)),
    );
  const task = (await w.tasks())[0]!;
  expect(task.status).toBe('signing');
  return { ...w, task, event, complete, employeeSign, next, request, call, batch, audits, exports };
}
export type RecordsWorld = Awaited<ReturnType<typeof recordsWorld>>;
export async function json(response: Response, status = 200) {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
/** ZIP 中央目录 UTF-8 名称。 */
export function zipNames(bytes: Buffer): string[] {
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  let position = bytes.readUInt32LE(end + 16);
  return Array.from({ length: bytes.readUInt16LE(end + 10) }, () => {
    expect(bytes.readUInt32LE(position)).toBe(0x02014b50);
    const length = bytes.readUInt16LE(position + 28);
    const name = bytes.subarray(position + 46, position + 46 + length).toString();
    position += 46 + length + bytes.readUInt16LE(position + 30) + bytes.readUInt16LE(position + 32);
    return name;
  });
}
