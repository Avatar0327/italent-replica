import { Button, Checkbox, Space, Tooltip } from 'antd';
import type { ReactNode } from 'react';
import type { usePermissions } from '../foundation/Permissions.js';
import { m, textValue } from './messages.js';
import type { Row } from './model.js';

export const evUi = {
  records: '评定记录',
  editActivity: '编辑活动',
  forms: '评价表',
  groups: '评审组',
  back: '返回',
  new: '新建',
  unavailable: '未完成（缺后端契约）',
  unverified: '未验证，暂不提供此操作',
  clear: '清空已选',
  enabled: '启用',
  disabled: '停用',
  allPeople: '全部人员',
  basic: '基本信息',
  formEdit: '编辑评价表',
  formCreate: '新建评价表',
  staffArea: '员工信息区',
  scoringArea: '评价区',
  resultArea: '评价结果区',
  formName: '评价表名称',
  scoreMode: '打分规则',
  fullScore: '满分',
  passScore: '通过分数',
  totalRule: '评委总分计算方式',
  votePassRatio: '投票通过比例',
  indicatorReference: '指标参考评分',
  items: '评分项',
  standard: '任职资格标准',
  general: '通用评分项',
  hiddenTargets: '不显示的指标',
  weight: '权重',
  preview: '预览',
  confirm: '确定',
  mode: '评价模式',
  standardMode: '标准模式',
  by_indicator: '按指标评分',
  by_total: '评总分',
  by_vote: '投票',
  average: '平均分',
  weighted: '加权平均',
  sum: '加总',
  conditionHint: '不设置参评条件时，申报不受参评条件限制。',
  commonHint: '适用于本活动的参评人员',
  extraHint: '指定类别、级别的附加参评条件',
  stageUnavailable: '阶段筛选和各阶段人数暂不可用，当前接口仅支持按活动读取评定数据。',
  missingDisplay: '部分展示配置暂不可用；尚未接入的数据不作为默认值或保存内容。',
  savePublish: '保存并发布',
  dates: '起止日期',
  configure: '配置表单',
  notification: '活动通知模板',
  yes: '是',
  no: '否',
  allowException: '是否允许破格提名',
  exceptionRoles: '破格提名角色',
  noticeRoles: '通知角色及通知模板',
  resultHint: '从上一环节转入后，需手动发布结果',
  staffFields: ['基本信息', '全景档案页面', '显示名称'],
  scoringFields: ['评价区标题信息', '是否显示级别描述', '评价模式', '配置列信息', '评价标准'],
  resultFields: ['配置评价结果'],
} as const;
export type ColumnSpec = readonly [string, string, number];
export const staffColumns: Record<string, ColumnSpec[]> = {
  process: [
    ['employeeId', '人员', 122],
    ['', '部门', 132],
    ['originalCategoryId', '原类别', 132],
    ['applyCategoryId', '申请类别', 132],
    ['originalLevelId', '原级别', 132],
    ['applyLevelId', '申请级别', 132],
    ['currentStage', '状态', 132],
    ['finalResult', '最终结果', 132],
    ['experience', '累计工龄（年）', 132],
  ],
  apply: [
    ['employeeId', '人员', 122],
    ['', '部门', 132],
    ['appliedAt', '申报日期', 97],
    ['originalCategoryId', '原类别', 132],
    ['applyCategoryId', '申请类别', 132],
    ['originalLevelId', '原级别', 132],
    ['applyLevelId', '申请级别', 132],
    ['applyStatus', '状态', 132],
    ['', '操作', 140],
  ],
  records: [
    ['employeeId', '人员', 130],
    ['', '部门', 172],
    ['', '入职日期', 110],
    ['applyCategoryId', '申请类别', 172],
    ['applyLevelId', '申请级别', 172],
    ['effectiveDate', '生效日期', 110],
    ['currentStage', '状态', 172],
    ['', '操作', 164],
  ],
};
export const settingColumns: Record<string, ColumnSpec[]> = {
  forms: [
    ['name', '名称', 268],
    ['ownerOrgId', '所属组织', 268],
    ['enabled', '状态', 268],
    ['createdBy', '创建人', 226],
  ],
  groups: [
    ['name', '名称', 178],
    ['ownerOrgId', '所属组织', 178],
    ['members', '人数', 179],
    ['members', '组长', 137],
    ['members', '成员', 179],
    ['enabled', '状态', 179],
  ],
};
export function Unavailable({ label, reason = evUi.unverified }: { label: string; reason?: string }) {
  return (
    <Tooltip title={reason}>
      <Button disabled aria-label={label}>
        {label}
      </Button>
    </Tooltip>
  );
}
export function FilterLabels({
  fields,
  permission,
  children,
}: {
  fields: readonly (readonly [string, string])[];
  permission: ReturnType<typeof usePermissions>;
  children?: ReactNode;
}) {
  return (
    <Space wrap>
      {fields
        .filter(([key]) => !key || permission.field(key).visible)
        .map(([key, label]) => (
          <Unavailable key={`${key}/${label}`} label={label} reason={evUi.unverified} />
        ))}
      {children}
    </Space>
  );
}
const statuses: Record<string, Record<string, string>> = {
  apply: { draft: '待申报', reviewing: '申报审核中', passed: '申报通过', failed: '申报未通过' },
  material: { pending: '材料待提交', reviewing: '材料审核中', passed: '材料通过', failed: '材料未通过' },
  defense: { unscheduled: '待评审', scheduled: '待评审', reviewed: '评审完成', calibrated: '校准完成' },
  result: { pending: '结果待发布', published: '结果已发布' },
};
export function evaluationValue(key: string, value: unknown, row: Row): ReactNode {
  if (key === 'currentStage') {
    const stage = String(value);
    const status = row[`${stage}Status`];
    return statuses[stage]?.[String(status)] ?? (stage in m ? m[stage as 'apply'] : m.noValue);
  }
  if (key === 'enabled') return value === true ? evUi.enabled : value === false ? evUi.disabled : m.noValue;
  if (key === 'applyStatus') return statuses.apply?.[String(value)] ?? m.noValue;
  if (key === 'finalResult') return value === 'passed' ? '通过' : value === 'failed' ? '未通过' : m.noValue;
  return textValue(value);
}
export function columnsFor(specs: ColumnSpec[], permission: ReturnType<typeof usePermissions>) {
  return specs
    .filter(([key]) => !key || permission.field(key).visible)
    .map(([key, title, width], index) => ({
      key: `${key}/${index}`,
      title,
      width,
      dataIndex: key,
      ellipsis: true,
      render: (value: unknown, row: Row) => {
        const stageField = `${String(row.currentStage)}Status`;
        const visibleRow = permission.field(stageField).visible ? row : { ...row, [stageField]: undefined };
        return key ? evaluationValue(key, value, visibleRow) : m.noValue;
      },
    }));
}

export const selectionColumn = {
  key: 'selection',
  width: 38,
  title: <Checkbox disabled />,
  render: () => <Checkbox disabled />,
};
export const settingsColumn = { key: 'settings', width: 26, title: <span aria-label="列设置">⚙</span> };
export function MissingFields({ labels }: { labels: readonly string[] }) {
  return (
    <div className="r3b-form-grid">
      {labels.map((label) => (
        <label key={label}>
          {label}
          <Unavailable label={evUi.unavailable} reason={evUi.unavailable} />
        </label>
      ))}
    </div>
  );
}
