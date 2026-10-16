/**
 * 入职生成邮箱规则（R2 BE-2b；docs/02_业务建模/34 EN-R12、AC-EN-06）。纯函数，不碰 IO：
 * 规则按优先级（数字小的先）逐条判定，命中第一条即停止——该条生成失败也不再尝试下一条；
 * 邮箱 = 前缀 + @ + 后缀；重名时在已占用的最大序号上 +1；前缀为空或含非法字符 → 失败并给出原因。
 * 规则的配置形态（前缀字段、条件）原站只有一行规格，字段集与条件集是首版保守取值，见 PR“未验证”。
 */
export const EMAIL_PREFIX_FIELDS = {
  employeeCode: '工号',
  namePinyin: '姓名全拼',
  pinyinInitials: '姓名拼音首字母',
} as const;
export type EmailPrefixField = keyof typeof EMAIL_PREFIX_FIELDS;
export const EMAIL_PREFIX_FIELD_CODES = Object.keys(EMAIL_PREFIX_FIELDS) as [EmailPrefixField, ...EmailPrefixField[]];

/** 附加人员条件：雇佣关系（与任职字段 employType 同一取值）。 */
export const EMAIL_EMPLOY_TYPES = ['internal', 'intern', 'external'] as const;
export type EmailEmployType = (typeof EMAIL_EMPLOY_TYPES)[number];

export const EMAIL_RULE_LIMIT = 20;
const PREFIX_MAX = 64;
const PREFIX_PATTERN = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** 后缀统一小写；允许写成 “@example.com”。不合法返回 null。 */
export function normalizeEmailDomain(value: string): string | null {
  const domain = value.trim().replace(/^@/, '').toLowerCase();
  return domain.length <= 253 && DOMAIN_PATTERN.test(domain) ? domain : null;
}

export interface EmailRuleFacts {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly enabled: boolean;
  /** 组织范围（含下级）：候选人所在部门或其任一上级在其中即满足。 */
  readonly orgIds: readonly string[];
  /** 空 = 不加雇佣关系条件。 */
  readonly employTypes: readonly string[];
  readonly prefixField: EmailPrefixField;
  readonly domain: string;
}

export interface EmailCandidate {
  readonly kind: string;
  /** 入职部门及其全部上级（行政维度，入职日当天）；没有部门为空。 */
  readonly orgChain: readonly string[];
  readonly employType: string | null;
  readonly employeeCode: string;
  readonly namePinyin: string | null;
  readonly pinyinInitials: string | null;
}

export type EmailFailureReason = 'PREFIX_EMPTY' | 'PREFIX_ILLEGAL';
export type EmailGeneration =
  | { readonly status: 'generated'; readonly email: string; readonly ruleId: string; readonly ruleName: string }
  | {
      readonly status: 'failed';
      readonly reason: EmailFailureReason;
      readonly ruleId: string;
      readonly ruleName: string;
    }
  | { readonly status: 'skipped'; readonly reason: 'REHIRE_NOT_GENERATED' }
  | { readonly status: 'no_rule' };

/** 重聘入职、退休返聘入职沿用原邮箱，不生成（EN-R12）。 */
const NON_GENERATING_KINDS: readonly string[] = ['rehire', 'retire_rehire', 'intern_regularization'];

export function emailPrefixOf(field: EmailPrefixField, candidate: EmailCandidate): string {
  return (candidate[field] ?? '').trim().toLowerCase();
}

export function validateEmailPrefix(prefix: string): EmailFailureReason | null {
  if (!prefix) return 'PREFIX_EMPTY';
  return prefix.length <= PREFIX_MAX && PREFIX_PATTERN.test(prefix) ? null : 'PREFIX_ILLEGAL';
}

export function matchEmailRule(rules: readonly EmailRuleFacts[], candidate: EmailCandidate): EmailRuleFacts | null {
  const ordered = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.enabled)
    .toSorted((a, b) => a.rule.priority - b.rule.priority || a.index - b.index);
  const hit = ordered.find(
    ({ rule }) =>
      rule.orgIds.some((orgId) => candidate.orgChain.includes(orgId)) &&
      (rule.employTypes.length === 0 ||
        (candidate.employType !== null && rule.employTypes.includes(candidate.employType))),
  );
  return hit?.rule ?? null;
}

/** 重名处理：前缀@后缀未被占用就用它；否则取已占用的“前缀 + 序号”里的最大序号 + 1（无序号的原名按 0 算）。 */
export function nextAvailableEmail(prefix: string, domain: string, taken: readonly string[]): string {
  const occupied = taken.map((email) => email.trim().toLowerCase());
  const plain = `${prefix}@${domain}`;
  const pattern = new RegExp(`^${escapeRegExp(prefix)}(\\d*)@${escapeRegExp(domain)}$`);
  const sequences = occupied.flatMap((email) => {
    const match = pattern.exec(email);
    return match ? [match[1] === '' ? 0 : Number(match[1])] : [];
  });
  return sequences.length === 0 && !occupied.includes(plain)
    ? plain
    : `${prefix}${Math.max(0, ...sequences) + 1}@${domain}`;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type EmailPlan =
  | Exclude<EmailGeneration, { readonly status: 'generated' }>
  | { readonly status: 'plan'; readonly rule: EmailRuleFacts; readonly prefix: string };

/**
 * 第一步（纯判定）：跳过 / 无规则 / 命中规则后前缀失败 / 得到前缀。得到前缀后再由调用方查已占用邮箱（IO），
 * 交给 nextAvailableEmail 取最终邮箱。
 */
export function planEntryEmail(rules: readonly EmailRuleFacts[], candidate: EmailCandidate): EmailPlan {
  if (NON_GENERATING_KINDS.includes(candidate.kind)) return { status: 'skipped', reason: 'REHIRE_NOT_GENERATED' };
  const rule = matchEmailRule(rules, candidate);
  if (!rule) return { status: 'no_rule' };
  const prefix = emailPrefixOf(rule.prefixField, candidate);
  const reason = validateEmailPrefix(prefix);
  return reason ? { status: 'failed', reason, ruleId: rule.id, ruleName: rule.name } : { status: 'plan', rule, prefix };
}
