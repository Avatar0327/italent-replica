/**
 * 标准身份授权项的稳定编码、解析与目录指纹（F-061，docs/08_设计/F-061_标准身份授权补装_方案.md §3.1、§3.4）。
 * 编码只由身份编码与目录编码组成，不随租户改名变化；回补与台账（seed_grant_ledger）都只认编码。
 * 只有身份定义**授予**的项才有编码：readOnly 不授予的按钮、partial 没列的数据操作、360 排除的按钮、系统字段的 edit、
 * 租户扩展字段，都没有编码——永远不补、也不动。
 *
 * | 种类 | 编码 |
 * |---|---|
 * | 身份 × 应用 | `<身份>/app:<应用>` |
 * | 对象（可见） | `<身份>/<对象>/op:view` |
 * | 数据操作 | `<身份>/<对象>/op:<create\|update\|delete>` |
 * | 字段 | `<身份>/<对象>/field:<字段>:<view\|edit>` |
 * | 按钮 | `<身份>/<对象>/button:<按钮>@<层级>` |
 * | 预置看全部 | `<身份>/seeAll:<应用>:<entity\|datasource>:<目标>`（只有用户批准的目标才有编码，见 PR-3） |
 *
 * 台账另用两种标记编码（不是授权项，不进报告的 installed）：`<身份>/@ledger` 该身份已完成首次接管；
 * `<身份>/<对象>/@modified` 租户保存过该身份的该对象（不随审计保留期消失）。
 */
import {
  BUTTON_LEVELS,
  type ButtonLevel,
  type DataOperation,
  type ObjectDefinition,
  type ObjectPermission,
} from '../permission/object-permission.js';
import { sha256Hex } from './sha256.js';
import {
  type PresetSeeAllTarget,
  presetSeeAllTargets,
  STANDARD_PROFILES,
  type StandardProfile,
} from './standard-presets.js';

/** 授权项在补装台账里的登记项编码（module/key，同 DEC-361 SeedEntry）。 */
export const STANDARD_GRANT_ENTRY = 'permission/standard-profile-grants';

/**
 * 当前授权项编码集合的版本与指纹。目录增删授权项（改对象目录或 STANDARD_PROFILES）时 version +1 并更新指纹；
 * 守卫测试算出的指纹不一致即失败——任何改目录的 PR 都会撞到它，审查方一眼看到“这个 PR 会给存量标准身份补授权”。
 * version 只用于回补报告，不参与缺失判断。
 */
export const STANDARD_GRANT_VERSION = 12;
export const STANDARD_GRANT_DIGEST = '2077da982ac181f1';

/**
 * 预置“看全部”补装批准清单（D3 = A′，DEC-374②）：看全部属于数据范围扩大，存量租户的标准身份只对**这里明确列出**的目标补，
 * 租户关过的（范围行在但 see_all = false）不补。以后新增的看全部目标（九宫格、计算规则等）逐次由用户确认后才能加进来，
 * 每行写身份、应用、种类、目标编码与 DEC 号；守卫测试保证：未批准目标不进授权项编码，新租户开通照旧预置全部目标。
 */
export interface SeeAllBackfillApproval extends PresetSeeAllTarget {
  readonly profileCode: string;
  readonly dec: string;
}
export const SEE_ALL_BACKFILL_APPROVED: readonly SeeAllBackfillApproval[] = [
  // DEC-374②：R3-T04 B1（#148）新增的盘点设置类对象，存量盘点管理员缺它们的看全部就维护不了字典
  approve('standard_talent_review_admin', 'TalentReview', 'entity', 'TalentReview.Settings', 'DEC-374②'),
  approve('standard_talent_review_admin', 'TalentReview', 'entity', 'TalentReview.Category', 'DEC-374②'),
  approve('standard_talent_review_admin', 'TalentReview', 'entity', 'TalentReview.Role', 'DEC-374②'),
  approve('standard_talent_review_admin', 'TalentReview', 'entity', 'TalentReview.Field', 'DEC-374②'),
  // DEC-384：用户把 #201 描述里“未批准目标清单”的 32 个目标全部批准（描述里写的“36 行”是把已批准的 4 个也数进去了的总数）；以后新增的看全部目标仍须逐次问用户
  approve('standard_talent_review_admin', 'TalentReview', 'entity', 'TalentReview.Readiness', 'DEC-384'),
  approve('standard_talent_review_admin', 'TalentReview', 'entity', 'TalentReview.Matrix', 'DEC-384'),
  approve('standard_talent_review_admin', 'TalentReview', 'entity', 'TalentReview.CalcRule', 'DEC-384'),
  // DEC-408②：R3-T04 B2（#180 / #219）新增的评价规则、模块等级，盘点管理员预置看全部，否则开箱不能维护这两类配置
  approve('standard_talent_review_admin', 'TalentReview', 'entity', 'TalentReview.ScoreRule', 'DEC-408②'),
  approve('standard_talent_review_admin', 'TalentReview', 'entity', 'TalentReview.ModuleGrade', 'DEC-408②'),
  approve('standard_succession_admin', 'SuccessionAndDevelopment', 'entity', 'Succession.RiskLevel', 'DEC-384'),
  approve('standard_succession_admin', 'SuccessionAndDevelopment', 'entity', 'Succession.HealthLevel', 'DEC-384'),
  approve('standard_succession_admin', 'SuccessionAndDevelopment', 'entity', 'Succession.Population', 'DEC-384'),
  approve('standard_succession_admin', 'SuccessionAndDevelopment', 'entity', 'Succession.RuleSettings', 'DEC-384'),
  approve('standard_talent_admin', 'TalentCenter', 'entity', 'TalentCenter.DescriptionType', 'DEC-384'),
  // 三个标准 HR 身份的 DEC-121 预置：职务字典类实体 + 编制方案数据源（各 8 个）
  ...['standard_org_system_admin', 'standard_hr_admin', 'standard_hr_specialist'].flatMap((profileCode) => [
    ...['JobLayer', 'JobGrade', 'JobLevelType', 'JobLevel', 'JobSequence', 'JobProfessionalLine', 'JobPost'].map(
      (name) => approve(profileCode, 'TenantBase', 'entity', `TenantBase.${name}`, 'DEC-384'),
    ),
    approve(profileCode, 'TenantBase', 'datasource', 'TenantBase.OrganizationEstablishment.scheme', 'DEC-384'),
  ]),
];

function approve(
  profileCode: string,
  appCode: string,
  targetKind: 'entity' | 'datasource',
  targetCode: string,
  dec: string,
): SeeAllBackfillApproval {
  return { profileCode, appCode, targetKind, targetCode, dec };
}

const isApproved = (profileCode: string, target: PresetSeeAllTarget) =>
  SEE_ALL_BACKFILL_APPROVED.some(
    (a) =>
      a.profileCode === profileCode &&
      a.appCode === target.appCode &&
      a.targetKind === target.targetKind &&
      a.targetCode === target.targetCode,
  );

/** 身份定义里预置了看全部、但还没有用户批准补装的目标（报审查合并窗口转总编排问用户）。 */
export function unapprovedSeeAllTargets(
  profiles: readonly StandardProfile[] = STANDARD_PROFILES,
): readonly (PresetSeeAllTarget & { readonly profileCode: string })[] {
  return profiles.flatMap((profile) =>
    presetSeeAllTargets(profile)
      .filter((target) => !isApproved(profile.code, target))
      .map((target) => ({ ...target, profileCode: profile.code })),
  );
}

export type GrantRef =
  | { readonly kind: 'app'; readonly code: string; readonly profileCode: string; readonly appCode: string }
  | { readonly kind: 'object'; readonly code: string; readonly profileCode: string; readonly objectCode: string }
  | {
      readonly kind: 'op';
      readonly code: string;
      readonly profileCode: string;
      readonly objectCode: string;
      readonly op: DataOperation;
    }
  | {
      readonly kind: 'field';
      readonly code: string;
      readonly profileCode: string;
      readonly objectCode: string;
      readonly fieldCode: string;
      readonly mode: 'view' | 'edit';
    }
  | {
      readonly kind: 'button';
      readonly code: string;
      readonly profileCode: string;
      readonly objectCode: string;
      readonly buttonCode: string;
      readonly level: ButtonLevel;
    }
  | {
      readonly kind: 'seeAll';
      readonly code: string;
      readonly profileCode: string;
      readonly appCode: string;
      readonly targetKind: 'entity' | 'datasource';
      readonly targetCode: string;
    }
  | { readonly kind: 'ledger'; readonly code: string; readonly profileCode: string }
  | { readonly kind: 'modified'; readonly code: string; readonly profileCode: string; readonly objectCode: string };

/** 授权项（不含标记编码）。 */
export type GrantItem = Exclude<GrantRef, { readonly kind: 'ledger' | 'modified' }>;

export const appGrantCode = (profileCode: string, appCode: string) => `${profileCode}/app:${appCode}`;
export const objectGrantCode = (profileCode: string, objectCode: string) => `${profileCode}/${objectCode}/op:view`;
export const opGrantCode = (profileCode: string, objectCode: string, op: DataOperation) =>
  `${profileCode}/${objectCode}/op:${op}`;
export const fieldGrantCode = (profileCode: string, objectCode: string, fieldCode: string, mode: 'view' | 'edit') =>
  `${profileCode}/${objectCode}/field:${fieldCode}:${mode}`;
export const buttonGrantCode = (profileCode: string, objectCode: string, buttonCode: string, level: ButtonLevel) =>
  `${profileCode}/${objectCode}/button:${buttonCode}@${level}`;
export const seeAllGrantCode = (
  profileCode: string,
  appCode: string,
  targetKind: 'entity' | 'datasource',
  targetCode: string,
) => `${profileCode}/seeAll:${appCode}:${targetKind}:${targetCode}`;
/** 该身份已完成首次接管（台账标记）。 */
export const profileLedgerMarker = (profileCode: string) => `${profileCode}/@ledger`;
/** 租户保存过该身份的该对象（台账标记）。 */
export const objectModifiedMarker = (profileCode: string, objectCode: string) =>
  `${profileCode}/${objectCode}/@modified`;

const DATA_OPERATION_VALUES: readonly string[] = ['create', 'update', 'delete'];
const isButtonLevel = (value: string): value is ButtonLevel => (BUTTON_LEVELS as readonly string[]).includes(value);

/** 解析授权项 / 标记编码；认不出的编码返回 null（不猜测）。编码里的各段不得含 `/`（守卫测试保证目录没有）。 */
export function parseGrantCode(code: string): GrantRef | null {
  const parts = code.split('/');
  const [profileCode, second, third] = parts;
  if (!profileCode || !second) return null;
  if (parts.length === 2) return parseProfileLevel(code, profileCode, second);
  if (parts.length !== 3 || !third) return null;
  return parseObjectLevel(code, profileCode, second, third);
}

function parseProfileLevel(code: string, profileCode: string, segment: string): GrantRef | null {
  if (segment === '@ledger') return { kind: 'ledger', code, profileCode };
  if (segment.startsWith('app:')) {
    const appCode = segment.slice('app:'.length);
    return appCode ? { kind: 'app', code, profileCode, appCode } : null;
  }
  if (segment.startsWith('seeAll:')) {
    const [appCode, targetKind, targetCode, ...rest] = segment.slice('seeAll:'.length).split(':');
    if (!appCode || !targetCode || rest.length > 0) return null;
    if (targetKind !== 'entity' && targetKind !== 'datasource') return null;
    return { kind: 'seeAll', code, profileCode, appCode, targetKind, targetCode };
  }
  return null;
}

function parseObjectLevel(code: string, profileCode: string, objectCode: string, segment: string): GrantRef | null {
  if (segment === '@modified') return { kind: 'modified', code, profileCode, objectCode };
  if (segment === 'op:view') return { kind: 'object', code, profileCode, objectCode };
  if (segment.startsWith('op:')) {
    const op = segment.slice('op:'.length);
    return DATA_OPERATION_VALUES.includes(op)
      ? { kind: 'op', code, profileCode, objectCode, op: op as DataOperation }
      : null;
  }
  if (segment.startsWith('field:')) {
    const rest = segment.slice('field:'.length);
    const split = rest.lastIndexOf(':');
    const fieldCode = rest.slice(0, split);
    const mode = rest.slice(split + 1);
    if (split < 1 || (mode !== 'view' && mode !== 'edit')) return null;
    return { kind: 'field', code, profileCode, objectCode, fieldCode, mode };
  }
  if (segment.startsWith('button:')) {
    const rest = segment.slice('button:'.length);
    const split = rest.lastIndexOf('@');
    const buttonCode = rest.slice(0, split);
    const level = rest.slice(split + 1);
    if (split < 1 || !isButtonLevel(level)) return null;
    return { kind: 'button', code, profileCode, objectCode, buttonCode, level };
  }
  return null;
}

/**
 * 依赖关系：应用 → 该应用下对象可见 → 同对象的数据操作 / 字段查看 / 按钮；字段查看 → 字段编辑；看全部 → 其应用。
 * 租户撤销了父项，子项在回补时“不可装”（不会补出没有父项的孤儿授权）。应用与标记编码没有父项。
 * 对象所属应用来自对象目录（编码里没有），由调用方用 appOf 给出；不给则对象可见项视为没有父项。
 */
export function grantParentCode(
  code: string,
  appOf: (objectCode: string) => string | undefined = () => undefined,
): string | null {
  const ref = parseGrantCode(code);
  if (!ref) return null;
  switch (ref.kind) {
    case 'object': {
      const appCode = appOf(ref.objectCode);
      return appCode ? appGrantCode(ref.profileCode, appCode) : null;
    }
    case 'op':
    case 'button':
      return objectGrantCode(ref.profileCode, ref.objectCode);
    case 'field':
      return ref.mode === 'edit'
        ? fieldGrantCode(ref.profileCode, ref.objectCode, ref.fieldCode, 'view')
        : objectGrantCode(ref.profileCode, ref.objectCode);
    case 'seeAll':
      return appGrantCode(ref.profileCode, ref.appCode);
    case 'app':
    case 'ledger':
    case 'modified':
      return null;
  }
}

/** 一份对象权限授予的授权项：对象可见、为 true 的数据操作、字段查看 / 编辑、按钮。保存登记与身份定义共用这一处编码。 */
export function objectGrantItems(profileCode: string, object: ObjectPermission): readonly GrantItem[] {
  const objectCode = object.objectCode;
  const items: GrantItem[] = [
    { kind: 'object', code: objectGrantCode(profileCode, objectCode), profileCode, objectCode },
  ];
  for (const op of ['create', 'update', 'delete'] as const)
    if (object.dataOperations[op])
      items.push({ kind: 'op', code: opGrantCode(profileCode, objectCode, op), profileCode, objectCode, op });
  for (const field of object.fields) {
    const { fieldCode } = field;
    const base = { kind: 'field', profileCode, objectCode, fieldCode } as const;
    if (field.view)
      items.push({ ...base, code: fieldGrantCode(profileCode, objectCode, fieldCode, 'view'), mode: 'view' });
    if (field.edit)
      items.push({ ...base, code: fieldGrantCode(profileCode, objectCode, fieldCode, 'edit'), mode: 'edit' });
  }
  for (const { buttonCode, level } of object.buttons)
    items.push({
      kind: 'button',
      code: buttonGrantCode(profileCode, objectCode, buttonCode, level),
      profileCode,
      objectCode,
      buttonCode,
      level,
    });
  return items;
}

/** 身份定义授予的全部授权项（按身份、对象、数据操作、字段、按钮的顺序）。profiles 参数供“旧版本升级”夹具注入旧定义。 */
export function standardGrantItems(profiles: readonly StandardProfile[] = STANDARD_PROFILES): readonly GrantItem[] {
  return profiles.flatMap((profile) => [
    ...profile.apps.map((appCode): GrantItem => ({
      kind: 'app',
      code: appGrantCode(profile.code, appCode),
      profileCode: profile.code,
      appCode,
    })),
    ...profile.objects.flatMap((object) => objectGrantItems(profile.code, object)),
    ...presetSeeAllTargets(profile)
      .filter((target) => isApproved(profile.code, target))
      .map((target): GrantItem => ({
        kind: 'seeAll',
        code: seeAllGrantCode(profile.code, target.appCode, target.targetKind, target.targetCode),
        profileCode: profile.code,
        ...target,
      })),
  ]);
}

export const STANDARD_GRANT_CODES: readonly string[] = standardGrantItems().map((item) => item.code);

/** 编码集合的指纹：与顺序无关，SHA-256 前 16 位十六进制。 */
export function grantCodesDigest(codes: readonly string[]): string {
  return sha256Hex([...codes].sort().join('\n')).slice(0, 16);
}

/**
 * 对象目录指纹（D2 = A，方案 §3.1）：输入是**解析后的对象定义**（含租户扩展字段，与保存时校验所用定义同源）。
 * 规范化：对象编码与应用；字段按编码排序（编码 + 是否系统字段）；按钮按 编码@层级 排序（编码 + 层级 + 依赖的数据操作）；
 * 不含名称等展示文案。固定键序序列化后取 SHA-256 前 16 位。租户增删扩展字段、发版改目录都会让指纹变化。
 */
export function objectCatalogDigest(definition: ObjectDefinition): string {
  const byKey = <T>(items: readonly T[], key: (item: T) => string) =>
    [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const canonical = JSON.stringify([
    definition.code,
    definition.application,
    byKey(definition.fields, (f) => f.code).map((f) => [f.code, f.system]),
    byKey(definition.buttons, (b) => `${b.code}@${b.level}`).map((b) => [b.code, b.level, b.requires ?? null]),
  ]);
  return sha256Hex(canonical).slice(0, 16);
}
