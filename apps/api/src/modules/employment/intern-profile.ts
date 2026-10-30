/** F-322 / DEC-685：实习一体写入复用档案与教育子集端口，不直接改系统反写列。 */
import { withTenant, type Tx } from '@italent/db';
import { PERSONNEL_OBJECT, SUBSETS, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { authorize, requirePerson, trimWithFields } from '../personnel/access.js';
import { readEmployee } from '../personnel/employee-read.js';
import { appendEmployee } from '../personnel/employee-write.js';
import type { Row } from '../personnel/store.js';
import { saveSubset } from '../personnel/subsets.js';
import { employeeInput, subsetInput } from '../personnel/validation.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import type { EmploymentContext } from './types.js';
import { personnelCreationScope } from '../permission/scope-resolver.js';

const PROFILE_FIELDS = [
  'backupMail',
  'mobilePhone',
  'gender',
  'birthday',
  'engName',
  'idType',
  'idNumber',
  'dailyWageStandard',
];
const EDUCATION_FIELDS: Record<string, string> = {
  educationLevel: 'educationLevel',
  lastSchool: 'school',
  major: 'major',
  graduateDate: 'endDate',
};
export interface InternProfilePlan {
  readonly fields: Row;
  readonly education?: Row;
}

export function planInternProfile(value: Row): InternProfilePlan {
  const allowed = new Set([...PROFILE_FIELDS, ...Object.keys(EDUCATION_FIELDS)]);
  if (Object.keys(value).some((field) => !allowed.has(field)))
    throw new AppError('VALIDATION_FAILED', '实习生资料含不支持的字段');
  const ordinary = Object.fromEntries(Object.entries(value).filter(([field]) => PROFILE_FIELDS.includes(field)));
  const fields = Object.keys(ordinary).length ? employeeInput(ordinary) : {};
  const hasEducation = ['educationLevel', 'lastSchool', 'major'].some((field) => Object.hasOwn(value, field));
  if (!hasEducation) {
    if (Object.hasOwn(value, 'graduateDate'))
      throw new AppError('VALIDATION_FAILED', '毕业日期须随学历、学校或专业提供');
    return { fields };
  }
  const education = subsetInput('education', {
    ...Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key in EDUCATION_FIELDS)
        .map(([key, field]) => [EDUCATION_FIELDS[key]!, field]),
    ),
    isHighestEducation: true,
    isMainMajor: true,
  });
  return { fields, education };
}

/** 与档案 PATCH / 教育 POST 相同：任一字段无权整单拒绝，反写列不另做人工字段编辑。 */
export async function requireInternProfileAccess(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  plan: InternProfilePlan,
  employeeId?: string,
) {
  const authorizer = authorizeInTransaction(deps.authorize, tx);
  const writes = [
    ...(Object.keys(plan.fields).length
      ? [{ objectCode: PERSONNEL_OBJECT, operation: 'update' as const, payload: plan.fields }]
      : []),
    ...(plan.education
      ? [{ objectCode: SUBSETS.education.objectCode, operation: 'create' as const, payload: plan.education }]
      : []),
  ];
  for (const { objectCode, operation, payload } of writes) {
    let scope = await resolveModuleScopeInTransaction(deps, ctx, tx, objectCode);
    // DEC-082：创建人规则只授予旧记录读写权，教育新增仍须落在当前管理范围内。
    if (operation === 'create')
      scope = await personnelCreationScope(
        tx,
        { ...ctx, appCode: 'TenantBase', asOf: tenantLocalDate(ctx.now, ctx.timezone) },
        scope,
      );
    const access = { ...ctx, authorizer, objectCode, scope };
    await authorize(authorizer, access, operation, payload, operation);
    if (!scope.hasDataPermission) throw new AppError('NOT_FOUND', '人员不存在');
    // 首次建档尚无 ID，落地在任职生成后复核实际归属；重聘及重放在写入前按已有人员复核。
    if (employeeId) await requirePerson(tx, access, employeeId);
  }
}

export async function writeInternProfile(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  plan: InternProfilePlan,
  employeeId: string,
): Promise<Row | undefined> {
  if (!Object.keys(plan.fields).length && !plan.education) return undefined;
  await requireInternProfileAccess(tx, deps, ctx, plan, employeeId);
  const personnel = { ...ctx, authorizer: authorizeInTransaction(deps.authorize, tx), expectedRevision: 0 };
  // 任职员工锁已由外层持有；资料和教育版本各自追加，不拿员工 revision 冒充档案 revision。
  if (Object.keys(plan.fields).length) await appendEmployee(tx, personnel, employeeId, plan.fields, false);
  if (plan.education) await saveSubset(tx, personnel, employeeId, 'education', plan.education);
  const saved = await readEmployee(tx, personnel, employeeId);
  const keys = [...PROFILE_FIELDS, ...Object.keys(EDUCATION_FIELDS), 'revision'];
  return Object.fromEntries(keys.map((key) => [key, saved[key]]));
}

/** 台账保留原结果；首次和重放在当前档案对象查看权、范围及字段查看权下投影，不能返出旧授权快照。 */
export async function projectInternProfile(deps: TenantRouteDeps, ctx: EmploymentContext, body: unknown) {
  const receipt = body as Row;
  if (!receipt.profile) return body;
  const { profile, ...base } = receipt;
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const authorizer = authorizeInTransaction(deps.authorize, tx);
    if (!(await authorizer({ ...ctx, action: 'object.view', resource: PERSONNEL_OBJECT }))) return base;
    const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, PERSONNEL_OBJECT);
    try {
      await requirePerson(tx, { ...ctx, objectCode: PERSONNEL_OBJECT, scope }, String(receipt.employeeId));
    } catch (error) {
      // 教育写入权与档案查看范围独立；不可披露只省略快照，不能把已提交的命令伪装成失败。
      if (error instanceof AppError && error.code === 'NOT_FOUND') return base;
      throw error;
    }
    const visible = await getModuleViewableFieldsInTransaction(deps, ctx, PERSONNEL_OBJECT, tx);
    return { ...base, profile: trimWithFields(profile as Row, visible) };
  });
}
