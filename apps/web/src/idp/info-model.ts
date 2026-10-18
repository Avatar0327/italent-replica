import { projectFields, type Values } from '../foundation/forms/values.js';

export type InfoKind = 'tutorships' | 'careers' | 'work-shifts';
export type InfoRow = Values & { id: string; revision?: number };
export interface InfoField {
  name: string;
  label: string;
  type: 'person' | 'date' | 'text' | 'org' | 'position' | 'professionalLine' | 'level' | 'post';
  required?: boolean;
}
const field = (name: string, label: string, type: InfoField['type'], required = false): InfoField => ({
  name,
  label,
  type,
  required,
});
const dates = (end = '结束时间') => [field('startDate', '开始时间', 'date', true), field('endDate', end, 'date', true)];
export const INFO = {
  tutorships: {
    title: '带教信息',
    object: 'IDP.TutorShip',
    create: '新增',
    fields: [
      field('tutorEmployeeId', '带教人', 'person', true),
      field('tuteeEmployeeId', '被带教人', 'person', true),
      ...dates('结束日期'),
    ],
  },
  careers: {
    title: '职业发展信息',
    object: 'IDP.Career',
    create: '新建',
    fields: [
      field('employeeId', '发展员工', 'person', true),
      ...dates(),
      field('strengths', '优势项', 'text'),
      field('developmentItems', '待发展项', 'text'),
      field('targetPositionId', '拟晋升职位', 'position'),
      field('targetProfessionalLineId', '发展条线', 'professionalLine'),
      field('targetLevelId', '拟晋升职级', 'level'),
      field('targetPostId', '拟晋升职务', 'post'),
    ],
  },
  'work-shifts': {
    title: '轮岗信息',
    object: 'IDP.WorkShift',
    create: '新建',
    fields: [
      field('employeeId', '姓名', 'person', true),
      ...dates(),
      field('orgId', '轮岗部门', 'org', true),
      field('positionId', '轮岗职位', 'position', true),
      field('mentorEmployeeId', '轮岗导师', 'person'),
    ],
  },
} satisfies Record<InfoKind, { title: string; object: string; create: string; fields: InfoField[] }>;
export const infoText = {
  actions: '操作',
  choose: '请选择',
  currentLevel: '当前职级',
  currentPosition: '当前职位',
  currentPost: '当前职务',
  noDataPermission: '暂无数据权限',
  confirmAll: '删除所选记录',
  edit: '编辑',
  remove: '删除',
  cancel: '取消',
  confirm: '确认删除',
  saved: '保存成功',
  deleted: '已删除',
  retry: '重读关联信息',
  readError: '关联信息读取失败，已保留列表记录；请重读。',
  required: '此项必填',
  dateOrder: '结束时间不能早于开始时间',
  selfTutor: '带教人与被带教人不能是同一人',
  basic: '基本信息',
  rotation: '轮岗信息',
  none: '--',
  invalid: '原单回执无效，请回查原单。',
  deleting: '逐条删除，每条回执独立显示；失败的记录保留。',
  limit: '每次最多删除 50 条',
  loading: '加载中',
  retryList: '重读列表',
  total: (n: number) => `共${n}条`,
};
export const infoPath = (kind: InfoKind) => `/api/tenant/idp/${kind}`;
export const projectInfo = (kind: InfoKind, row?: Values) =>
  projectFields(
    row,
    INFO[kind].fields.map((f) => f.name),
  );
export function infoReceipt(
  raw: unknown,
  revision: number | undefined,
  action: 'save' | 'delete',
  id?: string,
): InfoRow {
  if (revision === undefined || !Number.isSafeInteger(revision)) throw new Error(infoText.invalid);
  const row = raw as InfoRow | null;
  const expected = action === 'delete' ? revision : revision + 1;
  if (!row || typeof row.id !== 'string' || !row.id || (id && row.id !== id) || row.revision !== expected)
    throw new Error(infoText.invalid);
  return row;
}
export const textValue = (value: unknown) => (typeof value === 'string' && value ? value : infoText.none);
