/**
 * 人事分析第 2 段 BE-13a 的组件目录（docs/02_业务建模/35“补充：BE-13…”B49、B55，“员工结构两张报表”B53）：
 * 只放不含 IO 的稳定标识与名称；口径在 apps/api 的 analytics/hr-structure*.ts、contract-board.ts 实现。
 * 三个只读授权对象在 permission/module-actions.ts 登记（授权项“人事分析 - <看板名> 查看”）。
 */
export const HR_STRUCTURE_OBJECT = 'TenantBase.HrStructure';
export const HR_STRUCTURE_REPORT_OBJECT = 'TenantBase.HrStructureReport';
export const CONTRACT_BOARD_OBJECT = 'TenantBase.ContractBoard';

/**
 * 组件的数据形态（与图形无关）：value = 计数；average = 平均值 + 样本数；groups = 分组计数；
 * ratio = 分组的命中数 / 分母 / 占比；unavailable = 复刻没有数据源，数值为 null。
 */
export type BoardComponentKind = 'value' | 'average' | 'groups' | 'ratio' | 'unavailable';

/** B49 人员结构分析 6.01～6.14（编号即规格编号）。 */
export const HR_STRUCTURE_COMPONENTS = [
  { code: '6.01', name: '在职人数', kind: 'value' },
  { code: '6.02', name: '平均年龄', kind: 'average' },
  { code: '6.03', name: '平均司龄', kind: 'average' },
  { code: '6.04', name: '机构人数统计', kind: 'groups' },
  { code: '6.05', name: '职级分布', kind: 'groups' },
  { code: '6.06', name: '职务序列', kind: 'groups' },
  { code: '6.07', name: '试用期人员占比', kind: 'groups' },
  { code: '6.08', name: '司龄分布', kind: 'groups' },
  { code: '6.09', name: '工作地点分布', kind: 'unavailable' },
  { code: '6.10', name: '籍贯分布', kind: 'unavailable' },
  { code: '6.11', name: '本科及以上学历占比', kind: 'ratio' },
  { code: '6.12', name: '学历结构', kind: 'groups' },
  { code: '6.13', name: '年龄结构', kind: 'groups' },
  { code: '6.14', name: '性别结构', kind: 'groups' },
] as const satisfies readonly { code: string; name: string; kind: BoardComponentKind }[];
export type HrStructureCode = (typeof HR_STRUCTURE_COMPONENTS)[number]['code'];
/** 6.04“机构人数统计”只展示人数前 20 的机构。 */
export const HR_STRUCTURE_TOP_INSTITUTIONS = 20;

/** B55 合同情况：4 张变动计数卡、3 个签署分布、3.1.17（复用人事看板第 6 项）。原站只有 3.1.17 有编号，其余用语义编码。 */
export const CONTRACT_BOARD_COMPONENTS = [
  { code: 'changeCreate', name: '合同变动统计-初签', kind: 'value' },
  { code: 'changeChange', name: '合同变动统计-变更', kind: 'value' },
  { code: 'changeRenew', name: '合同变动统计-续签', kind: 'value' },
  { code: 'changeTerminate', name: '合同变动统计-终止', kind: 'value' },
  { code: 'signByCompany', name: '合同签署情况-按法人', kind: 'groups' },
  { code: 'signByType', name: '合同签署情况-按合同类型', kind: 'groups' },
  { code: 'signByTermType', name: '合同签署情况-按合同期限类型', kind: 'groups' },
  { code: '3.1.17', name: '未来 30 天合同到期', kind: 'value' },
] as const satisfies readonly { code: string; name: string; kind: BoardComponentKind }[];
export type ContractBoardCode = (typeof CONTRACT_BOARD_COMPONENTS)[number]['code'];
/** “按法人”只展示签署人数前 10 的合同主体公司。 */
export const CONTRACT_BOARD_TOP_COMPANIES = 10;

/** B53 两张报表；雇佣关系默认内部员工（规格“默认筛选：任职记录-雇佣关系 = 内部员工”）。 */
export const HR_STRUCTURE_REPORTS = [
  { code: 'quality', name: '员工素质结构统计' },
  { code: 'position', name: '员工任职结构统计' },
] as const;
export type HrStructureReportCode = (typeof HR_STRUCTURE_REPORTS)[number]['code'];
export const HR_STRUCTURE_REPORT_EMPLOY_TYPES = ['internal', 'intern', 'all'] as const;
