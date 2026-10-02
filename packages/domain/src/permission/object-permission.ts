/**
 * 身份对象权限（REQ-PRM-001「身份权限内容结构」；docs/02_业务建模/06 §7.2，G-018）：
 * 身份持有一张对象清单，每个对象有三类子权限——
 * - 字段权限：每个字段「查看」「编辑」，对列表和表单同时生效；系统字段的「编辑」固定不可授（AC-PRM-23）；
 * - 功能权限：粒度是「按钮编码 × 级别」（列表 / 列表行 / 详情页 / 应用页）；
 * - 数据操作权限：新增 / 编辑 / 删除 三个开关。
 * 这里只描述功能权限；数据范围（管理单元）是另一张表、另一套机制（R1-T02，DEC-043）。
 */

export const BUTTON_LEVELS = ['list', 'list_row', 'detail', 'app_page'] as const;
export type ButtonLevel = (typeof BUTTON_LEVELS)[number];

export const DATA_OPERATIONS = ['create', 'update', 'delete'] as const;
export type DataOperation = (typeof DATA_OPERATIONS)[number];

export interface FieldDefinition {
  readonly code: string;
  /** 系统字段（创建人、修改时间、工作流实例 ID 等）：「编辑」不可授。 */
  readonly system: boolean;
}

export interface ButtonDefinition {
  readonly code: string;
  readonly level: ButtonLevel;
  /** 按钮执行的数据操作；有值时还须该数据操作权限开启才可执行（REQ-PRM-001 R6）。 */
  readonly requires?: DataOperation;
}

/** 对象元数据：由各业务模块登记（权限模块只消费，不定义业务对象）。 */
export interface ObjectDefinition {
  readonly code: string;
  /**
   * 对象所属应用（如 TenantBase = 组织员工，见 docs/01_证据/导出/组织员工应用_对象注册表_214.txt）。
   * 身份按“身份 × 应用”授权（REQ-PRM-001）：对象只能配置进、也只在登记了该应用的身份里生效。
   */
  readonly application: string;
  readonly fields: readonly FieldDefinition[];
  readonly buttons: readonly ButtonDefinition[];
}

export type DataOperations = Readonly<Record<DataOperation, boolean>>;

export interface FieldPermission {
  readonly fieldCode: string;
  readonly view: boolean;
  readonly edit: boolean;
}

export interface ButtonGrant {
  readonly buttonCode: string;
  readonly level: ButtonLevel;
}

/** 某身份对某对象的权限配置（对象在身份对象清单中即有这一条）。 */
export interface ObjectPermission {
  readonly objectCode: string;
  readonly dataOperations: DataOperations;
  readonly fields: readonly FieldPermission[];
  readonly buttons: readonly ButtonGrant[];
}

export type ObjectPermissionViolation =
  | { readonly reason: 'UNKNOWN_FIELD'; readonly fieldCode: string }
  | { readonly reason: 'SYSTEM_FIELD_NOT_EDITABLE'; readonly fieldCode: string }
  | { readonly reason: 'DUPLICATE_FIELD'; readonly fieldCode: string }
  | { readonly reason: 'UNKNOWN_BUTTON'; readonly buttonCode: string; readonly level: ButtonLevel }
  | { readonly reason: 'DUPLICATE_BUTTON'; readonly buttonCode: string; readonly level: ButtonLevel };

/** 按对象元数据校验一份身份对象权限配置；返回全部违规项（空数组即合法）。 */
export function validateObjectPermission(
  definition: ObjectDefinition,
  permission: Omit<ObjectPermission, 'objectCode'>,
): ObjectPermissionViolation[] {
  return [...fieldViolations(definition, permission.fields), ...buttonViolations(definition, permission.buttons)];
}

function fieldViolations(definition: ObjectDefinition, fields: readonly FieldPermission[]) {
  const known = new Map(definition.fields.map((f) => [f.code, f]));
  const seen = new Set<string>();
  const violations: ObjectPermissionViolation[] = [];
  for (const { fieldCode, edit } of fields) {
    const field = known.get(fieldCode);
    if (seen.has(fieldCode)) violations.push({ reason: 'DUPLICATE_FIELD', fieldCode });
    else if (!field) violations.push({ reason: 'UNKNOWN_FIELD', fieldCode });
    else if (field.system && edit) violations.push({ reason: 'SYSTEM_FIELD_NOT_EDITABLE', fieldCode });
    seen.add(fieldCode);
  }
  return violations;
}

function buttonViolations(definition: ObjectDefinition, buttons: readonly ButtonGrant[]) {
  const known = new Set(definition.buttons.map((b) => buttonKey(b.code, b.level)));
  const seen = new Set<string>();
  const violations: ObjectPermissionViolation[] = [];
  for (const { buttonCode, level } of buttons) {
    const key = buttonKey(buttonCode, level);
    if (seen.has(key)) violations.push({ reason: 'DUPLICATE_BUTTON', buttonCode, level });
    else if (!known.has(key)) violations.push({ reason: 'UNKNOWN_BUTTON', buttonCode, level });
    seen.add(key);
  }
  return violations;
}

/** 应用边界：对象所属应用必须在身份登记的应用内，身份才能配置、才能凭它获得该对象的权限。 */
export function isWithinProfileApps(definition: ObjectDefinition, profileApps: readonly string[]): boolean {
  return profileApps.includes(definition.application);
}

export function buttonKey(code: string, level: ButtonLevel): string {
  return `${code}@${level}`;
}

/** 对象元数据目录：同一对象编码只能登记一次（重复登记同一定义视为幂等）。 */
export class ObjectCatalog {
  readonly #objects = new Map<string, ObjectDefinition>();

  constructor(definitions: readonly ObjectDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: ObjectDefinition): void {
    const existing = this.#objects.get(definition.code);
    if (existing && JSON.stringify(existing) !== JSON.stringify(definition)) {
      throw new Error(`对象 ${definition.code} 已登记为不同的定义`);
    }
    this.#objects.set(definition.code, definition);
  }

  get(code: string): ObjectDefinition | undefined {
    return this.#objects.get(code);
  }
}
