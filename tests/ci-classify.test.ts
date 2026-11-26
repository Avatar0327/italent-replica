/**
 * DEC-454① / DEC-344：CI 模式判定 scripts/ci-classify.sh 的回归测试。
 * 在临时 git 仓库里按 GitHub 的方式造“测试合并提交”（HEAD^1 = base 分支头、HEAD^2 = PR 头）再调用脚本。
 * 重点（第 2 轮 P2-1）：从功能分支切出、只加文档的 PR，目标分支是功能分支时不得判 docs；
 * 把目标分支改成 main 后同一个头提交仍不能拿到“纯文档”绿灯。
 * DEC-694②：队首完整运行由添加 queue-head 标签触发，其他 labeled 事件不得进入完整或纯文档模式。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
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

function classifyOutput(env: Record<string, string>): string[] {
  const out = execFileSync('bash', [SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.trim().split('\n');
}

/** mode 永远是最后一行（ci.yml 用 ${result##*=} 取值）。 */
function classify(env: Record<string, string>): string {
  return classifyOutput(env).at(-1) ?? '';
}

/** F-573：evidence_check 行（F090b 证据快检开关）。 */
function evidenceCheck(env: Record<string, string>): string {
  return classifyOutput(env).find((l) => l.startsWith('evidence_check=')) ?? '';
}

/**
 * F-573：从 ci.yml 文本里取出 light job 块和块内的快检步骤（找不到则为空串）。
 * 不引入 YAML 解析依赖（DEC-1006），按缩进做文本截取：job 键恰好两格缩进，后面可跟空格和行尾 # 注释。
 * 依据：YAML 块文本（run: | 等）的内容缩进必须深于父键，所以两格缩进的 job 键不会出现在任何 run 脚本之内；
 * 两格缩进的 `# key:` 独立注释以 # 开头，不匹配 job 键。块在“下一个同级 job 键或文件末尾”结束，不依赖 job 排列顺序。
 */
const JOB_KEY_LINE = String.raw`[A-Za-z0-9_-]+:[ \t]*(?:#[^\n]*)?`;
const LIGHT_JOB = new RegExp(String.raw`\n {2}light:[ \t]*(?:#[^\n]*)?\n([\s\S]*?)(?=\n {2}${JOB_KEY_LINE}(?:\n|$)|$)`);
// 步骤到下一个步骤、或任何缩进浅于步骤内容的行（job 间的两格缩进注释、下一个 job 键）、或块末为止
const QUICK_STEP = /- name: F090b 证据快检（F-573）\n([\s\S]*?)(?=\n {6}- |\n {0,5}\S|$)/;

function quickCheck(yml: string): { lightJob: string; step: string } {
  const lightJob = LIGHT_JOB.exec(yml)?.[1] ?? '';
  // 步骤末尾的换行取决于它后面是空行、下一个 job 还是文件末尾，比较前去掉
  return { lightJob, step: (QUICK_STEP.exec(lightJob)?.[1] ?? '').trimEnd() };
}

let main = '';
let feature = '';
let docsOffFeature = '';
let docsOffMain = '';
let codeOffMain = '';
let apiOffMain = '';
let routePolicyOffMain = '';
let webOffMain = '';
let apiAndDocsOffMain = '';
let apiOffFeature = '';

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
  git('checkout', '-q', main);
  git('checkout', '-q', '-b', 'api-on-main');
  apiOffMain = commitFile('apps/api/src/modules/x/routes.ts', 'export const r = 1;\n');
  git('checkout', '-q', main);
  git('checkout', '-q', '-b', 'route-policy-on-main');
  routePolicyOffMain = commitFile('tests/acceptance/support/route-policy/required/x.ts', 'export const a = 1;\n');
  git('checkout', '-q', main);
  git('checkout', '-q', '-b', 'web-on-main');
  webOffMain = commitFile('apps/web/src/page.tsx', 'export const p = 1;\n');
  git('checkout', '-q', main);
  git('checkout', '-q', '-b', 'api-and-docs-on-main');
  commitFile('docs/note.md', '# 说明\n');
  apiAndDocsOffMain = commitFile('apps/api/src/y.ts', 'export const y = 1;\n');
  git('checkout', '-q', feature);
  git('checkout', '-q', '-b', 'api-on-feature');
  apiOffFeature = commitFile('apps/api/src/z.ts', 'export const z = 1;\n');
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

  it('DEC-458 / DEC-694②：兼容手工 reopened，带 queue-head 仍完整，不带标签仍轻量', () => {
    testMerge(main, codeOffMain);
    const reopened = { EVENT_NAME: 'pull_request', EVENT_ACTION: 'reopened', BASE_REF: 'main' };
    expect(classify({ ...reopened, QUEUE_HEAD: 'true' })).toBe('mode=full');
    expect(classify({ ...reopened, QUEUE_HEAD: 'false' })).toBe('mode=light');
    // 纯文档 PR 重开仍是 docs（标签不改变纯文档判定）
    testMerge(main, docsOffMain);
    expect(classify({ ...reopened, QUEUE_HEAD: 'true' })).toBe('mode=docs');
  });

  it('DEC-694②：labeled queue-head 遵守 full / docs / 非 main light 的既有口径', () => {
    const labeled = { EVENT_NAME: 'pull_request', EVENT_ACTION: 'labeled', EVENT_LABEL: 'queue-head' };
    testMerge(main, codeOffMain);
    expect(classify({ ...labeled, BASE_REF: 'main', QUEUE_HEAD: 'true' })).toBe('mode=full');
    expect(classify({ ...labeled, BASE_REF: 'main', QUEUE_HEAD: 'false' })).toBe('mode=light');
    expect(classify({ ...labeled, BASE_REF: 'feature', QUEUE_HEAD: 'true' })).toBe('mode=light');
    testMerge(main, docsOffMain);
    expect(classify({ ...labeled, BASE_REF: 'main', QUEUE_HEAD: 'true' })).toBe('mode=docs');
  });

  it('DEC-694②：其他 labeled 即使已有 queue-head 或只有文档，也不报告 full / docs', () => {
    const labeled = { EVENT_NAME: 'pull_request', EVENT_ACTION: 'labeled', BASE_REF: 'main' };
    for (const head of [codeOffMain, docsOffMain]) {
      testMerge(main, head);
      for (const label of ['reviewed', 'queue-head-extra', '']) {
        for (const queued of ['true', 'false']) {
          expect(classify({ ...labeled, EVENT_LABEL: label, QUEUE_HEAD: queued })).toBe('mode=light');
        }
      }
    }
  });

  it('DEC-694②：ci.yml 监听 labeled，queue-head 仍取自 pull_request 事件里的标签', () => {
    const yml = readFileSync(CI_YML, 'utf8');
    const types = /pull_request:\n(?:\s*#.*\n)*\s*types: \[([^\]]*)\]/
      .exec(yml)?.[1]
      ?.split(',')
      .map((t) => t.trim());
    expect(types).toEqual(expect.arrayContaining(['opened', 'synchronize', 'reopened', 'ready_for_review']));
    expect(types).toContain('labeled');
    expect(yml).toContain('EVENT_ACTION: ${{ github.event.action }}');
    expect(yml).toContain('EVENT_LABEL: ${{ github.event.label.name }}');
    expect(yml).toContain("QUEUE_HEAD: ${{ contains(github.event.pull_request.labels.*.name, 'queue-head') }}");
    expect(yml).toContain('BASE_REF: ${{ github.base_ref }}');
  });

  describe('F-573：F090b 证据快检开关 evidence_check', () => {
    const light = { EVENT_NAME: 'pull_request', BASE_REF: 'main', QUEUE_HEAD: 'false' };

    it('light 且改了 apps/api/src 或 route-policy 支撑代码判 true，mode 仍在最后一行', () => {
      for (const head of [apiOffMain, routePolicyOffMain, apiAndDocsOffMain]) {
        testMerge(main, head);
        expect(classifyOutput(light)).toEqual(['evidence_check=true', 'mode=light']);
      }
    });

    it('只改前端、其他代码或文档判 false', () => {
      for (const [head, mode] of [
        [webOffMain, 'mode=light'],
        [codeOffMain, 'mode=light'],
        [docsOffMain, 'mode=docs'],
      ] as const) {
        testMerge(main, head);
        expect(evidenceCheck(light)).toBe('evidence_check=false');
        expect(classify(light)).toBe(mode);
      }
    });

    it('full 模式不重复跑（完整分片已含 F090b）：队首、push、定时一律 false', () => {
      testMerge(main, apiOffMain);
      expect(classifyOutput({ ...light, QUEUE_HEAD: 'true' })).toEqual(['evidence_check=false', 'mode=full']);
      expect(classifyOutput({ EVENT_NAME: 'push', BASE_REF: '' })).toEqual(['evidence_check=false', 'mode=full']);
      expect(evidenceCheck({ EVENT_NAME: 'schedule', BASE_REF: '' })).toBe('evidence_check=false');
    });

    it('目标分支非 main：mode 仍 light 不回退，快检按相对 base 的改动判定，queue-head 不生效', () => {
      testMerge(feature, apiOffFeature);
      for (const queued of ['true', 'false']) {
        const env = { EVENT_NAME: 'pull_request', BASE_REF: 'feature', QUEUE_HEAD: queued };
        expect(classifyOutput(env)).toEqual(['evidence_check=true', 'mode=light']);
      }
      testMerge(feature, docsOffFeature);
      expect(classifyOutput({ EVENT_NAME: 'pull_request', BASE_REF: 'feature', QUEUE_HEAD: 'true' })).toEqual([
        'evidence_check=false',
        'mode=light',
      ]);
      testMerge(main, apiOffMain);
      expect(classifyOutput({ EVENT_NAME: 'pull_request', BASE_REF: '', QUEUE_HEAD: 'false' })).toEqual([
        'evidence_check=true',
        'mode=light',
      ]);
    });

    it('改动清单为空（空提交）按 true 多跑：light 为 true，队首 full 为 false', () => {
      git('checkout', '-q', main);
      git('checkout', '-q', '-b', 'empty-on-main');
      git('commit', '-q', '--allow-empty', '-m', 'empty');
      const emptyOffMain = git('rev-parse', 'HEAD');
      testMerge(main, emptyOffMain);
      expect(git('diff', '--name-only', 'HEAD^1', 'HEAD')).toBe('');
      expect(classifyOutput(light)).toEqual(['evidence_check=true', 'mode=light']);
      expect(classifyOutput({ ...light, QUEUE_HEAD: 'true' })).toEqual(['evidence_check=false', 'mode=full']);
    });

    it('git diff 失败（无父提交）按 true 多跑：light 为 true，队首 full 为 false', () => {
      // main 是仓库的根提交：HEAD^1 不存在，git diff 非零退出
      git('checkout', '-q', '--detach', main);
      expect(() => git('rev-parse', '--verify', '-q', 'HEAD^1')).toThrow();
      expect(classifyOutput(light)).toEqual(['evidence_check=true', 'mode=light']);
      expect(classifyOutput({ ...light, QUEUE_HEAD: 'true' })).toEqual(['evidence_check=false', 'mode=full']);
    });

    it('无关 labeled 不开快检（即使改了 apps/api/src）', () => {
      testMerge(main, apiOffMain);
      const labeled = { ...light, EVENT_ACTION: 'labeled', EVENT_LABEL: 'reviewed' };
      expect(classifyOutput(labeled)).toEqual(['evidence_check=false', 'mode=light']);
      // queue-head 标签的 labeled 事件走正常判定
      const queueLabeled = { ...light, EVENT_ACTION: 'labeled', EVENT_LABEL: 'queue-head' };
      expect(classifyOutput(queueLabeled)).toEqual(['evidence_check=true', 'mode=light']);
    });
  });

  it('F-573：ci.yml 的 light job 只在 light + evidence_check=true 时 strict 跑 F090b 两个测试', () => {
    const yml = readFileSync(CI_YML, 'utf8');
    expect(yml).toContain('evidence_check: ${{ steps.classify.outputs.evidence_check }}');
    const { lightJob, step } = quickCheck(yml);
    expect(step).not.toBe('');
    // 完整 if 值逐字比对：把 && 换成 ||、加 false && 之类的改动都会让它失配
    expect(/^\s*if: (.*)$/m.exec(step)?.[1]).toBe(
      "needs.changes.outputs.mode == 'light' && needs.changes.outputs.evidence_check == 'true'",
    );
    // 步骤或整个 light job 设了 continue-on-error 都会让快检红了也不拦
    expect(step).not.toContain('continue-on-error');
    expect(lightJob).not.toContain('continue-on-error');
    expect(step).toContain("ROUTE_POLICY_EVIDENCE_STRICT: '1'");
    expect(step).toContain('tests/acceptance/AC-PRM-FW-F090b-entries.test.ts');
    expect(step).toContain('tests/acceptance/AC-PRM-FW-02-evidence.test.ts');
  });

  // 变体用测试内固定的最小工作流样本，不读真实 ci.yml：真实文件只受上面的主门禁约束，
  // 合法的 ci.yml 改动（给 job 键加注释、调序、挪 light）不会让这些用例误报。
  describe('F-573：light 块截取对工作流变体的健壮性（固定样本，内存字符串）', () => {
    const STEP = [
      '      - name: F090b 证据快检（F-573）',
      "        if: needs.changes.outputs.mode == 'light' && needs.changes.outputs.evidence_check == 'true'",
      '        run: pnpm test tests/acceptance/AC-PRM-FW-F090b-entries.test.ts',
    ].join('\n');
    const OTHER = '      - name: 其他步骤\n        run: echo other';
    type Job = { key: string; step: boolean };
    /** 一个 job 块：键行 + steps；step=true 时在其它步骤后放快检步骤。 */
    const job = ({ key, step }: Job): string =>
      `  ${key}\n    runs-on: ubuntu-latest\n    steps:\n${OTHER}${step ? `\n${STEP}` : ''}`;
    const sample = (jobs: Job[], opts: { tail?: string } = {}): string =>
      `name: sample\njobs:\n${jobs.map(job).join('\n\n')}${opts.tail ?? '\n'}`;
    const LIGHT: Job = { key: 'light:', step: true };
    const SHARDS: Job = { key: 'check-shards:', step: false };
    /** 前置断言：快检步骤在整份样本里恰好出现一次，且位于键行为 key 的 job 内。 */
    const expectStepOnlyIn = (yml: string, key: string): void => {
      expect(yml.split('F090b 证据快检（F-573）').length - 1).toBe(1);
      const at = yml.indexOf('F090b 证据快检（F-573）');
      const header = yml.lastIndexOf(`\n  ${key}\n`, at);
      expect(header).toBeGreaterThan(-1);
      // 键行与快检步骤之间不能再有别的 job 键行
      expect(/\n {2}[A-Za-z0-9_-]+:/.test(yml.slice(header + 1 + key.length + 3, at))).toBe(false);
    };
    const baseStep = quickCheck(sample([LIGHT, SHARDS])).step;

    it('基线：样本里 light 块能找到快检步骤', () => {
      expectStepOnlyIn(sample([LIGHT, SHARDS]), 'light:');
      expect(baseStep).toContain('AC-PRM-FW-F090b-entries');
    });

    it('变体①：job 键带行尾注释时，快检移出 light 仍判失败（check-shards / 插入的 decoy）', () => {
      const shards: Job = { key: 'check-shards: # 完整分片', step: true };
      const moved = sample([{ ...LIGHT, step: false }, shards]);
      expect(moved).toContain('\n  check-shards: # 完整分片\n');
      expectStepOnlyIn(moved, 'check-shards: # 完整分片');
      expect(quickCheck(moved).step).toBe('');

      const decoy: Job = { key: 'decoy: # x', step: true };
      const withDecoy = sample([{ ...LIGHT, step: false }, decoy, { ...SHARDS, key: 'check-shards: # 完整分片' }]);
      expect(withDecoy).toContain('\n  decoy: # x\n');
      expectStepOnlyIn(withDecoy, 'decoy: # x');
      expect(quickCheck(withDecoy).step).toBe('');

      // 对照：快检留在 light，注释边界（含 light 自己带注释）不影响判定
      const kept = sample([
        { ...LIGHT, key: 'light: # 轻量' },
        { ...SHARDS, key: 'check-shards: # 完整分片' },
      ]);
      expect(kept).toContain('\n  light: # 轻量\n');
      expect(kept).toContain('\n  check-shards: # 完整分片\n');
      expectStepOnlyIn(kept, 'light: # 轻量');
      expect(quickCheck(kept).step).toBe(baseStep);
    });

    it('变体②：仅把 check-shards 调到 light 前面，仍通过', () => {
      const reordered = sample([SHARDS, LIGHT]);
      expect(reordered.indexOf('\n  check-shards:')).toBeLessThan(reordered.indexOf('\n  light:'));
      expectStepOnlyIn(reordered, 'light:');
      expect(quickCheck(reordered).step).toBe(baseStep);
    });

    it('变体③：light 放文件末尾（有 / 无末尾换行）仍通过', () => {
      const withNewline = sample([SHARDS, LIGHT]);
      const withoutNewline = sample([SHARDS, LIGHT], { tail: '' });
      expect(withNewline.endsWith('\n')).toBe(true);
      expect(withoutNewline.endsWith('\n')).toBe(false);
      expect(withoutNewline.lastIndexOf('\n  light:')).toBeGreaterThan(withoutNewline.lastIndexOf('\n  check-shards:'));
      for (const yml of [withNewline, withoutNewline]) {
        expectStepOnlyIn(yml, 'light:');
        expect(quickCheck(yml).step).toBe(baseStep);
      }
    });

    it('前置断言自身有效：只删快检不插入、或注释没写入，都会被前置断言拦下', () => {
      const deleted = sample([{ ...LIGHT, step: false }, SHARDS]);
      expect(() => expectStepOnlyIn(deleted, 'check-shards: # 完整分片')).toThrow();
      const noComment = sample([
        { ...LIGHT, step: false },
        { ...SHARDS, step: true },
      ]);
      expect(noComment).not.toContain('check-shards: # 完整分片');
      expect(() => expectStepOnlyIn(noComment, 'check-shards: # 完整分片')).toThrow();
      const twice = sample([LIGHT, { ...SHARDS, step: true }]);
      expect(() => expectStepOnlyIn(twice, 'light:')).toThrow();
    });
  });
});
