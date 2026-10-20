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

// 🟡 行放行 = 状态列拆出的**全部**子项逐项判定（DEC-431①，F-290 第 4 轮）：每个子项只有两种结果——
// 整句命中“已取事实”或“可后补 / 已定口径”放行常量才算放行，其余（含任何否定 / 冲突 / 不确定表达）一律阻塞；
// 整行还须有一处声明可后补或由 DEC 定口径。没有声明、零散的“可后补”字样、只提到 DEC 编号的写法都不放行。
// 🔴 / □ 不适用，照旧按任务列判级。
const HEAD = /^(?:剩余|其余|余下|未测部分)(?:（可后补）)?[：:]?/;
// 冲突 / 否定 / 不确定表达：优先级高于一切白名单（已取事实原句常量除外，见 FACT_LITERALS）
const CONFLICT =
  /不可|不允许|不能|不得|不应|无法|仍须|须|必须|未完成|尚不确定|不确定|是否|待确认|待用户|待原站|待取证|可能|开工前|实现前|写代码前|阻塞|尚未|未[由按]|没有定论/;
const NEGATION = /[不未无仍待]|是否|可能/; // 结构化“已取事实”里不得出现的字
// 已取事实（结构化）：带完成标记、且全句没有上面的否定 / 待定字眼
const DONE_FACT = /已取|已测|已读|已补|已恢复|已满足|补全|实测|只读|复查/;
// 已取事实原句常量：逐句取自清单里 4 个由状态列放行的真实行（Q-M0-127 / 132 / 133 / 153）中无法用结构化规则表达的
// 已取现状描述（带“不 / 未 / 无 / 没有”字，或没有完成标记）；整句（补测记录则为冒号后的尾部）相等才算，不做包含匹配。
// 清单里这几行的原文改动后会不再命中、转为阻塞（保守），由真实清单放行集合的测试发现
const FACT_LITERALS = new Set([
  '已取证（待办按评价者去重、已完成者被拦、取消待办不使链接失效；被屏蔽者在进度明细标“已评价(被屏蔽)”、' +
    '报告算未完成、报表整列消失；清空入口“重新作答”启用 / 停用均可、仅已评价行；转发三步向导与收件人取数）', // Q-M0-127
  '已取证（W-667 用户亲手清除：不重发通知、旧报告失效；W-668 报表下载为 PNG 截图）', // Q-M0-127
  '2026-10-08 晚 A5 只读（23 §9）：所属资源集合是系统字段、表单不显示、不可手选，' +
    '分布在 分类 / 类别 / 级别 / 指标类型 / 指标 / 标准，层级、等级方案、发展通道和人才评定对象没有', // Q-M0-132
  '所有对象都没有“向下公开”字段', // Q-M0-132
  '评价表、评审组、评定活动的“所属组织”是必填手选（默认请选择）', // Q-M0-132
  '小范围管理员可见全部类别与标准，不裁剪', // Q-M0-132
  '子集入口 = 组织员工 → 人员子集 → 任职资格（A5 可见，无需改权限）', // Q-M0-133
  'SW74 关 → 已有自动同步记录的编辑 / 删除立即置灰（追溯），手工记录不受影响', // Q-M0-133
  '2026-10-10（25 §10.5，W-773～790）：过程提醒按页（点“下一页”时）判断，提交提醒判断整份', // Q-M0-153
  '页面不显示秒数', // Q-M0-153
  '约 1.2～1.5 秒/题、选项不同的作答，既不弹提醒也不被屏蔽（T1～T3）', // Q-M0-153
  '耗时大概率按打开到提交的整段时间算', // Q-M0-153
  '分母、按份 / 按页还没测出，脚本做不到明显低于 1 秒/题', // Q-M0-153
  '复查（W-790）T3 约 1.47 秒/题未被屏蔽', // Q-M0-153
]);
const FREE = '[^；;。，,不未无]'; // 自由文本槽位：不含分隔符与否定字
// 声明类：自己就表示剩余事项可后补 / 由 DEC 定口径
const DEFER_ITEMS = [
  /^(?:可后补|后续补测?|落地后补)$/,
  /^(?:[由按]\s*DEC-\d+\s*定口径|按设计口径定(?:（DEC-\d+）)?)$/, // Q-M0-153
  new RegExp(`^${FREE}{1,30}（无可用${FREE}{1,10}）[，,]可后补$`), // Q-M0-133
];
// 描述类：只在整行已声明可后补时有效（Q-M0-127 / 132 的剩余清单）
const DESCRIBE_ITEMS = [
  /^未测$/,
  /^本样本观察不到$/,
  new RegExp(`^${FREE}{1,30}只取到${FREE}{1,30}$`),
  new RegExp(`^仍待启用${FREE}{1,10}$`),
  new RegExp(`^${FREE}{1,40}[，,]需${FREE}{1,20}账号$`),
];
// 补测记录“[残项] <月-日> 已补 / 补（来源）：尾部”：尾部也必须是已取事实（Q-M0-127 ④、Q-M0-132 残项）
const SUPPLEMENT = /^(?:残项\s*)?\d{1,2}-\d{1,2}\s*已?补(?:（[^）]*）)?[：:](.+)$/;

// 按 ；;。 与 ①～⑳ 拆子项；括号内不拆
function splitItems(text) {
  const items = [];
  let cur = '';
  let depth = 0;
  for (const ch of text) {
    if ('（('.includes(ch)) depth += 1;
    if ('）)'.includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && (/[；;。]/.test(ch) || /[①-⑳]/.test(ch))) {
      items.push(cur);
      cur = '';
    } else cur += ch;
  }
  items.push(cur);
  return items
    .map((x) =>
      x
        .replace(/\*\*/g, '')
        .replace(/^[\s：:]+/, '')
        .replace(/^🟡\s*/, '')
        .trim(),
    )
    .filter(Boolean);
}

const isDoneFact = (text) =>
  FACT_LITERALS.has(text) || (DONE_FACT.test(text) && !NEGATION.test(text) && !CONFLICT.test(text));

// 返回 'defer'（声明类）/ 'ok'（已取事实或描述类）/ null（阻塞）
function judgeItem(raw, state) {
  let item = raw;
  const head = HEAD.exec(item);
  if (head) {
    state.headSeen = true;
    state.declared ||= /可后补/.test(head[0]);
    item = item.slice(head[0].length).replace(/^[\s：:]+/, '');
    if (!item) return 'ok';
  }
  if (FACT_LITERALS.has(item)) return 'ok';
  if (CONFLICT.test(item)) return null;
  const sup = SUPPLEMENT.exec(item);
  if (sup) return isDoneFact(sup[1].trim()) ? 'ok' : null;
  if (matchesAny(DEFER_ITEMS, item)) return state.headSeen ? 'defer' : null; // 声明必须在“剩余 / 未测部分”之后
  if (matchesAny(DESCRIBE_ITEMS, item) || isDoneFact(item)) return 'ok';
  return null;
}
const matchesAny = (list, item) => list.some((re) => re.test(item));

function remainderDeferred(statusCell) {
  const state = { declared: false, headSeen: false };
  const verdicts = splitItems(statusCell).map((i) => judgeItem(i, state));
  if (verdicts.length === 0 || verdicts.includes(null)) return false;
  return state.declared || verdicts.includes('defer');
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
