/**
 * F-141 任职分类（DEC-500）：补登记“任职分类”维护页——任职资格页签里增加分类的列表 / 新建 / 编辑，
 * 按 F-125 口径只改本模块的资源登记与注释登记。字段取自后端契约（category-classes：编码、名称、上级分类、顺序号、启用、向下公开）；
 * 原站该页的列与交互证据不足，页面复用任职类别 / 级别同一套目录页，不自创交互。
 */
import { QUALIFICATION_OBJECTS } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { notes } from '../../apps/web/src/qualification/annotations.js';
import { qualificationResources } from '../../apps/web/src/qualification/resources.js';
import { resourcePath, validateValues } from '../../apps/web/src/talent/catalog/api.js';

const classes = () => qualificationResources.find((r) => r.key === 'category-classes');

describe('AC-F141-qualification-class-page 任职分类维护页登记（DEC-500）', () => {
  it('登记了任职分类资源：路径、对象、归属管理单元（owner）与后端契约一致', () => {
    const resource = classes();
    expect(resource).toBeDefined();
    expect(resourcePath(resource!)).toBe('/api/tenant/qualification/category-classes');
    expect(resource!.object).toBe(QUALIFICATION_OBJECTS.categoryClass.code);
    expect(resource!.owner).toBe('categoryClass');
    expect(resource!.title).toBe('任职分类');
  });

  it('列与表单字段都是该对象目录里的字段；名称必填，上级分类只能在新建时选', () => {
    const resource = classes()!;
    const known = new Set(QUALIFICATION_OBJECTS.categoryClass.fields.map((f) => f.code));
    for (const key of [...resource.columns, ...resource.fields.map((f) => f.key)]) expect(known.has(key), key).toBe(true);
    expect(resource.fields.find((f) => f.key === 'name')?.required).toBe(true);
    const parent = resource.fields.find((f) => f.key === 'parentId')!;
    expect(parent).toMatchObject({ kind: 'select', createOnly: true, nullable: true });
    expect(parent.source).toBe('/api/tenant/qualification/category-classes');
    expect(() => validateValues(resource, { name: '  ' })).toThrow();
  });

  it('分类放在类别之前（类别按分类组织）；每个资源的注释登记都在本模块注释里', () => {
    const keys = qualificationResources.map((r) => r.key);
    expect(keys.indexOf('category-classes')).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf('category-classes')).toBeLessThan(keys.indexOf('categories'));
    for (const resource of qualificationResources) expect(notes[resource.note], resource.note).toBeDefined();
  });
});
