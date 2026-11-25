import { type CollectionSubmissionValues, type OnboardingCollectionTask, type Tx } from '@italent/db';
import { PERSONNEL_OBJECT, SUBSETS, subsetAttachmentFields, type PersonnelField } from '@italent/domain';
import { z } from 'zod';
import type { Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import { attachmentRefsLocked } from '../attachments/subset-binding.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { requirePerson } from '../personnel/access.js';
import { appendEmployee, employeeSnapshot } from '../personnel/employee-write.js';
import type { PersonnelContext, Row } from '../personnel/store.js';
import { loadSubset, saveSubset } from '../personnel/subsets.js';
import { employeeInput, subsetInput, validateDates } from '../personnel/validation.js';
import { templateFieldAllowed } from './collection-config-input.js';
import { staleCollection } from './collection-submit-store.js';

const fields = z.record(z.string().min(1).max(100), z.unknown());
const patch = z.strictObject({
  kind: z.enum(['education', 'certificate']),
  id: z
    .uuid()
    .transform((value) => value.toLowerCase())
    .optional(),
  revision: z.int().min(0).max(2147483647),
  values: fields,
});
const body = z.strictObject({
  profileRevision: z.int().min(0).max(2147483647),
  profile: fields.default({}),
  subsets: z.array(patch).max(24).default([]),
});
const prefill = ['name', 'email', 'idType'];

function allowedFields(
  task: OnboardingCollectionTask,
  current: readonly Pick<PersonnelField, 'code'>[] | undefined,
  objectCode: string,
  values: Row,
) {
  const allowed = new Set(
    task.fields
      .filter((field) => field.objectCode === objectCode && field.editable && templateFieldAllowed(field))
      .map(({ fieldCode }) => fieldCode),
  );
  if (Object.keys(values).some((key) => !allowed.has(key) || (current && !current.some((f) => f.code === key))))
    throw new AppError('FORBIDDEN', '采集字段不在当前可写范围', { reason: 'COLLECTION_FIELD_NOT_ALLOWED' });
}

export function decodeCollectionValues(raw: unknown): CollectionSubmissionValues {
  const result = body.safeParse(raw);
  if (!result.success) throw new AppError('VALIDATION_FAILED', '采集表单结构不合法');
  const { profile, profileRevision, subsets } = result.data;
  if (Buffer.byteLength(JSON.stringify(result.data)) > 32 * 1024)
    throw new AppError('PAYLOAD_TOO_LARGE', '采集表单超出大小限制');
  const ids = subsets.flatMap(({ id }) => (id ? [id] : []));
  if (new Set(ids).size !== ids.length || subsets.some(({ id, revision }) => (id ? revision === 0 : revision !== 0)))
    throw new AppError('VALIDATION_FAILED', '人员子集标识或版本不合法');
  return {
    profileRevision,
    profile: Object.keys(profile).length ? employeeInput(profile) : {},
    subsets: subsets.map(({ kind, values, ...ref }) => {
      if (subsetAttachmentFields(kind).some((key) => Object.hasOwn(values, key))) throw attachmentRefsLocked();
      return { ...ref, kind, values: subsetInput(kind, values) };
    }),
  };
}

function required(task: OnboardingCollectionTask, objectCode: string, values: Row) {
  if (
    task.fields.some(
      ({ objectCode: code, fieldCode, required }) =>
        code === objectCode && required && (values[fieldCode] == null || values[fieldCode] === ''),
    )
  )
    throw new AppError('VALIDATION_FAILED', '采集表单缺少必填字段', { reason: 'COLLECTION_REQUIRED_FIELD' });
}

async function requirePatch(
  tx: Tx,
  ctx: PersonnelContext,
  authorize: Authorizer,
  objectCode: string,
  employeeId: string,
  payload: Row,
  targetId?: string,
) {
  const scope = await resolveModuleScopeInTransaction({ authorize, clock: () => ctx.now }, ctx, tx, objectCode);
  await requirePerson(tx, { ...ctx, scope, objectCode, ...(targetId ? { targetId } : {}) }, employeeId);
  await requireObjectWrite(authorizeInTransaction(authorize, tx), ctx, {
    objectCode,
    operation: objectCode === PERSONNEL_OBJECT || targetId ? 'update' : 'create',
    payload,
  });
}

type CurrentField = { objectCode: string; fieldCode: string; editable: boolean };

/** 锁员工后在暂存、提交及实际落地共用。审批期间的改权、人员版本变化与配置缩窄均拒绝。 */
export async function checkCollectionValues(
  tx: Tx,
  ctx: PersonnelContext,
  authorize: Authorizer,
  employeeId: string,
  employeeName: string,
  task: OnboardingCollectionTask,
  currentFields: readonly CurrentField[],
  input: CollectionSubmissionValues,
  submitting: boolean,
) {
  const current = (object: string) =>
    currentFields.filter((f) => f.objectCode === object && f.editable).map((f) => ({ code: f.fieldCode }));
  allowedFields(task, current(PERSONNEL_OBJECT), PERSONNEL_OBJECT, input.profile);
  if (Object.keys(input.profile).length)
    await requirePatch(tx, ctx, authorize, PERSONNEL_OBJECT, employeeId, input.profile);
  const person = await employeeSnapshot(tx, ctx, employeeId);
  if (Number(person?.revision ?? 0) !== input.profileRevision) return staleCollection();
  if (submitting) {
    const available = Object.fromEntries(
      prefill.map((key) => [key, person?.[key] ?? (key === 'name' ? employeeName : null)]),
    );
    required(task, PERSONNEL_OBJECT, { ...available, ...input.profile });
    if (task.requiredSubsets.some((kind) => !input.subsets.some((row) => row.kind === kind)))
      throw new AppError('VALIDATION_FAILED', '采集表单缺少必填子集', { reason: 'COLLECTION_REQUIRED_SUBSET' });
  }
  for (const { kind, id, revision, values } of input.subsets) {
    const { objectCode } = SUBSETS[kind];
    allowedFields(task, current(objectCode), objectCode, values);
    await requirePatch(tx, ctx, authorize, objectCode, employeeId, values, id);
    const existing = id ? await loadSubset(tx, ctx, employeeId, kind, id) : null;
    if (Number(existing?.revision ?? 0) !== revision) return staleCollection();
    const merged = { ...existing, ...values };
    validateDates(merged);
    if (submitting) required(task, objectCode, merged);
  }
  return { ...person, ...input.profile };
}

export async function landCollectionValues(
  tx: Tx,
  ctx: PersonnelContext,
  employeeId: string,
  taskId: string,
  input: CollectionSubmissionValues,
) {
  if (Object.keys(input.profile).length)
    await appendEmployee(tx, { ...ctx, expectedRevision: input.profileRevision }, employeeId, input.profile);
  for (const { kind, id, revision, values } of input.subsets)
    await saveSubset(tx, { ...ctx, expectedRevision: revision }, employeeId, kind, values, id, false, {
      type: 'info_collection',
      id: taskId,
    });
}
