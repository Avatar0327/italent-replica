/**
 * DEC-454① / DEC-344：CI 模式判定 scripts/ci-classify.sh 的回归测试。
 * 在临时 git 仓库里按 GitHub 的方式造“测试合并提交”（HEAD^1 = base 分支头、HEAD^2 = PR 头）再调用脚本。
 * 重点（第 2 轮 P2-1）：从功能分支切出、只加文档的 PR，目标分支是功能分支时不得判 docs；
 * 把目标分支改成 main 后同一个头提交仍不能拿到“纯文档”绿灯。
 * DEC-458：队首完整运行由队列关闭再重开 PR 触发（reopened 的 pull_request 运行，带 queue-head 标签）。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/ci-classify.sh', import.meta.url));
const CI_YML = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));
let dir = '';

const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  }).trim();

function commitFile(file: string, text: string): string {
  writeFileSync(path.join(dir, file), text);
  git('add', '--', file);
  git('commit', '-q', '-m', file);
  return git('rev-parse', 'HEAD');
}

/** 模拟 GitHub 的测试合并提交：检出 base 头，合入 PR 头（无冲突）。 */
function testMerge(base: string, head: string): void {
  git('checkout', '-q', '--detach', base);
  git('merge', '-q', '--no-ff', '-m', 'test merge', head);
}

function classify(env: Record<string, string>): string {
  const out = execFileSync('bash', [SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.trim().split('\n').at(-1) ?? '';
}

let main = '';
let feature = '';
let docsOffFeature = '';
let docsOffMain = '';
let codeOffMain = '';

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ci-classify-'));
  git('init', '-q', '-b', 'main');
  main = commitFile('app.ts', 'export const a = 1;\n');
  // 功能分支 B：未经完整测试的业务代码
  git('checkout', '-q', '-b', 'feature');
  feature = commitFile('feature.ts', 'export const b = 2;\n');
  // H：从 B 切出，只加文档
  git('checkout', '-q', '-b', 'docs-on-feature');
  docsOffFeature = commitFile('notes.md', '# 说明\n');
  git('checkout', '-q', main);
  git('checkout', '-q', '-b', 'docs-on-main');
  docsOffMain = commitFile('readme.md', '# 文档\n');
  git('checkout', '-q', main);
  git('checkout', '-q', '-b', 'code-on-main');
  codeOffMain = commitFile('app2.ts', 'export const c = 3;\n');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('scripts/ci-classify.sh', () => {
  it('非 pull_request（push main、定时、手动派发）一律完整', () => {
    expect(classify({ EVENT_NAME: 'push', BASE_REF: '' })).toBe('mode=full');
    expect(classify({ EVENT_NAME: 'workflow_dispatch', BASE_REF: '' })).toBe('mode=full');
  });

  it('目标为 main 的纯文档 PR 判 docs；代码 PR 判 light，带 queue-head 判 full', () => {
    testMerge(main, docsOffMain);
    expect(classify({ EVENT_NAME: 'pull_request', BASE_REF: 'main', QUEUE_HEAD: 'false' })).toBe('mode=docs');
    testMerge(main, codeOffMain);
    expect(classify({ EVENT_NAME: 'pull_request', BASE_REF: 'main', QUEUE_HEAD: 'false' })).toBe('mode=light');
    expect(classify({ EVENT_NAME: 'pull_request', BASE_REF: 'main', QUEUE_HEAD: 'true' })).toBe('mode=full');
  });

  it('P2-1 回归：功能分支上只加文档的 PR 不判 docs，改 base 为 main 后同一头提交也不判 docs', () => {
    // H → B：相对 B 只有文档，但目标不是 main，必须 light（不以必需名称报告）
    testMerge(feature, docsOffFeature);
    expect(git('diff', '--name-only', 'HEAD^1', 'HEAD')).toBe('notes.md');
    expect(classify({ EVENT_NAME: 'pull_request', BASE_REF: 'feature', QUEUE_HEAD: 'false' })).toBe('mode=light');
    // 非 main 目标上 queue-head 也不生效
    expect(classify({ EVENT_NAME: 'pull_request', BASE_REF: 'feature', QUEUE_HEAD: 'true' })).toBe('mode=light');
    // 改 base 为 main：同一个 H，相对 main 含 B 的代码，判 light
    testMerge(main, docsOffFeature);
    expect(git('rev-parse', 'HEAD^2')).toBe(docsOffFeature);
    expect(classify({ EVENT_NAME: 'pull_request', BASE_REF: 'main', QUEUE_HEAD: 'false' })).toBe('mode=light');
    expect(feature).not.toBe(docsOffFeature);
  });

  it('目标分支为空（取不到 base_ref）按 light 处理', () => {
    testMerge(main, docsOffMain);
    expect(classify({ EVENT_NAME: 'pull_request', BASE_REF: '' })).toBe('mode=light');
  });

  it('DEC-458：关闭重开 PR（reopened）带 queue-head 标签走完整模式，不带标签仍轻量', () => {
    testMerge(main, codeOffMain);
    const reopened = { EVENT_NAME: 'pull_request', EVENT_ACTION: 'reopened', BASE_REF: 'main' };
    expect(classify({ ...reopened, QUEUE_HEAD: 'true' })).toBe('mode=full');
    expect(classify({ ...reopened, QUEUE_HEAD: 'false' })).toBe('mode=light');
    // 纯文档 PR 重开仍是 docs（标签不改变纯文档判定）
    testMerge(main, docsOffMain);
    expect(classify({ ...reopened, QUEUE_HEAD: 'true' })).toBe('mode=docs');
  });

  it('DEC-458：ci.yml 监听 reopened，queue-head 取自 pull_request 事件里的标签', () => {
    const yml = readFileSync(CI_YML, 'utf8');
    const types = /pull_request:\n(?:\s*#.*\n)*\s*types: \[([^\]]*)\]/
      .exec(yml)?.[1]
      ?.split(',')
      .map((t) => t.trim());
    expect(types).toEqual(expect.arrayContaining(['opened', 'synchronize', 'reopened', 'ready_for_review']));
    // 不监听 labeled：只打标签不触发运行，必须关闭重开或推送
    expect(types).not.toContain('labeled');
    expect(yml).toContain("QUEUE_HEAD: ${{ contains(github.event.pull_request.labels.*.name, 'queue-head') }}");
    expect(yml).toContain('BASE_REF: ${{ github.base_ref }}');
  });
});
