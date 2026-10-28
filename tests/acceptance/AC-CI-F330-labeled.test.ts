/** DEC-694②：直接读取 workflow 的条件、名称、并发键和汇总 shell，验证 labeled 隔离与既有门禁。 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const jobs = workflow.slice(workflow.indexOf('\njobs:\n'));
const required = ['lint / typecheck / test (PGlite, Node 24)', 'test (PostgreSQL 16)'];

function job(id: string): string {
  const body = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, 'm').exec(jobs)?.[1];
  if (!body) throw new Error(`未找到 job ${id}`);
  return body;
}

function scalar(body: string, key: string, indent: number): string {
  const match = new RegExp(`^ {${indent}}${key}: (.*)(?:\\n((?: {${indent + 2}}.*\\n)*))?`, 'm').exec(body);
  const value = match?.[1];
  if (value === undefined) throw new Error(`未找到 ${key}`);
  return value === '>-' ? (match?.[2] ?? '').trim().replace(/\s*\n\s*/g, ' ') : value;
}

function context(action = 'labeled', label = 'queue-head', mode = 'full', event = 'pull_request', draft = false) {
  return {
    github: {
      event_name: event,
      run_id: 101,
      ref: 'refs/heads/main',
      event: { action, label: { name: label }, pull_request: { number: 330, draft } },
    },
    needs: { changes: { outputs: { mode }, result: mode ? 'success' : 'skipped' } },
    matrix: { node: 24, shard: 1 },
    always: () => true,
    format: (template: string, ...args: unknown[]) => template.replace(/\{(\d+)\}/g, (_, i) => String(args[+i])),
  };
}

// 本文件只求值受信任仓库内的布尔/字符串表达式子集；不模拟 Actions 调度器或网络。
function evaluate(expression: string, ctx = context()): unknown {
  return runInNewContext(expression, ctx, { timeout: 1000 });
}
function render(template: string, ctx = context()): string {
  return template.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) => String(evaluate(expression, ctx)));
}
function enabled(id: string, ctx = context()): unknown {
  return evaluate(scalar(job(id), 'if', 4).replace(/^\$\{\{\s*|\s*\}\}$/g, ''), ctx);
}
function checkNames(ctx = context()): string[] {
  return ['check', 'test-pg'].map((id) => render(scalar(job(id), 'name', 4), ctx));
}
function group(ctx = context()): string {
  return render(scalar(workflow, 'group', 2), ctx);
}

function aggregate(id: string, env: Record<string, string>): number | null {
  const script = / {8}run: \|\n((?: {10}.*\n|\n)*)/.exec(job(id))?.[1];
  if (!script) throw new Error(`未找到 ${id} 汇总脚本`);
  return spawnSync('bash', ['-c', script.replace(/^ {10}/gm, '')], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  }).status;
}

describe('AC-CI-F330 labeled 触发与隔离', () => {
  it('DEC-694②：queue-head labeled 进入原 PR 并发组，正常推送仍可取消旧运行', () => {
    expect(group()).toBe('ci-330');
    expect(group(context('synchronize', '', 'full'))).toBe(group());
    expect(workflow).toContain('cancel-in-progress: true');
    expect(enabled('changes')).toBe(true);
    expect(checkNames()).toEqual(required);
    expect(render(scalar(job('changes'), 'name', 4))).toBe('classify changes');
    expect(render(scalar(job('light'), 'name', 4))).toBe('light checks (lint / typecheck / build / unit, Node 24)');
    expect(render(scalar(job('check-shards'), 'name', 4))).toBe('test (PGlite, Node 24, shard 1/5)');
  });

  it.each(['reviewed', 'queue-head-extra', ''])('DEC-694②：其他标签 %s 隔离且所有入口跳过，不占必需检查名', (label) => {
    const ignored = context('labeled', label, '');
    expect(group(ignored)).not.toBe(group());
    const next = context('labeled', label, '');
    next.github.run_id++;
    expect(group(next)).not.toBe(group(ignored));
    for (const id of ['changes', 'check', 'test-pg']) expect(enabled(id, ignored)).toBe(false);
    for (const name of checkNames(ignored)) expect(required).not.toContain(name);
    for (const id of [
      'changes',
      'light',
      'check-shards',
      'test-pg-shards',
      'test-pg-app-role-shards',
      'test-pg-race',
    ]) {
      expect(render(scalar(job(id), 'name', 4), ignored)).not.toBe(render(scalar(job(id), 'name', 4)));
    }
    // 其余 job 依赖 changes 的成功，不能带 always() 绕过已跳过的分类 job。
    for (const id of ['light', 'check-shards', 'test-pg-shards', 'test-pg-app-role-shards', 'test-pg-race']) {
      expect(scalar(job(id), 'needs', 4)).toBe('changes');
      expect(scalar(job(id), 'if', 4)).not.toMatch(/always\(|!cancelled\(/);
    }
  });

  it.each(['opened', 'synchronize', 'reopened', 'ready_for_review'])(
    'DEC-454①：常规 %s 事件名称与分类失败行为不变',
    (action) => {
      expect(checkNames(context(action, '', 'full'))).toEqual(required);
      expect(checkNames(context(action, '', 'docs'))).toEqual(required);
      expect(checkNames(context(action, '', ''))).toEqual(required);
      for (const name of checkNames(context(action, '', 'light'))) expect(required).not.toContain(name);
      expect(enabled('check', context(action, '', ''))).toBe(true);
    },
  );

  it('DEC-344 / DEC-454①：Draft 不跑，main / 定时 / 手动仍用既有组与必需名', () => {
    for (const id of ['changes', 'check', 'test-pg'])
      expect(enabled(id, context('labeled', 'queue-head', '', 'pull_request', true))).toBe(false);
    for (const event of ['push', 'schedule', 'workflow_dispatch']) {
      const ctx = context('', '', 'full', event);
      // 非 PR payload 没有 number；Actions 空属性以空串参与求值。
      Object.assign(ctx.github.event.pull_request, { number: '' });
      expect(group(ctx)).toBe('ci-refs/heads/main');
      expect(checkNames(ctx)).toEqual(required);
      expect(enabled('changes', ctx)).toBe(true);
    }
  });

  it('DEC-454①：full 汇总要求每个依赖成功，失败/取消/跳过/分类失败均不放行', () => {
    for (const id of ['check', 'test-pg']) {
      const env = {
        CHANGES_RESULT: 'success',
        MODE: 'full',
        LIGHT_RESULT: 'success',
        SHARDS_RESULT: 'success',
        APP_ROLE_SHARDS_RESULT: 'success',
        RACE_RESULT: 'success',
      };
      expect(aggregate(id, env)).toBe(0);
      const keys =
        id === 'check'
          ? ['CHANGES_RESULT', 'LIGHT_RESULT', 'SHARDS_RESULT']
          : ['CHANGES_RESULT', 'SHARDS_RESULT', 'APP_ROLE_SHARDS_RESULT', 'RACE_RESULT'];
      for (const key of keys)
        for (const result of ['failure', 'cancelled', 'skipped']) {
          expect(aggregate(id, { ...env, [key]: result })).not.toBe(0);
        }
      expect(aggregate(id, { ...env, MODE: '' })).not.toBe(0);
    }
  });

  it('DEC-344：docs 汇总只允许跳过分片，light 继续使用原校验', () => {
    for (const mode of ['docs', 'light']) {
      const env = {
        CHANGES_RESULT: 'success',
        MODE: mode,
        LIGHT_RESULT: mode === 'docs' ? 'skipped' : 'success',
        SHARDS_RESULT: 'skipped',
        APP_ROLE_SHARDS_RESULT: 'skipped',
        RACE_RESULT: 'skipped',
      };
      for (const id of ['check', 'test-pg']) {
        expect(aggregate(id, env)).toBe(0);
        expect(aggregate(id, { ...env, SHARDS_RESULT: 'failure' })).not.toBe(0);
      }
    }
  });
});
