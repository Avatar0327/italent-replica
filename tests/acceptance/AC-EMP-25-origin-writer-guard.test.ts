import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const insertPayload = /\binsert\s+into\s+(?:(?:"?\w+"?)\.)?"?employment_payload_versions\b/i;

it('AC-EMP-25 生产载荷追加必须经统一入口并声明来源', () => {
  const violations: string[] = [];
  for (const source of ['apps/api/src', 'apps/web/src', 'packages']) {
    for (const file of readdirSync(join(root, source), { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !/\.(?:ts|tsx|sql)$/.test(file.name) || /\.test\.tsx?$/.test(file.name)) continue;
      const path = join(file.parentPath, file.name);
      if (/(?:^|[/\\])(?:dist|node_modules)(?:[/\\]|$)/.test(relative(root, path))) continue;
      const content = readFileSync(path, 'utf8');
      const name = relative(root, path);
      if (file.name.endsWith('.sql')) {
        if (insertPayload.test(content)) violations.push(`${name}：直接插入载荷版本`);
        continue;
      }
      const syntax = ts.createSourceFile(name, content, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const [, table, , options] = node.arguments;
          const location = `${name}:${syntax.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
          if (
            node.expression.getText() === 'insertEmploymentRow' &&
            table?.getText().slice(1, -1) === 'employment_payload_versions'
          ) {
            const hasOrigins =
              options &&
              ts.isObjectLiteralExpression(options) &&
              options.properties.some((property) => property.name?.getText() === 'origins');
            if (!hasOrigins) violations.push(`${location}：载荷写点未声明 origins`);
          }
          if (
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'insert' &&
            node.arguments[0]?.getText().split('.').at(-1) === 'employmentPayloadVersions'
          ) {
            violations.push(`${location}：绕过统一入口插入载荷`);
          }
        }
        if (
          (ts.isStringLiteral(node) || ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
          insertPayload.test(node.getText())
        ) {
          violations.push(
            `${name}:${syntax.getLineAndCharacterOfPosition(node.getStart()).line + 1}：直接插入载荷版本`,
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(syntax);
    }
  }
  expect(violations).toEqual([]);
});
