/**
 * R3-T04 PR-B5 计算规则验收夹具（设计 §2.2 calc_rules / _items、§4.5、§7 计算规则行）。
 * 接口 /api/tenant/talent-review/calc-rules；缺省“全部允许”的授权钩子建数据，权限用例另用真实授权器（calcRuleOperator）。
 * 公式按字段名引用盘点字段：盘点对象.<字段名>（26 §8）。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { TALENT_REVIEW_APP, TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { expect } from 'vitest';
import {
  addMember,
  BASE,
  createProfile,
  grant,
  makeGrantable,
  type PermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { configBody, configWorld } from './AC-TR-config-support.js';
import { TR_BASE } from './AC-TR-support.js';
import type { RequestOptions } from './support/tenant-api.js';

export const CALC_RULES = '/calc-rules';

export interface CalcItemView {
  readonly targetFieldId: string;
  readonly priority: number;
  readonly formula: string;
  readonly description: string | null;
  readonly sortNo: number;
  readonly usesRanking: boolean;
}
export interface CalcRuleView {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly enabled: boolean;
  readonly assessmentLatestWindow: string;
  readonly description: string | null;
  readonly createdBy: string | null;
  readonly items: CalcItemView[];
  readonly hints?: { warnings: string[]; cycles: string[][]; blocked: string[]; order: string[] };
  readonly [key: string]: unknown;
}
export interface FieldRef {
  readonly id: string;
  readonly name: string;
}

let counter = 0;
const nextNo = () => {
  counter += 1;
  return counter;
};
/** 公式里的字段写法。 */
export const pathOf = (field: FieldRef) => `盘点对象.${field.name}`;

export const calcItem = (target: FieldRef, formula: string, extra: Record<string, unknown> = {}) => ({
  targetFieldId: target.id,
  priority: 1,
  formula,
  ...extra,
});
export const calcBody = (items: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  name: `计算规则${nextNo()}`,
  items,
  ...extra,
});

/** 一个租户 + 一名成员（全部允许），带计算规则与字段的快捷方法。 */
export async function calcWorld(db: Db, label: string) {
  const world = await configWorld(db, label);
  const field = (kind: string, extra: Record<string, unknown> = {}): Promise<FieldRef> =>
    world.create('field', configBody('field', { kind, group: 'result', ...extra }));
  const numberField = () => field('number');
  const textField = () => field('text', { group: 'evaluation' });
  const optionField = () =>
    field('option', {
      options: [
        { value: '1', label: '低' },
        { value: '2', label: '高' },
      ],
    });
  const multiField = () =>
    field('multi_option', {
      group: 'basic',
      options: [
        { value: 'a', label: '甲' },
        { value: 'b', label: '乙' },
      ],
    });
  const post = (body: Record<string, unknown>, options: RequestOptions = {}) =>
    world.request('POST', CALC_RULES, { ifMatch: 0, body, ...options });
  const create = async (body: Record<string, unknown>) => {
    const response = await post(body);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as CalcRuleView;
  };
  const read = async (id: string) => {
    const response = await world.request('GET', `${CALC_RULES}/${id}`);
    return { status: response.status, body: (await response.json()) as CalcRuleView };
  };
  const list = async (query = '') =>
    (await (await world.request('GET', `${CALC_RULES}${query}`)).json()) as { items: CalcRuleView[] };
  return { ...world, numberField, textField, optionField, multiField, post, create, read, list };
}

export interface CalcOperatorOptions {
  readonly seeAll?: boolean;
  readonly hidden?: readonly string[];
  readonly readonly?: readonly string[];
  readonly buttons?: boolean;
  readonly view?: boolean;
  /** 引用字段所需的字段目录权限：缺省有查看权但没有看全部；seeAll 给看全部；none 不给查看权。 */
  readonly fields?: 'none' | 'creator' | 'seeAll';
}

/** 真实授权器下的操作人：身份带 TalentReview 应用、计算规则对象与（可选）字段目录的查看权。 */
export async function calcRuleOperator(world: PermissionWorld, options: CalcOperatorOptions = {}) {
  const rule = TALENT_REVIEW_OBJECTS.calcRule;
  const field = TALENT_REVIEW_OBJECTS.field;
  const profile = await createProfile(world, `trk-${randomUUID().slice(0, 8)}`, { apps: [TALENT_REVIEW_APP] });
  const hidden = new Set(options.hidden ?? []);
  const locked = new Set(options.readonly ?? []);
  const setButtons = async (buttons: boolean) => {
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: true, update: true, delete: true },
        fields: rule.fields.map((item) => ({
          fieldCode: item.code,
          view: !hidden.has(item.code),
          edit: !item.system && !hidden.has(item.code) && !locked.has(item.code),
        })),
        buttons: buttons ? rule.buttons.map((button) => ({ buttonCode: button.code, level: button.level })) : [],
      },
      rule.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  };
  if (options.view !== false) await setButtons(options.buttons ?? true);
  if ((options.fields ?? 'creator') !== 'none') {
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: field.fields.map((item) => ({ fieldCode: item.code, view: true, edit: false })),
        buttons: [],
      },
      field.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  await makeGrantable(world, [profile.id]);
  const user = await addMember(world, `trk-operator-${randomUUID().slice(0, 4)}`);
  expect((await grant(world, user.id, profile.id)).status).toBe(201);
  const as = { user: user.id, tenant: world.tenant.id };
  const revisions = new Map<string, number>();
  const setSeeAll = async (target: 'calcRule' | 'field', seeAll: boolean) => {
    const code = TALENT_REVIEW_OBJECTS[target].code;
    const response = await world.api.request('PUT', `${BASE}/profiles/${profile.id}/data-scopes/${TALENT_REVIEW_APP}`, {
      ...world.asAdmin,
      ifMatch: revisions.get(code) ?? 0,
      body: { targetKind: 'entity', targetCode: code, seeAll },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    revisions.set(code, ((await response.json()) as { revision: number }).revision);
  };
  if (options.seeAll) await setSeeAll('calcRule', true);
  if (options.fields === 'seeAll') await setSeeAll('field', true);
  const request = (method: string, path: string, extra: RequestOptions = {}) =>
    world.api.request(method, `${TR_BASE}${path}`, { ...as, ...extra });
  return { profile, user, as, request, setSeeAll, setButtons };
}
