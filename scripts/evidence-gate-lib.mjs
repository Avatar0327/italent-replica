// 取证门禁的解析与判定（scripts/evidence-gate.mjs 的纯函数部分，便于用小夹具自测）。
const cells = (line) =>
  line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());

// “R1-T05/T09”“R1-T05/R2-T01”“R3-T01/T02”都展开成完整任务号
export function taskIds(text) {
  const ids = new Set();
  for (const m of text.matchAll(/(R\d)-T(\d{2})((?:\s*\/\s*(?:R\d-)?T\d{2})*)/g)) {
    ids.add(`${m[1]}-T${m[2]}`);
    for (const n of m[3].matchAll(/(?:(R\d)-)?T(\d{2})/g)) ids.add(`${n[1] ?? m[1]}-T${n[2]}`);
  }
  // 后续任务（docs/09_派发/后续任务.md）的编号 F-xxx 也可作为门禁目标
  for (const m of text.matchAll(/\bF-(\d{3})\b/g)) ids.add(`F-${m[1]}`);
  return ids;
}

// 状态判定的单一入口（DEC-431①）：取证行与差异行都只在这里决定“还拦不拦”。
// 门禁级别：写了“后续 / 落地后 / 恢复时”的可后补，其余（含“开工前 / 完成前 / 实现前”和未注明）按开工前处理
const level = (text) => (/后续|落地后|恢复时|可后补/.test(text) ? '可后补' : '开工前');

// 🟡 行放行 = 状态列里“剩余事项”这一段的每个子项都命中下面的封闭白名单（整子项匹配，不做子串包含），
// 且至少有一处声明可后补 / DEC 定口径；任一子项不命中、含否定或冲突词，整行保守拦截（DEC-431①，F-290 第 3 轮）。
// 只提到 DEC 编号、零散的“可后补”字样、没有“剩余 / 其余 / 未测部分”起头的写法都不放行。🔴 / □ 不适用，照旧按任务列判级。
const HEAD = /(?:\*\*)?(?:剩余|其余|余下|未测部分)(?:[（(]可后补[）)])?(?:\*\*)?[：:]?/;
// 整行冲突词（含“剩余”之前的正文）：命中即拦
const CELL_CONFLICT =
  /开工前|实现前|写代码前|须先|必须先|待用户决定|待原站实测|待取证|尚未[^。；;]{0,12}定口径|未[由按][^。；;]{0,12}定口径/;
// 子项冲突词：优先级高于白名单
const ITEM_CONFLICT =
  /不可|不能|不得|不应|无法|仍须|必须|须|待用户|待原站|待取证|开工前|实现前|写代码前|阻塞|尚未|未[由按]/;
const FREE = '[^；;。，,不未无]'; // 白名单里的自由文本槽位：不含分隔符与否定字
// 声明类子项：自己就表示剩余事项可后补 / 由 DEC 定口径
const DEFER_ITEMS = [
  /^(?:可后补|后续补测?|落地后补)$/,
  /^(?:未测部分|剩余部分?)?(?:[由按]\s*DEC-\d+\s*定口径|按设计口径定(?:（DEC-\d+）)?)$/,
  new RegExp(`^${FREE}{1,30}（无可用${FREE}{1,10}）[，,]可后补$`),
];
// 描述类子项（写法归纳自清单里 4 个由状态列放行的真实行：Q-M0-127 / 132 / 133 / 153），只在已声明可后补时有效
const DESCRIBE_ITEMS = [
  /^未测$/, // Q-M0-127 ⑤
  /^本样本观察不到$/, // Q-M0-127 ⑯
  new RegExp(`^${FREE}{1,30}只取到${FREE}{1,30}$`), // Q-M0-127 ④“变量清单只取到……”
  new RegExp(`^仍待启用${FREE}{1,10}$`), // Q-M0-127 ⑤“仍待启用中活动”
  new RegExp(`^${FREE}{1,40}[，,]需${FREE}{1,20}账号$`), // Q-M0-132“……，需小范围管理员账号”
  // 补测记录“<日期> 已补 / 补（来源）：已取事实”（Q-M0-127 ④、Q-M0-132 残项）：冒号后是已取事实，只查冲突词
  /^(?:残项\s*)?\d{1,2}-\d{1,2}\s*已?补(?:（[^）]*）)?[：:].+$/,
];
const matchesAny = (list, item) => list.some((re) => re.test(item));

const remainderItems = (statusCell) => {
  const m = HEAD.exec(statusCell);
  if (!m) return null;
  const items = statusCell
    .slice(m.index + m[0].length)
    .split(/[；;。]|[①-⑳]/)
    .map((x) =>
      x
        .replace(/\*\*/g, '')
        .replace(/^[\s：:]+/, '')
        .trim(),
    )
    .filter(Boolean);
  return { declared: /可后补/.test(m[0]), items };
};

function remainderDeferred(statusCell) {
  const rem = remainderItems(statusCell);
  if (!rem || rem.items.length === 0 || CELL_CONFLICT.test(statusCell)) return false;
  if (rem.items.some((i) => ITEM_CONFLICT.test(i) || !matchesAny([...DEFER_ITEMS, ...DESCRIBE_ITEMS], i))) return false;
  return rem.declared || rem.items.some((i) => matchesAny(DEFER_ITEMS, i));
}

export function evidenceState(blocks, statusCell) {
  const st = /🔴/.test(statusCell)
    ? '🔴 未定论'
    : /🟡/.test(statusCell)
      ? '🟡 部分'
      : /✅/.test(statusCell)
        ? '✅'
        : '□ 未取证';
  const deferred = st === '🟡 部分' && remainderDeferred(statusCell);
  return { st, level: deferred ? '可后补' : level(blocks) };
}

// 差异行：状态列以 ✅ / “已定” / “已关闭”开头视为已结；其余（含“待用户决定 / 待原站实测”和认不出的写法）仍拦
export const decisionSettled = (statusCell) => /^(✅|已定|已关闭)/.test(statusCell.trim());

export function parseEvidence(markdown) {
  return markdown
    .split('\n')
    .filter((l) => /^\| Q-M0-\d+/.test(l))
    .map((l) => {
      const c = cells(l);
      return { id: c[0], what: c[2], blocks: c[4], tasks: taskIds(c[4]), ...evidenceState(c[4], c[5]) };
    });
}

export function parseDecisions(markdown) {
  return markdown
    .split('\n')
    .filter((l) => /^\| \*\*D-\d+\*\*/.test(l))
    .map((l) => {
      const c = cells(l);
      // 只认显式写明的“影响任务：R1-T03、F-007”；行里顺带提到的任务号不算范围（PR #46 Codex 审查 P2）
      const scope = /影响任务[：:]\s*([^|；;。]+)/.exec(l);
      return {
        id: c[0].replace(/\*/g, ''),
        what: c[1],
        diff: c[2],
        st: c[4] ?? '',
        tasks: scope ? taskIds(scope[1]) : null,
      };
    })
    .filter((d) => !decisionSettled(d.st));
}

const clip = (s, n = 70) => (s.length > n ? s.slice(0, n) + '…' : s);

/** 返回要打印的行与退出码：有“开工前”未完成项或待决差异（且指定了目标）时为 1。 */
export function gateReport(evidence, decisions, targets) {
  const out = [];
  let blocked = false;
  if (targets.length === 0) {
    const open = evidence.filter((e) => e.st !== '✅');
    out.push(`未完成取证 ${open.length} 项（共 ${evidence.length} 项）`);
    for (const e of open) out.push(`  ${e.id}  ${e.st}  [${e.blocks}]  ${clip(e.what)}`);
  } else {
    for (const t of targets) {
      const hits = evidence.filter((e) => e.tasks.has(t) && e.st !== '✅');
      const must = hits.filter((e) => e.level === '开工前');
      const later = hits.filter((e) => e.level === '可后补');
      out.push(`\n== ${t} ==`);
      if (must.length) {
        blocked = true;
        out.push(`⛔ 开工前须完成的取证 ${must.length} 项：`);
        for (const e of must) out.push(`  ${e.id}  ${e.st}  ${clip(e.what)}`);
      }
      if (later.length) {
        out.push(`⚠️ 可先按暂定口径开发、合并后补的取证 ${later.length} 项：`);
        for (const e of later) out.push(`  ${e.id}  ${e.st}  ${clip(e.what)}`);
      }
      if (!hits.length) out.push('✅ 清单中没有挂在该任务上的未完成取证（新任务仍须先做开工前取证扫描）');
    }
  }
  // 待决差异：登记册行里显式写了“影响任务：…”的只拦对应任务；没写的按保守口径拦所有目标
  const relevant =
    targets.length === 0 ? decisions : decisions.filter((d) => !d.tasks || targets.some((t) => d.tasks.has(t)));
  if (relevant.length) {
    blocked = blocked || targets.length > 0;
    out.push(`\n待用户决定 / 待原站实测的差异 ${relevant.length} 项（开工前确认是否涉及本任务）：`);
    for (const d of relevant) out.push(`  ${d.id}  ${clip(d.st, 20)}  ${clip(d.what)}`);
  }
  return { lines: out, exitCode: blocked ? 1 : 0 };
}
