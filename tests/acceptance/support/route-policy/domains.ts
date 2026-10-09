/**
 * 分支域常量（现状必测基准的来源 (c)，F-039 PR-A §4.4「分支清单登记」限定版）：每个动态选择器的有限域来自
 * `@italent/domain` / 模块常量，不来自声明。声明里的 `map` 键集合或 `domain` 必须与这里某个域**集合相等**，
 * 删一个值就对不上任何域（WEAKER:domain）。常量变了基准必须跟着变（FW-02 freshness）。
 */
import { JOB_OBJECT_CODES } from '@italent/api';
import { CONTRACT_FLOW, CONTRACT_OBJECT, contractAction, SUBSETS, TALENT_OBJECTS } from '@italent/domain';

const CONTRACT_MODES = ['direct', 'application'] as const;
/** 任职记录对象编码（apps/api/src/modules/employment/context.ts EMPLOYMENT_OBJECT）。 */
const EMPLOYMENT_RECORD_OBJECT = 'TenantBase.EmploymentRecord';

export function domainConstants(): Record<string, string[]> {
  const operations = Object.keys(CONTRACT_FLOW);
  return {
    'job.kind': Object.keys(JOB_OBJECT_CODES).sort(),
    'personnel.subset': Object.keys(SUBSETS).sort(),
    'contracts.operation': [...operations].sort(),
    'contracts.mode': [...CONTRACT_MODES].sort(),
    // 合同命令按钮 `code@level`：create 类在列表页、其余在详情页（contracts/routes.ts）
    'contracts.commandButton': operations
      .flatMap((op) =>
        CONTRACT_MODES.map((mode) => `${contractAction(op, mode)}@${op === 'create' ? 'list' : 'detail'}`),
      )
      .sort(),
    // 合同待办批量的动作（contracts/todos.ts）
    'contracts.todoAction': ['approve', 'decline', 'reject', 'resubmit'],
    // apps/api/src/modules/contracts/imports.ts `mode: z.enum([...])`
    'contracts.importMode': ['add', 'change', 'edit', 'initialize'],
    // apps/api/src/modules/transfer/service.ts `initiator: z.enum([...])`
    'transfer.initiator': ['employee', 'hr', 'manager'],
    // 审批任务所属业务对象：任职记录、合同、人员子集（personnel_change）
    'approval.taskObject': [
      EMPLOYMENT_RECORD_OBJECT,
      CONTRACT_OBJECT,
      ...Object.values(SUBSETS).map((subset) => subset.objectCode),
    ].sort(),
    // 重提 / 撤回权按业务类型分支（approval/access.ts）
    'approval.businessType': ['contract', 'employment', 'personnel_change'],
    // 经理待办页签（transfer/manager-routes.ts）
    'manager.tab': ['initiated', 'pending', 'processed'],
    // 导入逐行操作（org / job import-service）；任职导入逐行为 create / edit（employment/forward-import.ts）
    'import.rowOperation': ['create', 'update'],
    'employment.importRowOperation': ['create', 'edit'],
    // 人才标准六对象（forms/:object）与可选所属管理单元的五对象（candidates/owner-orgs，字典不设单元）
    'talent.object': Object.keys(TALENT_OBJECTS).sort(),
    'talent.ownerUnitObject': Object.keys(TALENT_OBJECTS)
      .filter((key) => key !== 'descriptionType')
      .sort(),
  };
}
