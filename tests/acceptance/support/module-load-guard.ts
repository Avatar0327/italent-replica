/**
 * F-512：模块首入口加载守卫的公共部分。
 * apps/api/src/modules 下的非测试源文件按字典序枚举，分到若干分片；每个文件一个用例，
 * 用例在全新的模块图里（vi.resetModules）以该文件为首个入口动态加载。
 * 模块环上顶层求值若读了环上别的模块尚未初始化的导出（TDZ / 读到 undefined），只有当它恰好不是第一个被求值的
 * 成员时才会崩，所以必须逐个入口各试一次，不能依赖测试文件的导入顺序（同 F-476 P4 的 AC-F476-13）。
 */
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const MODULES_DIR = resolve(import.meta.dirname, '../../../apps/api/src/modules');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });
}

/** 全部模块的相对路径（相对 modules 目录，字典序）。 */
export function listApiModules(): string[] {
  return walk(MODULES_DIR)
    .map((file) => relative(MODULES_DIR, file).split('\\').join('/'))
    .sort();
}

/** 在当前测试文件注册第 shard 片（0 起，共 shards 片）的逐入口加载用例。 */
export function registerModuleLoadGuard(shard: number, shards: number): void {
  const all = listApiModules();
  const mine = all.filter((_, index) => index % shards === shard);
  describe(`F-512 模块首入口加载守卫 分片 ${shard + 1}/${shards}（共 ${all.length} 个模块）`, () => {
    it('分片非空', () => expect(mine.length).toBeGreaterThan(0));
    it.each(mine)('首个入口 %s', async (module) => {
      vi.resetModules();
      await expect(import(/* @vite-ignore */ join(MODULES_DIR, module))).resolves.toBeDefined();
    });
  });
}
