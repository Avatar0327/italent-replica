/**
 * R3-T04 PR-B4 九宫格验收夹具（设计 §2.2 matrices / position_fields / axis_levels / cells / ratio_rule_*；TR-R31～R35）。
 * 接口 /api/tenant/talent-review/matrices；缺省“全部允许”的授权钩子建数据，权限用例另用真实授权器（matrixOperator）。
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

export const MATRICES = '/matrices';
export const LEVEL_OPTIONS = [
  { value: '3', label: '高' },
  { value: '2', label: '中' },
  { value: '1', label: '低' },
];

export interface MatrixView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly revision: number;
  readonly createdBy: string | null;
  readonly xFieldId: string;
  readonly yFieldId: string;
  readonly zFieldId: string | null;
  readonly positionFields: { role: string; fieldId: string }[];
  readonly axisLevels: Record<string, unknown>[];
  readonly cells: {
    cellNo: number;
    xLevelNo: number;
    yLevelNo: number;
    name: string;
    color: string;
    countsGreen: boolean;
  }[];
  readonly ratioGroups: {
    id: string;
    name: string;
    sortNo: number;
    isDefault: boolean;
    rules: Record<string, unknown>[];
  }[];
  readonly [key: string]: unknown;
}
export interface MatrixRefs {
  readonly x: string;
  readonly y: string;
  readonly before: string;
  readonly after: string;
}

let counter = 0;
const nextNo = () => {
  counter += 1;
  return counter;
};

/** 3 × 3 的最小合法九宫格载荷：两个单选轴（低 / 中 / 高三段）、9 个格子、校准前 / 后两个位置字段。 */
export function matrixBody(refs: MatrixRefs, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const n = nextNo();
  const axisLevels = (['x', 'y'] as const).flatMap((axis) =>
    ['1', '2', '3'].map((value, index) => ({
      axis,
      levelNo: index + 1,
      name: ['低', '中', '高'][index],
      optionValues: [value],
    })),
  );
  const cells = [1, 2, 3].flatMap((y) =>
    [1, 2, 3].map((x) => ({
      cellNo: (y - 1) * 3 + x,
      xLevelNo: x,
      yLevelNo: y,
      name: `格子${(y - 1) * 3 + x}`,
      color: '#336699',
    })),
  );
  return {
    code: `mx_${n}_${randomUUID().slice(0, 4)}`,
    name: `九宫格${n}`,
    xFieldId: refs.x,
    yFieldId: refs.y,
    positionFields: [
      { role: 'before', fieldId: refs.before },
      { role: 'after', fieldId: refs.after },
    ],
    axisLevels,
    cells,
    ...extra,
  };
}

/** 比例规则组最小合法载荷：高 - 高格子（9 号）占比不超过 20%。 */
export const ratioGroupBody = (extra: Record<string, unknown> = {}) => ({
  name: `规则组${nextNo()}`,
  controlScope: 'project_meeting',
  controlMode: 'warn',
  rules: [{ operator: 'lte', pctLow: 20, cellNos: [9] }],
  ...extra,
});

/** 一个租户 + 一名成员（全部允许），带九宫格与引用字段的快捷方法。 */
export async function matrixWorld(db: Db, label: string) {
  const world = await configWorld(db, label);
  const optionField = () =>
    world.create('field', configBody('field', { kind: 'option', group: 'result', options: LEVEL_OPTIONS }));
  const positionField = () => world.create('field', configBody('field', { kind: 'number', group: 'position' }));
  const numberField = () => world.create('field', configBody('field', { kind: 'number', group: 'result' }));
  const textField = () => world.create('field', configBody('field', { kind: 'text', group: 'evaluation' }));
  const refs = async (): Promise<MatrixRefs> => ({
    x: (await optionField()).id,
    y: (await optionField()).id,
    before: (await positionField()).id,
    after: (await positionField()).id,
  });
  const post = (body: Record<string, unknown>, options: RequestOptions = {}) =>
    world.request('POST', MATRICES, { ifMatch: 0, body, ...options });
  const create = async (extra: Record<string, unknown> = {}, given?: MatrixRefs) => {
    const response = await post(matrixBody(given ?? (await refs()), extra));
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as MatrixView;
  };
  const read = async (id: string) => {
    const response = await world.request('GET', `${MATRICES}/${id}`);
    return { status: response.status, body: (await response.json()) as MatrixView };
  };
  const list = async (query = '') =>
    (await (await world.request('GET', `${MATRICES}${query}`)).json()) as { items: MatrixView[] };
  return { ...world, optionField, positionField, numberField, textField, refs, post, create, read, list };
}

export interface MatrixOperatorOptions {
  readonly seeAll?: boolean;
  readonly hidden?: readonly string[];
  readonly readonly?: readonly string[];
  readonly buttons?: boolean;
  readonly omitButtons?: readonly string[];
  readonly view?: boolean;
  /** 引用字段所需的字段目录权限：缺省有查看权但没有看全部；seeAll 给看全部；none 不给查看权。 */
  readonly fields?: 'none' | 'creator' | 'seeAll';
}

/** 真实授权器下的操作人：身份带 TalentReview 应用、九宫格对象与（可选）字段目录的查看权。 */
export async function matrixOperator(world: PermissionWorld, options: MatrixOperatorOptions = {}) {
  const matrix = TALENT_REVIEW_OBJECTS.matrix;
  const field = TALENT_REVIEW_OBJECTS.field;
  const profile = await createProfile(world, `trm-${randomUUID().slice(0, 8)}`, { apps: [TALENT_REVIEW_APP] });
  const hidden = new Set(options.hidden ?? []);
  const locked = new Set(options.readonly ?? []);
  const setButtons = async (buttons: boolean) => {
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: true, update: true, delete: true },
        fields: matrix.fields.map((item) => ({
          fieldCode: item.code,
          view: !hidden.has(item.code),
          edit: !item.system && !hidden.has(item.code) && !locked.has(item.code),
        })),
        buttons: buttons
          ? matrix.buttons
              .filter((button) => !options.omitButtons?.includes(button.code))
              .map((button) => ({ buttonCode: button.code, level: button.level }))
          : [],
      },
      matrix.code,
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
  const user = await addMember(world, `trm-operator-${randomUUID().slice(0, 4)}`);
  expect((await grant(world, user.id, profile.id)).status).toBe(201);
  const as = { user: user.id, tenant: world.tenant.id };
  const revisions = new Map<string, number>();
  const setSeeAll = async (target: 'matrix' | 'field', seeAll: boolean) => {
    const code = TALENT_REVIEW_OBJECTS[target].code;
    const response = await world.api.request('PUT', `${BASE}/profiles/${profile.id}/data-scopes/${TALENT_REVIEW_APP}`, {
      ...world.asAdmin,
      ifMatch: revisions.get(code) ?? 0,
      body: { targetKind: 'entity', targetCode: code, seeAll },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    revisions.set(code, ((await response.json()) as { revision: number }).revision);
  };
  if (options.seeAll) await setSeeAll('matrix', true);
  if (options.fields === 'seeAll') await setSeeAll('field', true);
  const request = (method: string, path: string, extra: RequestOptions = {}) =>
    world.api.request(method, `${TR_BASE}${path}`, { ...as, ...extra });
  return { profile, user, as, request, setSeeAll, setButtons };
}
