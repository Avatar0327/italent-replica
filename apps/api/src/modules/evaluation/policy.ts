/**
 * 人才评定配置路由的现状声明（F-039；按 docs/08_设计/R3-T02-B1a_评定底座与活动类型_路由声明.md 转写，处理函数不变）。
 * 全部挂在 /api/tenant/evaluation 之下，应用 TEvaluation（DEC-043：数据范围按用户 × TEvaluation 一份，缺省为空）。
 * 活动类型是字典（无组织字段）：看全部 ∪ 创建人（ev.dictionary，DEC-121），新建只认看全部（DEC-082 / DEC-356②）；
 * TEvaluation 没有向下公开，读写同一谓词，范围外读写都是 404。
 * 写入共性：If-Match 必带、Idempotency-Key 必带、ledger single；write.fields = 'body'。
 */
import { EVALUATION_OBJECTS } from '@italent/domain';
import { defineTable, type RoutePolicy } from '../../route-policy/index.js';
import {
  BAD_REQUEST,
  button,
  listScope,
  noButton,
  none,
  NOT_FOUND,
  object,
  pointScope,
  seeAll,
  shape,
  write,
} from '../../route-policy/presets.js';

const BASE = '/api/tenant/evaluation';
const E = EVALUATION_OBJECTS;
const NF = NOT_FOUND;
/** `talent/http.uuidParam`：对象标识非 UUID → 400 VALIDATION_FAILED。 */
const byId = { invalidId: BAD_REQUEST };

type Key = 'activityType';

interface Spec {
  readonly path: string;
  readonly out: ReturnType<typeof shape>;
}

const SPECS: Readonly<Record<Key, Spec>> = {
  activityType: { path: 'activity-types', out: shape('ev.activityType') },
};

const locator = (key: Key) => `ev.${key}.byId`;
const commandResult = (loc: string) => ({ generic: { targets: 'id', locator: loc } }) as const;

function evWrite(key: Key, fields: 'body' | 'none') {
  return write(fields === 'body' ? 'body' : none('删除不写字段'), 'ev.commandScope', commandResult(locator(key)), {
    ledger: 'single',
  });
}

function crud(key: Key): Record<string, RoutePolicy> {
  const spec = SPECS[key];
  const code = E[key].code;
  const path = `${BASE}/${spec.path}`;
  const base = { object: code, fields: spec.out };
  // 详情 / 编辑 / 删除：范围外与不存在同一个 404（读写同一谓词）
  const point = (op: 'byId' | 'editable') => pointScope({ param: 'id' }, `ev.${key}.${op}`, NF);
  return {
    [`GET ${path}`]: object({
      ...base,
      operation: 'view',
      button: noButton('列表按对象查看权'),
      scope: listScope('ev.dictionary'),
      // 带 enabled 筛选而无 enabled 字段查看权 → 403 FILTER_FIELD_HIDDEN；排序只用可见字段（read-model.orderBy）
      guards: ['ev.filterFieldVisible'],
    }),
    [`GET ${path}/:id`]: object({
      ...base,
      ...byId,
      operation: 'view',
      button: noButton('详情按对象查看权'),
      scope: point('byId'),
    }),
    [`POST ${path}`]: object({
      ...base,
      operation: 'create',
      button: button('create', 'list'),
      scope: seeAll(NF),
      write: evWrite(key, 'body'),
    }),
    [`PATCH ${path}/:id`]: object({
      ...base,
      ...byId,
      operation: 'update',
      button: button('update', 'detail'),
      scope: point('editable'),
      write: evWrite(key, 'body'),
    }),
    [`DELETE ${path}/:id`]: object({
      ...base,
      ...byId,
      operation: 'delete',
      button: button('delete', 'detail'),
      scope: point('editable'),
      write: evWrite(key, 'none'),
    }),
  };
}

export const EVALUATION_POLICIES = defineTable('evaluation', {
  ...crud('activityType'),
});
