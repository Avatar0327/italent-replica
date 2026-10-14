/**
 * 盘点字段目录的领域常量与预置清单（R3-T04 设计 §2.2 fields、§2.7）。字段目录供公式、九宫格、结果规则、映射、权限、
 * 同步目录引用；预置与自定义字段在权限与同步目录里一视同仁。
 */
export const TALENT_REVIEW_FIELD_KINDS = ['number', 'text', 'option', 'multi_option', 'date', 'boolean'] as const;
export type TalentReviewFieldKind = (typeof TALENT_REVIEW_FIELD_KINDS)[number];
/** 字段分组（设计 §2.7）；“校准”分组的字段可作项目的校准原因字段（TR-R38）。 */
export const TALENT_REVIEW_FIELD_GROUPS = ['result', 'position', 'basic', 'evaluation', 'calibration'] as const;
export type TalentReviewFieldGroup = (typeof TALENT_REVIEW_FIELD_GROUPS)[number];
export const TALENT_REVIEW_PAIR_ROLES = ['before', 'after'] as const;
export type TalentReviewPairRole = (typeof TALENT_REVIEW_PAIR_ROLES)[number];
/** number 字段小数位：缺省 2，上限 4（存储 numeric(14,4)，设计 §4.2）。 */
export const FIELD_DEFAULT_PRECISION = 2;
export const FIELD_MAX_PRECISION = 4;

/** 盘点角色解析方式（设计 §3.4）。 */
export const TALENT_REVIEW_ROLE_RESOLVERS = ['direct_manager', 'indirect_manager', 'self', 'designated'] as const;
export type TalentReviewRoleResolver = (typeof TALENT_REVIEW_ROLE_RESOLVERS)[number];

export interface PresetFieldOption {
  readonly value: string;
  readonly label: string;
}
export interface PresetField {
  readonly code: string;
  readonly name: string;
  readonly kind: TalentReviewFieldKind;
  readonly group: TalentReviewFieldGroup;
  readonly systemWritten: boolean;
  readonly pairRole?: TalentReviewPairRole;
  /** 成对字段的另一端编码；安装时按编码互相回填。 */
  readonly pairCode?: string;
  readonly options?: readonly PresetFieldOption[];
}

const LEVELS: readonly PresetFieldOption[] = [
  { value: '3', label: '高' },
  { value: '2', label: '中' },
  { value: '1', label: '低' },
];
const pair = (base: string, name: string, kind: TalentReviewFieldKind, group: TalentReviewFieldGroup, extra = {}) =>
  (['before', 'after'] as const).map((role): PresetField => ({
    code: `${base}_${role}`,
    name: `${name}（校准${role === 'before' ? '前' : '后'}）`,
    kind,
    group,
    systemWritten: false,
    pairRole: role,
    pairCode: `${base}_${role === 'before' ? 'after' : 'before'}`,
    ...extra,
  }));
const single = (
  code: string,
  name: string,
  kind: TalentReviewFieldKind,
  group: TalentReviewFieldGroup,
): PresetField => ({
  code,
  name,
  kind,
  group,
  systemWritten: false,
});

/**
 * 预置最小集合（编码固定，名称可改）。发展方向 / 调动意愿的类型原站未取到（🟡），先按文本；位置字段只能由系统按
 * 九宫格落位写入（设计 §4.7）。
 */
export const TALENT_REVIEW_PRESET_FIELDS: readonly PresetField[] = [
  ...(['achievement:业绩', 'capability:能力', 'appraisal:绩效', 'potential:潜力'] as const).flatMap((item) => {
    const [code, name] = item.split(':') as [string, string];
    return pair(code, name, 'option', 'result', { options: LEVELS });
  }),
  single('appraisal_score', '绩效得分', 'number', 'result'),
  single('capability_score', '能力得分', 'number', 'result'),
  single('potential_score', '潜力得分', 'number', 'result'),
  single('overall_score', '综合得分', 'number', 'result'),
  ...(['achievement_capability_cell:业绩-能力九宫格位置', 'appraisal_potential_cell:绩效-潜力九宫格位置'] as const)
    .flatMap((item) => {
      const [code, name] = item.split(':') as [string, string];
      return pair(code, name, 'number', 'position');
    })
    .map((field) => ({ ...field, systemWritten: true })),
  single('tags', '标签', 'multi_option', 'basic'),
  single('strengths', '优势', 'text', 'evaluation'),
  single('development_areas', '待发展项', 'text', 'evaluation'),
  single('development_advice', '发展建议', 'text', 'evaluation'),
  single('contribution_3y', '近三年贡献', 'text', 'evaluation'),
  single('development_direction', '发展方向', 'text', 'evaluation'),
  single('mobility_willingness', '调动意愿', 'text', 'evaluation'),
  single('calibration_reason', '校准原因', 'text', 'calibration'),
  single('remark', '备注', 'text', 'calibration'),
];
