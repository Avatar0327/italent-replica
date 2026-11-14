/**
 * F-326 F1 变量管理页夹具：形状照抄后端序列化（apps/api/src/modules/approval/variables.ts variableViews：
 * valuesOf + id / status / revision / createdBy / createdAt / updatedBy / updatedAt / people；
 * 引用清单照 source-usages.ts SourceUsage 与 sourceUsagePage 的 { items, total }）。全部为合成数据。
 */
export const ADMIN_USER = '20000000-0000-4000-8000-000000000001';
export const PERSON_A = '40000000-0000-4000-8000-00000000000a';

export interface VariableFixture {
  scope: 'public' | 'application';
  appId: string | null;
  code: string;
  name: string;
  dataType: string;
  defaultValue: unknown;
  usageScopes: string[];
  description: string | null;
  id: string;
  status: 'draft' | 'enabled' | 'disabled';
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  people: {
    userId: string;
    name: string;
    code: string | null;
    departmentId: string | null;
    departmentName: string | null;
  }[];
}

export function publicVariable(over: Partial<VariableFixture> = {}): VariableFixture {
  return {
    scope: 'public',
    appId: null,
    code: 'Global.B.SynthPerson',
    name: '合成审批人变量',
    dataType: 'person',
    defaultValue: PERSON_A,
    usageScopes: ['process', 'business_rule', 'message_template'],
    description: '合成说明',
    id: '50000000-0000-4000-8000-000000000001',
    status: 'enabled',
    revision: 2,
    createdBy: ADMIN_USER,
    createdAt: '2026-11-01T02:00:00.000Z',
    updatedBy: ADMIN_USER,
    updatedAt: '2026-11-02T03:04:05.000Z',
    people: [{ userId: PERSON_A, name: '合成员工甲', code: 'E001', departmentId: null, departmentName: '合成部门' }],
    ...over,
  };
}

export function applicationVariable(appId: string, over: Partial<VariableFixture> = {}): VariableFixture {
  return {
    ...publicVariable(),
    scope: 'application',
    appId,
    code: 'B.SynthApp',
    name: '合成应用变量',
    dataType: 'string',
    defaultValue: '合成默认值',
    usageScopes: [],
    description: null,
    id: '50000000-0000-4000-8000-000000000101',
    status: 'draft',
    revision: 1,
    people: [],
    ...over,
  };
}

export interface ReferenceFixture {
  processId: string;
  processCode: string;
  processName: string;
  approvalType: string;
  versionKind: 'draft' | 'current' | 'in_flight';
  versionNo: number;
  nodeKey: string;
  nodeName: string;
  position: 'approver' | 'empty_approver';
  columnId: string | null;
  instanceCount: number | null;
}

export function reference(over: Partial<ReferenceFixture> = {}): ReferenceFixture {
  return {
    processId: '60000000-0000-4000-8000-000000000001',
    processCode: 'P_SYNTH_TRANSFER',
    processName: '合成调动流程',
    approvalType: 'transfer',
    versionKind: 'current',
    versionNo: 2,
    nodeKey: 'n1',
    nodeName: '合成会签节点',
    position: 'approver',
    columnId: null,
    instanceCount: null,
    ...over,
  };
}

/** GET /variables 的分页形状：listVariables 返回 { items, total, offset, limit }。 */
export const page = (items: VariableFixture[], offset = 0, limit = 50) => ({
  items,
  total: items.length,
  offset,
  limit,
});
