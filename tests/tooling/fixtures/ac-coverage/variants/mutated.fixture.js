// 被修改的常量表、对象覆盖、原型属性与 undefined 遮蔽（#91 第 5 轮 P2-1～P2-3）。
/* eslint-disable no-dupe-keys, no-shadow-restricted-names -- 夹具故意使用这些写法 */
import { describe, it } from 'vitest';

const fn = () => {};

const rows1 = [{ ac: 'AC-DEMO-70' }];
rows1[0].ac = 'AC-DEMO-71';
it.each(rows1)('$ac', fn);

const rows2 = [{ ac: 'AC-DEMO-72' }];
rows2.length = 0;
it.each(rows2)('$ac', fn);

const rows3 = [{ ac: 'AC-DEMO-73' }];
rows3.push({ ac: 'AC-DEMO-74' });
it.each(rows3)('$ac', fn);

const rows4 = [{ ac: 'AC-DEMO-75' }];
rows4.splice(0, 1, { ac: 'AC-DEMO-76' });
it.each(rows4)('$ac', fn);

let rows5 = [{ ac: 'AC-DEMO-77' }];
[rows5] = [[{ ac: 'AC-DEMO-78' }]];
it.each(rows5)('$ac', fn);

const rows6 = [{ ac: 'AC-DEMO-79' }];
Object.defineProperty(rows6[0], 'ac', { value: 'AC-DEMO-80' });
it.each(rows6)('$ac', fn);

it.each([{ ac: 'AC-DEMO-81', ...{ ac: 'AC-DEMO-82' } }])('$ac', fn);
it.each([
  {
    ac: 'AC-DEMO-83',
    get ac() {
      return 'AC-DEMO-84';
    },
  },
])('$ac', fn);
it.each([{ __proto__: { ac: 'AC-DEMO-85' } }])('$ac', fn);

describe('遮蔽', () => {
  const undefined = 'AC-DEMO-86';
  it.each([undefined])('%s', fn);
});

const mutate = (rows) => {
  rows[0].ac = 'AC-DEMO-88';
};
const rows7 = [{ ac: 'AC-DEMO-87' }];
mutate(rows7);
it.each(rows7)('$ac', fn);
