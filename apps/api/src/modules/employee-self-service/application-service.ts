import { z } from 'zod';
import type { Tx } from '@italent/db';
import { type SelfApplicationKind } from '@italent/domain';
import { AppError } from '../../errors.js';
import { createExitApplication, updateExitFields } from '../employment/exit-application.js';
import { applyInitiationSubset, exitOptionsSchema } from '../employment/exit-initiation.js';
import { submitExit } from '../employment/exit-batch.js';
import { lockExitForEdit } from '../employment/exit-reschedule.js';
import { day, parse } from '../employment/exit-routes.js';
import { lockEmploymentEmployee } from '../employment/record-store.js';
import {
  createAddRequest,
  updateRequest,
  submitRequest,
  type AddRequestPatch,
} from '../employment/part-time/request-service.js';
import {
  createSchema,
  editSchema,
  serviceInput,
  editInput,
  writeBusiness,
  editBusiness,
} from '../employment/part-time/routes.js';
import { getModuleViewableFieldsInTransaction } from '../permission/module-access.js';
import { foreignVisibility } from '../approval/foreign-fields.js';
import type { EmploymentContext } from '../employment/types.js';
import type { SelfAccess } from './access.js';
import { ownRequest, requireApplicationAccess, selfPartTimeDepartmentScope } from './application-access.js';

// attachmentRefs（F-479 S2）：UUID 数组，张数上限与归属 / 状态由绑定函数判定并给 ATTACHMENT_LIMIT / ATTACHMENT_INVALID
const exitFields = exitOptionsSchema.pick({ reasonCode: true, whereaboutsCode: true, attachmentRefs: true }).extend({
  whereaboutsCode: z.string().trim().max(100).optional(), // DEC-790：空串清空选填去向。
});
const exitCreate = exitFields.extend({ lastWorkDate: day, pendingTransferAck: z.string().max(200).optional() });
const exitUpdate = exitCreate.partial();
const submit = z.strictObject({ pendingTransferAck: z.string().max(200).optional() });
const remark = z.string().max(32766).nullable().optional();
const present = (value: unknown) => value !== null && value !== undefined;
export type SelfRequestAction = 'create' | 'update' | 'submit';

export function applicationInput(
  kind: SelfApplicationKind,
  action: SelfRequestAction,
  raw: unknown,
): Record<string, unknown> {
  if (action === 'submit') return kind === 'exit' ? parse(submit, raw) : parse(z.strictObject({}), raw);
  if (kind === 'exit') {
    const data = action === 'create' ? parse(exitCreate, raw) : parse(exitUpdate, raw);
    return action === 'create' ? { ...data, ...applyInitiationSubset('self', 'application', data) } : data;
  }
  return action === 'create'
    ? parse(createSchema.extend({ requestRemark: remark }), raw)
    : parse(editSchema.extend({ requestRemark: remark }), raw);
}
export type ApplicationInput = ReturnType<typeof applicationInput>;

/** 所有写出口及重放前统一复核本人、按钮、实际写字段与候选部门；提交按保存后的整单。 */
export async function checkApplication(
  tx: Tx,
  self: SelfAccess,
  kind: SelfApplicationKind,
  action: SelfRequestAction,
  body: ApplicationInput,
  id?: string,
) {
  const existing = id ? await ownRequest(tx, self, kind, id) : undefined;
  let payload: object = body;
  if (kind === 'partTime') {
    const current = existing as Record<string, unknown> | undefined;
    const raw = body as z.infer<typeof createSchema> & { requestRemark?: string | null };
    payload =
      action === 'submit'
        ? {
            partTimeType: current!.serviceType,
            effectiveDate: current!.effectiveDate,
            ...(!present(current!.endDate) ? {} : { endDate: current!.endDate }),
            fields: Object.fromEntries(
              Object.entries(current!.fields as object).filter(
                ([key, value]) => ['departmentId', 'directManagerId'].includes(key) && present(value),
              ),
            ),
            ...(!present(current!.requestRemark) ? {} : { requestRemark: current!.requestRemark }),
          }
        : {
            ...(action === 'create' ? writeBusiness(raw) : editBusiness(raw)),
            ...(raw.requestRemark === undefined ? {} : { requestRemark: raw.requestRemark }),
          };
    const fields = raw.fields ?? {};
    const department = fields.departmentId ?? (current?.fields as { departmentId?: string } | undefined)?.departmentId;
    const date = raw.startDate ?? current?.effectiveDate;
    if (department && typeof date === 'string') await selfPartTimeDepartmentScope(tx, self, date, department);
  } else if (action === 'submit') {
    const current = existing as Record<string, unknown>;
    payload = Object.fromEntries(
      ['lastWorkDate', 'reasonCode', 'whereaboutsCode']
        .filter((key) => present(current[key]))
        .map((key) => [key, current[key]]),
    );
  }
  await requireApplicationAccess(tx, self, kind, action === 'create' ? 'create' : 'update', payload);
}

export async function writeApplication(
  tx: Tx,
  self: SelfAccess,
  ctx: EmploymentContext,
  kind: SelfApplicationKind,
  action: SelfRequestAction,
  body: ApplicationInput,
  id?: string,
) {
  if (action === 'update' && id) {
    if (kind === 'exit') await lockExitForEdit(tx, ctx, id);
    const current = await ownRequest(tx, self, kind, id);
    if (!['draft', 'rejected'].includes(current.status))
      throw new AppError('CONFLICT', '只能暂存草稿、已驳回的本人申请');
    if (kind === 'exit')
      applyInitiationSubset('self', 'application', {
        reasonCode: (current as Record<string, unknown>).reasonCode as string | undefined,
        whereaboutsCode: (current as Record<string, unknown>).whereaboutsCode as string | undefined,
        ...body,
      });
  }
  if (action === 'create') await lockEmploymentEmployee(tx, ctx, self.employee.id, ctx.expectedRevision);
  if (kind === 'exit') {
    const data = body as z.infer<typeof exitCreate>;
    if (action === 'create')
      return createExitApplication(tx, ctx, {
        employeeId: self.employee.id,
        initiation: 'self',
        mode: 'application',
        lastWorkDate: data.lastWorkDate,
        exit: {
          reasonCode: data.reasonCode,
          whereaboutsCode: data.whereaboutsCode,
          pendingTransferAck: data.pendingTransferAck,
          attachmentRefs: data.attachmentRefs,
        },
        bindAttachments: true,
      });
    if (action === 'submit') return submitExit(tx, ctx, id!, data.pendingTransferAck);
    const { lastWorkDate, pendingTransferAck, ...fields } = data;
    return updateExitFields(
      tx,
      ctx,
      id!,
      {
        fields,
        dates: lastWorkDate === undefined ? {} : { lastWorkDate },
        pendingTransferAck,
      },
      { bindAttachments: true },
    );
  }
  const data = body as z.infer<typeof createSchema> & { requestRemark?: string | null };
  if (action === 'create')
    return createAddRequest(tx, ctx, {
      ...serviceInput(self.employee.id, data),
      initiator: 'self',
      remark: data.requestRemark,
    });
  if (action === 'update')
    // editSchema 的部门不接受 null；复用 HR 申请适配器同样的类型收窄。
    return updateRequest(tx, ctx, id!, {
      ...(editInput(data) as AddRequestPatch),
      ...(data.requestRemark === undefined ? {} : { remark: data.requestRemark }),
    });
  return submitRequest(tx, ctx, id!, {
    viewable: (tx, userId, objectCode) =>
      getModuleViewableFieldsInTransaction(self.deps, { ...ctx, userId }, objectCode, tx),
    foreignVisible: (tx, userId, field) => foreignVisibility(self.deps, { ...ctx, userId }, tx)(field),
  });
}
