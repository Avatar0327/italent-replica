/**
 * 接管 T1 执行引擎（docs/08_设计/F-039_接管T1_设计.md §2.1 阶段顺序、§2.4 点校验事务方式、§2.6 义务 × 阶段）。
 *
 * 启动期（verifyRouteDeclarations）把已接管模块的每条声明编译成执行计划；结构不支持、名称未归类、缺实现都让
 * 应用无法启动（fail-closed）。运行期按保序主序执行（DEC-363①）：
 *   S1 If-Match → S2 功能权限 / 管理员能力 → S3 授权输入 → S4 写字段 → S5 按钮 → S6 范围 → S7 处理函数 → S8 核对
 * 每一步都调用模块登记的实现，任何错误原样传播：引擎不比较、不改写、不记录（§2.3，审查 P2-3）。
 * 只编译本期试点用到的结构；any / 关系 / 本人单条 / 选择器 / 可选分支 / rows 等推广阶段再加，现在一律启动失败。
 */
import type { Context, Next } from 'hono';
import { type AccessRuntime, bindAccess, RouteAccess } from './access.js';
import type { AdminNode, AnyImplementations, DataOperation, InputParser, T1Check } from './impl-registry.js';
import { type Declaration, RoutePolicyError } from './registry.js';
import type { ButtonPolicy, ButtonRef, FieldsPolicy, ObjectPolicy, RoutePolicy, ScopePolicy } from './types.js';

type S2Step =
  | { readonly kind: 'object'; readonly object: string; readonly operation: DataOperation }
  | { readonly kind: 'admin'; readonly node: AdminNode };

interface ScopeCheck {
  readonly name: string;
  readonly fn: T1Check<unknown, unknown, unknown>;
  readonly shared: boolean;
}

export interface EnforcePlan {
  readonly key: string;
  readonly impls: AnyImplementations;
  readonly revision: boolean;
  readonly s2: readonly S2Step[];
  readonly parse: readonly { readonly key: string; readonly parser: InputParser<unknown, unknown, unknown> }[];
  readonly fields?: { readonly object: string; readonly operation: 'create' | 'update' };
  readonly buttons: readonly { readonly object: string; readonly ref: ButtonRef }[];
  readonly scopeObject?: { readonly object: string; readonly view: string | undefined };
  readonly check?: ScopeCheck;
}

function missing(key: string, message: string): never {
  throw new RoutePolicyError('ROUTE_POLICY_IMPL_MISSING', `${key}：${message}`);
}
function unsupported(key: string, what: string): never {
  missing(key, `接管引擎尚不支持${what}（推广阶段再加）`);
}

/** 把根声明展开成节点：根本身，或 all 的子节点（不支持嵌套组合）。 */
function nodesOf(key: string, policy: RoutePolicy): readonly RoutePolicy[] {
  const nodes = policy.kind === 'all' ? policy.of : [policy];
  for (const node of nodes) {
    if (!['object', 'admin', 'own', 'member'].includes(node.kind)) unsupported(key, ` ${node.kind} 声明`);
    if (node.optional && Object.keys(node.optional).length > 0) unsupported(key, '可选分支 optional');
    if (node !== policy && (node.input || node.write)) unsupported(key, '组合子节点上的 input / write');
    // 管理员能力级范围（审计三条）推广阶段才接管；现在不能静默忽略范围（#166 第 1 轮 P2-2）
    if (node.kind === 'admin' && node.scope && node.scope.mode !== 'none') unsupported(key, '管理员范围 admin.scope');
  }
  if (policy.optional && Object.keys(policy.optional).length > 0) unsupported(key, '可选分支 optional');
  return nodes;
}

function isDynamic(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'from' in value;
}

function staticButton(key: string, button: ButtonPolicy): ButtonRef | undefined {
  if ('none' in button) return undefined;
  if (isDynamic(button)) unsupported(key, '动态按钮选择器');
  return button as ButtonRef;
}

function objectStep(key: string, node: ObjectPolicy): S2Step {
  if (typeof node.object !== 'string') unsupported(key, '动态对象选择器');
  if (typeof node.operation !== 'string') unsupported(key, '动态操作选择器');
  if (node.operation === 'button') unsupported(key, "operation: 'button'");
  if (node.rows || node.failureAudit) unsupported(key, 'rows / failureAudit');
  if ('byObject' in node.scope) unsupported(key, '按对象分派的范围 byObject');
  return { kind: 'object', object: node.object, operation: node.operation };
}

/**
 * 一条声明里出现的名称，按**出现位置**（义务）记录（§2.6 义务 × 阶段）。同一个名称可以在不同位置归不同阶段：
 * 如合同详情的定位器与出口形状同名（T1 + T4），IDP 新建的范围守卫与写足迹同名（T1 + T3），复制任务来源校验
 * 命令前一次、事务内一次（T1 + T3）。归类按位置做，不按名称全局禁止（#166 第 1 轮 P2-3）。
 * - scope：点定位器 / 看全部创建人定位器 / 范围守卫——登记了 T1 实现就由引擎执行，否则须登记延后阶段；
 * - deferred：守卫列表 / 列表谓词 / 本人谓词——引擎本期不执行这些位置，须登记延后阶段；
 * - positional：写足迹 / 返回后复核 / 命令内前提 / 出口形状与投影器——按位置不归 T1，无须登记。
 */
type Occurrence = { readonly name: string; readonly role: 'scope' | 'deferred' | 'positional' };

/** 用到的登记键：未用的键启动报 ROUTE_POLICY_IMPL_UNUSED。 */
export interface UsedNames {
  readonly t1: Set<string>;
  readonly deferred: Set<string>;
  readonly inputs: Set<string>;
}

function scopeOccurrences(key: string, scope: ScopePolicy): Occurrence[] {
  if (scope.mode === 'list') return [{ name: scope.predicate, role: 'deferred' }];
  if (scope.mode === 'point') return [{ name: scope.locator, role: 'scope' }];
  if (scope.mode === 'guard') return [{ name: scope.guard, role: 'scope' }];
  if (scope.mode === 'see-all') {
    if (!scope.creatorLocator) unsupported(key, '不带创建人定位器的看全部');
    return [{ name: scope.creatorLocator, role: 'scope' }];
  }
  return [];
}

function fieldOccurrences(fields: FieldsPolicy): Occurrence[] {
  if (fields.mode === 'shape') return [{ name: fields.shape, role: 'positional' }];
  if (fields.mode === 'projector') {
    return [
      { name: fields.projector, role: 'positional' },
      { name: fields.shape, role: 'positional' },
    ];
  }
  return [];
}

function guardOccurrences(policy: RoutePolicy): Occurrence[] {
  return (policy.guards ?? []).map((name) => ({ name, role: 'deferred' }));
}

function nodeOccurrences(key: string, node: RoutePolicy): Occurrence[] {
  const found = guardOccurrences(node);
  if (node.kind === 'object' && !('byObject' in node.scope)) found.push(...scopeOccurrences(key, node.scope));
  if (node.kind === 'own') {
    if (node.locator || node.target) unsupported(key, '本人单条定位 own.locator');
    found.push({ name: node.predicate, role: 'deferred' });
  }
  if ('fields' in node) found.push(...fieldOccurrences(node.fields));
  return found;
}

function collectNames(key: string, policy: RoutePolicy, nodes: readonly RoutePolicy[]): Occurrence[] {
  const found = nodes.flatMap((node) => nodeOccurrences(key, node));
  if (policy.kind === 'all') found.push(...guardOccurrences(policy), ...fieldOccurrences(policy.fields));
  const write = policy.write;
  const positional = [
    typeof write?.footprint === 'string' ? write.footprint : undefined,
    typeof write?.result === 'string' ? write.result : undefined,
    ...(write?.preconditions ?? []),
  ];
  for (const name of positional) if (name) found.push({ name, role: 'positional' });
  return found;
}

/** 按出现位置归类并查找实现；返回由引擎执行的范围名称（若有）。 */
function classify(key: string, found: readonly Occurrence[], impls: AnyImplementations, used: UsedNames) {
  let executed: string | undefined;
  for (const { name, role } of found) {
    const isT1 = impls.t1?.[name] !== undefined;
    const deferred = impls.deferred?.[name];
    if (role === 'scope' && isT1) {
      used.t1.add(name);
      executed = name;
    } else if (deferred) {
      used.deferred.add(name);
    } else if (role === 'scope') {
      missing(key, `${name} 未归类：须登记 t1 实现或延后阶段（§2.6）`);
    } else if (role === 'deferred') {
      missing(key, `${name} 在守卫 / 列表谓词 / 本人谓词位置，须登记延后阶段（引擎本期不执行这些位置）`);
    }
  }
  return executed;
}

function fieldsStep(key: string, policy: RoutePolicy, s2: readonly S2Step[]): EnforcePlan['fields'] {
  const fields = policy.write?.fields;
  if (fields === undefined || (typeof fields === 'object' && 'none' in fields)) return undefined;
  if (fields !== 'body' && fields !== 'body+subdivisions') unsupported(key, `写字段来源 ${JSON.stringify(fields)}`);
  const step = s2.find((s) => s.kind === 'object');
  if (step?.kind !== 'object' || (step.operation !== 'create' && step.operation !== 'update')) {
    missing(key, '写字段要求一个 create / update 的对象节点');
  }
  if (!policy.input?.parse?.some((p) => p.key === 'body')) missing(key, '写字段要求 input.parse 里有 body');
  return { object: step.object, operation: step.operation };
}

function scopeCheck(
  key: string,
  object: ObjectPolicy | undefined,
  name: string | undefined,
  impls: AnyImplementations,
): ScopeCheck | undefined {
  if (!object || !name || 'byObject' in object.scope || object.scope.mode === 'list' || object.scope.mode === 'none') {
    return undefined;
  }
  const shared = object.scope.tx === 'shared';
  const fn = impls.t1?.[name];
  if (!fn) missing(key, `${name} 缺实现`);
  return { name, fn, shared };
}

function requirePrimitives(plan: EnforcePlan): void {
  const p = plan.impls.primitives;
  const need: [boolean, unknown, string][] = [
    [plan.revision, p.revision, 'revision'],
    [plan.s2.some((s) => s.kind === 'object'), p.operation, 'operation'],
    [plan.s2.some((s) => s.kind === 'admin'), p.admin, 'admin'],
    [plan.s2.length === 0, p.context, 'context'],
    [plan.fields !== undefined, p.writeFields, 'writeFields'],
    [plan.buttons.length > 0, p.button, 'button'],
    [plan.scopeObject !== undefined, p.scope, 'scope'],
    [plan.check?.shared === true, p.transaction, 'transaction'],
  ];
  for (const [required, fn, name] of need) if (required && !fn) missing(plan.key, `缺原语 ${name}`);
}

function parseSteps(key: string, policy: RoutePolicy, impls: AnyImplementations, used: UsedNames) {
  return (policy.input?.parse ?? []).map(({ key: inputKey, using }) => {
    used.inputs.add(using);
    const parser = impls.inputs?.[using];
    if (!parser) missing(key, `输入解析器 ${using} 缺实现`);
    return { key: inputKey, parser };
  });
}

/** 编译一条已接管声明；used 收集用到的实现键，供未用检查。 */
export function compilePlan(declaration: Declaration, impls: AnyImplementations, used: UsedNames): EnforcePlan {
  const { key, policy } = declaration;
  const nodes = nodesOf(key, policy);
  const objects = nodes.filter((n): n is ObjectPolicy => n.kind === 'object');
  if (objects.length > 1) unsupported(key, '多个对象节点');
  const object = objects[0];
  const scope = object?.scope;
  if (scope && 'tx' in scope && scope.tx === 'shared' && declaration.method !== 'GET') {
    unsupported(key, '写路由的 shared 点校验');
  }
  const s2 = nodes.flatMap((n): S2Step[] => {
    if (n.kind === 'object') return [objectStep(key, n)];
    if (n.kind === 'admin') return [{ kind: 'admin', node: { capability: n.capability, alias: n.alias } }];
    return [];
  });
  const executed = classify(key, collectNames(key, policy, nodes), impls, used);
  const ref = object ? staticButton(key, object.button) : undefined;
  const flat = object && !('byObject' in object.scope) ? object.scope : undefined;
  const view = flat && 'view' in flat ? flat.view : undefined;
  const plan: EnforcePlan = {
    key,
    impls,
    revision: policy.input?.revision === true,
    s2,
    parse: parseSteps(key, policy, impls, used),
    fields: fieldsStep(key, policy, s2),
    buttons: object && ref ? [{ object: object.object as string, ref }] : [],
    scopeObject: object && flat && flat.mode !== 'none' ? { object: object.object as string, view } : undefined,
    check: scopeCheck(key, object, executed, impls),
  };
  requirePrimitives(plan);
  return plan;
}

/**
 * S8：shared 点校验的响应隔离（#166 第 1 轮 P2-1，DEC-363④）。处理函数可能已经设置了下载头、甚至把响应写进
 * `c.res`（Hono 已 finalized 时不采用返回值，已有 `c.res` 时还会把旧头合并进新响应）。所以不能只返回一个新的
 * Response：先把 Context 里的响应清掉，再放入只带处理函数之前已有响应头（如中间件的 X-Trace-Id）的新响应。
 */
function resetResponse(c: Context, baseline: Headers, replacement?: Response): Response {
  c.res = undefined;
  const response = replacement ?? new Response(null, { headers: baseline });
  c.res = response;
  return response;
}

function uncheckedResponse(key: string, baseline: Headers): Response {
  console.error(JSON.stringify({ type: 'route_policy.unchecked', route: key }));
  const headers = new Headers(baseline);
  headers.set('content-type', 'application/json');
  const body = { error: { code: 'ROUTE_POLICY_UNCHECKED', message: '点校验未完成，响应已丢弃' } };
  return new Response(JSON.stringify(body), { status: 500, headers });
}

/**
 * S1～S6。各步按声明顺序**逐个** await：顺序就是现状的错误优先级（保序，DEC-363①），不能并行。
 * 原语上的非空断言由启动期 requirePrimitives 保证（缺原语时应用无法启动）。
 */
async function admit(plan: EnforcePlan, c: Context, access: RouteAccess): Promise<void> {
  const p = plan.impls.primitives;
  const expectedRevision = plan.revision ? p.revision!(c) : 0;
  let ctx: unknown;
  for (const step of plan.s2) {
    const result =
      step.kind === 'object'
        ? await p.operation!(c, step.object, step.operation, expectedRevision)
        : await p.admin!(c, step.node, expectedRevision);
    if (ctx === undefined) ctx = result;
  }
  access.setContext(ctx === undefined ? await p.context!(c, expectedRevision) : ctx);
  for (const step of plan.parse) access.input[step.key] = await step.parser(c, access);
  if (plan.fields) await p.writeFields!(access.ctx, plan.fields.object, plan.fields.operation, access.input.body);
  for (const { object, ref } of plan.buttons) await p.button!(access.ctx, object, ref);
  if (plan.check && !plan.check.shared) {
    const scope = await access.getScope();
    access.point = await plan.check.fn({ c, access, scope });
  } else if (plan.check) {
    await access.getScope(); // shared：范围仍在事务外、按现状位置解析
  }
}

function runtimeFor(plan: EnforcePlan, c: Context): AccessRuntime<unknown, unknown, unknown> {
  const p = plan.impls.primitives;
  const { scopeObject, check } = plan;
  return {
    resolveScope: async (ctx) => {
      if (!scopeObject || !p.scope) throw new Error(`${plan.key} 没有对象范围，不能 getScope`);
      return p.scope(c, ctx, scopeObject.object, scopeObject.view);
    },
    scopedTx: check?.shared
      ? (access, scope, fn) =>
          p.transaction!(access.ctx, async (tx) => fn(tx, await check.fn({ c, access, scope, tx })))
      : undefined,
  };
}

type Handler = (c: Context, next: Next) => unknown;

/** shared 路由：处理函数抛错（含点校验拒绝）保留原错误码但丢弃它设置的响应头；未完成点检则 500。 */
async function runShared(plan: EnforcePlan, c: Context, next: Next, handler: Handler, access: RouteAccess) {
  const baseline = new Headers(c.res.headers);
  let response: unknown;
  try {
    response = await handler(c, next);
  } catch (error) {
    resetResponse(c, baseline);
    throw error;
  }
  if (!access.sharedChecked) return resetResponse(c, baseline, uncheckedResponse(plan.key, baseline));
  return response;
}

/** 已接管路由的一次请求：准入 → 处理函数 → shared 核对。 */
export async function runPlan(plan: EnforcePlan, c: Context, next: Next, handler: Handler) {
  const access = new RouteAccess(runtimeFor(plan, c));
  bindAccess(c, access);
  await admit(plan, c, access);
  if (plan.check?.shared) return runShared(plan, c, next, handler, access);
  return handler(c, next);
}
