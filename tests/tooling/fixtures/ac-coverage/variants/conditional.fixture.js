// 条件执行：AC_FIXTURE_PG 模拟 TEST_DATABASE_URL，两档收集分别决定 run / skip。
import { describe, it } from 'vitest';

const fn = () => {};
const pg = Boolean(process.env.AC_FIXTURE_PG);

describe.runIf(pg)('AC-DEMO-90', () => it('仅真 PG', fn));
it.skipIf(pg)('AC-DEMO-91 仅 PGlite', fn);
it('AC-DEMO-92 两档都跑', fn);
it.runIf(pg)('AC-DEMO-92 仅真 PG 的补充用例', fn);
it('AC-DEMO-99 引用未定义编号', fn);
it('AC-DEMO-97 已登记的非业务编号', fn);
