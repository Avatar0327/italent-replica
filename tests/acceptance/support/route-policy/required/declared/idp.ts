import type { ModuleDeclared } from '../../module-declared.js';

/** idp 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const IDP_DECLARED: ModuleDeclared = {
  /** R1c：含 ≥2 个准入承载节点的备选的端点（需要 need 登记） */
  multiCarrierAdmission: [
    'DELETE /api/tenant/idp/plans/:id',
    'DELETE /api/tenant/idp/processes/:id',
    'DELETE /api/tenant/idp/templates/:id',
    'GET /api/tenant/idp/approval-processes',
    'POST /api/tenant/idp/plans/tasks/issue',
    'POST /api/tenant/idp/templates/:id/copy',
  ],
  /** 状态码相同、错误体不同，由实际行为证明非法标识声明适用的端点 */
  sameStatusInvalidId: [
    'GET /api/tenant/idp/plans/:id/competency-candidates',
    'POST /api/tenant/idp/plans/:id/goals',
    'POST /api/tenant/idp/plans/:id/goals/:goalId/tasks',
    'POST /api/tenant/idp/plans/:id/jump',
    'POST /api/tenant/idp/plans/:id/transfer',
    'POST /api/tenant/idp/templates/:id/common-goals',
    'POST /api/tenant/idp/templates/:id/modules',
  ],
  /** 已知缺口台账里本模块端点的逐对登记 */
  knownGapPairs: [
    ['DELETE /api/tenant/idp/plans/:id', 'obj:IDP.Analysis:view'],
    ['DELETE /api/tenant/idp/plans/:id', 'obj:IDP.Career:view'],
    ['DELETE /api/tenant/idp/plans/:id', 'obj:IDP.GoalReview:view'],
    ['DELETE /api/tenant/idp/plans/:id', 'obj:IDP.IDPTemplateModule:view'],
    ['DELETE /api/tenant/idp/plans/:id', 'obj:IDP.Idp:view'],
    ['DELETE /api/tenant/idp/plans/:id', 'obj:IDP.IdpGoal:view'],
    ['DELETE /api/tenant/idp/plans/:id', 'obj:IDP.Review:view'],
    ['DELETE /api/tenant/idp/plans/:id', 'obj:IDP.SubProcess:view'],
    ['DELETE /api/tenant/idp/plans/:id', 'obj:IDP.Task:view'],
    ['DELETE /api/tenant/idp/plans/:id', 'obj:IDP.TutorShip:view'],
    ['DELETE /api/tenant/idp/plans/:id', 'obj:IDP.WorkShift:view'],
    ['DELETE /api/tenant/idp/plans/:id', 'obj:TenantBase.EmploymentRecord:view'],
    ['GET /api/tenant/idp/plans', 'obj:IDP.SubProcess:view'],
    ['GET /api/tenant/idp/plans', 'obj:TenantBase.EmploymentRecord:view'],
    ['GET /api/tenant/idp/plans/:id', 'obj:IDP.Analysis:view'],
    ['GET /api/tenant/idp/plans/:id', 'obj:IDP.Career:view'],
    ['GET /api/tenant/idp/plans/:id', 'obj:IDP.GoalReview:view'],
    ['GET /api/tenant/idp/plans/:id', 'obj:IDP.IDPTemplateModule:view'],
    ['GET /api/tenant/idp/plans/:id', 'obj:IDP.IdpGoal:view'],
    ['GET /api/tenant/idp/plans/:id', 'obj:IDP.Review:view'],
    ['GET /api/tenant/idp/plans/:id', 'obj:IDP.SubProcess:view'],
    ['GET /api/tenant/idp/plans/:id', 'obj:IDP.Task:view'],
    ['GET /api/tenant/idp/plans/:id', 'obj:IDP.TutorShip:view'],
    ['GET /api/tenant/idp/plans/:id', 'obj:IDP.WorkShift:view'],
    ['GET /api/tenant/idp/plans/:id', 'obj:TenantBase.EmploymentRecord:view'],
    ['GET /api/tenant/idp/processes', 'obj:IDP.SubProcess:view'],
    ['PATCH /api/tenant/idp/plans/:id', 'obj:TenantBase.EmploymentRecord:view'],
    ['PATCH /api/tenant/idp/plans/:id', 'obj:TenantBase.Organization:view'],
  ],
};
