import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('AC-EV-conditions：类别 / 级别引用守卫可生成声明，不暴露无法命名的私有类型', () => {
  const configPath = resolve('apps/api/tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve('apps/api'), {
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
  });
  expect(parsed.errors).toEqual([]);
  const sourcePath = resolve('apps/api/src/modules/qualification/reference-usage.ts');
  const program = ts.createProgram([sourcePath], parsed.options);
  const source = program.getSourceFile(sourcePath);
  expect(source).toBeDefined();
  const declarations: string[] = [];
  const result = program.emit(source, (_file, content) => declarations.push(content), undefined, true);
  const diagnostics = result.diagnostics.map((item) => ({
    code: item.code,
    message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
  }));
  expect(diagnostics).toEqual([]);
  expect(result.emitSkipped).toBe(false);
  expect(declarations).toHaveLength(1);
});
