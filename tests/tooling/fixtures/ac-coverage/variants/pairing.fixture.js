// 跨档配对：同名用例只在一档注册时，不能按同名序号与另一档的用例错配（#102 第 1 轮 P2-2）。
import { it } from 'vitest';

const fn = () => {};
const pg = Boolean(process.env.AC_FIXTURE_PG);

if (pg) it.skip('AC-DEMO-116 同名用例', fn);
it('AC-DEMO-116 同名用例', fn);

it.skip('AC-DEMO-117 反向同名', fn);
if (pg) it('AC-DEMO-117 反向同名', fn);
