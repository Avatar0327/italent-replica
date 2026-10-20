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

export function evidenceState(blocks, statusCell) {
  const st = /🔴/.test(statusCell)
    ? '🔴 未定论'
    : /🟡/.test(statusCell)
      ? '🟡 部分'
      : /✅/.test(statusCell)
        ? '✅'
        : '□ 未取证';
  return { st, level: level(blocks) };
}

// 差异行：状态列以 ✅ 开头视为已结；其余（含“待用户决定 / 待原站实测”和认不出的写法）仍拦
export const decisionSettled = (statusCell) => /✅/.test(statusCell);

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
