#!/usr/bin/env node
// 取证门禁：列出某个任务开工 / 合并前还在等的取证项（Q-M0-xx）与待用户决定的差异（D-xxx）。
// 用法：node scripts/evidence-gate.mjs R1-T08 [R1-T09 ...]    无参数时列出全部未完成取证。
// 退出码：有“开工前”未完成项或待决差异时为 1，否则为 0。
// 数据源：docs/07_M0/03_需取证清单.md、docs/00_状态/04_缺口冲突差异登记册.md（只读）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const cells = (line) => line.split("|").slice(1, -1).map((c) => c.trim());

// “R1-T05/T09”“R1-T05/R2-T01”“R3-T01/T02”都展开成完整任务号
function taskIds(text) {
  const ids = new Set();
  for (const m of text.matchAll(/(R\d)-T(\d{2})((?:\s*\/\s*(?:R\d-)?T\d{2})*)/g)) {
    ids.add(`${m[1]}-T${m[2]}`);
    for (const n of m[3].matchAll(/(?:(R\d)-)?T(\d{2})/g)) ids.add(`${n[1] ?? m[1]}-T${n[2]}`);
  }
  return ids;
}

// 门禁级别：写了“后续 / 落地后 / 恢复时”的可后补，其余（含“开工前 / 完成前 / 实现前”和未注明）按开工前处理
const level = (text) => (/后续|落地后|恢复时|可后补/.test(text) ? "可后补" : "开工前");

const status = (text) =>
  /🔴/.test(text) ? "🔴 未定论" : /🟡/.test(text) ? "🟡 部分" : /✅/.test(text) ? "✅" : "□ 未取证";

const evidence = read("docs/07_M0/03_需取证清单.md")
  .split("\n")
  .filter((l) => /^\| Q-M0-\d+/.test(l))
  .map((l) => {
    const c = cells(l);
    return { id: c[0], what: c[2], blocks: c[4], tasks: taskIds(c[4]), level: level(c[4]), st: status(c[5]) };
  });

const decisions = read("docs/00_状态/04_缺口冲突差异登记册.md")
  .split("\n")
  .filter((l) => /^\| \*\*D-\d+\*\*/.test(l))
  .map((l) => {
    const c = cells(l);
    return { id: c[0].replace(/\*/g, ""), what: c[1], diff: c[2], st: c[4] ?? "" };
  })
  .filter((d) => !/✅/.test(d.st));

const clip = (s, n = 70) => (s.length > n ? s.slice(0, n) + "…" : s);
const targets = process.argv.slice(2);
let blocked = false;

if (targets.length === 0) {
  const open = evidence.filter((e) => e.st !== "✅");
  console.log(`未完成取证 ${open.length} 项（共 ${evidence.length} 项）`);
  for (const e of open) console.log(`  ${e.id}  ${e.st}  [${e.blocks}]  ${clip(e.what)}`);
} else {
  for (const t of targets) {
    const hits = evidence.filter((e) => e.tasks.has(t) && e.st !== "✅");
    const must = hits.filter((e) => e.level === "开工前");
    const later = hits.filter((e) => e.level === "可后补");
    console.log(`\n== ${t} ==`);
    if (must.length) {
      blocked = true;
      console.log(`⛔ 开工前须完成的取证 ${must.length} 项：`);
      for (const e of must) console.log(`  ${e.id}  ${e.st}  ${clip(e.what)}`);
    }
    if (later.length) {
      console.log(`⚠️ 可先按暂定口径开发、合并后补的取证 ${later.length} 项：`);
      for (const e of later) console.log(`  ${e.id}  ${e.st}  ${clip(e.what)}`);
    }
    if (!hits.length) console.log("✅ 清单中没有挂在该任务上的未完成取证（新任务仍须先做开工前取证扫描）");
  }
}

if (decisions.length) {
  blocked = blocked || targets.length > 0;
  console.log(`\n待用户决定 / 待原站实测的差异 ${decisions.length} 项（开工前确认是否涉及本任务）：`);
  for (const d of decisions) console.log(`  ${d.id}  ${clip(d.st, 20)}  ${clip(d.what)}`);
}
process.exit(blocked ? 1 : 0);
