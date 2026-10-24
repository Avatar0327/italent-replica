import { sql } from '@italent/db';

type OrderKey = readonly [column: string, direction: 'ASC' | 'DESC'];

/** F-224：列表实际次序键的唯一声明；不接受调用方提供的 SQL 或请求参数。 */
export const EXIT_LIST_ORDER_KEYS = {
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
} as const satisfies Readonly<Record<string, readonly OrderKey[]>>;

/** 列名逐段引用，方向只从固定枚举生成，保证 SQL 与声明的键、方向、顺序一一对应。 */
export function exitListOrder(name: keyof typeof EXIT_LIST_ORDER_KEYS) {
  const keys = EXIT_LIST_ORDER_KEYS[name];
  const order = sql.join(
    keys.map(([column, direction]) => {
      const identifier = sql.join(column.split('.').map(sql.identifier), sql`.`);
      return sql`${identifier} ${direction === 'ASC' ? sql`ASC` : sql`DESC`}`;
    }),
    sql`, `,
  );
  return { keys, order };
}
