/**
 * DEC-118 / DEC-122：调动审批详情页 TransferDetailView（`14` §11.2，原站视图 TransferMultiFormView）逐字段映射，
 * 分批交付。现有业务模型已有数据的标准字段在本期交付：任职调整区块映射到任职记录字段（审批表单值、字段权限、
 * 节点表单共用同一字段编码），性别、年龄取员工档案（只读带出），调动人员映射到实例抬头；业务模型里还没有的
 * 字段与区块逐项登记延期，不算已完成。
 * 继续遵守 DEC-057：节点只给其表单上的字段，预置表单取本表“已交付且在表单上”的字段（presets.ts）。
 */

export interface TransferViewItem {
  readonly label: string;
  /** 原站字段编码（`14` §11.2）；规格未给出或区块没有单一编码时为空。 */
  readonly code: string | null;
  readonly status: 'delivered' | 'deferred';
  /** 已交付：form = 审批表单字段（任职记录字段编码）；header = 实例抬头（详情 subjectEmployeeId）。 */
  readonly place?: 'form' | 'header';
  readonly field?: string;
  /** 延期：接入该字段的后续任务（路线图任务号）与原因。 */
  readonly deferredTo?: string;
  readonly reason?: string;
}

const form = (label: string, code: string | null, field: string): TransferViewItem => ({
  label,
  code,
  status: 'delivered',
  place: 'form',
  field,
});

const later = (label: string, code: string | null, deferredTo: string, reason: string): TransferViewItem => ({
  label,
  code,
  status: 'deferred',
  deferredTo,
  reason,
});

const NO_FIELD = '任职记录尚无该字段';
const NO_MODEL = '尚无业务模型';

export const TRANSFER_DETAIL_VIEW: readonly TransferViewItem[] = [
  // 调动信息
  { label: '调动人员', code: 'UserID', status: 'delivered', place: 'header', field: 'subjectEmployeeId' },
  form('调动日期', 'StartDate', 'effectiveDate'),
  later('异动类型', 'TransitionTypeOID', 'R1-T09', `${NO_FIELD}（调动类型字典随调动业务接入）`),
  later('调动原因', 'ChangeReason', 'R1-T09', `${NO_FIELD}（变动原因字典随调动业务接入）`),
  later('交接人', 'HandoverPerson', 'R1-T10', `${NO_MODEL}（调动交接）`),
  form('工号', null, 'jobNumber'),
  // DEC-122：员工档案已有性别与出生日期，本期交付（只读带出，按员工信息对象的字段查看权裁剪）。
  form('性别', null, 'gender'),
  form('年龄', null, 'age'),
  later('是否调整薪资', 'AdjustSalary', 'R1-T10', `${NO_MODEL}（薪资只记标志，DEC-002）`),
  later('是否变更合同', 'IsChangeContract', 'R1-T10', `${NO_MODEL}（合同变更联动）`),
  later('是否同步履历', 'TransferSyncToJobHistory', 'R1-T10', `${NO_MODEL}（工作履历联动）`),
  later('是否带编制调动', 'IsTranferWithEstablish', 'R1-T09', NO_FIELD),
  later('试岗方式', 'OnTrialMode', 'R1-T10', `${NO_MODEL}（试岗）`),
  later('试岗开始日期', null, 'R1-T10', `${NO_MODEL}（试岗）`),
  later('预计试岗结束日期', null, 'R1-T10', `${NO_MODEL}（试岗）`),
  later('试岗期限（月）', null, 'R1-T10', `${NO_MODEL}（试岗）`),
  later('是否调整目标', 'IsAdjustTarget', 'R1-T10', `${NO_MODEL}（目标调整未列入任务书范围，派发时确认）`),
  // 任职调整
  form('新部门', 'OIdDepartment', 'departmentId'),
  form('新职务', 'OIdJobPost', 'postId'),
  form('新职级', 'OIdJobLevel', 'levelId'),
  form('新职等', 'OidJobGrade', 'gradeId'),
  form('新职务序列', 'OIdJobSequence', 'sequenceId'),
  form('新职位', 'OIdJobPosition', 'positionId'),
  form('新直线经理', 'POIdEmpAdmin', 'directManagerId'),
  form('用工形式', 'EmploymentForm', 'employmentForm'),
  form('人员类别', 'EmploymentType', 'employmentType'),
  form('调动后是否部门负责人', 'IsCharge', 'isDepartmentHead'),
  later('新增下属', 'AddSubordinate', 'R1-T10', `${NO_MODEL}（新增下属联动）`),
  // 其余区块
  later('兼职调整', 'ParttimeJobInfo', 'R1-T10', `${NO_MODEL}（兼职调整联动）`),
  later('薪资调整', null, 'R1-T10', `${NO_MODEL}（薪资只记标志，DEC-002）`),
  later('合同变更', null, 'R1-T10', `${NO_MODEL}（合同变更联动）`),
  later('职责转交', null, 'R1-T10', `${NO_MODEL}（职责转交，原站隐藏）`),
  later('目标调整', null, 'R1-T10', `${NO_MODEL}（目标调整未列入任务书范围，派发时确认）`),
];

/** 预置调动流程的节点表单：已交付且在审批表单上的字段（顺序同原站视图）。 */
export const TRANSFER_FORM_FIELDS: readonly string[] = TRANSFER_DETAIL_VIEW.flatMap((item) =>
  item.status === 'delivered' && item.place === 'form' && item.field ? [item.field] : [],
);
