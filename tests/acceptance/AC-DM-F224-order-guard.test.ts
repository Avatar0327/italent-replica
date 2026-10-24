import { sql, type Tx } from '@italent/db';
import { describe, expect, it } from 'vitest';
import {
  EXIT_SORT_DEPENDENCIES,
  EXIT_VIEWS,
  listExitView,
  type ExitView,
} from '../../apps/api/src/modules/employment/exit-queries.js';

type Key = readonly [column: string, direction: 'ASC' | 'DESC'];
const EXPECTED: Record<ExitView, readonly Key[]> = {
  in_progress: [
    ['p.last_work_date', 'ASC'],
    ['b.id', 'ASC'],
  ],
  completed: [
    ['p.last_work_date', 'DESC'],
    ['b.id', 'ASC'],
  ],
  all: [
    ['b.created_at', 'DESC'],
    ['b.id', 'DESC'],
  ],
  cancellations: [
    ['c.created_at', 'DESC'],
    ['c.id', 'DESC'],
  ],
};

/** 从真正传给 execute 的窗口排序读取键；独立于产品生成器，不把生成器的输出当作期望。 */
function actualKeys(statement: string): Key[] {
  const match = /row_number\(\) OVER \(ORDER BY ([^)]+)\) AS ord/i.exec(statement);
  expect(match, '查询必须包含候选行排序').not.toBeNull();
  return match![1]!.split(',').map((part) => {
    const key = /^([\w.]+)(?:\s+(ASC|DESC))?$/i.exec(part.replaceAll('"', '').trim());
    expect(key, `不是受控列排序：${part}`).not.toBeNull();
    return [key![1]!, (key![2]?.toUpperCase() ?? 'ASC') as Key[1]];
  });
}

function assertOrder(statement: string, declared: readonly Key[]) {
  expect(actualKeys(statement), '声明排序键必须等于实际 SQL 次序键（含方向与末位键）').toEqual(declared);
}

async function queryFor(view: ExitView, fields: readonly string[]) {
  let statement = '';
  const tx = {
    execute: async (query: ReturnType<typeof sql>) => {
      statement = query.toQuery({
        escapeName: (name) => `"${name}"`,
        escapeParam: (index) => `$${index + 1}`,
        escapeString: (value) => `'${value.replaceAll("'", "''")}'`,
      }).sql;
      return [];
    },
  } as unknown as Tx;
  await listExitView(
    tx,
    '合成租户',
    {
      view,
      page: { limit: 2, offset: 1 },
      filter: {},
      show: { employee: () => true, employment: (field) => fields.includes(field) },
    },
    undefined,
  );
  return statement;
}

describe('AC-DM-F224 排序守卫覆盖实际执行的次序键', () => {
  it.each(EXIT_VIEWS)('%s 的受控声明、实际查询和既有逐键顺序一致', async (view) => {
    const rule = EXIT_SORT_DEPENDENCIES[view];
    const statement = await queryFor(view, rule.anyOf);
    assertOrder(statement, EXPECTED[view]);
    expect(rule).toHaveProperty('keys', EXPECTED[view]);
    assertOrder(statement, Reflect.get(rule, 'keys') as readonly Key[]);
  });

  it.each(EXIT_VIEWS)('%s 无日期字段权时仅按业务 ID 升序；单个许可字段仍保留原排序', async (view) => {
    assertOrder(await queryFor(view, []), [['b.id', 'ASC']]);
    for (const field of EXIT_SORT_DEPENDENCIES[view].anyOf) {
      assertOrder(await queryFor(view, [field]), EXPECTED[view]);
    }
  });

  it('AC-DM-F224 变异：改列、改方向、漏键、多键、换次序及撤销 ID 混用都被实际 SQL 守卫拒绝', async () => {
    const statement = await queryFor('cancellations', ['createdAt']);
    const mutants: readonly (readonly Key[])[] = [
      [
        ['b.created_at', 'DESC'],
        ['c.id', 'DESC'],
      ],
      [
        ['c.created_at', 'ASC'],
        ['c.id', 'DESC'],
      ],
      [['c.created_at', 'DESC']],
      [
        ['c.created_at', 'DESC'],
        ['c.id', 'DESC'],
        ['b.id', 'ASC'],
      ],
      [
        ['c.id', 'DESC'],
        ['c.created_at', 'DESC'],
      ],
      [
        ['c.created_at', 'DESC'],
        ['b.id', 'DESC'],
      ],
    ];
    for (const mutant of mutants) expect(() => assertOrder(statement, mutant)).toThrow();
  });
});
