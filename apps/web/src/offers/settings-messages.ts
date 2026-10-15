import { offerSettingExamples } from '../demo-stubs/offers.js';
// 目录顺序按 R2a/10-settings-index；摘要仅显示已读取的当前值，不提供写入口。
export interface SettingSummary {
  id: string;
  title: string;
  group: 'Offer管理' | '入职';
  values?: [string, string][];
  columns?: string[];
  rows?: string[][];
  note?: string;
}
const offer = (id: string, title: string, content: Omit<SettingSummary, 'id' | 'title' | 'group'>): SettingSummary => ({
  id,
  title,
  group: 'Offer管理',
  ...content,
});
const entry = (id: string, title: string, content: Omit<SettingSummary, 'id' | 'title' | 'group'>): SettingSummary => ({
  id,
  title,
  group: '入职',
  ...content,
});
export const authorizationModes = [
  '按应聘职位及管理单元授权',
  '按应聘职位或管理单元授权',
  '按管理人或管理单元授权',
  '仅按应聘职位授权',
  '仅按管理单元授权',
  '仅按管理人授权',
];
export const settings: SettingSummary[] = [
  offer('reasons', 'Offer拒绝/取消入职原因', {
    columns: ['名称', '适用角色', '顺序号', '生效日期', '操作'],
    rows: offerSettingExamples.reasons,
    note: '原站拒绝原因共5项，另有个人原因、其他原因；本页仅显示3条摘要。取消入职原因未验证。',
  }),
  offer('sync', 'Offer同步规则', {
    values: [
      ['应聘者自动生成Offer', '开；Offer环节，未处理（U001）'],
      ['招聘简历信息同步到待入职', '开（原站禁用）'],
      ['Offer自动同步待入职', '开'],
      ['同步时机', '接受Offer时立即同步'],
      ['其他同步时机', '发送Offer时立即同步 / 接受Offer且入职日期前指定天数同步（未选中）'],
      ['在职实习生正式Offer同步待入职', '开'],
      ['接受Offer同步试工管理', '关'],
      ['取消入职联动已拒绝Offer', '开'],
    ],
    note: '无论是否开启，拒绝Offer都会联动取消入职。本片只展示设置，不执行联动。',
  }),
  offer('edit-send', 'Offer编辑和发送', {
    values: [
      ['发送前须审批：校招', '关'],
      ['发送前须审批：社招', '关'],
      ['发送前须审批：实习', '关'],
      ['发送前须审批：HSoffer', '关'],
      ['必审字段', '未配置'],
      ['审批通过后允许编辑', '开'],
      ['审批通过后允许再次发起审批', '开'],
      ['发送时显示前次抄送/密送', '开'],
      ['Offer附件加密', '开'],
      ['候选人电子签完成才视为接受', '关'],
    ],
  }),
  offer('headcount', 'Offer受招聘需求人数管控', {
    values: [['使用招聘需求对Offer管控', '关']],
    note: '剩余Offer数 = 需求人数 - 已到岗人数 - 流程中的Offer数。',
  }),
  offer('templates', 'Offer模板', {
    columns: ['模板名称', '模板适用范围', '模板编码', '最后修改人', '最后修改时间', '操作'],
    rows: offerSettingExamples.templates,
    note: '原站有启用/停用视图和模板名称筛选；启用视图4条。只读摘要展示2条合成样例。',
  }),
  offer('validity', '链接有效期', { values: [['接受/拒绝链接有效期', '15天']] }),
  offer('authorization', 'Offer管理授权模式', {
    values: [['当前授权模式', '仅按管理单元授权']],
    note: authorizationModes.join('；'),
  }),
  offer('matching', 'Offer表单匹配规则', { values: [['按Offer类型匹配表单', '关']] }),
  entry('collection', '入职信息采集规则', {
    values: [
      ['信息采集填写模板', '--'],
      ['信息采集通知模板', '--'],
      ['信息采集自动发送', '--'],
      ['信息采集催办', '开；距离入职日期前7天自动催办'],
      ['信息采集启用审批流', '开'],
      ['信息采集登录', '免登录'],
    ],
    note: '模板与范围含租户自定义内容，未验证的当前值不展示；不提供候选人填写入口。',
  }),
  entry('entry-auth', '入职管理授权模式', {
    values: [['当前授权模式', '入职人员Offer的应聘职位或管理单元']],
    note: '六种模式：应聘职位及管理单元、应聘职位或管理单元、管理人或管理单元、应聘职位、管理人、管理单元。当前选中项以R2a截图为准。',
  }),
  entry('preparations', '入职准备事项', {
    columns: ['事项类别', '序号', '待办类别', '待办事项', '备注', '操作'],
    rows: offerSettingExamples.preparations,
    note: '原站12条，本页仅展示2条合成样例。',
  }),
  entry('reminders', '入职准备发起/催办设置', {
    values: [
      ['自动发起入职准备', '开'],
      ['入职准备发起规则', '生成待入职时自动发起入职准备'],
      ['自动催办入职准备事项', '开；距离入职日期前1天自动催办'],
    ],
  }),
  entry('requirements', '入职必备事项设置', {
    values: [
      ['入职信息采集必须完成', '关'],
      ['入职材料必须提交', '关'],
      ['入职准备事项必须完成', '关'],
    ],
  }),
  entry('welcome', '欢迎信', {
    values: [['启用模板', '--']],
    note: '员工扫码报到后展示启用的入职欢迎信。此处仅提供只读说明，不复制原站图片或个人信息。',
  }),
  entry('qr', '扫码添加待入职方案', {
    columns: ['优先级', '方案名称', '方案说明', '适用组织范围', '状态', '操作'],
    rows: offerSettingExamples.qr,
    note: '原站1条默认方案，优先级99。',
  }),
  entry('handbook', '入职手册/扫码报到配置', {
    note: '原站在独立设计器中配置入职手册与扫码报到页面。本片只读展示此说明，不提供设计器、上传或扫码入口。',
  }),
  entry('email', '生成邮箱规则', {
    values: [
      ['自动生成邮箱', '开'],
      ['生成邮箱阶段', '待入职阶段 / 新增人员阶段'],
      ['待入职阶段生成时机', '入职/入职申请时'],
    ],
    columns: ['优先级', '规则名称', '邮箱组成', '组织范围', '附加人员范围', '操作'],
    rows: offerSettingExamples.email,
    note: '原站3条，本页仅展示2条合成样例。',
  }),
  entry('integration', '新员工融入设置', {
    columns: ['优先级', '方案名称', '方案说明', '状态', '是否到期提醒', '操作'],
    rows: offerSettingExamples.integration,
    note: '原站有融入方案/融入任务池页签；默认启用方案12条，本页仅展示2条合成方案。任务池内容未验证。',
  }),
  entry('materials', '材料设置', {
    columns: ['序号', '材料类型', '材料名称', '准备阶段', '材料说明', '是否允许补交', '上传示例', '操作'],
    rows: offerSettingExamples.materials,
    note: '原站11条，本页仅展示2条合成样例。',
  }),
  entry('rehire', '重聘/返聘规则', {
    values: [
      ['重聘/返聘判定信息', '证件类型+证件号码、手机号码、电子邮件'],
      ['重聘入职方式', '合并人员'],
      ['不允许离职人员证件类型+证件号码重复', '关'],
    ],
  }),
  entry('other', '其他设置', {
    values: [
      ['新员工融入自动发起', '开'],
      ['新员工自我介绍', '开'],
      ['适用部门范围', '--'],
      ['入职流程电子签发起时机', '入职生效（审批通过且到了入职日期）后发起'],
      ['入职准备事项启用免登录', '开'],
      ['入职材料提交催办', '开'],
      ['下半部分', '--'],
    ],
    note: '下半部分设置未验证。',
  }),
];
