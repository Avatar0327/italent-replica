// 子进程：用 Vitest 运行时收集一档用例（父进程按档设置环境变量）。
// staticParse: false 必须显式写：Vitest 5 的 collect() 与 `vitest list` 默认是静态解析，正是 DEC-254 要弃用的做法。
// 收集会真实加载测试文件、执行各级 describe 回调并格式化 each 标题，但不执行用例体与钩子。
// DEC-282：身份与状态只读 Vitest 任务对象在收集完成后的字段（name、location、mode、result / state），不自行解释语义。
import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { createVitest } from 'vitest/node';

const { root, vitestConfig, filters, out } = JSON.parse(process.argv[2]);

const messageOf = (error) => String(error?.message ?? error).split('\n')[0];
const isOnlyError = (error) => messageOf(error).includes('.only');
const locationOf = (node) => (node.location ? `${node.location.line}:${node.location.column}` : null);
const errorsOf = (node) => (node.type === 'test' ? (node.result().errors ?? []) : node.errors());

/** 从根到 node 的 suite 链（不含 module）。 */
function suitesOf(node) {
  const suites = [];
  for (let parent = node.parent; parent.type !== 'module'; parent = parent.parent) suites.unshift(parent);
  return suites;
}

const namesOf = (node) => [...suitesOf(node), node].map((n) => n.name);
const keyOf = (file, node) => JSON.stringify([file, namesOf(node), locationOf(node)]);

/**
 * 有效状态：用例自身与全部祖先 suite 的 mode 都是 run、且 Vitest 没有把它们标为 skipped / failed，才算运行。
 * 必须连祖先一起读：叶子在 skip / todo 祖先之下时，Vitest 收集后仍保留 mode=run、state=pending，
 * 与正常可运行用例完全相同（实测）。这里只做“全部为 run”的合取，不解释 only / skip / todo 的语义。
 */
function modeOf(test, suites) {
  const blocked =
    test.options.mode !== 'run' ||
    test.result().state !== 'pending' ||
    suites.some((suite) => suite.options.mode !== 'run' || ['skipped', 'failed'].includes(suite.state()));
  if (!blocked) return 'run';
  return test.options.mode === 'todo' ? 'todo' : 'skip';
}

/** only 门禁：mode 为 only（含挂在 skip / todo 祖先下、Vitest 不再检查的），或被 Vitest 以 .only 拒绝。 */
const registersOnly = (node) => node.options.mode === 'only' || errorsOf(node).some(isOnlyError);

/** 同一档内“文件 + 名称路径 + 位置”出现多次的注册（suite 或用例）：身份冲突，其下用例都无法确认身份。 */
function duplicatedKeys(file, nodes) {
  const counts = new Map();
  for (const node of nodes) counts.set(keyOf(file, node), (counts.get(keyOf(file, node)) ?? 0) + 1);
  return new Map([...counts].filter(([, count]) => count > 1));
}

function conflictOf(file, test, suites, duplicated) {
  const node = [...suites, test].find((n) => duplicated.has(keyOf(file, n)));
  if (!node) return null;
  const what = node === test ? '用例' : `父套件「${namesOf(node).join(' > ')}」`;
  return `${what}（${locationOf(node)}）在同一档注册 ${duplicated.get(keyOf(file, node))} 次`;
}

function serializeModule(module) {
  const file = relative(root, module.moduleId);
  const suites = [...module.children.allSuites()];
  const tests = [...module.children.allTests()];
  const duplicated = duplicatedKeys(file, [...suites, ...tests]);
  const errors = [module, ...suites, ...tests]
    .flatMap((node) => (node.type === 'module' ? node.errors() : errorsOf(node)))
    .filter((error) => !isOnlyError(error))
    .map((error) => ({ file, message: messageOf(error) }));
  const onlyNodes = [...suites, ...tests]
    .filter(registersOnly)
    .map((node) => ({ file, names: namesOf(node), location: locationOf(node) }));
  const records = tests.map((test) => {
    const chain = suitesOf(test);
    return {
      file,
      names: namesOf(test),
      location: locationOf(test),
      ancestors: chain.map(locationOf),
      mode: modeOf(test, chain),
      only: [...chain, test].some(registersOnly),
      conflict: conflictOf(file, test, chain, duplicated),
    };
  });
  return { tests: records, onlyNodes, errors };
}

function serialize(result) {
  const modules = result.testModules.map(serializeModule);
  return {
    files: result.testModules.length,
    tests: modules.flatMap((m) => m.tests),
    onlyNodes: modules.flatMap((m) => m.onlyNodes),
    errors: [...result.unhandledErrors.map((error) => ({ file: null, message: messageOf(error) }))].concat(
      modules.flatMap((m) => m.errors),
    ),
  };
}

const options = {
  config: vitestConfig,
  root,
  watch: false,
  reporters: [],
  allowOnly: false,
  passWithNoTests: true,
  includeTaskLocation: true,
};
const vitest = await createVitest('test', options);
try {
  const result = await vitest.collect(filters, { staticParse: false });
  writeFileSync(out, JSON.stringify(serialize(result)));
} finally {
  await vitest.close();
}
// 收集到的错误已写进结果，由父进程列为问题；Vitest 因此设置的非零退出码不代表本进程失败。
process.exitCode = 0;
