import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const { StandardCells } = await import(resolve('apps/web/src/talent/catalog/ResourceDetail.tsx'));

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement } = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');

it('AC-FE-R3a P2-2 指标格与能力条目的目标权重分别渲染，空值和零不互相覆盖', () => {
  const cells = [
    {
      targetId: 'target',
      targetValue: '80',
      weight: 45,
      abilities: [
        { content: '空值能力', targetValue: null, weight: null },
        { content: '零值能力', targetValue: '0', weight: 0 },
      ],
    },
  ];
  const before = JSON.stringify(cells);
  const html = renderToStaticMarkup(createElement(StandardCells, { cells }));
  expect(html).toContain('指标目标值');
  expect(html).toContain('能力目标值');
  expect(html).toContain('>80<');
  expect(html).toContain('>45<');
  expect(html).toContain('>0<');
  expect(JSON.stringify(cells)).toBe(before);
});

it('AC-FE-R3a P2-3 目标等级独立列保留等级引用，名称未加载时不显示为空值', () => {
  const html = renderToStaticMarkup(
    createElement(StandardCells, {
      cells: [
        {
          targetId: 'target',
          abilities: [{ content: '评级能力', targetGradeId: 'grade-id' }],
        },
      ],
    }),
  );
  expect(html).toContain('目标等级');
  expect(html).toContain('grade-id');
});
