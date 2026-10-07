#!/usr/bin/env python3
"""进度看板更新工具（进度窗口专用）。只改 看板数据.json，再由模板生成 进度看板.html。

用法（多条命令用 -- 分隔，按顺序执行）：
  python3 board.py t F-022 s=review pr+=93 note="…" -- pr 93 s=review r=2 n="…" -- log "…" -- build
命令：
  t <ID> k=v …     改任务字段：n 名称 / ms 子阶段 / p 被修正任务 / s 状态(done|active|review|todo|blocked)
                   dev / rev / note / ev(阻塞取证说明) / deps=a,b / pr=1,2 / pr+=93；值为 - 表示删除该字段
  pr <N> k=v …      改在途 PR：s 状态 / r 轮次 / n 说明 / h+="第N轮:说明"（追加轮次记录）；pr <N> -  删除（合并后）
  run <编号> pr=N n=任务 now=当前在做 r=轮次 who=谁在做   改“正在进行”清单一行；run <编号> -  删除
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


def build(d, nosync):
    if not nosync:
        sync(d)
        save(d)
    html = open(TPL, encoding="utf8").read().replace("__DATA__", json.dumps(d, ensure_ascii=False))
    with open(OUT, "w", encoding="utf8") as f:
        f.write(html)
    js = html[html.index("const DATA"):html.rindex("</script>")]
    stub = """const els={};const mk=()=>({innerHTML:"",textContent:"",hidden:false,onclick:null,addEventListener(){},closest(){return null},classList:{add(){},remove(){}}});
global.document={getElementById:id=>els[id]||(els[id]=mk()),querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}};
""" + js + "\nconsole.log('ok graph',els.graph.innerHTML.length,'table',els.table.innerHTML.length,'log',els.log.innerHTML.length,'|',els.stats.innerHTML.replace(/<[^>]+>/g,' ').replace(/\\s+/g,' ').slice(0,200));"
    r = subprocess.run(["node", "-e", stub], capture_output=True, text=True)
    print(r.stdout.strip() or r.stderr.strip()[:800])
    if r.returncode:
        sys.exit(1)


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
