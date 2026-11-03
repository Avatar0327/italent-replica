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

// 非 ✅ 状态放行只认“整条状态列规范化后逐字等于放行表里的一条”（F-290 第 5 轮，DEC-431①），
// 放行表之外的任何写法（含改了一个字、追加说明、新写法）一律阻塞。放行表 = 真实清单 / 登记册里当前由 DEC 已定或
// 剩余可后补而放行的 20 行状态列原文（取自 main 708feef）。新的状态写法须人工把原文加进下面的常量并配测试；
// 这几行原文被改动后会不再命中、转为阻塞（保守），由 AC-TOOL-F290 的真实清单放行集合测试发现。
// 规范化：NFKC（全半角统一）并去掉所有空白。
const norm = (text) => text.normalize('NFKC').replace(/\s+/g, '');
const releasedSet = (entries) => new Set(entries.map(norm));

// F-303 点名的待实测 / 待取证 / 待定，加 F-290 已有待决写法（回归与历史 CONFLICT），不扩展其他同义词。
const PENDING_STATUS = /待(?:实测|取证|定|确认|复核|用户|原站)/;
const startsChecked = (statusCell) => /^✅/.test(statusCell.trim());
// F-303 P2-1：标点与圈号只在括号外分项，避免诊断丢掉括号内的说明。
function statusItems(statusCell) {
  const items = [];
  const closers = [];
  let start = 0;
  for (const match of statusCell.matchAll(/[()（）；;。，,、]|\.\s+|<br\s*\/?>|[①-⑳]/gi)) {
    const token = match[0];
    if (token === '(' || token === '（') {
      closers.push(token === '(' ? ')' : '）');
      continue;
    }
    if (token === ')' || token === '）') {
      // 只闭合栈顶同类括号；孤立右括号保留原文，未闭合的左括号保守保留后续文字。
      if (token === closers.at(-1)) closers.pop();
      continue;
    }
    if (closers.length) continue;
    items.push(statusCell.slice(start, match.index));
    start = /[①-⑳]/.test(token) ? match.index : match.index + token.length;
  }
  items.push(statusCell.slice(start));
  return items;
}

// F-313：取证列任意位置的 ✅ 都可能触发放行，待决检查必须覆盖相同范围，含带前缀的状态。
// 保留原文与圈号供定位；括号内待决及未完成标记不能被外面的 ✅ 或后面的“已完成”覆盖。
function checkedPendingItems(statusCell) {
  if (!/✅/.test(statusCell)) return [];
  return statusItems(statusCell)
    .map((item) => item.trim())
    .filter((item) => PENDING_STATUS.test(norm(item)) || /🟡|🔴/.test(item));
}

// 取证清单（🟡 行）：Q-M0-127 / 132 / 133 / 153
const RELEASED_EVIDENCE_STATUS = releasedSet([
  // Q-M0-127：docs/07_M0/03_需取证清单.md 第 133 行
  [
    '🟡 2026-10-08 晚 写入实测（25 §10.3，DEC-315 ②，W-656～W-666）：①②③⑨⑩⑮⑲ 已取证（待办按评价者去重、已完成者被拦、',
    '取消待办不使链接失效；被屏蔽者在进度明细标“已评价(被屏蔽)”、报告算未完成、报表整列消失；清空入口“重新作答”启用 / 停用均可、仅已评价行；转发三步向导与收',
    '件人取数）；⑬⑭ 补全（标准版目录、异步生成 2 小时一次）；⑥⑦⑧ 早前已取证。⑪⑫⑱ 已取证（W-667 用户亲手清除：不重发通知、旧报告失效；W-668 ',
    '报表下载为 PNG 截图）。**剩余（可后补）**：⑯ 本样本观察不到；④ 变量清单只取到待办和转发报告两种模板；⑤ 未测；**④ 10-09 补（25 §10',
    '.4，W-692）**：邀请作答邮件 / 短信变量全集已取（含通用网址 ＋ 序列号 ＋ 密码作答方式）；⑤ 仍待启用中活动',
  ].join(''),
  // Q-M0-132：docs/07_M0/03_需取证清单.md 第 138 行
  [
    '🟡 2026-10-08 晚 A5 只读（23 §9）：所属资源集合是系统字段、表单不显示、不可手选，分布在 分类 / 类别 / 级别 / 指标类型 / 指标 ',
    '/ 标准，层级、等级方案、发展通道和人才评定对象没有；所有对象都没有“向下公开”字段；评价表、评审组、评定活动的“所属组织”是必填手选（默认请选择）。**剩余（',
    '可后补）**：下级能否看到 / 引用上级类别与标准，需小范围管理员账号；**残项 10-09 已补（23 §16）**：小范围管理员可见全部类别与标准，不裁剪',
  ].join(''),
  // Q-M0-133：docs/07_M0/03_需取证清单.md 第 139 行
  [
    '🟡 2026-10-08 晚（23 §10，W-677 / W-678，已恢复）：字段全集已取；子集入口 = 组织员工 → 人员子集 → 任职资格（A5 可见，',
    '无需改权限）；**SW74 关 → 已有自动同步记录的编辑 / 删除立即置灰（追溯），手工记录不受影响**。剩余：员工自助能否改（无可用员工账号），可后补',
  ].join(''),
  // Q-M0-153：docs/07_M0/03_需取证清单.md 第 159 行
  [
    '🟡 2026-10-10（25 §10.5，W-773～790）：过程提醒按页（点“下一页”时）判断，提交提醒判断整份；页面不显示秒数；约 1.2～1.5 秒/',
    '题、选项不同的作答，既不弹提醒也不被屏蔽（T1～T3）；耗时大概率按打开到提交的整段时间算；分母、按份 / 按页还没测出，脚本做不到明显低于 1 秒/题；复查（',
    'W-790）T3 约 1.47 秒/题未被屏蔽；未测部分按设计口径定（DEC-392）',
  ].join(''),
]);

// 差异登记册：D-062～D-077（✅ 开头的行另查待决子项）
const RELEASED_DECISION_STATUS = releasedSet([
  // D-062：docs/00_状态/04_缺口冲突差异登记册.md 第 89 行
  '已定（DEC-261 选③：结构化录入，保存时编译为 R3-T00 表达式）',
  // D-063：docs/00_状态/04_缺口冲突差异登记册.md 第 90 行
  '已定（DEC-318，可推翻）',
  // D-064：docs/00_状态/04_缺口冲突差异登记册.md 第 91 行
  '已关闭（DEC-352：查看照原站全员可见；写操作仍按管理单元，🟡）',
  // D-065：docs/00_状态/04_缺口冲突差异登记册.md 第 92 行
  '已定（DEC-355①，可推翻）',
  // D-066、D-067、D-068、D-069、D-071、D-076、D-077：docs/00_状态/04_缺口冲突差异登记册.md 第 93、94、95、96、98、103、104 行
  '已定（可推翻）',
  // D-070、D-072、D-073、D-074：docs/00_状态/04_缺口冲突差异登记册.md 第 97、99、100、101 行
  '已定（用户选定）',
  // D-075：docs/00_状态/04_缺口冲突差异登记册.md 第 102 行
  '已定',
]);

export function evidenceState(blocks, statusCell) {
  const pendingItems = checkedPendingItems(statusCell);
  const st = /🔴/.test(statusCell)
    ? '🔴 未定论'
    : /🟡/.test(statusCell) || pendingItems.length > 0
      ? '🟡 部分'
      : /✅/.test(statusCell)
        ? '✅'
        : '□ 未取证';
  const deferred = st === '🟡 部分' && RELEASED_EVIDENCE_STATUS.has(norm(statusCell));
  // ✅ 中明确待决的子项须阻塞；其余状态保留 F-290 / F-271 的后补口径。
  if (pendingItems.length) return { st, level: '开工前', pendingItems };
  return { st, level: deferred ? '可后补' : level(blocks), pendingItems };
}

// 差异行：✅ 须在开头且每个子项都无待决才算已结；其余继续整列精确匹配。
export const decisionSettled = (statusCell) =>
  (startsChecked(statusCell) && checkedPendingItems(statusCell).length === 0) ||
  RELEASED_DECISION_STATUS.has(norm(statusCell));

// F-367 第 2 轮：阻塞列按任务写级别。顶层分段（括号外按、；，分隔）形如“R3-T03（不挡本任务：…）”时，
// 该段任务对这一行只列为可后补；同一任务在别的分段也出现、或该段另写“开工前”，仍按整行级别（保守）。
// 标记不含“后续 / 可后补”等字样，不会触发整行放行（整行放行的缺陷另见 F-407）。
const DEFERRED_SEGMENT = /^(?:R\d-T\d{2}|F-\d{3})(?:\s*\/\s*(?:R\d-)?T\d{2})*\s*[（(]不挡本任务/;
function topLevelSegments(text) {
  const segments = [];
  let depth = 0;
  let start = 0;
  for (const match of text.matchAll(/[()（）、；;，,]/g)) {
    const token = match[0];
    if (token === '(' || token === '（') depth += 1;
    else if (token === ')' || token === '）') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      segments.push(text.slice(start, match.index));
      start = match.index + 1;
    }
  }
  segments.push(text.slice(start));
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

export function deferredTasks(blocks) {
  const deferred = new Set();
  const others = new Set();
  for (const segment of topLevelSegments(blocks)) {
    const into = DEFERRED_SEGMENT.test(segment) && !/开工前/.test(segment) ? deferred : others;
    for (const id of taskIds(segment)) into.add(id);
  }
  return new Set([...deferred].filter((id) => !others.has(id)));
}

export function parseEvidence(markdown, file = 'docs/07_M0/03_需取证清单.md') {
  return markdown.split('\n').flatMap((l, index) => {
    if (!/^\| Q-M0-\d+/.test(l)) return [];
    const c = cells(l);
    const state = evidenceState(c[4], c[5]);
    return [
      {
        id: c[0],
        what: c[2],
        blocks: c[4],
        tasks: taskIds(c[4]),
        file,
        line: index + 1,
        ...state,
        // ✅ 中有待决子项时一律开工前阻塞，不按任务放宽。
        deferredTasks: state.pendingItems.length ? new Set() : deferredTasks(c[4]),
      },
    ];
  });
}

export function parseDecisions(markdown, file = 'docs/00_状态/04_缺口冲突差异登记册.md') {
  return markdown
    .split('\n')
    .flatMap((l, index) => {
      if (!/^\| \*\*D-\d+\*\*/.test(l)) return [];
      const c = cells(l);
      // 只认显式写明的“影响任务：R1-T03、F-007”；行里顺带提到的任务号不算范围（PR #46 Codex 审查 P2）
      const scope = /影响任务[：:]\s*([^|；;。]+)/.exec(l);
      return [
        {
          id: c[0].replace(/\*/g, ''),
          what: c[1],
          diff: c[2],
          st: c[4] ?? '',
          tasks: scope ? taskIds(scope[1]) : null,
          file,
          line: index + 1,
          pendingItems: checkedPendingItems(c[4] ?? ''),
        },
      ];
    })
    .filter((d) => !decisionSettled(d.st));
}

const clip = (s, n = 70) => (s.length > n ? s.slice(0, n) + '…' : s);
// 子项不截断，避免待决词在长说明尾部时诊断再次漏掉。
const pendingDetails = (row) =>
  row.pendingItems.map((item) => `    ${row.file}:${row.line}  ${row.id}  待决子项：${item}`);

/** 返回要打印的行与退出码：有“开工前”未完成项或待决差异（且指定了目标）时为 1。 */
export function gateReport(evidence, decisions, targets) {
  const out = [];
  let blocked = false;
  if (targets.length === 0) {
    const open = evidence.filter((e) => e.st !== '✅');
    out.push(`未完成取证 ${open.length} 项（共 ${evidence.length} 项）`);
    for (const e of open) out.push(`  ${e.id}  ${e.st}  [${e.blocks}]  ${clip(e.what)}`, ...pendingDetails(e));
  } else {
    for (const t of targets) {
      const hits = evidence.filter((e) => e.tasks.has(t) && e.st !== '✅');
      const levelFor = (e) => (e.deferredTasks?.has(t) ? '可后补' : e.level);
      const must = hits.filter((e) => levelFor(e) === '开工前');
      const later = hits.filter((e) => levelFor(e) === '可后补');
      out.push(`\n== ${t} ==`);
      if (must.length) {
        blocked = true;
        out.push(`⛔ 开工前须完成的取证 ${must.length} 项：`);
        for (const e of must) out.push(`  ${e.id}  ${e.st}  ${clip(e.what)}`, ...pendingDetails(e));
      }
      if (later.length) {
        out.push(`⚠️ 可先按暂定口径开发、合并后补的取证 ${later.length} 项：`);
        for (const e of later) out.push(`  ${e.id}  ${e.st}  ${clip(e.what)}`, ...pendingDetails(e));
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
    for (const d of relevant) out.push(`  ${d.id}  ${clip(d.st, 20)}  ${clip(d.what)}`, ...pendingDetails(d));
  }
  return { lines: out, exitCode: blocked ? 1 : 0 };
}
