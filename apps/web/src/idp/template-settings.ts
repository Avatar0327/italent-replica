import { t } from './messages.js';
import type { ApprovalCandidate, SubProcess, TemplateModule } from './types.js';

export interface SettingItem {
  label: string;
  value: string;
}
export interface SettingSection {
  title: string;
  items: SettingItem[];
}
export interface NodeSetting {
  subProcessId?: string;
  nodeKey?: string;
  enabled?: boolean;
  buttons?: string[];
}

const s = t.settings;
function onOff(value: unknown) {
  if (typeof value !== 'boolean') return t.noValue;
  return value ? t.open : t.closed;
}
const label = (labels: Record<string, string>, value: unknown) =>
  typeof value === 'string' ? (labels[value] ?? t.noValue) : t.noValue;
const list = (value: unknown) => (Array.isArray(value) ? value : []);

/** 目标设置（原站 B2_13 / B2_17“目标设置”分区）；只取已知配置项，未知键一律不展示。 */
function goalItems(module: TemplateModule): SettingItem[] {
  return [
    { label: s.allowCustomGoal, value: onOff(module.allowCustomGoal) },
    { label: s.allowLibraryGoal, value: onOff(module.allowLibraryGoal) },
    { label: s.competencySource, value: label(s.competencySources, module.competencySource) },
    { label: s.goalReviewEnabled, value: onOff(module.goalReviewEnabled) },
    { label: s.taskEnabled, value: onOff(module.taskEnabled) },
    { label: s.checkNoneGoal, value: onOff(module.checkNoneGoal) },
  ];
}

/** 区块设置（原站 B2_12）：每个区块一行，“展示字段：字段1；字段2”。 */
function keyInfoItems(module: TemplateModule): SettingItem[] {
  return list(module.keyInfoBlocks).map((entry: { block?: unknown; fields?: unknown }) => ({
    label: label(s.keyInfoBlocks, entry.block),
    value: `${s.shownFields}${
      list(entry.fields)
        .map((field) => label(t.keyInfoFields, field))
        .join('；') || t.noValue
    }`,
  }));
}

function reviewItems(module: TemplateModule): SettingItem[] {
  const categories = list(module.reviewCategoryIds).length;
  return [
    { label: s.reviewTimeBasis, value: label(s.reviewTimeBases, module.reviewTimeBasis) },
    { label: s.planTimeBasis, value: label(s.planTimeBases, module.planTimeBasis) },
    { label: s.reviewCategories, value: s.selected(categories) },
  ];
}

const BUTTON_LABELS: Record<string, string> = {
  RowAddIdpGoal: t.actions.create,
  RowEditIdpGoal: t.actions.edit,
  RowDeleteIdpGoal: t.actions.delete,
  EditModuleContent: t.actions.edit,
};
/** 节点权限（原站“各步骤参与角色及权限设置”）：目标模块按“目标：新增、编辑、删除”，内容模块按“模块内容：编辑”。 */
function nodeValue(module: TemplateModule, setting: NodeSetting) {
  if (setting.enabled === false) return s.nodeDisabled;
  const names = list(setting.buttons)
    .map((button) => BUTTON_LABELS[String(button)])
    .filter((name): name is string => !!name);
  if (!names.length) return s.noButtons;
  return `${module.moduleType === 'goal' ? s.goalButtons : s.contentButtons}${names.join('、')}`;
}

const SPECIFIC: Record<string, { title: string; items: (module: TemplateModule) => SettingItem[] }> = {
  goal: { title: s.goalSection, items: goalItems },
  key_info: { title: s.blockSection, items: keyInfoItems },
  talent_review: { title: s.reviewSection, items: reviewItems },
};

/**
 * 模板模块的只读配置 → 原站中文分区与字段名（B2_12 / B2_13 / B2_16 / B2_17）；不输出 DTO 键名或 JSON 文本。
 * `node` 把节点配置解析成“子流程 / 节点”名称，由调用方按流程与审批目录解析。
 */
export function moduleSettingSections(
  module: TemplateModule,
  node: (setting: NodeSetting) => string,
): SettingSection[] {
  const sections: SettingSection[] = [
    {
      title: s.baseSection,
      items: [
        { label: t.fields.name, value: module.name || t.noValue },
        { label: s.moduleType, value: label(t.moduleTypes, module.moduleType) },
        { label: t.fields.description, value: module.description || t.noValue },
      ],
    },
  ];
  const specific = SPECIFIC[module.moduleType];
  if (specific) sections.push({ title: specific.title, items: specific.items(module) });
  if (Array.isArray(module.nodeSettings)) {
    sections.push({
      title: s.nodeSection,
      items: (module.nodeSettings as NodeSetting[]).map((setting) => ({
        label: node(setting),
        value: nodeValue(module, setting),
      })),
    });
  }
  return sections;
}

/**
 * 节点配置 → 原站节点名：子流程（按 subProcessId）→ 审批流程（按 approvalProcessId）→ 节点（按 nodeKey）。
 * 任何一环读不到（无权或已删除）时显示“子流程名 · 节点名称不可见”，不回显内部键。
 */
export function nodeLabeler(subProcesses: readonly SubProcess[], approvals: readonly ApprovalCandidate[]) {
  return (setting: NodeSetting) => {
    const sub = subProcesses.find((item) => item.id === setting.subProcessId);
    const approval = approvals.find((item) => item.id === sub?.approvalProcessId);
    const node = approval?.nodes.find((item) => item.nodeKey === setting.nodeKey);
    return node?.name ?? `${sub?.name ?? t.noValue} · ${s.unknownNode}`;
  };
}
