/** F-135 / DEC-789：线性预置基线；转正 / 实习转正（S3）与退休（S4）有意改契约，单列在下方。 */
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

  // F-478 S3 有意改契约：转正 / 实习转正不再是“部门负责人 → HRBP”基线两节点（原 DEC-789 行），改为下列结构；
  // 节点动作、出口与读回细节在 AC-APV-F478-s3.presets.test.ts 逐项断言。
  it.each([
    [
      'regularization',
      [
        ['员工自评', 'object_field', 'subject_employee'],
        ['上级评价', 'department', 'record_department_head'],
      ],
    ],
    ['intern_regularization', [['系统管理员', 'identity', 'system_admin']]],
  ] as const)('%s：F-478 S3 新预置节点、顺序与来源', (type, expected) => {
    const matches = installed.filter((item) => item.approvalType === type);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.latestVersion.nodes.map((n) => [n.name, n.approver?.type, n.approver?.value])).toEqual(expected);
    expect(matches[0]!.currentVersion).toBeNull();
    expect(matches[0]!.latestVersion.status).toBe('draft');
  });

  // F-478 S4 有意改契约：退休预置由两节点改为四节点（HRBP 按是否返聘走业务出口，返聘后再经返聘后直线经理 → 返聘后 HRBP）；
  // 出口、路由与办理流转在 AC-APV-F478-18 逐项断言。
  it('retirement：F-478 S4 四节点预置，节点、顺序与来源', () => {
    const matches = installed.filter((item) => item.approvalType === 'retirement');
    expect(matches).toHaveLength(1);
    const nodes = matches[0]!.latestVersion.nodes;
    expect(nodes.map((n) => [n.name, n.approver?.type, n.approver?.value])).toEqual([
      ['直线经理', 'object_field', 'direct_manager'],
      ['HRBP', 'department', 'record_department_hrbp'],
      ['返聘后直线经理', 'object_field', 'rehire_direct_manager'],
      ['返聘后 HRBP', 'department', 'rehire_department_hrbp'],
    ]);
    expect(nodes.map((n) => n.exits)).toEqual([
      ['approve'],
      ['approve_no_rehire', 'approve_rehire'],
      ['approve'],
      ['approve'],
    ]);
    expect(matches[0]!.currentVersion).toBeNull();
    expect(matches[0]!.latestVersion.status).toBe('draft');
  });

  it('AC-APV-F135：重复安装保持已有流程与版本，不回填或重建', async () => {
    const response = await world.request(world.hr.id, 'POST', '/api/tenant/approval/presets/install', { ifMatch: 0 });
    expect(response.status).toBe(200);
    const again = await world.json<{ items: ProcessView[] }>(response);
    expect(again.items).toEqual(installed);
  });
});
