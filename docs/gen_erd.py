"""Generate a rich, landscape ERD parsed from the LIVE Postgres migration SQL.

There's no local Postgres running for this project (it's Supabase), so instead
of PRAGMA introspection this parses the real `create table` statements in
supabase/migrations/20260924000001_schema.sql directly -- same principle as the
SQLite-based generators (real source, not hand-drawn), just a different source
of truth. Writes erd-real.html; render with headless Chrome (command printed at
the end).

    python3 docs/gen_erd.py
"""

from __future__ import annotations

import html
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SCHEMA_SQL = ROOT / "supabase" / "migrations" / "20260924000001_schema.sql"
W, H = 1900, 1160
ACCENT, PKBG, DOT = "#92400e", "#fef3e2", "#fef3e2"  # coffee-roaster amber/brown

TABLES_ORDER = [
    "store_admins", "products", "orders", "order_items",
    "knowledge_docs", "knowledge_chunks", "conversations", "messages", "rate_limits",
]

POS = {
    "products": (60, 190), "orders": (60, 560), "order_items": (430, 560),
    "knowledge_docs": (430, 190), "knowledge_chunks": (800, 190),
    "conversations": (1230, 190), "messages": (1230, 560),
    "store_admins": (1580, 190), "rate_limits": (1580, 560),
}

ZONES = [
    (30, 150, 660, 850, "Catalog &amp; orders", "rgba(146,64,14,.06)", "rgba(146,64,14,.35)"),
    (400, 150, 660, 350, "Knowledge base (RAG)", "rgba(13,148,136,.06)", "rgba(13,148,136,.35)"),
    (1200, 150, 300, 850, "Conversations", "rgba(2,132,199,.06)", "rgba(2,132,199,.35)"),
    (1550, 150, 300, 350, "Access &amp; ops", "rgba(100,116,139,.06)", "rgba(100,116,139,.35)"),
]

LINES = [
    ("M310,330 V560 H430", [(322, 480, "1"), (412, 552, "&#8734;")], (330, 470, "line items")),
    ("M300,660 H430", [(312, 652, "1"), (412, 652, "&#8734;")], (335, 644, "contains")),
    ("M670,260 H800", [(682, 252, "1"), (782, 252, "&#8734;")], (700, 244, "chunked into")),
    ("M310,260 V310 H430 V320", [(322, 300, "1"), (412, 312, "&#8734;")], (350, 300, "describes")),
    ("M1370,660 V330 H1370", [], None),
    ("M1300,330 V400 H1300 V560", [(1312, 352, "1"), (1312, 552, "&#8734;")], (1330, 400, "has messages")),
]


def parse_ddl(sql_text: str) -> dict:
    tables = {}
    for m in re.finditer(r"create table (?:public\.)?(\w+)\s*\((.*?)\n\);", sql_text, re.S):
        name, body = m.group(1), m.group(2)
        cols = []
        fks = {}
        depth = 0
        buf = ""
        parts = []
        for ch in body:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            if ch == "," and depth == 0:
                parts.append(buf.strip())
                buf = ""
            else:
                buf += ch
        if buf.strip():
            parts.append(buf.strip())

        for part in parts:
            line = " ".join(part.split())
            if not line or line.lower().startswith(("primary key", "unique (", "check (")):
                if line.lower().startswith("primary key"):
                    pk_cols = re.findall(r"\((.*?)\)", line)
                    if pk_cols:
                        for c in pk_cols[0].split(","):
                            for col in cols:
                                if col["name"] == c.strip():
                                    col["pk"] = True
                continue
            cm = re.match(r"(\w+)\s+([a-zA-Z0-9_.\[\]() ]+?)(\s+.*)?$", line)
            if not cm:
                continue
            cname, ctype = cm.group(1), cm.group(2).strip()
            rest = line
            pk = bool(re.search(r"\bprimary key\b", rest, re.I))
            fk_match = re.search(r"references\s+(?:public\.)?(\w+)\s*\(([\w]+)\)", rest, re.I)
            if fk_match:
                fks[cname] = fk_match.group(1)
            ctype_short = ctype.split()[0] if ctype else "text"
            ctype_short = ctype_short.replace("extensions.", "")
            ctype_short = {
                "bigint": "bigint", "text": "text", "uuid": "uuid",
                "timestamptz": "timestamptz", "integer": "integer",
                "boolean": "boolean", "date": "date", "jsonb": "jsonb",
                "tsvector": "tsvector",
            }.get(ctype_short, ctype_short)
            cols.append({"name": cname, "type": ctype_short, "pk": pk})
        tables[name] = {"cols": cols, "fks": fks}
    return tables


def card(name, meta, x, y):
    lis = []
    for c in meta["cols"]:
        badge = ('<span class="k pk">PK</span>' if c["pk"]
                 else ('<span class="k fk">FK</span>' if c["name"] in meta["fks"] else ""))
        lis.append(f'<li>{badge}<span class="nm">{html.escape(c["name"])}</span>'
                   f'<span class="ty">{html.escape(c["type"])}</span></li>')
    return (f'<div class="entity" style="left:{x}px; top:{y}px;">'
            f'<div class="h">{html.escape(name)}</div><ul>{"".join(lis)}</ul></div>')


CSS = """<style>
 :root {{ --accent:{accent}; --pkbg:{pkbg}; --dot:{dot}; }}
 *{{box-sizing:border-box;margin:0;padding:0;}} html,body{{width:{W}px;height:{H}px;}}
 body{{font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;color:#0f172a;background:#fff;position:relative;}}
 .bg{{position:absolute;inset:0;background-image:radial-gradient(var(--dot) 1.4px,transparent 1.4px);background-size:26px 26px;opacity:.55;}}
 header{{position:absolute;top:28px;left:44px;z-index:5;}} h1{{font-size:28px;letter-spacing:-.02em;}} h1 .tag{{color:var(--accent);}}
 .sub{{color:#64748b;font-size:14px;margin-top:5px;}}
 .legend{{position:absolute;top:34px;right:46px;z-index:5;display:flex;gap:16px;align-items:center;font-size:12.5px;color:#475569;}}
 .legend .k{{font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;margin-right:5px;}}
 .pk{{background:var(--pkbg);color:var(--accent);}} .fk{{background:#f1f5f9;color:#64748b;}}
 .zone{{position:absolute;z-index:0;border:1.5px dashed;border-radius:16px;}}
 .zone-label{{position:absolute;z-index:1;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#475569;}}
 svg.lines{{position:absolute;inset:0;z-index:1;}}
 .entity{{position:absolute;z-index:2;width:250px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 6px 20px rgba(15,23,42,.08);overflow:hidden;}}
 .entity .h{{background:var(--accent);color:#fff;font-weight:700;font-size:14px;padding:9px 13px;}}
 .entity ul{{list-style:none;padding:6px 0;}}
 .entity li{{font-size:11.5px;padding:2.5px 13px;display:flex;align-items:center;gap:7px;color:#334155;}}
 .entity li .nm{{flex:1;}} .entity li .ty{{color:#94a3b8;font-size:9.5px;}}
 .entity li .k{{font-size:8.5px;font-weight:700;padding:1px 5px;border-radius:4px;}}
 .rel{{fill:#64748b;font-size:12px;font-weight:700;}}
 .verb{{fill:{accent};font-size:11.5px;font-style:italic;}}
</style>"""


def main():
    sql_text = SCHEMA_SQL.read_text()
    data = parse_ddl(sql_text)
    ncols = sum(len(v["cols"]) for v in data.values())
    nfk = sum(len(v["fks"]) for v in data.values())
    zones = "".join(
        f'<div class="zone" style="left:{x}px;top:{y}px;width:{w}px;height:{h}px;'
        f'background:{fill};border-color:{bc};"></div>'
        f'<div class="zone-label" style="left:{x+16}px;top:{y+12}px;">{lbl}</div>'
        for (x, y, w, h, lbl, fill, bc) in ZONES)
    cards = "".join(card(t, data[t], *POS[t]) for t in TABLES_ORDER if t in data)
    svg = ""
    for path, labels, verb in LINES:
        svg += f'<path d="{path}" stroke="#94a3b8" stroke-width="2" fill="none"/>'
        for lx, ly, tx in labels:
            svg += f'<text class="rel" x="{lx}" y="{ly}">{tx}</text>'
        if verb:
            svg += f'<text class="verb" x="{verb[0]}" y="{verb[1]}">{verb[2]}</text>'
    legend = (
        '<div class="legend">'
        '<span><span class="k pk">PK</span>primary key</span>'
        '<span><span class="k fk">FK</span>foreign key</span>'
        '<span>1 &mdash;&mdash; &#8734; one&#8209;to&#8209;many</span></div>')
    page = ("<!doctype html><html><head><meta charset='utf-8'>"
            + CSS.format(accent=ACCENT, pkbg=PKBG, dot=DOT, W=W, H=H)
            + "</head><body><div class='bg'></div>"
            "<header><h1>Ember &amp; Oak Store Assistant <span class='tag'>&mdash; database schema</span></h1>"
            f"<div class='sub'>Parsed from the live Postgres migration (supabase/migrations/20260924000001_schema.sql) "
            f"&middot; {len(TABLES_ORDER)} tables &middot; {ncols} columns &middot; {nfk} relationships.</div></header>"
            + legend
            + f"<svg class='lines' width='{W}' height='{H}'>{svg}</svg>{zones}{cards}</body></html>")
    (HERE / "erd-real.html").write_text(page)
    print(f"wrote erd-real.html ({len(TABLES_ORDER)} tables, {ncols} cols, {nfk} rels)\nRender:")
    print(f'  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless '
          f'--disable-gpu --hide-scrollbars --force-device-scale-factor=2 '
          f'--window-size={W},{H} --screenshot="{HERE}/erd-real.png" "file://{HERE}/erd-real.html"')


if __name__ == "__main__":
    main()
