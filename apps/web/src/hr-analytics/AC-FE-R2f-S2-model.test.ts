import { HR_STRUCTURE_COMPONENTS, type HrStructureCode } from '@italent/domain';
import { expect, it } from 'vitest';
import { structureCards, structureDetailUrl, structureOrgUrl, structureOverviewUrl } from './structure-model.js';

const asOf = '2026-10-01';
const filters = { asOf, institutionId: 'ZZ_FER2F_inst', departmentId: 'ZZ_FER2F_dept' };
const params = (path: string) => Object.fromEntries(new URL(path, 'https://example.com').searchParams);

it('AC-FE-R2f-03 两个包含下级分别默认 true，准确传 false，空组织省略开关', () => {
  expect(params(structureOverviewUrl(filters))).toEqual({
    ...filters,
    institutionIncludeChildren: 'true',
    departmentIncludeChildren: 'true',
  });
  expect(
    params(
      structureOverviewUrl({
        ...filters,
        institutionIncludeChildren: 'false',
        departmentIncludeChildren: 'false',
        ignored: 'ZZ_FER2F_unknown',
      }),
    ),
  ).toEqual({ ...filters, institutionIncludeChildren: 'false', departmentIncludeChildren: 'false' });
  expect(params(structureOverviewUrl({ asOf, institutionIncludeChildren: 'false' }))).toEqual({ asOf });
});

it('AC-FE-R2f-03 已应用条件原样传详细页，分组用回执的键，传人员类别名称与用工形式编码', () => {
  const draft = { asOf, employmentForm: 'ZZ_FER2F_A+B/01', employmentType: 'ZZ_FER2F_类别 & 名称' };
  expect(params(structureOverviewUrl(draft))).toEqual(draft);
  expect(params(structureDetailUrl('6.14', draft, 2, '空/ & +'))).toEqual({
    ...draft,
    group: '空/ & +',
    page: '2',
    pageSize: '20',
  });
  expect(params(structureDetailUrl('6.05', draft, 1, ''))).toHaveProperty('group', '');
  expect(params(structureDetailUrl('6.02', draft, 1))).not.toHaveProperty('group');
  expect(params(structureOrgUrl(asOf))).toEqual({ object: 'HrStructure', asOf });
});

it('AC-FE-R2f-03 平均卡对 count、前二十柱不重算总人数、占比条展示全量机构的各自分子分母', () => {
  const groups = Array.from({ length: 21 }, (_, n) => ({
    key: `ZZ_FER2F_${n}`,
    label: `机构 ${n}`,
    count: 2,
    total: 7,
    ratio: 0.2857,
  }));
  const components = HR_STRUCTURE_COMPONENTS.map((component) => {
    const code: HrStructureCode = component.code;
    if (code === '6.04') return { ...component, value: 42, groups: groups.slice(0, 20) };
    if (code === '6.11') return { ...component, value: 42, groups };
    if (code === '6.02') return { ...component, value: 36.3, count: 5, groups: null };
    if (code === '6.03') return { ...component, value: null, count: 0, groups: null };
    return { ...component, value: component.kind === 'unavailable' ? null : 0, groups: null };
  });
  const cards = structureCards({ asOf, hasDataPermission: true, components: components.reverse() });
  expect(cards.map(({ code }) => code)).toEqual(HR_STRUCTURE_COMPONENTS.map(({ code }) => code));
  expect(cards[1]).toMatchObject({ body: 'stat', text: '36.3 岁', wholeCount: 5 });
  expect(cards[2]).toMatchObject({ body: 'stat', text: '—', wholeCount: 0 });
  const column = cards.find(({ code }) => code === '6.04')!;
  expect(column).toMatchObject({ body: 'column', wholeCount: 42 });
  expect(column.points).toHaveLength(20);
  expect(column.points[0]).toMatchObject({ value: 2, text: '2' });
  const ratio = cards.find(({ code }) => code === '6.11')!;
  expect(ratio).toMatchObject({ body: 'bar', ratio: true });
  expect(ratio.points).toHaveLength(21);
  expect(ratio.points[20]).toMatchObject({ value: 0.2857, text: '28.57% · 2 / 7' });
  expect(cards.slice(8, 10)).toMatchObject([
    { body: 'map', wholeCount: null, points: [] },
    { body: 'map', wholeCount: null, points: [] },
  ]);
});
