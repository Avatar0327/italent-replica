/**
 * F-082 AC-23（F082-5 第 1 轮 P2-1）：所有后台入口的数据库连接都要带 application_name（`italent-api:<APP_VERSION>`）——
 * 部署检查脚本（首次启用、之后每次部署 / 恢复）靠它数目标库上的应用连接，漏设的入口会被漏数。
 * 源码扫描：apps/api/src 与 packages/db/scripts 里每个创建连接的调用（createPgDb( / postgres(）都必须设置它。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCAN = ['apps/api/src', 'packages/db/scripts', 'packages/db/src'];
const CALL = /\b(createPgDb|postgres)\(\s*[a-zA-Z_.]+/g;
/** 定义连接工厂本身的文件：application_name 由调用方通过选项传入，工厂里按选项设置。 */
const FACTORY = 'packages/db/src/client.ts';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.(ts|mjs)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

describe('AC-23 所有后台入口的数据库连接都设置了 application_name', () => {
  it('每个 createPgDb( / postgres( 调用都带 applicationName / application_name', () => {
    const missing: string[] = [];
    for (const file of SCAN.flatMap((dir) => sources(join(ROOT, dir)))) {
      const name = relative(ROOT, file);
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(CALL)) {
        // 函数定义（export function createPgDb(url…）不是调用
        if (text.slice(Math.max(0, match.index - 16), match.index).includes('function ')) continue;
        const call = text.slice(match.index, text.indexOf(';', match.index));
        const ok = /applicationName|application_name/.test(call) || (name === FACTORY && call.includes('options'));
        if (!ok) missing.push(`${name}: ${call.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
