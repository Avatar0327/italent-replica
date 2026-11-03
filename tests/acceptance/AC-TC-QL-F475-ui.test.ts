import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormOverlayProps } from '../../apps/web/src/foundation/FormOverlay.js';
import type { ObjectPermission } from '../../apps/web/src/foundation/permission-model.js';
import type { Resource, Row } from '../../apps/web/src/talent/catalog/types.js';

const state = vi.hoisted(() => ({ row: { id: 'synthetic', revision: 1, name: '合成标准' } as Row }));
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h } = requireWeb('react');
const { renderToStaticMarkup: render } = requireWeb('react-dom/server');
vi.mock('../../apps/web/src/talent/catalog/hooks.js', () => ({
  useReferenceNames: () => ({ data: new Map(), loading: false }),
  useRemote: (key: string) => ({
    loading: false,
    data: key.startsWith('list:')
      ? { items: [state.row], total: 1 }
      : key.startsWith('form:')
        ? { options: {}, owners: [{ id: 'owner', name: '合成组织' }] }
        : key.startsWith('detail:')
          ? state.row
          : undefined,
  }),
}));
vi.mock('../../apps/web/src/foundation/DecisionNote.js', () => ({ DecisionNote: () => null }));
vi.mock('../../apps/web/src/foundation/forms/useCommandForm.js', () => ({ useCommandForm: () => ({}) }));
vi.mock('../../apps/web/src/foundation/FormOverlay.js', () => ({
  FormOverlay: (props: FormOverlayProps) =>
    h(
      'section',
      { 'data-mode': props.mode },
      props.groups.map((group) =>
        h(
          'fieldset',
          { key: group.title },
          h('legend', null, group.title),
          group.fields
            .filter((field) => field.access.visible)
            .map((field) => h('label', { key: field.name }, field.label, field.control)),
        ),
      ),
    ),
}));
const { talentResources } = await import(resolve('apps/web/src/talent/catalog/resources.ts'));
const { qualificationResources } = await import(resolve('apps/web/src/qualification/resources.ts'));
const { ResourcePage } = await import(resolve('apps/web/src/talent/catalog/ResourcePage.tsx'));
const { ResourceDetail } = await import(resolve('apps/web/src/talent/catalog/ResourceDetail.tsx'));
const { ResourceForm } = await import(resolve('apps/web/src/talent/catalog/ResourceForm.tsx'));
const all = [...talentResources, ...qualificationResources] as Resource[];
const permission: ObjectPermission = {
  objectCode: '',
  dataOperations: { view: true, create: true, update: true },
  viewableFields: [
    'name',
    'code',
    'enabled',
    'type',
    'classId',
    'categoryId',
    'layerId',
    'displayOrder',
    'jobLinkType',
    'jobLinks',
    'createdBy',
    'createdAt',
    'description',
    'typeId',
    'details',
    'dimensions',
    'levelIds',
    'definition',
    'targetValue',
    'weight',
    'abilityNote',
    'potentialNote',
    'experienceNote',
    'achievementNote',
    'isCommon',
    'evalMode',
    'gradeSchemeId',
    'publicDown',
  ],
  editableFields: ['name', 'code', 'enabled', 'description', 'details', 'typeId', 'evalMode', 'categoryId'],
  buttons: [
    { buttonCode: 'create', level: 'list' },
    { buttonCode: 'update', level: 'detail' },
  ],
};
const resource = (module: string, key: string) => {
  const found = all.find((r) => r.module === module && r.key === key);
  expect(found, `${module}/${key} 必须有页面`).toBeDefined();
  return found!;
};
const headers = (html: string) =>
  [...(html.match(/<thead\b[^>]*>[\s\S]*?<\/thead>/)?.[0] ?? '').matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)]
    .map((match) =>
      match[1]!
        .replace(/<[^>]*>/g, '')
        .replace(/&[^;]+;/g, '')
        .trim(),
    )
    .filter(Boolean);
beforeEach(() => {
  state.row = { id: 'synthetic', revision: 1, name: '合成标准', enabled: true };
});

describe('AC-TC / AC-QL F-475 R3a 列表真实渲染', () => {
  it.each([
    ['talent', 'criteria', ['名称', '分类', '状态', '创建人', '创建时间', '操作']],
    ['talent', 'libraries', ['指标库名称', '指标库说明', '状态', '类型', '创建人', '创建时间', '操作']],
    ['talent', 'criterion-categories', ['分类名称', '说明', '状态', '创建人', '创建时间', '操作']],
    ['qualification', 'categories', ['名称', '编码', '所属分类', '关联岗职务类型', '关联岗职务数据', '操作']],
    ['qualification', 'levels', ['名称', '编码', '顺序号', '层级', '关联岗职务类型', '关联岗职务数据', '操作']],
    ['qualification', 'standards', ['名称', '所属分类', '任职类别', '生效日期', '状态', '操作']],
    ['qualification', 'targets', ['名称', '编码', '指标类型', '指标说明', '顺序号', '状态', '操作']],
    ['qualification', 'grade-schemes', ['名称', '描述', '操作']],
  ])('%s/%s 表头与顺序', (module, key, expected) => {
    const html = render(h(ResourcePage, { resource: resource(module as string, key as string), permission }));
    expect(headers(html)).toEqual(expected);
    expect(html).not.toContain('ant-tag-green');
  });
  it('标准列宽按证据分配，筛选入口按名称、状态、分类排列', () => {
    const html = render(h(ResourcePage, { resource: resource('talent', 'criteria'), permission }));
    expect(html).toContain('width:199px');
    expect(html).toContain('width:217px');
    expect(html).toContain('aria-label="名称"');
    expect(html).toContain('aria-label="状态"');
    expect(html).toContain('aria-label="分类"');
  });
  it('字段裁剪后不渲染对应列或筛选入口', () => {
    const html = render(
      h(ResourcePage, {
        resource: resource('talent', 'criteria'),
        permission: { ...permission, viewableFields: ['name'] },
      }),
    );
    expect(headers(html)).toEqual(['名称', '操作']);
    expect(html).not.toContain('aria-label="状态"');
    expect(html).not.toContain('aria-label="分类"');
  });
});

describe('AC-TC / AC-QL F-475 详情与表单结构', () => {
  it.each([
    ['talent', 'criteria'],
    ['qualification', 'standards'],
  ])('%s/%s 为整页详情并提供返回', (module, key) => {
    const html = render(
      h(ResourceDetail, { resource: resource(module!, key!), id: state.row.id, permission, onClose() {} }),
    );
    expect(html).toContain('catalog-detail-page');
    expect(html).toContain('合成标准');
    expect(html).toContain('返回');
    expect(html).not.toContain('role="dialog"');
  });
  it('人才标准新增与编辑均为居中弹窗', () => {
    for (const original of [null, state.row]) {
      const html = render(
        h(ResourceForm, { resource: resource('talent', 'criteria'), original, permission, onClose() {}, onSaved() {} }),
      );
      expect(html).toContain('data-mode="modal"');
    }
  });
  it('等级方案编辑包含等级方案信息和等级明细', () => {
    const html = render(
      h(ResourceForm, {
        resource: resource('qualification', 'grade-schemes'),
        original: { ...state.row, details: [] },
        permission,
        onClose() {},
        onSaved() {},
      }),
    );
    expect(html).toContain('data-mode="modal"');
    expect(html).toContain('等级方案信息');
    expect(html).toContain('等级明细');
  });
});
