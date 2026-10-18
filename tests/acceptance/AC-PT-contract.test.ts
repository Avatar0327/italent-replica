/**
 * BE-7 PT-1 兼职契约（docs/08_设计/R2-T05_兼职设计.md §1.5 / §4.5 / §7.2 / §7.4，§13.1 PT-1 开闸行）：
 * 三个审批类型与预置流程、审批人表达式“主职部门 HRBP”、业务类型 part_time 的占位适配器（任何调用 409）、
 * 任职记录对象的 6 个按钮与 6 个字段、两个审计对象标签。本批没有任何公开写入口。
 */
import { sql } from '@italent/db';
import {
  APPROVAL_TYPES,
  APPROVER_EXPRESSIONS,
  approvalTypeOfBusiness,
  auditFieldLabel,
  auditObjectMeta,
  definitionViolations,
  MODULE_OBJECTS,
  PART_TIME_ERRORS,
  PRESET_PROCESSES,
  STANDARD_PROFILES,
  type ApprovalTypeCode,
  type ApprovalNode,
} from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { ADAPTERS } from '../../apps/api/src/modules/approval/adapters.js';
import { approvalWorld, transferScene } from './AC-APV-support.js';

const testDb = useTestDb();

const TYPES = [
  ['part_time_add', '兼职', 'AddParttimeJobProcess'],
  ['part_time_extend', '延长兼职', 'ExtendParttimeJobProcess'],
  ['part_time_end', '结束兼职', 'EndParttimeJobProcess'],
] as const;

const typeOf = (code: string) => (APPROVAL_TYPES as Record<string, (typeof APPROVAL_TYPES)[ApprovalTypeCode]>)[code];
const approverOf = (node: ApprovalNode) => ('approver' in node ? node.approver : null);

async function constraint(name: string) {
  const result = (await testDb().db.execute(
    sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name}`,
  )) as unknown as { def: string }[] | { rows: { def: string }[] };
  return (Array.isArray(result) ? result : result.rows)[0]?.def ?? '';
}

describe('AC-PT-contract BE-7 PT-1 审批类型与表达式（§1.5）', () => {
  it('三个审批类型：原站标准编码、挂任职记录对象、适配器 part_time、开放审批中编辑；不从任职业务映射', () => {
    for (const [code, name, processCode] of TYPES) {
      expect(typeOf(code), code).toMatchObject({
        code,
        name,
        defaultProcessCode: processCode,
        objectCode: MODULE_OBJECTS.employmentRecord.code,
        adapter: 'part_time',
        approvalEdit: true,
      });
      const paths = typeOf(code)!.conditionFields.map((field) => field.path);
      expect(paths).toEqual(
        expect.arrayContaining([
          'processCode',
          'business.kind',
          'employee.code',
          'employee.name',
          'record.departmentId',
          'employee.departmentId',
        ]),
      );
      // 申请字段编码 = 任职记录字段编码（PT-R4）：结束日期、备注可放进节点表单
      expect(typeOf(code)!.formFields).toEqual(expect.arrayContaining(['partTimeType', 'endDate', 'requestRemark']));
    }
    // 兼职底层业务不是任职业务类型（BusinessKind 不加 part_time，§3.2），任职审批映射不会落到兼职类型
    expect(approvalTypeOfBusiness('part_time')).toBeNull();
  });

  it('审批人表达式加“主职部门 HRBP”，节点两处 CHECK 都接受', async () => {
    expect(APPROVER_EXPRESSIONS).toContain('latest_record_department_hrbp');
    expect(await constraint('approval_nodes_approver')).toContain("'latest_record_department_hrbp'");
    expect(await constraint('approval_nodes_approvers')).toContain("'latest_record_department_hrbp'");
  });

  it('latest_record_department_hrbp 取流程主体当前主职部门的 HRBP（与调入部门 HRBP 不同人）', async () => {
    const w = await approvalWorld(testDb().db, 'pt-hrbp');
    const s = await transferScene(w);
    const outHrbp = await w.person('调出HRBP', s.from);
    await w.setOrgRoles(s.from, { head: s.outHead.employeeId, hrbp: outHrbp.employeeId });
    await w.publishedProcess({
      nodes: [
        { key: 'primary_hrbp', name: '主职部门HRBP', approver: 'latest_record_department_hrbp' },
        { key: 'in_hrbp', name: '调入部门HRBP', approver: 'record_department_hrbp' },
      ],
    });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    let view = await w.submit(draft);
    expect(w.pending(view)).toEqual([
      expect.objectContaining({ assigneeUserId: outHrbp.userId, nodeKey: 'primary_hrbp', origin: 'resolved' }),
    ]);
    view = await w.json(await w.taskAction(outHrbp.userId, w.pending(view)[0]!.id, 'approve', view.revision));
    expect(w.pending(view)[0]).toMatchObject({ assigneeUserId: s.inHrbp.userId, nodeKey: 'in_hrbp' });
  });

  it('租户可按兼职类型新建并发布流程：结束兼职节点可配置“编辑并同意”结束日期与备注', async () => {
    const w = await approvalWorld(testDb().db, 'pt-process');
    const process = await w.publishedProcess({
      approvalType: 'part_time_end',
      conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'EndParttimeJobProcess' }] },
      nodes: [
        {
          key: 'pt_head',
          name: '兼职部门负责人',
          approver: 'record_department_head',
          formFields: ['endDate', 'requestRemark', 'departmentId'],
          editableFields: ['endDate', 'requestRemark'],
          editMode: 'with_approve',
        },
      ],
    });
    expect(process).toMatchObject({
      approvalType: 'part_time_end',
      objectCode: MODULE_OBJECTS.employmentRecord.code,
      currentVersion: { status: 'published' },
    });
    expect(process.currentVersion!.nodes[0]).toMatchObject({
      editMode: 'with_approve',
      editableFields: ['endDate', 'requestRemark'],
    });
  });
});

describe('AC-PT-contract BE-7 PT-1 预置流程（§4.5）', () => {
  const HEAD_FIRST = [
    'record_department_head',
    'record_department_hrbp',
    'latest_record_department_head',
    'latest_record_department_hrbp',
  ];
  const HRBP_FIRST = [
    'latest_record_department_hrbp',
    'latest_record_department_head',
    'record_department_hrbp',
    'record_department_head',
  ];

  it('新增 / 延长：主职 HRBP → 主职负责人 → 兼职 HRBP → 兼职负责人；结束相反', () => {
    for (const [code, , processCode] of TYPES) {
      const preset = PRESET_PROCESSES.find((p) => p.approvalType === code);
      expect(preset, code).toBeDefined();
      const { definition } = preset!;
      expect(definition.nodes.map(approverOf), code).toEqual(code === 'part_time_end' ? HEAD_FIRST : HRBP_FIRST);
      expect(definition.isFallback).toBe(false);
      expect(definition.conditions.items).toEqual([
        expect.objectContaining({ field: 'processCode', operator: 'eq', value: processCode }),
      ]);
      expect(definitionViolations(definition, typeOf(code)!), code).toEqual([]);
    }
  });

  it('节点：审批人为空转异常管理员；发起人回避开、多主体回避关（DEC-332①）；只有结束兼职“编辑并同意”结束日期与备注', () => {
    for (const [code] of TYPES) {
      const { nodes } = PRESET_PROCESSES.find((p) => p.approvalType === code)!.definition;
      expect(nodes).toHaveLength(4);
      for (const node of nodes) {
        expect(node, `${code}/${node.key}`).toMatchObject({
          noAssignee: 'exception_admin',
          actions: { avoidSelf: true, avoidSubjects: false },
        });
        if (code === 'part_time_end') {
          expect(node).toMatchObject({ editMode: 'with_approve', editableFields: ['endDate', 'requestRemark'] });
        } else {
          expect(node).toMatchObject({ editMode: 'none', editableFields: [] });
        }
      }
    }
  });
});

describe('AC-PT-contract BE-7 业务类型 part_time（PT-4a 起是真适配器，行为见 AC-PT-request-approval）', () => {
  it('业务类型进实例 CHECK；适配器已登记且不再是占位（占位的 PART_TIME_NOT_AVAILABLE 不存在）', async () => {
    expect(await constraint('approval_instances_business_type')).toContain("'part_time'");
    const adapter = (ADAPTERS as Record<string, (typeof ADAPTERS)['employment']>).part_time;
    expect(adapter).toBeDefined();
    expect(typeof adapter!.lockMany).toBe('function');
    expect(Object.hasOwn(PART_TIME_ERRORS, 'notAvailable')).toBe(false);
  });
});

describe('AC-PT-contract BE-7 PT-1 按钮、字段与审计标签（§7.2 / §7.4）', () => {
  // 批量结束在兼职列表上勾选多条操作，是列表级按钮；其余在员工 / 兼职详情上（§7.2 未定层级，复刻取此）
  const BUTTONS = [
    ['Employment.PartTime', 'detail', 'create'],
    ['Employment.PartTimeApproval', 'detail', 'create'],
    ['Employment.PartTimeExtend', 'detail', 'update'],
    ['Employment.PartTimeEnd', 'detail', 'update'],
    ['Employment.PartTimeBatchEnd', 'list', 'update'],
    ['Employment.PartTimeEdit', 'detail', 'update'],
  ] as const;

  it('任职记录对象新增 6 个按钮与 6 个字段（3 个可授编辑、3 个系统字段只可授查看）', () => {
    const { buttons, fields } = MODULE_OBJECTS.employmentRecord;
    for (const [code, level, requires] of BUTTONS) {
      expect(
        buttons.find((b) => b.code === code),
        code,
      ).toMatchObject({ code, level, requires });
    }
    const field = (code: string) => fields.find((f) => f.code === code);
    for (const code of ['partTimeType', 'endDate', 'requestRemark'])
      expect(field(code), code).toEqual({ code, system: false });
    for (const code of ['originalEndDate', 'serviceStatus', 'partTimeView'])
      expect(field(code), code).toEqual({ code, system: true });
  });

  it('标准 HR 身份随目录获得兼职按钮；经理身份只读、无按钮', () => {
    const grantsOf = (profileCode: string) =>
      STANDARD_PROFILES.find((p) => p.code === profileCode)!.objects.find(
        (o) => o.objectCode === MODULE_OBJECTS.employmentRecord.code,
      )!;
    for (const profile of ['standard_org_system_admin', 'standard_hr_admin', 'standard_hr_specialist']) {
      const codes = grantsOf(profile).buttons.map((b) => b.buttonCode);
      for (const [code] of BUTTONS) expect(codes, `${profile}/${code}`).toContain(code);
    }
    const manager = grantsOf('standard_manager');
    expect(manager.buttons).toEqual([]);
    expect(manager.fields.find((f) => f.fieldCode === 'endDate')).toEqual({
      fieldCode: 'endDate',
      view: true,
      edit: false,
    });
  });

  it('审计对象“兼职记录”“兼职申请”归组织员工；新字段有中文名', () => {
    expect(auditObjectMeta('employment-part-time')).toEqual({ label: '兼职记录', app: '组织员工' });
    expect(auditObjectMeta('part-time-request')).toEqual({ label: '兼职申请', app: '组织员工' });
    expect(auditFieldLabel('partTimeType')).toBe('任职类型');
    expect(auditFieldLabel('endDate')).toBe('结束日期');
    expect(auditFieldLabel('originalEndDate')).toBe('原定结束日期');
    expect(auditFieldLabel('requestRemark')).toBe('申请备注');
  });
});
