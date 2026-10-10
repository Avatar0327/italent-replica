/**
 * 路由权限声明的类型（F-039 PR-A，docs/08_设计/F-039_权限框架强制_设计.md §2.1）。
 *
 * PR-A 的声明是对**现状契约**的登记（DEC-297④ / DEC-300 / DEC-303）：每个字段描述现有处理函数已经做的判定、
 * 响应与形状；框架不据此拦截或改写请求，只做注册身份核对与自检（§3.1）。注释里“框架评估 / 框架调用”的描述
 * 是接管阶段（§10）的目标语义，在 PR-A 由反向测试按现状核对其真实性。
 */
import type { AdminCapability } from '@italent/domain';
import type { ErrorCode } from '../errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ButtonLevel = 'list' | 'detail';
export type ObjectCode = string;
/** 具名登记项的名称：定位器 / 守卫 / 谓词 / 关系 / 映射函数 / 形状 / 投影器 / 命令内前提。实现随接管 PR。 */
export type GuardName = string;
export type LocatorName = string;
export type PredicateName = string;
export type RelationName = string;
export type MapperName = string;
export type ShapeName = string;
export type ProjectorName = string;
export type PreconditionName = string;
/** 接管 T1：模块登记的授权输入解析器名（`implement` 的 inputs 键）。 */
export type InputName = string;

/** 选择器：静态值，或由请求某处决定；动态选择器都登记有限分支清单（map 的键或 domain）。 */
export type Selector<T> =
  | T
  | { readonly from: 'param' | 'body' | 'query'; readonly path: string; readonly map: Readonly<Record<string, T>> }
  | { readonly from: 'mapper'; readonly mapper: MapperName; readonly domain: readonly string[] }
  | {
      readonly from: 'record';
      readonly locator: LocatorName;
      readonly attribute: string;
      readonly domain: readonly string[];
    };

export type ObjectSelector = Selector<ObjectCode>;
/** 'button' = 只校验按钮，不附加数据操作开关（审批管理员动作、流程仿真等现状）。 */
export type OperationSelector = Selector<'view' | 'create' | 'update' | 'delete' | 'button'>;
export interface ButtonRef {
  readonly code: string;
  readonly level: ButtonLevel;
}
export type ButtonPolicy = Selector<ButtonRef> | { readonly none: true; readonly reason: string };

/** 拒绝码：范围外 / 关系不成立 / 标识非法都声明 status 与 error.code（DEC-291 Q1），含 details.reason。 */
export interface Denial {
  readonly status: 400 | 403 | 404 | 409;
  readonly code: ErrorCode;
  readonly reason?: string;
}

export type Target =
  | { readonly param: string }
  | { readonly body: string }
  | { readonly query: string }
  | { readonly record: LocatorName; readonly attribute: string }
  | { readonly derived: GuardName };

/**
 * 接管 T1 的点校验事务方式（docs/08_设计/F-039_接管T1_设计.md §2.4）：`own` = 登记实现自己开事务或不需要事务（缺省）；
 * `shared` = 与处理函数共用一个事务，由处理函数调用 `access.inScopedTx` 触发，未调用即 500（DEC-363④）。
 */
export type ScopeTx = 'own' | 'shared';

export type ScopePolicy =
  | { readonly mode: 'list'; readonly predicate: PredicateName; readonly view?: string }
  | {
      readonly mode: 'point';
      readonly target: Target;
      readonly locator: LocatorName;
      readonly denied: Denial;
      readonly view?: string;
      readonly tx?: ScopeTx;
    }
  | {
      readonly mode: 'see-all';
      readonly view?: string;
      readonly creatorLocator?: LocatorName;
      readonly denied: Denial | { readonly status: 200; readonly empty: true };
      readonly tx?: ScopeTx;
    }
  | { readonly mode: 'guard'; readonly guard: GuardName; readonly denied: Denial; readonly tx?: ScopeTx }
  | { readonly mode: 'none'; readonly reason: string };

export type FieldsFrom =
  | 'body'
  | 'body.fields+customFields'
  /** 只取本次输入 body.fields，不含继承字段（第 3 轮 P2-1 ②）。 */
  | 'contracts.fields+customFields'
  | 'body+subdivisions'
  | { readonly rows: string }
  | { readonly guard: GuardName }
  | { readonly none: true; readonly reason: string };

/**
 * 命令台账策略：single = 整个请求一条命令（默认）；perItem = 逐项 runCommand；
 * none = 认证专用例外（DEC-377③，F-076 登录 / 登出）：台账会留存凭据相关请求，故不走命令台账，
 * 必须写 `ledgerReason`（替代方案与结果未知时的恢复语义见设计文档），其他取值不得带理由。
 */
export type LedgerPolicy =
  | { readonly ledger?: 'single' | 'perItem'; readonly ledgerReason?: undefined }
  | { readonly ledger: 'none'; readonly ledgerReason: string };

export type WritePolicy = WritePolicyBase & LedgerPolicy;

export interface WritePolicyBase {
  readonly fields: FieldsFrom;
  readonly controls?: readonly string[];
  readonly commandOnly?: boolean;
  /** 提交前足迹守卫（接管阶段 §10.3）：PR-A 登记现状事务内复核函数名，或 { none, reason }。 */
  readonly footprint: GuardName | { readonly none: true; readonly reason: string };
  /** 返回后守卫（接管阶段 §10.3）：PR-A 登记现状返回后复核函数名、generic 定位或 { none, reason }。 */
  readonly result:
    | GuardName
    | { readonly generic: { readonly targets: string; readonly locator: LocatorName } }
    | { readonly none: true; readonly reason: string };
  /** 命令内动作前业务前提的名称登记（留在命令内执行，框架不调用）。 */
  readonly preconditions?: readonly PreconditionName[];
}

export interface RowsPolicy {
  readonly path: string;
  readonly operation?: OperationSelector;
  readonly button?: ButtonPolicy;
  readonly relation?: Selector<RelationName>;
  readonly fields: FieldsFrom;
  readonly target?: Target;
  readonly batch: 'atomic' | 'receipt';
}

export type FieldsPolicy =
  | { readonly mode: 'shape'; readonly shape: ShapeName }
  | {
      readonly mode: 'projector';
      readonly projector: ProjectorName;
      readonly shape: ShapeName;
      readonly format?: 'text/csv';
    }
  | { readonly mode: 'fixed'; readonly keys: readonly string[]; readonly dec: string; readonly intersect?: ObjectCode }
  | { readonly mode: 'all'; readonly dec: string }
  | { readonly mode: 'none'; readonly reason: string };

export interface FailureAuditPolicy {
  readonly kind: 'import';
  readonly rows: 'rows' | 'items';
  readonly objectType: Selector<string>;
  readonly anchors: MapperName;
  readonly resolveAnchors?: GuardName;
  readonly scopeEmployee?: Target;
}

/**
 * 接管 T1 的授权输入（设计 §2.1 S1 / S3）：只对已接管模块生效。
 * `revision` = 写请求的 If-Match（现状 revision(c)，在任何判定之前求值）；
 * `parse` = 按现状代码顺序解析的授权输入：`key` 是 access.input 的键（写字段取 `body`），`using` 是模块登记的解析器。
 */
export interface InputPolicy {
  readonly revision?: true;
  readonly parse?: readonly { readonly key: string; readonly using: InputName }[];
}

/** 所有 policy 共用的基础字段。 */
export interface PolicyBase {
  /** 接管 T1 的授权输入；未接管模块不读。 */
  readonly input?: InputPolicy;
  /** 路径 / 查询标识非法时的现状码（org 400、permission idParam 404、job/context.uuidParam 400 …）。 */
  readonly invalidId?: Denial;
  /** 附加具名守卫（grants 的 other_settings 附加能力、person-links 固定拒绝、经理身份 …）。 */
  readonly guards?: readonly GuardName[];
  /** 写路由必填。 */
  readonly write?: WritePolicy;
  /** 可选分支：不参与准入，只决定处理函数内的分支行为（交接的实例改派与披露）。 */
  readonly optional?: Readonly<Record<string, RoutePolicy>>;
  /** 现状缺陷登记：声明按应有契约写，差异显式带 issue（§4.2）。 */
  readonly knownGap?: { readonly scenario: string; readonly issue: string };
}

export interface ObjectPolicy extends PolicyBase {
  readonly kind: 'object';
  readonly object: ObjectSelector;
  readonly operation: OperationSelector;
  readonly button: ButtonPolicy;
  readonly scope: ScopePolicy | { readonly byObject: Readonly<Record<ObjectCode | '*', ScopePolicy>> };
  readonly fields: FieldsPolicy;
  readonly rows?: RowsPolicy;
  readonly failureAudit?: FailureAuditPolicy;
}

export type RoutePolicy =
  /** 不要求成员身份；令牌 / 业务资格由 guards 强制（DEC-291 Q2）。 */
  | (PolicyBase & { readonly kind: 'public'; readonly reason: string; readonly dec: string })
  /** 平台运营身份；write 为平台命令（Idempotency-Key + If-Match，platform.ledger）。 */
  | (PolicyBase & { readonly kind: 'platform'; readonly fields: FieldsPolicy })
  /** 任一有效租户成员。 */
  | (PolicyBase & { readonly kind: 'member'; readonly reason: string; readonly fields: FieldsPolicy })
  /** 管理员能力（或现有 tenant.* 动作别名）；scope 供审计等能力级列表。 */
  | (PolicyBase & {
      readonly kind: 'admin';
      readonly capability: AdminCapability;
      readonly alias?: string;
      readonly scope?: ScopePolicy;
      readonly fields: FieldsPolicy;
    })
  /** 绑定员工本人 + 叠加授权器 selfService。 */
  | (PolicyBase & {
      readonly kind: 'self';
      readonly target?: Target;
      readonly button?: ButtonPolicy;
      readonly fields: FieldsPolicy;
    })
  /** 本人数据：列表用谓词；单条用 target + locator。 */
  | (PolicyBase & {
      readonly kind: 'own';
      readonly predicate: PredicateName;
      readonly target?: Target;
      readonly locator?: LocatorName;
      readonly denied?: Denial;
      readonly fields: FieldsPolicy;
    })
  | (PolicyBase & {
      readonly kind: 'relation';
      readonly relation: RelationName | Selector<RelationName>;
      readonly target: Target;
      readonly denied: Denial;
      readonly rows?: RowsPolicy;
      readonly fields: FieldsPolicy;
    })
  /** 具名例外（DEC-135）。 */
  | (PolicyBase & {
      readonly kind: 'exception';
      readonly guard: GuardName;
      readonly dec: string;
      readonly fields: FieldsPolicy;
    })
  /** 独立按钮策略，供 any / all 组合。 */
  | (PolicyBase & {
      readonly kind: 'button';
      readonly object: ObjectSelector;
      readonly button: Selector<ButtonRef>;
      readonly denied: Denial;
    })
  | ObjectPolicy
  /** OR：任一通过即通过；出口字段取通过分支的 fields。 */
  | (PolicyBase & { readonly kind: 'any'; readonly of: readonly RoutePolicy[] })
  /** AND：全部通过；出口字段由组合层声明。 */
  | (PolicyBase & { readonly kind: 'all'; readonly of: readonly RoutePolicy[]; readonly fields: FieldsPolicy });

export type PolicyKind = RoutePolicy['kind'];
