/**
 * 必需项显式表的类型（F-039 PR-A 第 4 轮，DEC-348②）。表逐端点登记**审定过**的义务，校验器拿声明与它硬比对
 * （../required.ts）；证据与摘要的校验见 ../evidence.ts。表只放字面量，不得从声明或探测结果重新生成。
 *
 * 权限键（perm，比对只看它，范围 / 字段等是元数据）：
 *   obj:<对象>:<操作>        对象数据操作；对象 / 操作是动态选择器时写成排序后的取值集合 `{a,b}`，
 *                            映射函数 / 记录定位写 `{mapper:名}` / `{record:定位器.属性}`
 *   btn:<对象>#<按钮>@<层级>  按钮；本人叠加授权的按钮对象写 self
 *   rel:<关系名>   guard:<守卫名>   admin:<能力>   own:<谓词>   self   exception:<守卫名>
 * 用途（purpose，缺省 = 准入）：
 *   disclosure:<键>  只决定响应里的附加披露，必须由同名 optional 分支授予，不得出现在准入里（纯披露时）；
 *   guard:<承载者>   在某个守卫 / 关系判定内部使用（承载者本身是准入义务），不单独要求；
 *   when:<守卫名>    条件准入（如 initialize 才要删除权），由该具名条件守卫承载，不得写成无条件准入。
 * “或”准入：同一 group 的义务按 `组:备选` 标注；同一备选内全部义务 AND，备选之间 OR。
 */

/**
 * 证据角色：强制调用点（抛错 / 拒绝的那一句所在处）、授权实现（辅助函数）、决定实参的常量、
 * 强制范围判定处（`need.scope` 不是 none 的义务必须有，PR-B1；evidence.ts 对角色不做分支）。
 */
export type EvidenceRole = 'call' | 'impl' | 'const' | 'scope';

export interface Evidence {
  readonly role: EvidenceRole;
  /**
   * `仓库相对路径#名字`：名字是函数 / 常量 / 方法名（文件内唯一），或 `route:<方法> <注册路径>` 表示该文件里
   * 这条注册的处理函数。摘要按单元登记在 digests.ts。
   */
  readonly unit: string;
  /** 判定处的原文片段（按词法记号比较，空白与注释不计）。 */
  readonly anchor: string;
}

export type Purpose = `disclosure:${string}` | `guard:${string}` | `when:${string}`;

/**
 * 义务绑定的范围（B-03）：权限必须由范围满足该要求的节点提供。名字（locator / predicate / guard）写了就要相等；
 * 三个名字至多写一个，且与 scope 对应（point → locator，list → predicate，guard → guard）。
 * `none` = 该权限随主对象的范围，不另行过滤。
 */
export interface Need {
  readonly scope: 'point' | 'list' | 'see-all' | 'guard' | 'none';
  readonly locator?: string;
  readonly predicate?: string;
  readonly guard?: string;
}

/**
 * 守卫内部义务的内部角色（第 3 轮审查 P2）：
 *   required  承载者必需，且该权限是其必需项；
 *   or        承载者内部“或”的一支（备选登记在 guard-inner.ts 的 GUARD_INNER_ALTS，含不经授权器的数据态备选）；
 *   when      条件成立时才用到，condition 为条件名。
 */
export type Inner =
  | { readonly role: 'required' }
  | { readonly role: 'or'; readonly group: string; readonly alt: string }
  | { readonly role: 'when'; readonly condition: string };

export interface Obligation {
  readonly perm: string;
  /** 缺省 = 准入。 */
  readonly purpose?: Purpose;
  /** “或”准入：`组:备选`。 */
  readonly or?: string;
  /** 本义务承接的探测器原始事实（`维度:原语名` / `objectOp:编码:操作` / `or:名字`）。 */
  readonly facts?: readonly string[];
  /** 范围绑定（B-03）：含 ≥2 个承载节点的准入备选里的 obj: / admin: 准入义务与全部披露义务必须登记。 */
  readonly need?: Need;
  /** 守卫内部义务（purpose = guard:*）的内部角色，必须登记。 */
  readonly inner?: Inner;
  readonly at: readonly Evidence[];
  /** 审定备注（为什么是这个用途、现状特殊处）。 */
  readonly note?: string;
}

/** 键 = `METHOD 最终路径`。没有权限义务的端点（/healthz、普通成员可读）登记空数组。 */
export type RequiredTable = Readonly<Record<string, readonly Obligation[]>>;

/** 证据单元摘要按文件分组登记（文件 → 单元名 → 摘要），单元键 = `文件#名字`（../evidence.ts）。 */
export type Digests = Readonly<Record<string, Readonly<Record<string, string>>>>;
