/**
 * 分支域常量（现状必测基准的来源 (c)，F-039 PR-A §4.4「分支清单登记」限定版）：每个动态选择器的有限域来自
 * `@italent/domain` / 模块常量，不来自声明。声明里的 `map` 键集合或 `domain` 必须与这里某个域**集合相等**，
 * 删一个值就对不上任何域（WEAKER:domain）。常量变了基准必须跟着变（FW-02 freshness）。
 */
import { JOB_OBJECT_CODES } from '@italent/api';
import {
  APPROVAL_TYPES,
  CONTRACT_FLOW,
  CONTRACT_OBJECT,
  contractAction,
  IDP_OBJECTS,
  QUALIFICATION_OWNED_OBJECTS,
  SUBSETS,
  TALENT_OBJECTS,
} from '@italent/domain';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ADAPTERS } from '../../../../apps/api/src/modules/approval/adapters.js';
import { API_SRC } from './scan.js';

const CONTRACT_MODES = ['direct', 'application'] as const;

/**
 * 审批适配器快照 `fieldObjectCode:` 的表达式 → 所属适配器与对象编码（审查第 1 轮 P2-2：从实际适配器生成，不手抄数组）。
 * 源码里出现目录外的表达式、或运行时适配器（ADAPTERS）有键没被任何表达式覆盖，基准生成即失败，必须先在这里登记。
 */
const FIELD_OBJECT_EXPRESSIONS: Readonly<Record<string, { adapter: string; codes: readonly string[] }>> = {
  // approval/adapters.ts 任职适配器：APPROVAL_TYPES[approvalType].objectCode（任职记录类审批类型）
  'type.objectCode': {
    adapter: 'employment',
    codes: Object.values(APPROVAL_TYPES)
      .filter((type) => type.adapter === 'employment')
      .map((type) => type.objectCode),
  },
  // approval/adapters.ts 员工子集适配器
  'SUBSETS[subset].objectCode': {
    adapter: 'personnel_change',
    codes: Object.values(SUBSETS).map((subset) => subset.objectCode),
  },
  // contracts/adapter.ts
  CONTRACT_OBJECT: { adapter: 'contract', codes: [CONTRACT_OBJECT] },
  // idp/approval-adapter.ts
  'IDP_OBJECTS.plan.code': { adapter: 'idp', codes: [IDP_OBJECTS.plan.code] },
};

/**
 * 只占位、还没有快照的适配器（所有回调都拒绝，不会产生任务，也就没有任务业务对象）。接入快照时必须从这里移除，
 * 并把它的 fieldObjectCode 表达式登记到上表（否则上面的检查直接失败）。
 */
export const NO_SNAPSHOT_YET: Readonly<Record<string, string>> = {
  // talent-review/approval-adapter.ts：R3-T04 PR-A 只占业务类型位置，PR-D 接入前任何回调 409
  talent_review: 'TALENT_REVIEW_APPROVAL_UNAVAILABLE',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return sourceFiles(file);
    // 登记表（policy.ts）是声明，不是现状来源
    return file.endsWith('.ts') && name !== 'policy.ts' ? [file] : [];
  });
}

/** 审批任务业务对象域：扫描全部 `fieldObjectCode: <表达式>`，按上表解析；每个运行时适配器都要有来源。 */
function approvalTaskObjects(): string[] {
  const codes = new Set<string>();
  const adapters = new Set<string>();
  for (const file of sourceFiles(API_SRC)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\bfieldObjectCode:\s*([^,\n}]+?)\s*,/g)) {
      const expression = match[1]!;
      const resolved = FIELD_OBJECT_EXPRESSIONS[expression];
      if (!resolved)
        throw new Error(`审批适配器字段对象表达式未登记：${expression}（${path.relative(API_SRC, file)}）`);
      for (const code of resolved.codes) codes.add(code);
      adapters.add(resolved.adapter);
    }
  }
  for (const key of Object.keys(NO_SNAPSHOT_YET)) {
    if (adapters.has(key)) throw new Error(`审批适配器 ${key} 已有 fieldObjectCode 来源，从 NO_SNAPSHOT_YET 移除`);
  }
  const missing = Object.keys(ADAPTERS).filter((key) => !adapters.has(key) && !Object.hasOwn(NO_SNAPSHOT_YET, key));
  if (missing.length) throw new Error(`审批适配器 ${missing.join(' / ')} 没有找到 fieldObjectCode 来源`);
  return [...codes].sort();
}

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
    // 审批任务所属业务对象：运行时适配器快照的 fieldObjectCode（任职记录、合同、人员子集、IDP 计划）
    'approval.taskObject': approvalTaskObjects(),
    // 重提 / 撤回权按业务类型分支（approval/access.ts）：运行时适配器的键
    'approval.businessType': Object.keys(ADAPTERS).sort(),
    // 经理待办页签（transfer/manager-routes.ts）
    'manager.tab': ['initiated', 'pending', 'processed'],
    // 导入逐行操作（org / job import-service）；任职导入逐行为 create / edit（employment/forward-import.ts）
    'import.rowOperation': ['create', 'update'],
    'employment.importRowOperation': ['create', 'edit'],
    // 人才标准六对象（forms/:object）与可选所属管理单元的五对象（candidates/owner-orgs，字典不设单元）
    'talent.object': Object.keys(TALENT_OBJECTS).sort(),
    // 人才表单的 operation 查询参数（talent/form-access.ts talentFormHandler：create / update，其余 400）
    'talent.formOperation': ['create', 'update'],
    'talent.ownerUnitObject': Object.keys(TALENT_OBJECTS)
      .filter((key) => key !== 'descriptionType')
      .sort(),
    // 任职资格新建时可选所属管理单元的五对象（qualification/candidates.ts ownerObject；标准随类别，不在此列）
    'qualification.ownerUnitObject': QUALIFICATION_OWNED_OBJECTS.filter((key) => key !== 'standard').sort(),
  };
}
