import { describe, expect, it } from 'vitest';
import { collectPages, mountPath } from '../../apps/web/src/foundation/page-registry.js';
import { menuNodes, type ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';

const leaf = (id: string, objectCode = id) => ({ id, label: id, objectCode });
const group = {
  id: 'group',
  app: 'idp',
  label: '合成分组',
  group: 'talent',
  children: [leaf('z'), { ...leaf('a'), legacy: true }],
};
const collect = (entries: unknown[]) =>
  collectPages(
    {
      '../fixture/pages.ts': { pages: { apps: [{ app: 'idp', label: '应用', group: 'talent' }], entries } },
    },
    ['idp'],
  );
const snapshot = (entryObjects: string[], visible = true) =>
  ({
    apps: [{ app: 'idp', visible, entryObjects }],
  }) as ServerSnapshot;

describe('AC-FE-F190a 共享入口子菜单契约', () => {
  it('01 不带 children 的旧入口：结构、路由、权限和排序快照不变', () => {
    const registry = collect(['z', 'a'].map((id) => ({ ...leaf(id), app: 'idp', group: 'talent' })));
    expect(registry.entries).toEqual(
      ['a', 'z'].map((id) => ({
        ...leaf(id),
        app: 'idp',
        group: 'talent',
        path: `/${id}`,
        module: 'fixture',
        legacy: false,
      })),
    );
    expect(registry.entries.map(mountPath)).toEqual(['/a/*', '/z/*']);
    expect(menuNodes(registry.entries, snapshot(['z']))).toEqual([
      { key: 'z', label: 'z', path: '/z', group: 'talent' },
    ]);
  });
  it('02 子项按声明顺序独立鉴权；父组不要求额外对象权限，子项全无权限则隐藏', () => {
    const registry = collect([group]);
    expect(menuNodes(registry.entries, snapshot(['a']))).toEqual([
      {
        key: 'group',
        label: '合成分组',
        path: '/a',
        group: 'talent',
        directory: true,
        children: [{ key: 'a', label: 'a', path: '/a', group: 'talent' }],
      },
    ]);
    expect(menuNodes(registry.entries, snapshot(['a', 'z']))[0]?.children?.map((item) => item.key)).toEqual(['z', 'a']);
    expect(menuNodes(registry.entries, snapshot([]))).toEqual([]);
    expect(menuNodes(registry.entries, snapshot(['a'], false))).toEqual([]);
    expect(menuNodes(collect([{ ...group, children: [] }]).entries, snapshot(['a']))).toEqual([]);
  });
  it('03 子项继承 app / group / module，自己声明路由与 legacy；不支持更深层级或重复键', () => {
    const registry = collect([group]);
    expect(registry.entries[0]?.children).toEqual(
      ['z', 'a'].map((id) => ({
        ...leaf(id),
        app: 'idp',
        group: 'talent',
        path: `/${id}`,
        module: 'fixture',
        legacy: id === 'a',
      })),
    );
    expect(() => collect([{ ...group, children: [leaf('a'), leaf('a')] }])).toThrow(/重复/);
    expect(() => collect([group, { ...leaf('a'), app: 'idp', group: 'talent' }])).toThrow(/重复/);
    expect(() => collect([{ ...group, children: [{ ...leaf('a'), children: [leaf('b')] }] }])).toThrow(/一层/);
  });
});
