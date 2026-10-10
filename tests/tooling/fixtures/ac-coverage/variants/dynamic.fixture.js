// 动态生成的用例：循环、函数返回的表、展开、拼接、带标签模板表。
import { it } from 'vitest';

const fn = () => {};

for (const n of ['60', '61']) it(`AC-DEMO-${n} 循环`, fn);
const makeRows = () => ['AC-DEMO-62'];
it.each(makeRows())('%s', fn);
const base = ['AC-DEMO-63'];
it.each([...base, 'AC-DEMO-64'])('%s', fn);
it('AC-DEMO-' + '65', fn);
it.each`
  ac
  ${'AC-DEMO-66'}
`('$ac', fn);
