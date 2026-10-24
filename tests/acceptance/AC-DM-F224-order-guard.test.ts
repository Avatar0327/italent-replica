import { createPgDb, type sql, type Tx } from '@italent/db';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EXIT_SORT_DEPENDENCIES,
  EXIT_VIEWS,
  listExitView,
  loadExitDetail,
  type ExitView,
} from '../../apps/api/src/modules/employment/exit-queries.js';
import { EXIT_LIST_ORDER_KEYS, exitListOrder } from '../../apps/api/src/modules/employment/exit-list-order.js';
import { listHandoverItems } from '../../apps/api/src/modules/employment/exit-handover-items.js';
import { probeDownstream } from '../../apps/api/src/modules/employment/exit-downstream.js';
import { listRetirementBills, listRetirementPersons } from '../../apps/api/src/modules/employment/retirement-views.js';

type Key = readonly [column: string, direction: 'ASC' | 'DESC'];
// postgres-js 按需连接；这里只借真实方言编译 SQL，不执行驱动查询，不需要数据库服务。
const compiler = createPgDb('postgresql://example.invalid/f224-sql-compilation');
afterAll(() => compiler.close());
const dialect = Reflect.get(compiler.db, 'dialect') as {
  sqlToQuery: (query: ReturnType<typeof sql>) => { sql: string; params: unknown[] };
};
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
  return parseKeys(match![1]!);
}

function parseKeys(order: string): Key[] {
  return order.split(',').map((part) => {
    const key = /^([\w.]+)(?:\s+(ASC|DESC))?$/i.exec(part.replaceAll('"', '').trim());
    expect(key, `不是受控列排序：${part}`).not.toBeNull();
    return [key![1]!, (key![2]?.toUpperCase() ?? 'ASC') as Key[1]];
  });
}

function assertOrder(statement: string, declared: readonly Key[]) {
  expect(actualKeys(statement), '声明排序键必须等于实际 SQL 次序键（含方向与末位键）').toEqual(declared);
}

async function capture(run: (tx: Tx) => Promise<unknown>, results: unknown[][] = []) {
  const statements: string[] = [];
  const tx = {
    execute: async (query: ReturnType<typeof sql>) => {
      statements.push(dialect.sqlToQuery(query).sql);
      return results[statements.length - 1] ?? [];
    },
  } as unknown as Tx;
  await run(tx);
  return statements;
}

async function queryFor(view: ExitView, fields: readonly string[]) {
  const [statement] = await capture((tx) =>
    listExitView(
      tx,
      '合成租户',
      {
        view,
        page: { limit: 2, offset: 1 },
        filter: {},
        show: { employee: () => true, employment: (field) => fields.includes(field) },
      },
      undefined,
    ),
  );
  return statement!;
}

describe('AC-DM-F224 排序守卫覆盖实际执行的次序键', () => {
  it.each(EXIT_VIEWS)('%s 的受控声明、实际查询和既有逐键顺序一致', async (view) => {
    const rule = EXIT_SORT_DEPENDENCIES[view];
    const statement = await queryFor(view, rule.anyOf);
    assertOrder(statement, EXPECTED[view]);
    expect(rule).toHaveProperty('keys', EXPECTED[view]);
    assertOrder(statement, rule.keys);
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

const OTHER_EXPECTED = {
  businessId: [['b.id', 'ASC']],
  retirementPersons: [
    ['pv.expected_retirement_date', 'ASC'],
    ['e.id', 'ASC'],
  ],
  employeeId: [['e.id', 'ASC']],
  page: [['ord', 'ASC']],
  pageResult: [['page.ord', 'ASC']],
  versions: [['version_no', 'ASC']],
  events: [['event_no', 'ASC']],
  approvalInstance: [
    ['created_at', 'DESC'],
    ['id', 'DESC'],
  ],
  effectSummary: [
    ['phase', 'ASC'],
    ['kind', 'ASC'],
  ],
  effectTargets: [
    ['x.created_at', 'ASC'],
    ['x.id', 'ASC'],
  ],
  handoverItems: [
    ['sequence_no', 'ASC'],
    ['created_at', 'ASC'],
    ['id', 'ASC'],
  ],
} as const;

/** 末级列表排序（排除内部取最新版本的子查询）。 */
function lastOrder(statement: string): Key[] {
  const tail = statement.split(/ORDER BY/i).at(-1)!;
  return parseKeys(tail.split(/\s+LIMIT\b/i)[0]!.trim());
}

describe('AC-DM-F224 同类列表使用单一入口，原次序逐键不变', () => {
  it('AC-DM-F224 全部受控描述及生成结果精确匹配原排序（不漏登记末位键）', () => {
    expect(EXIT_LIST_ORDER_KEYS).toEqual({ ...EXPECTED, ...OTHER_EXPECTED });
    for (const name of Object.keys(EXIT_LIST_ORDER_KEYS) as (keyof typeof EXIT_LIST_ORDER_KEYS)[]) {
      const generated = dialect.sqlToQuery(exitListOrder(name).order);
      expect(parseKeys(generated.sql)).toEqual(EXIT_LIST_ORDER_KEYS[name]);
      expect(generated.params).toEqual([]);
    }
  });

  it('AC-DM-F224 权限依赖与实际 SQL 主键对应，日期两字段的任一可见语义不变', () => {
    const dependencies: Record<string, readonly string[]> = {
      'p.last_work_date': ['lastWorkDate', 'effectiveDate'],
      'b.created_at': ['createdAt'],
      'c.created_at': ['createdAt'],
    };
    for (const rule of Object.values(EXIT_SORT_DEPENDENCIES)) {
      expect(rule.anyOf).toEqual(dependencies[rule.keys[0]![0]]);
    }
  });

  it('AC-DM-F224 退休三单据视图、两人员视图及字段无权回退的实际查询保持原排序', async () => {
    const at = { asOf: '2026-10-01', timezone: 'Asia/Shanghai' };
    const page = { limit: 2, offset: 1 };
    for (const visible of [true, false]) {
      const show = { employee: () => visible, employment: () => visible };
      for (const view of ['processing', 'completed', 'all'] as const) {
        const [statement] = await capture((tx) =>
          listRetirementBills(tx, '合成租户', { view, at, page, show }, undefined),
        );
        assertOrder(
          statement!,
          visible ? EXPECTED[view === 'processing' ? 'in_progress' : view] : OTHER_EXPECTED.businessId,
        );
      }
      for (const view of ['upcoming', 'overdue'] as const) {
        const [statement] = await capture((tx) =>
          listRetirementPersons(
            tx,
            '合成租户',
            {
              view,
              at,
              page,
              show,
              upcomingDays: 30,
            },
            undefined,
          ),
        );
        assertOrder(statement!, visible ? OTHER_EXPECTED.retirementPersons : OTHER_EXPECTED.employeeId);
      }
    }
  });

  it('AC-DM-F224 候选分页、详情版本/事件/效果、交接事项与撤销目标清单均核对实际 SQL', async () => {
    const pageSql = await queryFor('all', ['createdAt']);
    expect(parseKeys(/SELECT \* FROM base ORDER BY (.+?)\s+LIMIT/.exec(pageSql)![1]!)).toEqual(OTHER_EXPECTED.page);
    expect(lastOrder(pageSql)).toEqual(OTHER_EXPECTED.pageResult);
    const details = await capture(
      (tx) => loadExitDetail(tx, '合成租户', '合成单据', undefined),
      [[{ id: '合成单据', createdAt: '2026-10-01T00:00:00Z', plannedLastWorkDate: '2026-10-01' }], [{}]],
    );
    assertOrder(details[0]!, OTHER_EXPECTED.businessId);
    for (const [index, name] of ['versions', 'events', 'approvalInstance', 'effectSummary'].entries()) {
      expect(lastOrder(details[index + 2]!)).toEqual(OTHER_EXPECTED[name as keyof typeof OTHER_EXPECTED]);
    }
    const [handover] = await capture((tx) => listHandoverItems(tx, '合成租户'));
    expect(lastOrder(handover!)).toEqual(OTHER_EXPECTED.handoverItems);
    const effects = await capture((tx) =>
      probeDownstream(
        tx,
        {
          tenantId: '合成租户',
        } as Parameters<typeof probeDownstream>[1],
        { businessId: '合成单据', employeeId: '合成员工', lastWorkDate: null },
      ),
    );
    expect(effects.length).toBeGreaterThan(0);
    for (const statement of effects) expect(lastOrder(statement)).toEqual(OTHER_EXPECTED.effectTargets);
  });
});
