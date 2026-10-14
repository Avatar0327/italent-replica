import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('AC-FE-F114 合入页面后，相对模块引用仍可解析（含仅类型导入）', () => {
  const root = resolve('apps/web/src');
  const configPath = resolve('apps/web/tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve('apps/web'));
  const missing: string[] = [];
  for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (!/\.tsx?$/.test(file)) continue;
    const path = resolve(root, file);
    for (const { fileName } of ts.preProcessFile(readFileSync(path, 'utf8')).importedFiles) {
      if (!fileName.startsWith('.') || !fileName.endsWith('.js')) continue;
      if (!ts.resolveModuleName(fileName, path, options, ts.sys).resolvedModule)
        missing.push(`${relative(root, path)} → ${fileName}`);
    }
  }
  expect(missing).toEqual([]);
});
