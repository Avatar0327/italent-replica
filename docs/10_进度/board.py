#!/usr/bin/env python3
"""进度看板更新工具（进度窗口专用）。只改 看板数据.json，再由模板生成 进度看板.html。

用法（多条命令用 -- 分隔，按顺序执行）：
  python3 board.py t F-022 s=review pr+=93 note="…" -- pr 93 s=review r=2 n="…" -- log "…" -- build
命令：
  t <ID> k=v …     改任务字段：n 名称 / ms 子阶段 / p 被修正任务 / s 状态(done|active|review|todo|blocked)
                   dev / rev / note / ev(阻塞取证说明) / deps=a,b / pr=1,2 / pr+=93；值为 - 表示删除该字段
  pr <N> k=v …      改在途 PR：s 状态 / r 轮次 / n 说明 / h+="第N轮:说明"（追加轮次记录）；pr <N> -  删除（合并后）
  it <编号> g=链 o=列序 k=run|done|todo pr=N n=任务 seg="ev:d ds:n dev:a4 rev:d3 mg:w" now=… wait=… need=1 fable=1 up=… u=…
                   进行中看板条目（seg 段状态 a 正在做 / d 完成 / w 待做 / n 不适用，后接轮次；同链同 o 为并行）；it <编号> -  删除
  chain <链> t=标题 d=说明   定义一条依赖链（按加入顺序显示）；chain <链> -  删除
  build              生成两个页面：进度看板.html（总体，低频发布）与 进行中看板.html（高频发布）
  log "<文本>"      在最近动态最前面加一条（日期取今天）
  build [--nosync] 同步统计（gh、DEC、evidence-gate）并生成 HTML，再用 node 校验渲染
"""
import json, os, re, subprocess, sys, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
DATA = os.path.join(HERE, "看板数据.json")
TPL = os.path.join(HERE, "进度看板.template.html")
OUT = os.path.join(HERE, "进度看板.html")


def load():
    with open(DATA, encoding="utf8") as f:
        return json.load(f)


def save(d):
    with open(DATA, "w", encoding="utf8") as f:
        json.dump(d, f, ensure_ascii=False, indent=0)


def kv(args):
    for a in args:
        if "+=" in a:
            k, v = a.split("+=", 1)
            yield k, "+", v
        else:
            k, v = a.split("=", 1)
            yield k, "=", v


def cmd_t(d, a):
    tid, rest = a[0], a[1:]
    t = d["tasks"].setdefault(tid, {"n": tid, "s": "todo"})
    for k, op, v in kv(rest):
        if v == "-":
            t.pop(k, None)
        elif k in ("deps", "pr"):
            vals = [int(x) if k == "pr" else x for x in v.split(",") if x]
            t[k] = (t.get(k, []) + [x for x in vals if x not in t.get(k, [])]) if op == "+" else vals
        else:
            t[k] = v


def cmd_pr(d, a):
    n, rest = a[0], a[1:]
    if rest == ["-"]:
        d["prs"].pop(n, None)
        return
    p = d["prs"].setdefault(n, {"s": "review", "r": 1, "n": ""})
    for k, op, v in kv(rest):
        if k == "h":
            kk, dd = v.split(":", 1)
            p.setdefault("h", []).append([kk, dd])
        elif k == "r":
            p["r"] = int(v)
        else:
            p[k] = v


def cmd_item(d, key, a):
    rows = d.setdefault(key, [])
    k, rest = a[0], a[1:]
    row = next((r for r in rows if r["id"] == k), None)
    if rest == ["-"]:
        if row: rows.remove(row)
        return
    if not row:
        row = {"id": k}; rows.append(row)
    for kk, _, v in kv(rest):
        if v == "-":
            row.pop(kk, None)
        else:
            row[kk] = int(v) if kk in ("pr", "o") else v
    d["liveUpdated"] = datetime.datetime.now().strftime("%m-%d %H:%M")


def cmd_run(d, a):
    rows = d.setdefault("run", [])
    key, rest = a[0], a[1:]
    row = next((r for r in rows if r[1] == key), None)
    if rest == ["-"]:
        if row: rows.remove(row)
        return
    if not row:
        row = [None, key, "", "", "", ""]; rows.append(row)
    idx = {"pr": 0, "n": 2, "now": 3, "r": 4, "who": 5}
    for k, _, v in kv(rest):
        row[idx[k]] = (int(v) if v not in ("", "-") else None) if k == "pr" else v
    rows.sort(key=lambda r: (r[0] is None, r[0] or 0))


def cmd_log(d, a):
    d["log"].insert(0, [datetime.date.today().strftime("%m-%d"), a[0]])
    d["updated"] = datetime.date.today().isoformat()


def sh(c):
    return subprocess.run(c, shell=True, cwd=ROOT, capture_output=True, text=True).stdout.strip()


def sync(d):
    s = d.setdefault("stats", {})
    try:
        s["merged"] = int(sh("gh pr list --state merged --limit 500 --json number --jq length") or s.get("merged", 0))
        s["open"] = int(sh("gh pr list --state open --json number --jq length") or s.get("open", 0))
    except ValueError:
        pass
    dec = re.findall(r"\*\*DEC-(\d+)", open(os.path.join(ROOT, "docs/00_状态/02_已确认决策.md"), encoding="utf8").read())
    if dec:
        s["dec"] = max(map(int, dec))
    m = re.search(r"未完成取证 (\d+) 项（共 (\d+) 项）", sh("node scripts/evidence-gate.mjs"))
    if m:
        s["ev"] = f"{m.group(1)}/{m.group(2)}"


def live_prs():
    """进行中看板的自动部分：在途 PR 逐个判状态（卡点优先），以及已合并 PR 清单。"""
    now = datetime.datetime.now(datetime.timezone.utc)
    def age(t):
        return int((now - datetime.datetime.fromisoformat(t.replace("Z", "+00:00"))).total_seconds() // 60) if t else 10**6
    try:
        opened = json.loads(sh("gh pr list --state open --limit 40 --json number,title,isDraft,mergeable,statusCheckRollup,createdAt,headRefOid") or "[]")
        for p in opened:  # 评论与最新提交逐个取，避免一次查询过大被 GraphQL 拒绝
            p["comments"] = [{"createdAt": c["created_at"], "body": c["body"]} for c in
                             json.loads(sh(f"gh api --paginate repos/{{owner}}/{{repo}}/issues/{p['number']}/comments --jq '[.[] | {{created_at, body}}]' | jq -s add") or "[]") or []]
            cd = sh(f"gh api repos/{{owner}}/{{repo}}/commits/{p['headRefOid']} --jq .commit.committer.date")
            p["commits"] = [{"committedDate": cd}] if cd else []
        merged = json.loads(sh("gh pr list --state merged --limit 500 --json number,title,mergedAt") or "[]")
    except ValueError:
        return None
    paused = set()
    try:
        paused = set(open(os.path.expanduser("~/.cache/italent-paused-prs")).read().split())
    except OSError:
        pass
    out = []
    for p in opened:
        n = p["number"]
        if str(n) in paused:
            continue
        best = {}  # 同名检查可能有多条（取消后重跑），按名取最好结果：任一 SUCCESS 即算 SUCCESS
        for c in p["statusCheckRollup"]:
            if c.get("conclusion") == "SKIPPED":
                continue
            v = c.get("conclusion") or c.get("status")
            k = c.get("name") or c.get("context") or str(len(best))
            if best.get(k) != "SUCCESS":
                best[k] = v
        checks = list(best.values())
        ci = "none" if not checks else "green" if all(c == "SUCCESS" for c in checks) else "red" if any(c in ("FAILURE", "CANCELLED", "TIMED_OUT") for c in checks) else "running"
        cs = p["comments"]
        last_push = p["commits"][-1]["committedDate"] if p["commits"] else p["createdAt"]
        def last(pred):
            ts = [c["createdAt"] for c in cs if pred(c.get("body", "").lstrip())]
            return max(ts) if ts else ""
        t_ask = last(lambda b: b.startswith("【等决定】"))
        t_dec = last(lambda b: b.startswith(("【决定】", "【派发更正】")) or "已按 A 处理" in b[:40] or "按 DEC-" in b[:60] and "处理" in b[:60])
        t_rev = last(lambda b: b.startswith("【审查已发起】"))
        t_res = last(lambda b: b.startswith("## 审查原文"))
        res_body = next((c["body"] for c in reversed(cs) if c.get("body", "").lstrip().startswith("## 审查原文")), "")
        t_done = last(lambda b: b.startswith(("开发完成", "设计完成")))
        rounds = sum(1 for c in cs if c.get("body", "").lstrip().startswith("## 审查原文"))
        act = max([x for x in (last_push, cs[-1]["createdAt"] if cs else "") if x] or [p["createdAt"]])
        # 10-11 用户指出看板与实际不符：CI 红 / 冲突原先排在审查阶段之前，审查中、审查通过待合并的 PR 被误报为卡点。
        # 现在先按流程阶段定状态（等决定 → 审查中 → 审查通过合并中 → 返工 → 待送审），CI / 冲突只作附注
        t_merge = last(lambda b: b.startswith(("待合并", "已合并 main，待合并", "【待合并】")))
        # “暂不能合并：本轮代码复审通过，但 CI 未全绿”（#243）也算审查通过；之后贴过“待合并”同样算
        head = res_body[:400]
        approved = bool(t_res) and not (t_rev > t_res) and (("可以合并" in head and "暂不能合并" not in head) or "代码复审通过" in head or "代码审查通过" in head or t_merge > t_res)
        # 【等决定】之后已有开发完成 / 审查发起，说明已不再等（如 #245 D02 随 #244 合并自然解除，未补【决定】）
        asking = t_ask and t_ask > t_dec and t_ask > max(t_done, t_rev)
        note = "；与 main 冲突" if p["mergeable"] == "CONFLICTING" else "；CI 红" if ci == "red" else "；CI 运行中" if ci == "running" else ""
        st, why = "dev", "开发中"
        if asking:
            st, why = "decide", "【等决定】待你 / 总编排定"
        elif t_rev and t_rev > t_res:
            st, why = "review", f"第 {rounds + 1} 轮审查中"
        elif approved and ci == "red" and not t_merge > t_res:
            st, why = "rework", "审查通过，CI 红修复中"
            note = ""
        elif approved:
            st, why = "merge", "审查通过，合并中" + note
            note = ""
        elif t_res and t_done <= t_res:
            st, why = f"rework", f"第 {rounds} 轮未过，返工中"
        elif t_done and t_done > max(t_res, t_rev) and last_push > t_done:
            # 10-12 #282：贴“开发完成”后仍有新推送（清单补充在补），记返工中，不记待审
            st, why = "rework", f"第 {rounds + 1} 轮前补充修改中"
        elif t_done and t_done > max(t_res, t_rev) and p["mergeable"] == "CONFLICTING":
            st, why = "conflict", "开发完成，待合 main 后送审"
            note = ""
        elif t_done and t_done > max(t_res, t_rev) and not p["isDraft"]:
            st, why = "queue", "开发完成，待发起审查"
        elif p["mergeable"] == "CONFLICTING" and not p["isDraft"]:
            st, why = "conflict", "与 main 冲突，CI 不跑"
            note = ""
        elif ci == "red" and not p["isDraft"]:
            st, why = "cired", "CI 红"
            note = ""
        elif not p["isDraft"] and ci == "green":
            st, why = "queue", "待发起审查"
        elif not p["isDraft"]:
            st, why = "ci", "等 CI"
        why += note
        idle = age(act)
        # DEC-428 暂停派发期间（标记文件同 watch.py），待审 / 返工 / CI 红都是在等恢复，不算卡点；待决定与合并中超时仍算
        hold = os.path.exists(os.path.expanduser("~/.cache/italent-dispatch-paused"))
        # 已过审在合并队列里（合并中 / 审查通过 CI 红修复中）由审查合并窗口盯，180 分钟才算卡点（10-12 用户同意减误报）
        lim = 180 if why.startswith("审查通过") else 60
        stuck = (st == "decide" or (st == "merge" and idle >= 180)) if hold else st == "decide" or (st in ("conflict", "cired") and idle >= 60) or (st in ("merge", "dev", "rework") and idle >= lim) or (st == "queue" and idle >= 15)
        out.append({"n": n, "t": p["title"][:60], "s": st, "why": why, "r": rounds, "idle": idle, "stuck": stuck,
                    "ask": age(t_ask) if st == "decide" else None})
    today = now.strftime("%Y-%m-%d")
    return {"at": now.strftime("%m-%d %H:%MZ"), "open": out,
            "merged": {str(m["number"]): m["mergedAt"][:10] for m in merged},
            "today": [{"n": m["number"], "t": m["title"][:60], "at": m["mergedAt"][11:16]} for m in merged if m["mergedAt"][:10] == today]}


PROG = os.path.expanduser("~/.cache/italent-board-progress.json")


def progress(d, live):
    """进行中看板顶部的“已完成 / 计划 PR”（用户 10-11 要求）：主线 + 支撑任务的步骤，暂停的不计；
    分子 = 步骤 PR 已合并或标 done。与上次不同则把上次读数记为 prev，看板显示变化量"""
    merged = (live or {}).get("merged", {})
    done = tot = 0
    for ln in (d.get("main") or {}).get("lines", []):   # 10-15：只算主线，与 D1+D2+D3 三张卡片之和一致（支撑在页 2，重复项不计）
        steps = [s for g in ln.get("groups", []) for s in g["steps"]]
        for st in steps:
            if st.get("s") == "paused" or st.get("dup"):
                continue
            tot += 1
            done += bool(st.get("s") == "done" or (st.get("pr") and str(st["pr"]) in merged))
    # 依赖已满足但没派的步骤（10-11 B6 漏派 4.5 小时）：after 里的步骤全部合并、自身没有 PR 也没标已派
    ready = []
    for ln in (d.get("main") or {}).get("lines", []):
        steps = [s for g in ln.get("groups", []) for s in g["steps"]]
        byk = {s["k"]: s for s in steps}
        isdone = lambda s: s and (s.get("s") == "done" or (s.get("pr") and str(s["pr"]) in merged))
        for st in steps:
            if st.get("after") and not st.get("pr") and st.get("s") not in ("assigned", "paused", "done") and all(isdone(byk.get(k)) for k in st["after"]):
                ready.append(f"{ln['id']} {st['k']} {st['n']}")
    print("ready " + ("；".join(ready) if ready else "无"))
    at = (live or {}).get("at", "")
    try:
        rec = json.load(open(PROG))
    except (OSError, ValueError):
        rec = {}
    cur = rec.get("cur")
    if not cur or cur[:2] != [done, tot]:
        rec = {"cur": [done, tot, at], "prev": cur}
        os.makedirs(os.path.dirname(PROG), exist_ok=True)
        json.dump(rec, open(PROG, "w"))
    print(f"progress {done}/{tot}" + (f" prev {rec['prev'][0]}/{rec['prev'][1]} @{rec['prev'][2]}" if rec.get("prev") else ""))
    return {"done": done, "tot": tot, "prev": rec.get("prev"), "since": rec["cur"][2], "ms": milestones(d, merged)}


MS_DEF = {"D1": {"t": "D1 · R1+R3 可演示", "dl": "2026-10-15"},
          "D2": {"t": "D2 · R1+R2+R3 完整演示版（在 D1 上加 R2）", "dl": "2026-10-19"},
          "D3": {"t": "D3 · 绿 + 蓝全模块", "dl": "2026-10-31"}}
D3_R2 = {"BE-12", "BE-13", "FE-R2f"}   # 人事分析：蓝色、可先接桩，不影响演示 → D3（用户 10-14 决定）


def resolve(ln, st):
    """每个步骤的 演示节点(D1/D2/D3)、模块标签、类型。st['ms'] 优先；R2E 线归 D2（人事分析 D3）；蓝色模块 D3；其余 D1。"""
    k, lid = str(st.get("k", "")), ln.get("id", "")
    if st.get("ms"):
        ms = st["ms"]
    elif k in D3_R2 or k.startswith("M-"):
        ms = "D3"
    elif lid == "R2E":
        ms = "D2"
    else:
        ms = "D1"
    if lid == "R2E" or k in ("REM-R2a", "REM-R2b", "GAP-R2", "SPLIT-R2", "PRIO-R2"):
        mod = "R2"
    elif k.startswith("M-"):
        mod = "蓝"
    elif k.startswith("FE-R1") or k == "REM-R1":
        mod = "R1"
    elif k.startswith("FE-R3") or k == "REM-R3" or lid in ("T02", "T03", "T04", "T05", "T07"):
        mod = "R3"
    elif lid in ("FE",):
        mod = "底座"
    else:
        mod = "支撑"
    if k.startswith("REM-") or k.startswith("F-129") or k.startswith("F-131") or k == "UI-ref":
        kind = "取证"
    elif k in ("GAP-R2", "SPLIT-R2", "PRIO-R2"):
        kind = "规划"
    elif k.startswith("DEMO-") or k == "PRD-kit":
        kind = "演示配套"
    elif k.startswith("FE-") or k.startswith("M-"):
        kind = "前端" if k.startswith("FE-") else "蓝色模块"
    else:
        kind = "后端"
    return ms, mod, kind


def mile_rows(d):
    """演示节点用的平铺任务表：只含主线（支撑任务不计，在页 2），暂停项、dup 重复项不进。"""
    rows = []
    for ln in (d.get("main") or {}).get("lines", []):
        for g in ln.get("groups", []):
            for st in g["steps"]:
                if st.get("s") == "paused" or st.get("dup"):
                    continue
                ms, mod, kind = resolve(ln, st)
                rows.append({"st": st, "ms": ms, "mod": mod, "kind": kind})
    return rows


def ms_of(d):
    """步骤键 → 演示节点（含 dup 项，供任务格上的 D 标签）。"""
    out = {}
    for ln in (d.get("main") or {}).get("lines", []):
        for g in ln.get("groups", []):
            for st in g["steps"]:
                if st.get("s") != "paused":
                    out[st["k"]] = resolve(ln, st)[0] if not st.get("dup") else None
    for ln in (d.get("main") or {}).get("lines", []):
        for g in ln.get("groups", []):
            for st in g["steps"]:
                if st.get("dup"):
                    out[st["k"]] = out.get(st["dup"])
    return out


def milestones(d, merged):
    out = {k: {"t": v["t"], "dl": v["dl"], "done": 0, "act": 0, "todo": 0, "tot": 0} for k, v in MS_DEF.items()}
    for r in mile_rows(d):
        st, m = r["st"], out[r["ms"]]
        m["tot"] += 1
        if st.get("s") == "done" or (st.get("pr") and str(st["pr"]) in merged):
            m["done"] += 1
        elif st.get("pr") or st.get("s") in ("assigned", "ready"):
            m["act"] += 1
        else:
            m["todo"] += 1
    out["paused"] = sorted(i.get("pr") for i in d.get("items", []) if "DEC-475" in str(i.get("now", "")) and i.get("pr") and i.get("pr") != 100)
    return out


L3_LINES = ("T02", "T03", "T04", "T05", "T07")


def build_l3(d, lv):
    """页 2：L3 深度线 + 支撑任务的任务级明细（新页面，不动复刻进度看板）。同一模板，只换数据并隐藏全局 PR 列表。"""
    main = d.get("main") or {}
    data = {"main": {"lines": [l for l in main.get("lines", []) if l.get("id") in L3_LINES], "support": main.get("support", []), "asks": []},
            "items": d.get("items"), "log": [], "live": lv, "prog": None, "page": "l3"}
    h = open(os.path.join(HERE, "进行中看板.template.html"), encoding="utf8").read().replace("__DATA__", json.dumps(data, ensure_ascii=False))
    h = h.replace("<title>iTalent 进行中</title>", "<title>iTalent L3 深度线</title>", 1).replace("<h1>iTalent 进行中</h1>", "<h1>iTalent L3 深度线与支撑</h1>", 1)
    a = h.index('<section class="flow"')
    h = h[:a] + h[h.index("</details></section>", a) + len("</details></section>"):]
    for head in ("<section><h2>卡点与待你决定</h2>", "<section><h2>其他在途（修正任务等）</h2>", "<section><h2>今日已合并</h2>", "<section><details><summary>最近动态</summary>"):
        h = h.replace(head, head.replace("<section>", "<section hidden>", 1), 1)
    h = h.replace("</style>", "#kpis,#ms{display:none}</style>", 1)
    with open(os.path.join(HERE, "L3深度线看板.html"), "w", encoding="utf8") as f:
        f.write(h)
    js = h[h.index("const DATA"):h.rindex("</script>")]
    stub = """const els={};const mk=()=>({innerHTML:"",textContent:""});global.document={getElementById:id=>els[id]||(els[id]=mk())};
""" + js + "\nconsole.log('l3 lines',(els.lines.innerHTML.match(/class=\"line\"/g)||[]).length,'chips',(els.lines.innerHTML.match(/class=\"chip/g)||[]).length,'support chips',(els.support.innerHTML.match(/class=\"chip/g)||[]).length)"
    r = subprocess.run(["node", "-e", stub], capture_output=True, text=True)
    print(r.stdout.strip() or r.stderr.strip()[:600])


def build(d, nosync):
    if not nosync:
        sync(d)
        save(d)
    lv = live_prs() if not nosync else d.get("_live")
    live = open(os.path.join(HERE, "进行中看板.template.html"), encoding="utf8").read().replace(
        "__DATA__", json.dumps({"main": d.get("main"), "items": d.get("items"), "log": d.get("log", [])[:12],
                                "live": lv, "prog": progress(d, lv), "mile": mile_rows(d), "msof": ms_of(d)}, ensure_ascii=False))
    live = live.replace("<section><h2>支撑任务</h2>", "<section hidden><h2>支撑任务</h2>", 1)   # 支撑任务在页 2（L3 深度线），页 1 不显示
    with open(os.path.join(HERE, "进行中看板.html"), "w", encoding="utf8") as f:
        f.write(live)
    build_l3(d, lv)
    ljs = live[live.index("const DATA"):live.rindex("</script>")]
    lstub = """const els={};const mk=()=>({innerHTML:"",textContent:""});global.document={getElementById:id=>els[id]||(els[id]=mk())};
""" + ljs + "\nconsole.log('live lines',(els.lines.innerHTML.match(/class=\"line\"/g)||[]).length,'chips',(els.lines.innerHTML.match(/class=\"chip/g)||[]).length,'stuck',(els.stuck.innerHTML.match(/class=\"sk/g)||[]).length);"
    rr = subprocess.run(["node", "-e", lstub], capture_output=True, text=True)
    print(rr.stdout.strip() or rr.stderr.strip()[:800])
    if rr.returncode:
        sys.exit(1)
    html = open(TPL, encoding="utf8").read().replace("__DATA__", json.dumps(d, ensure_ascii=False))
    js = html[html.index("const DATA"):html.rindex("</script>")]
    stub = """const els={};const mk=()=>({innerHTML:"",textContent:"",hidden:false,onclick:null,addEventListener(){},closest(){return null},classList:{add(){},remove(){}}});
global.document={getElementById:id=>els[id]||(els[id]=mk()),querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}};
""" + js + "\nconsole.log('ok graph',els.graph.innerHTML.length,'table',els.table.innerHTML.length,'log',els.log.innerHTML.length,'|',els.stats.innerHTML.replace(/<[^>]+>/g,' ').replace(/\\s+/g,' ').slice(0,200));"
    r = subprocess.run(["node", "-e", stub], capture_output=True, text=True)
    print(r.stdout.strip() or r.stderr.strip()[:800])
    if r.returncode:
        print("！！总体看板渲染校验失败，未写入 进度看板.html", file=sys.stderr)
        sys.exit(1)
    with open(OUT, "w", encoding="utf8") as f:
        f.write(html)


def main():
    d = load()
    argv, groups, cur = sys.argv[1:], [], []
    for a in argv:
        if a == "--":
            groups.append(cur); cur = []
        else:
            cur.append(a)
    groups.append(cur)
    did_build = False
    for g in groups:
        if not g:
            continue
        c, a = g[0], g[1:]
        if c == "t":
            cmd_t(d, a)
        elif c == "pr":
            cmd_pr(d, a)
        elif c == "it":
            cmd_item(d, "items", a)
        elif c == "chain":
            rows = d.setdefault("chains", []); g = a[0]
            row = next((r for r in rows if r["g"] == g), None)
            if a[1:] == ["-"]:
                rows.remove(row) if row else None
            else:
                if not row: row = {"g": g}; rows.append(row)
                for kk, _, v in kv(a[1:]): row[kk] = v
        elif c == "run":
            cmd_run(d, a)
        elif c == "log":
            cmd_log(d, a)
        elif c == "build":
            save(d); build(d, "--nosync" in a); did_build = True
        else:
            sys.exit(f"未知命令 {c}")
    if not did_build:
        save(d)


if __name__ == "__main__":
    main()
