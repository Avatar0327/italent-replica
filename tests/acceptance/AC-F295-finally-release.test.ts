/** F-295：直接执行既有调用点的清理语句，注入等待失败与延迟拒绝，不复制被测 finally。 */
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { withRelease } from './support/pg-interleave.js';

function cleanupStatement(file: string, marker: string): string {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const matches: ts.Statement[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isTryStatement(node) ||
        (ts.isExpressionStatement(node) && node.getText(tree).startsWith('await withRelease('))) &&
      node.getText(tree).includes(marker)
    ) {
      matches.push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  expect(matches.length, `${file} 必须定位到实际清理语句`).toBeGreaterThan(0);
  return matches.at(-1)!.getText(tree);
}

function callsiteTypeErrors(statement: string): string[] {
  const support = readFileSync(new URL('./support/pg-interleave.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('pg-interleave.ts', support, ts.ScriptTarget.Latest, true);
  const contract = tree.statements
    .filter(
      (node) =>
        (ts.isInterfaceDeclaration(node) && node.name.text === 'HeldLock') ||
        (ts.isFunctionDeclaration(node) && node.name?.text === 'withRelease'),
    )
    .map((node) => node.getText(tree))
    .join('\n');
  const offers = readFileSync(new URL('./AC-OF-BE14b2-concurrency-pg.test.ts', import.meta.url), 'utf8');
  const offerTree = ts.createSourceFile('offers.ts', offers, ts.ScriptTarget.Latest, true);
  let requests = '';
  const visit = (node: ts.Node) => {
    if (ts.isVariableStatement(node) && node.getText(offerTree).includes('w.sync(target)')) {
      requests = node.getText(offerTree);
    }
    ts.forEachChild(node, visit);
  };
  visit(offerTree);
  expect(requests).not.toBe('');
  const file = '/f295-callsite-types.ts';
  // 使用真实调用语句和真实 helper 契约，合成两种不同的返回类型；不加载整个业务依赖图。
  const source = `${contract}
    declare const plan: Promise<{ id: string }>;
    declare const write: Promise<Response>;
    declare function release(): void;
    declare function testDb(): { db: unknown };
    declare function waitForBlocked(db: unknown, count: number): Promise<void>;
    declare const w: { send(id: string): Promise<Response>; sync(id: string): Promise<Response> };
    declare const target: string;
    async function probe() {
      ${statement}
      ${requests}
      const [sent, synced] = await Promise.all(requests);
      return [sent.status, synced.status];
    }`;
  const options: ts.CompilerOptions = {
    strict: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2023,
    types: [],
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
  };
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === file
      ? ts.createSourceFile(file, source, languageVersion, true)
      : readSource(name, languageVersion, onError, shouldCreateNewSourceFile);
  return ts
    .getPreEmitDiagnostics(ts.createProgram([file], options, host))
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

function execute(statement: string, locals: Record<string, unknown>) {
  const code = ts.transpileModule(`(async () => { let a, b; ${statement} })()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  // 只执行当前仓库里选中的测试语句；隔离上下文只提供显式注入的夹具。
  return new Script(code, { filename: 'f295-callsite-probe.js' }).runInNewContext(locals) as Promise<unknown>;
}

function delayedFailure() {
  let release!: () => void;
  let settled = false;
  const request = new Promise<void>((resolve) => (release = resolve)).then(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    settled = true;
    throw new Error('放行后的请求拒绝');
  });
  // 红测也必须安全退出；断言下面检查被测清理是否真的等完，不能以测试框架捕获 rejection 代替收束。
  void request.catch(() => undefined);
  return { request, release, settled: () => settled };
}

describe('AC-F295 finally 放行后的失败请求必须收束', () => {
  it('AC-F295-01 sync-plan 等待失败仍等 plan/write 都结束，保留原等待错误', async () => {
    const statement = cleanupStatement('./AC-SC-sync-plan.test.ts', 'await waitForBlocked(testDb().db, 1)');
    expect(callsiteTypeErrors(statement), '异构请求登记与 Promise.all 元组结果必须通过严格类型检查').toEqual([]);
    const plan = delayedFailure();
    const write = delayedFailure();
    const failure = new Error('注入等待失败');
    try {
      await expect(
        execute(statement, {
          withRelease,
          plan: plan.request,
          write: write.request,
          testDb: () => ({ db: {} }),
          waitForBlocked: async () => {
            throw failure;
          },
          release: () => {
            plan.release();
            write.release();
          },
        }),
      ).rejects.toBe(failure);
      expect([plan.settled(), write.settled()], '返回前必须收束全部请求').toEqual([true, true]);
    } finally {
      plan.release();
      write.release();
      await Promise.allSettled([plan.request, write.request]);
    }
  });

  it('AC-F295-02 levels 持锁事务拒绝也不能跳过请求收束，body 错误优先', async () => {
    const statement = cleanupStatement('./AC-SC-levels-pg.test.ts', 'a =');
    const request = delayedFailure();
    const holder = delayedFailure();
    const failure = new Error('阻塞人数不符');
    try {
      await expect(
        execute(statement, {
          withRelease,
          expect,
          first: () => request.request,
          second: () => Promise.resolve(),
          w: { db: {} },
          blocker: holder.request,
          settledOrBlocked: async () => {
            throw failure;
          },
          release: () => {
            request.release();
            holder.release();
          },
        }),
      ).rejects.toBe(failure);
      expect(request.settled(), 'holder 拒绝后仍须等在途请求').toBe(true);
    } finally {
      request.release();
      holder.release();
      await Promise.allSettled([request.request, holder.request]);
    }
  });

  it('AC-F295-03 withRelease 放行失败仍收束延迟拒绝，成功 body 的放行错误不被吞掉', async () => {
    const pending = delayedFailure();
    const failure = new Error('放行等待失败');
    await expect(
      withRelease(
        () => {
          pending.release();
          throw failure;
        },
        async ({ track }) => {
          track(pending.request);
          return 42;
        },
      ),
    ).rejects.toBe(failure);
    expect(pending.settled()).toBe(true);
  });
});
