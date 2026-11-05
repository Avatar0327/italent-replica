/** F-135 / DEC-789：只对齐六类线性预置；F-478 的分支和新来源不在本批。 */
import { PRESET_PROCESSES, type ApprovalTypeCode } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { approvalWorld, type ProcessView } from './AC-APV-support.js';

const database = useTestDb();
let world: Awaited<ReturnType<typeof approvalWorld>>;
let installed: ProcessView[];
const cases = [
  [
    'leave',
    '离职（无行为变更，保守回归）',
    [
      ['直接上级', 'object_field', 'direct_manager'],
      ['HR访谈', 'department', 'record_department_hrbp'],
    ],
  ],
  [
    'retirement',
    '退休（只保留两节点）',
    [
      ['直线经理', 'object_field', 'direct_manager'],
      ['HRBP', 'department', 'record_department_hrbp'],
    ],
  ],
  [
    'hire',
    '入职（第二节点沿用复刻 HRBP 角色）',
    [
      ['部门负责人审批', 'department', 'latest_record_department_head'],
      ['单人审批', 'department', 'record_department_hrbp'],
    ],
  ],
  [
    'org_adjustment',
    '组织调整（仍只装草稿）',
    [
      ['部门负责人审批', 'object_field', 'approval_subject_org_head'],
      ['HR审核生效', 'object_field', 'approval_subject_org_hrbp'],
    ],
  ],
  ['emp_info_change', '个人信息变更', [['HRBP审核', 'department', 'latest_record_department_hrbp']]],
  [
    'regularization',
    '转正（DEC-789 保持基线）',
    [
      ['部门负责人审批', 'department', 'latest_record_department_head'],
      ['HRBP审核', 'department', 'record_department_hrbp'],
    ],
  ],
  [
    'intern_regularization',
    '实习转正（本批不改动）',
    [
      ['部门负责人审批', 'department', 'latest_record_department_head'],
      ['HRBP审核', 'department', 'record_department_hrbp'],
    ],
  ],
] as const satisfies readonly (readonly [ApprovalTypeCode, string, readonly (readonly [string, string, string])[]])[];

beforeAll(async () => {
  world = await approvalWorld(database().db, 'f135-presets');
  const response = await world.request(world.hr.id, 'POST', '/api/tenant/approval/presets/install', { ifMatch: 0 });
  expect(response.status, await response.clone().text()).toBe(200);
  installed = (await world.json<{ items: ProcessView[] }>(response)).items;
});

describe('AC-APV-F135：真实安装接口保存并读回线性预置', () => {
  it.each(cases)('%s：%s，节点数、顺序、名称、角色与默认设置', (type, _label, expected) => {
    const matches = installed.filter((item) => item.approvalType === type);
    expect(matches).toHaveLength(1);
    const process = matches[0]!;
    const nodes = process.latestVersion.nodes;
    expect(nodes.map((n) => [n.name, n.approver?.type, n.approver?.value])).toEqual(expected);
    expect(process.currentVersion).toBeNull();
    expect(process.latestVersion.status).toBe('draft');
    expect(PRESET_PROCESSES.find((p) => p.approvalType === type)?.publishOnProvision).toBe(
      type === 'org_adjustment' ? false : undefined,
    );
    for (const node of nodes) {
      expect(node).toMatchObject({
        kind: 'single',
        noAssignee: 'exception_admin',
        sameAssigneeSkip: false,
        historySameAssigneeSkip: false,
        sameAssigneeResult: 'approve',
        historySameAssigneeResult: 'approve',
        editableFields: [],
        editMode: 'none',
        rejectCommentRequired: false,
        hideRecords: false,
        rejectResubmit: 'restart',
        messageRules: [],
        exits: ['approve'],
        actions: {
          transfer: false,
          addSign: false,
          copySend: false,
          retrieve: false,
          reject: true,
          urge: 'inherit',
          avoidSelf: true,
          avoidSubjects: false,
        },
      });
    }
  });

  it('AC-APV-F135：重复安装保持已有流程与版本，不回填或重建', async () => {
    const response = await world.request(world.hr.id, 'POST', '/api/tenant/approval/presets/install', { ifMatch: 0 });
    expect(response.status).toBe(200);
    const again = await world.json<{ items: ProcessView[] }>(response);
    expect(again.items).toEqual(installed);
  });
});
