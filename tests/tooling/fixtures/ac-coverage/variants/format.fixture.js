// 标题格式化：编号只按 Vitest 格式化后的真实标题计（DEC-254；#91 第 5 轮 P2-4）。
import { it } from 'vitest';

const fn = () => {};

it.each(['AC-DEMO-01'])('%s', fn);
it.each(['AC-DEMO-02'])('%d', fn);
it.each([{ ac: 'AC-DEMO-03' }])('$ac', fn);
it.each([{ 0: 'AC-DEMO-04', ac: 'AC-DEMO-05' }])('$0', fn);
it.each([['DEMO', '06']])('AC-%s-%s', fn);
it.each(['2'])('AC-DEMO-07%s', fn);
it.each([{ ac: `${'x'.repeat(60)} AC-DEMO-08` }])('$ac', fn);
it.each([null, null])('AC-DEMO-1%#', fn);
it.each([null])('AC-DEMO-10%$', fn);
it.each(['AC-DEMO-12', ' /13'])('%s', fn);
it.each([{ nested: { ac: 'AC-DEMO-14' } }])('$nested.ac', fn);
it.each(['AC-DEMO-15'])('%i', fn);
it('控制用例', fn);
