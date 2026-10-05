import { describe, expect, it } from 'vitest';
import { conditionViolations, evaluateCondition } from './conditions.js';
import { publishViolations } from './definition.js';
import { PRESET_PROCESSES } from './presets.js';
import { avoidSelfExceptionAdmin, decideNode, type Candidate, type RoutingFacts } from './routing.js';
import { TRANSFER_DETAIL_VIEW } from './transfer-view.js';
import {
  APPROVAL_TYPES,
  approvalTypeOfBusiness,
  subsetProcessCode,
  type SingleApprovalNode,
  type ConditionItem,
} from './types.js';

const fields = APPROVAL_TYPES.transfer.conditionFields;
const item = (no: number, field: string, operator: ConditionItem['operator'], value: ConditionItem['value']) => ({
  no,
  field,
  operator,
  value,
});

describe('发起条件（`14` §1.1）', () => {
  const context = {
    values: { processCode: 'TransferProcessNew', 'before.departmentId': 'child', 'employee.name': '甲' },
    orgAncestors: { child: ['child', 'parent', 'root'] },
  };
  it('高级表达式支持 and / or / not / 括号，默认全部 AND', () => {
    const items = [
      item(1, 'processCode', 'eq', 'TransferProcessNew'),
      item(2, 'before.departmentId', 'in_org_tree', 'parent'),
      item(3, 'employee.name', 'eq', '乙'),
    ];
    expect(evaluateCondition({ items, expression: '' }, context).result).toBe(false);
    expect(evaluateCondition({ items, expression: '1 and (2 or 3)' }, context).result).toBe(true);
    expect(evaluateCondition({ items, expression: '1 AND NOT 3' }, context).result).toBe(true);
    expect(evaluateCondition({ items: [], expression: '' }, context).result).toBe(true);
  });
  it('值列表、为空判断与包含下级只对组织字段开放', () => {
    expect(
      evaluateCondition({ items: [item(1, 'employee.code', 'is_empty', null)], expression: '' }, context).result,
    ).toBe(true);
    expect(
      evaluateCondition({ items: [item(1, 'employee.name', 'in', ['甲', '丙'])], expression: '' }, context).result,
    ).toBe(true);
    expect(
      conditionViolations({ items: [item(1, 'employee.name', 'in_org_tree', 'x')], expression: '' }, fields),
    ).toHaveLength(1);
    expect(
      conditionViolations({ items: [item(1, 'employee.salary', 'eq', '1')], expression: '' }, fields),
    ).toHaveLength(1);
    expect(conditionViolations({ items: [item(1, 'processCode', 'eq', 'A')], expression: '1 and 2' }, fields)).toEqual([
      '高级表达式不合法或引用了不存在的条件编号',
    ]);
  });
});

const node = (extra: Partial<SingleApprovalNode> = {}): SingleApprovalNode => ({
  key: 'n',
  name: '节点',
  approver: 'record_department_head',
  noAssignee: 'exception_admin',
  sameAssigneeSkip: true,
  historySameAssigneeSkip: true,
  sameAssigneeResult: 'approve',
  historySameAssigneeResult: 'approve',
  formFields: [],
  editableFields: [],
  editMode: 'none',
  actions: { transfer: false, addSign: false, copySend: false, retrieve: false, reject: true, urge: 'inherit' },
  rejectCommentRequired: false,
  hideRecords: false,
  rejectResubmit: 'restart',
  messageRules: [],
  ...extra,
});
const facts = (extra: Partial<RoutingFacts> = {}): RoutingFacts => ({
  isFirstNode: false,
  initiatorUserId: 'initiator',
  subjectEmployeeId: 'subject-person',
  subjectUserId: 'subject-user',
  exceptionAdminUserId: 'admin',
  previousApproverUserIds: [],
  approvedUserIds: [],
  chainUserIds: [],
  ...extra,
});
const person = (userId: string | null, personId: string | null = null): Candidate => ({ userId, personId });

describe('节点审批人决策（DEC-054 / DEC-068）', () => {
  it('首节点为空报错；中间节点一律转异常管理员', () => {
    expect(decideNode(node(), person(null), facts({ isFirstNode: true })).kind).toBe('first_node_empty');
    expect(decideNode(node(), person(null), facts())).toMatchObject({
      kind: 'assign',
      userId: 'admin',
      isExceptionAdmin: true,
    });
  });
  it('DEC-091：异常管理员是发起人或异动本人时转其直线经理，否则不可用', () => {
    expect(avoidSelfExceptionAdmin(person('admin'), facts())).toMatchObject({ kind: 'assign', userId: 'admin' });
    expect(avoidSelfExceptionAdmin(person('initiator'), facts(), person('boss'))).toMatchObject({
      kind: 'assign',
      userId: 'boss',
    });
    expect(avoidSelfExceptionAdmin(person('initiator'), facts()).kind).toBe('unavailable');
    expect(avoidSelfExceptionAdmin(person('x', 'subject-person'), facts(), person('subject-user')).kind).toBe(
      'unavailable',
    );
    expect(avoidSelfExceptionAdmin(person('initiator'), facts({ chainUserIds: ['boss'] }), person('boss')).kind).toBe(
      'unavailable',
    );
  });
  it('自审优先于相同审批人跳过：转直线经理；经理为空 / 本人 / 已在链上转异常管理员', () => {
    const self = person('initiator');
    const previous = facts({ previousApproverUserIds: ['initiator'] });
    expect(decideNode(node(), self, previous, person('boss'))).toMatchObject({
      origin: 'self_skip_manager',
      userId: 'boss',
      selfSkippedUserId: 'initiator',
    });
    expect(decideNode(node(), self, previous)).toMatchObject({ origin: 'exception_admin' });
    expect(decideNode(node(), person('x', 'subject-person'), facts(), person('subject-user'))).toMatchObject({
      origin: 'exception_admin',
    });
    expect(decideNode(node(), self, facts({ chainUserIds: ['boss'] }), person('boss'))).toMatchObject({
      origin: 'exception_admin',
    });
  });
  it('相同 / 历史相同审批人自动处理：结果按节点配置为「同意」或「跳过」（DEC-106）', () => {
    expect(decideNode(node(), person('a'), facts({ previousApproverUserIds: ['a'] }))).toMatchObject({
      outcome: 'same_skip',
      result: 'approve',
    });
    expect(decideNode(node(), person('a'), facts({ approvedUserIds: ['a'] }))).toMatchObject({
      outcome: 'history_skip',
      result: 'approve',
    });
    const skipping = node({ sameAssigneeResult: 'skip', historySameAssigneeResult: 'skip' });
    expect(decideNode(skipping, person('a'), facts({ previousApproverUserIds: ['a'] }))).toMatchObject({
      outcome: 'same_skip',
      result: 'skip',
    });
    expect(decideNode(skipping, person('a'), facts({ approvedUserIds: ['a'] }))).toMatchObject({
      outcome: 'history_skip',
      result: 'skip',
    });
    // 自审规则优先（DEC-068）：结果配置为「跳过」也不影响自审转直线经理。
    expect(
      decideNode(skipping, person('initiator'), facts({ previousApproverUserIds: ['initiator'] }), person('boss')),
    ).toMatchObject({ origin: 'self_skip_manager' });
    expect(
      decideNode(
        node({ sameAssigneeSkip: false, historySameAssigneeSkip: false }),
        person('a'),
        facts({ approvedUserIds: ['a'] }),
      ),
    ).toMatchObject({ kind: 'assign', origin: 'resolved' });
  });
});

describe('发布校验与出厂预置（DEC-018 / DEC-054）', () => {
  it('预置调动流程带流程编码条件，未配异常管理员不能发布', () => {
    const preset = PRESET_PROCESSES[0]!;
    expect(preset.definition.conditions.items).toHaveLength(1);
    expect(publishViolations(preset.definition).map((v) => v.reason)).toEqual(['APPROVAL_EXCEPTION_ADMIN_REQUIRED']);
    expect(
      publishViolations({
        ...preset.definition,
        exceptionAdminUserId: 'admin',
        conditions: { items: [], expression: '' },
      }),
    ).toMatchObject([{ reason: 'APPROVAL_CONDITION_REQUIRED' }]);
  });
});

describe('审批类型与标准流程编码（`14` §11.1，PR #35 第二轮补充·第 14 / 18 条）', () => {
  it('各类型使用原站标准流程编码；原站没有“重聘”类型，重聘入职 / 退休返聘归入入职', () => {
    expect(Object.keys(APPROVAL_TYPES)).not.toContain('rehire');
    expect(Object.keys(APPROVAL_TYPES)).not.toContain('retire_rehire');
    expect(APPROVAL_TYPES.hire).toMatchObject({ name: '入职', defaultProcessCode: 'EntryProcessNew' });
    expect(APPROVAL_TYPES.regularization.defaultProcessCode).toBe('ProbationProcessNew');
    expect(APPROVAL_TYPES.intern_regularization.defaultProcessCode).toBe('TraineeEntryProcess');
    expect(APPROVAL_TYPES.leave.defaultProcessCode).toBe('DimissionProcessNew');
    expect(APPROVAL_TYPES.transfer.defaultProcessCode).toBe('TransferProcessNew');
    expect(APPROVAL_TYPES.retirement.defaultProcessCode).toBe('RetireProcess');
    expect(approvalTypeOfBusiness('rehire')).toBe('hire');
    expect(approvalTypeOfBusiness('retire_rehire')).toBe('hire');
    expect(approvalTypeOfBusiness('transfer')).toBe('transfer');
  });
  it('员工子集变更按子集各用自己的流程编码；未取到标准编码的子集为空', () => {
    expect(subsetProcessCode('education')).toBe('ChangeEducationProcess');
    expect(subsetProcessCode('family')).toBe('ChangeFamilyProcess');
    expect(subsetProcessCode('jobhistory')).toBe('ChangeJobHistoryProcess');
    expect(subsetProcessCode('language-ability')).toBe('LanguageSkillsChange');
    expect(subsetProcessCode('skill')).toBe('ProfessionalSkillsChange');
    expect(subsetProcessCode('estimation-result')).toBeNull();
  });
  it('预置流程按标准编码带发起条件；调动节点表单字段取 TransferDetailView 的任职调整区块', () => {
    const byType = new Map(PRESET_PROCESSES.map((preset) => [preset.approvalType, preset]));
    expect(byType.has('rehire' as never)).toBe(false);
    for (const type of ['hire', 'regularization', 'intern_regularization', 'leave', 'retirement'] as const) {
      expect(byType.get(type)!.definition).toMatchObject({
        isFallback: false,
        conditions: {
          items: [{ field: 'processCode', operator: 'eq', value: APPROVAL_TYPES[type].defaultProcessCode }],
        },
      });
    }
    const transfer = byType.get('transfer')!.definition.nodes;
    expect(transfer.every((node) => node.formFields.includes('jobNumber'))).toBe(true);
    expect(transfer[0]!.formFields).toEqual(
      expect.arrayContaining(['effectiveDate', 'departmentId', 'postId', 'positionId', 'directManagerId']),
    );
  });
});

describe('PR #35 第三轮：预置与目录按规格核对', () => {
  it('F11：调动预置各节点的相同 / 历史相同审批人跳过全部关闭（`14` §11.10 更正）', () => {
    const transfer = PRESET_PROCESSES.find((preset) => preset.approvalType === 'transfer')!;
    expect(
      transfer.definition.nodes.map((node) => [node.key, node.sameAssigneeSkip, node.historySameAssigneeSkip]),
    ).toEqual([
      ['out_head', false, false],
      ['in_hrbp', false, false],
      ['in_head', false, false],
      ['first_level', false, false],
    ]);
  });

  it('F12 / DEC-116：规格目录（`14` §11.1）中首版涉及的标准流程编码都有审批类型与预置', () => {
    // 期望值抄自规格目录，不取实现自身的目录作分母。
    const spec = [
      ['入职', 'EntryProcessNew'],
      ['转正', 'ProbationProcessNew'],
      ['离职', 'DimissionProcessNew'],
      ['调动', 'TransferProcessNew'],
      ['新增员工', 'AddEmployeeProcess'],
      ['实习转正', 'TraineeEntryProcess'],
      ['退休', 'RetireProcess'],
      ['个人信息变更', 'EmpInfoChangeProcess'],
    ] as const;
    const byCode = new Map(
      Object.entries(APPROVAL_TYPES).map(([key, type]) => [type.defaultProcessCode, { key, type }]),
    );
    for (const [name, code] of spec) {
      expect(byCode.get(code)?.type.name, code).toBe(name);
      const preset = PRESET_PROCESSES.find((item) => item.approvalType === byCode.get(code)!.key);
      expect(preset?.definition.conditions.items, code).toEqual([
        expect.objectContaining({ field: 'processCode', operator: 'eq', value: code }),
      ]);
    }
  });

  it('F15 / DEC-118 / DEC-122：TransferDetailView 每个标准字段都有交付或延期登记，规定必须交付的字段都已交付', () => {
    // 字段清单抄自 `14` §11.2 TransferDetailView 一行。
    const spec = [
      '调动人员',
      '调动日期',
      '异动类型',
      '调动原因',
      '交接人',
      '工号',
      '性别',
      '年龄',
      '是否调整薪资',
      '是否变更合同',
      '是否同步履历',
      '是否带编制调动',
      '试岗方式',
      '试岗开始日期',
      '预计试岗结束日期',
      '试岗期限（月）',
      '是否调整目标',
      '新部门',
      '新职务',
      '新职级',
      '新职等',
      '新职务序列',
      '新职位',
      '新直线经理',
      '用工形式',
      '人员类别',
      '调动后是否部门负责人',
      '新增下属',
      '调动后是否店长',
      '兼职调整',
      '薪资调整',
      '合同变更',
      '职责转交',
      '目标调整',
    ];
    const labels = TRANSFER_DETAIL_VIEW.map((item) => item.label);
    expect([...labels].sort()).toEqual([...spec].sort());
    for (const item of TRANSFER_DETAIL_VIEW) {
      if (item.status === 'deferred') expect(item.deferredTo, item.label).toBeTruthy();
      else expect(item.field, item.label).toBeTruthy();
    }
    // 现有业务模型已有数据、必须在本 PR 交付的字段（DEC-118 / DEC-122），独立于实现列出：标签 → 表单字段编码。
    const mustDeliver: Record<string, string> = {
      调动日期: 'effectiveDate',
      异动类型: 'transferTypeCode',
      调动原因: 'reasonCode',
      工号: 'jobNumber',
      性别: 'gender',
      年龄: 'age',
      新部门: 'departmentId',
      新职务: 'postId',
      新职级: 'levelId',
      新职等: 'gradeId',
      新职务序列: 'sequenceId',
      新职位: 'positionId',
      新直线经理: 'directManagerId',
      用工形式: 'employmentForm',
      人员类别: 'employmentType',
      调动后是否部门负责人: 'isDepartmentHead',
      调动后是否店长: 'isStoreManager',
      新增下属: 'addedSubordinateIds',
    };
    const byLabel = new Map(TRANSFER_DETAIL_VIEW.map((item) => [item.label, item]));
    for (const [label, field] of Object.entries(mustDeliver)) {
      expect(byLabel.get(label), label).toMatchObject({ status: 'delivered', place: 'form', field });
    }
    expect(byLabel.get('调动人员')).toMatchObject({ status: 'delivered', place: 'header' });
    const transfer = PRESET_PROCESSES.find((preset) => preset.approvalType === 'transfer')!;
    for (const node of transfer.definition.nodes) {
      expect([...node.formFields].sort()).toEqual(Object.values(mustDeliver).sort());
    }
  });
});
