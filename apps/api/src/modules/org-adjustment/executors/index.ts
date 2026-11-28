/**
 * BE-11b 组织明细执行器（新增 1 / 变更 2 / 停用 3）与申请人主体层复核。
 * 人员 / 职位 / 编制 / 兼岗明细随 11c～11f 接入，届时在此登记。
 */
import type { GroupExecutors } from '../execution-groups.js';
import { applicantSubjectCheck, resolveApplicantScope, type ApplicantScopeOf } from './applicant-scope.js';
import { orgChangeExecutor, orgDeactivateExecutor } from './org-change.js';
import { orgCreateExecutor } from './org-create.js';
import { transferExecutor } from './transfer.js';

export function orgExecutors(scopeOf: ApplicantScopeOf = resolveApplicantScope): GroupExecutors {
  return { 1: orgCreateExecutor(scopeOf), 2: orgChangeExecutor(scopeOf), 3: orgDeactivateExecutor(scopeOf) };
}

/** 生产默认执行器（BE-11c-b 起运行器默认用它）：组织三类 + 调动明细同一组织内的执行器。 */
export function transferExecutors(scopeOf: ApplicantScopeOf = resolveApplicantScope): GroupExecutors {
  return { ...orgExecutors(scopeOf), transfer: transferExecutor(scopeOf) };
}

export { applicantSubjectCheck, resolveApplicantScope, type ApplicantScopeOf };
