// 子进程：用 Vitest 运行时收集一档用例（父进程按档设置环境变量）。
// staticParse: false 必须显式写：Vitest 5 的 collect() 与 `vitest list` 默认是静态解析，正是 DEC-254 要弃用的做法。
// 收集会真实加载测试文件、执行各级 describe 回调并格式化 each 标题，但不执行用例体与钩子。
import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { createVitest } from 'vitest/node';

const { root, vitestConfig, filters, out } = JSON.parse(process.argv[2]);

function titleChain(test) {
  const names = [];
  for (let node = test; node.type !== 'module'; node = node.parent) names.unshift(node.name);
  return names;
}

const errorOf = (file, error) => ({ file, message: String(error?.message ?? error).split('\n')[0] });

function serialize(result) {
  const tests = [];
  const errors = result.unhandledErrors.map((error) => errorOf(null, error));
  for (const module of result.testModules) {
    const file = relative(root, module.moduleId);
    const suites = [module, ...module.children.allSuites()];
    errors.push(...suites.flatMap((suite) => suite.errors().map((error) => errorOf(file, error))));
    for (const test of module.children.allTests()) {
      tests.push({ file, names: titleChain(test), mode: test.options.mode, line: test.location?.line ?? null });
      // allowOnly: false 时 Vitest 把 .only 记为该用例的收集失败（与 CI 默认一致），这里一并带回
      const result = test.result();
      if (result.state === 'failed') errors.push(...result.errors.map((error) => errorOf(file, error)));
    }
  }
  return { files: result.testModules.length, tests, errors };
}

const options = { config: vitestConfig, root, watch: false, reporters: [], allowOnly: false, passWithNoTests: true };
const vitest = await createVitest('test', options);
try {
  const result = await vitest.collect(filters, { staticParse: false });
  writeFileSync(out, JSON.stringify(serialize(result)));
} finally {
  await vitest.close();
}
// 收集到的错误已写进结果，由父进程列为问题；Vitest 因此设置的非零退出码不代表本进程失败。
process.exitCode = 0;
