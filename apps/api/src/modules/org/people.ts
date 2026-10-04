/**
 * DEC-135（`10` §14）：组织负责人、HRBP、店长的候选与服务端保存校验都是“同租户、生效日在职、内部员工”
 * （DEC-128：有人员档案即内部员工），不按操作人数据范围过滤。原站保存时是否再校验未实测，按用户选①实现。
 */
import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { ineligibleOrgPeople } from '../employment/org-people.js';
import { ORG_PERSON_FIELDS, type OrgPersonField, type OrgWriteContext } from './validation.js';

export type OrgPeople = Partial<Record<OrgPersonField, string | null | undefined>>;

/**
 * 只校验本次提交的值（新建时的全部人员字段、变更单里改了的人员字段）；沿用的原值不随无关变更重新校验，
 * 否则负责人离职后组织连改名都改不了。不区分“离职 / 未入职 / 不存在 / 其他租户”，避免借校验探测人员状态。
 */
export async function assertOrgPeopleEligible(
  tx: Tx,
  ctx: OrgWriteContext,
  submitted: OrgPeople,
  asOf: string,
): Promise<void> {
  const entries = ORG_PERSON_FIELDS.flatMap((field) => {
    const id = submitted[field];
    return typeof id === 'string' ? [[field, id] as const] : [];
  });
  if (!entries.length) return;
  const ineligible = new Set(
    await ineligibleOrgPeople(
      tx,
      ctx.tenantId,
      entries.map(([, id]) => id),
      asOf,
    ),
  );
  const fields = Object.fromEntries(
    entries.filter(([, id]) => ineligible.has(id)).map(([field]) => [field, '须为本租户生效日在职的内部员工']),
  );
  if (!Object.keys(fields).length) return;
  throw new AppError('VALIDATION_FAILED', '组织负责人、HRBP、店长须为本租户生效日在职的内部员工', {
    reason: 'PERSON_NOT_ELIGIBLE',
    fields,
  });
}

/** 本次提交的人员字段；变更时与原值相同的视为沿用（整表提交的客户端会原样带上原值），不再校验。 */
export function submittedPeople(input: object, current?: OrgPeople): OrgPeople {
  const values = input as OrgPeople;
  return Object.fromEntries(
    ORG_PERSON_FIELDS.filter((field) => Object.hasOwn(input, field))
      .filter((field) => current === undefined || values[field] !== current[field])
      .map((field) => [field, values[field]]),
  );
}
