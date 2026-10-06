import { eq, contractRequests, type Tx } from '@italent/db';
import { CONTRACT_OBJECT, CONTRACT_FLOW, tenantLocalDate, type ContractOperation } from '@italent/domain';
import { assertNotQuarantined } from './quarantine.js';
import { fieldsSchema, parse } from './input.js';
import { AppError } from '../../errors.js';
import type { BusinessAdapter } from '../approval/adapters.js';
import { audit, checkFields, checkScope, lockEmployee, type ContractContext } from './context.js';
import {
  applyRequest,
  businessFields,
  loadContract,
  loadRequest,
  prepare,
  assertNoInFlight,
  requestWriteFields,
  mergeFields,
} from './service.js';

async function transition(tx: Tx, ctx: ContractContext, id: string, status: string) {
  const before = await loadRequest(tx, ctx.tenantId, id);
  const [after] = await tx
    .update(contractRequests)
    .set({ status, revision: before.revision + 1 })
    .where(eq(contractRequests.id, id))
    .returning();
  await audit(tx, ctx, `contract.request.${status}`, id, before, after);
  return after!;
}
export const contractAdapter: BusinessAdapter = {
  async lock(tx, ctx, id) {
    const request = await loadRequest(tx, ctx.tenantId, id);
    await lockEmployee(tx, ctx, request.employeeId);
  },
  async snapshot(tx, ctx, id) {
    const request = await loadRequest(tx, ctx.tenantId, id);
    const before = request.targetId ? await loadContract(tx, ctx.tenantId, request.targetId) : null;
    const current = await checkScope(tx, { ...ctx, scope: undefined }, request.employeeId);
    const values = businessFields(request);
    const { customFields, ...standard } = values;
    const flattened: Record<string, unknown> = {
      ...standard,
      ...Object.fromEntries(Object.entries(customFields).map(([k, v]) => [`custom:${k}`, v])),
    };
    const prior = before ? businessFields(before) : null;
    const originals: Record<string, unknown> | null = prior
      ? {
          ...Object.fromEntries(Object.entries(prior).filter(([key]) => key !== 'customFields')),
          ...Object.fromEntries(Object.entries(prior.customFields).map(([key, value]) => [`custom:${key}`, value])),
        }
      : null;
    const operation = request.operation as ContractOperation;
    return {
      approvalType: `contract_${operation}`,
      businessType: 'contract',
      businessId: id,
      fieldObjectCode: CONTRACT_OBJECT,
      profileFields: [],
      subjectEmployeeId: request.employeeId,
      title:
        `合同${{ create: '新建', renew: '续签', change: '变更', terminate: '终止' }[operation]}申请` +
        (request.systemInitiated ? '（系统代发）' : ''),
      values: flattened,
      originals,
      changedFields: [...new Set([...Object.keys(flattened), ...Object.keys(originals ?? {})])].filter(
        (k) => JSON.stringify(flattened[k]) !== JSON.stringify(originals?.[k]),
      ),
      conditionValues: { processCode: CONTRACT_FLOW[operation], 'business.kind': operation },
      latestDepartmentId: current?.fields.departmentId ?? null,
      recordDepartmentId: current?.fields.departmentId ?? null,
      version: `revision:${request.revision}`,
      processCode: CONTRACT_FLOW[operation],
    };
  },
  async approved(tx, ctx, id) {
    const request = await transition(tx, ctx, id, 'approved');
    const due = request.operation === 'terminate' ? request.actualTerminationDate! : request.effectiveDate;
    if (due <= tenantLocalDate(ctx.now, ctx.timezone)) await applyRequest(tx, ctx, request);
  },
  async disapproved(tx, ctx, id) {
    await transition(tx, ctx, id, 'declined');
  },
  async rejected(tx, ctx, id) {
    await transition(tx, ctx, id, 'returned');
  },
  async withdrawn(tx, ctx, id) {
    await transition(tx, ctx, id, 'withdrawn');
  },
  async resubmit(tx, ctx, id, corrections) {
    await assertNotQuarantined(tx, ctx.tenantId, id);
    const request = await loadRequest(tx, ctx.tenantId, id);
    const target = request.targetId ? await loadContract(tx, ctx.tenantId, request.targetId) : null;
    corrections = parse(fieldsSchema, corrections);
    const writable = mergeFields(requestWriteFields(request), corrections);
    await checkFields(ctx, request.operation === 'create' ? 'create' : 'update', writable);
    const input = {
      operation: request.operation,
      mode: 'application',
      employeeId: request.employeeId,
      ...(request.targetId ? { targetId: request.targetId } : {}),
      fields:
        request.operation === 'terminate'
          ? { actualTerminationDate: request.actualTerminationDate, ...corrections }
          : mergeFields(businessFields(request), corrections),
    };
    const prepared = await prepare(
      tx,
      { ...ctx, authorize: undefined, expectedRevision: target?.revision ?? 0 },
      input,
    );
    await assertNoInFlight(tx, ctx, request.employeeId, prepared.data.typeId, request.operation, request.id);
    await tx
      .update(contractRequests)
      .set({
        ...prepared.data,
        submittedFields: writable,
        targetRevision: target?.revision ?? null,
        status: 'in_review',
        revision: request.revision + 1,
      })
      .where(eq(contractRequests.id, id));
    await audit(tx, ctx, 'contract.request.resubmit', id, request, prepared.data);
  },
  async edit() {
    throw new AppError('CONFLICT', '合同审批中修改请驳回后重新提交');
  },
};
