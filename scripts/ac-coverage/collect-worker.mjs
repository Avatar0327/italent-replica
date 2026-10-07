// 子进程：用 Vitest 运行时收集一档用例（父进程按档设置环境变量）。
// staticParse: false 必须显式写：Vitest 5 的 collect() 与 `vitest list` 默认是静态解析，正是 DEC-254 要弃用的做法。
// 收集会真实加载测试文件、执行各级 describe 回调并格式化 each 标题，但不执行用例体与钩子。
// DEC-282：身份与状态只读 Vitest 任务对象在收集完成后的字段（name、location、mode、result / state），不自行解释语义。
// DEC-282 补充（#102 第 4 轮）：不支持的写法一律报错，不合并、不推断；错误一律原样带回，不按消息文本分辨来源。
import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { createVitest } from 'vitest/node';

const { root, vitestConfig, filters, out } = JSON.parse(process.argv[2]);

const messageOf = (error) => String(error?.message ?? error).split('\n')[0];
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

/**
 * only 门禁只认 mode 仍为 only 的注册（挂在 skip / todo 祖先下、Vitest 不再检查的）。
 * 生效的 .only 被 Vitest 以 allowOnly: false 拒绝时 mode 已改回 run、挂一条错误：那条错误照常作为收集错误报出，
 * 不按消息文本认成 only（DEC-282 补充）；两条路径都让 --check 失败。
 */
const registersOnly = (node) => node.options.mode === 'only';

/** 一个 module 里全部 suite 与用例，带上所属文件与 project。 */
function nodesOf(module) {
  const file = relative(root, module.moduleId);
  const project = module.project.name ?? '';
  return { module, file, project, suites: [...module.children.allSuites()], tests: [...module.children.allTests()] };
}

/**
 * 同一档内“文件 + 名称路径 + 位置”出现多次的注册（suite 或用例）：在整档范围统计，跨 module 也算
 * （同一文件被多个 Vitest project 收集时，#102 第 3 轮 P2-3）。值为各次注册所属的 project。
 */
function duplicatedKeys(modules) {
  const seen = new Map();
  for (const { file, project, suites, tests } of modules) {
    for (const node of [...suites, ...tests]) {
      const key = keyOf(file, node);
      seen.set(key, [...(seen.get(key) ?? []), project]);
    }
  }
  return new Map([...seen].filter(([, projects]) => projects.length > 1));
}

/** 用例自身或任一祖先 suite 的身份在同一档重复时，说明是哪一个；其下用例都无法确认身份。 */
function conflictOf(file, test, suites, duplicated) {
  const node = [...suites, test].find((n) => duplicated.has(keyOf(file, n)));
  if (!node) return null;
  const projects = duplicated.get(keyOf(file, node));
  const named = [...new Set(projects)].filter(Boolean);
  const across = named.length > 1 ? `，跨 project：${named.join(' / ')}` : '';
  const what = node === test ? '用例' : `父套件「${namesOf(node).join(' > ')}」`;
  return `${what}（${locationOf(node)}）在同一档注册 ${projects.length} 次${across}`;
}

function errorRecords({ module, file, project, suites, tests }) {
  const moduleErrors = module.errors().map((error) => ({ file, project, names: null, location: null, error }));
  const nodeErrors = [...suites, ...tests].flatMap((node) =>
    errorsOf(node).map((error) => ({ file, project, names: namesOf(node), location: locationOf(node), error })),
  );
  return [...moduleErrors, ...nodeErrors].map(({ error, ...where }) => ({ ...where, message: messageOf(error) }));
}

function serializeModule(nodes, duplicated) {
  const { file, project, suites, tests } = nodes;
  const onlyNodes = [...suites, ...tests]
    .filter(registersOnly)
    .map((node) => ({ file, project, names: namesOf(node), location: locationOf(node) }));
  const records = tests.map((test) => {
    const chain = suitesOf(test);
    return {
      file,
      project,
      names: namesOf(test),
      location: locationOf(test),
      ancestors: chain.map(locationOf),
      mode: modeOf(test, chain),
      only: [...chain, test].some(registersOnly),
      conflict: conflictOf(file, test, chain, duplicated),
    };
  });
  return { tests: records, onlyNodes, errors: errorRecords(nodes) };
}

function serialize(result) {
  const modules = result.testModules.map(nodesOf);
  const duplicated = duplicatedKeys(modules);
  const serialized = modules.map((nodes) => serializeModule(nodes, duplicated));
  const unhandled = result.unhandledErrors.map((error) => ({
    file: null,
    project: '',
    names: null,
    location: null,
    message: messageOf(error),
  }));
  return {
    files: result.testModules.length,
    tests: serialized.flatMap((m) => m.tests),
    onlyNodes: serialized.flatMap((m) => m.onlyNodes),
    errors: [...unhandled, ...serialized.flatMap((m) => m.errors)],
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
