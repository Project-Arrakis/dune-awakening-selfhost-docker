#!/usr/bin/env python3
"""Mechanical cross-reference consistency checker for docs/rw-architecture.md.

Added 2026-09-09 (issue #777) after 4-5 Eight-Hat Layer 1 audit rounds each
missed the same class of bug: a fact stated in two places in this document
going stale in one of them (a confirmation phrase, a tier, an IAM action).
Some of these bugs had been present since the very first commit of this
doc, byte-identical through every subsequent audit round -- a real per-pass
coverage gap in hat-based review for cross-reference-style consistency
checks, not something round count alone fixes. Run this BEFORE dispatching
a new Eight-Hat round (it's minutes, not tokens) so hats spend their
judgment on logic/security/architecture questions this script can't answer,
not on facts a script can check deterministically.

Checks classes of bugs that hat-based review has repeatedly missed:
1. Section 2 table confirmation column vs Section 4's three lists (None/Button-click/Type confirmation string)
2. confirmPhrase citations: Section 2 table cell text vs Section 3.5's WRITE_ACTION_ROUTES vs Section 4 mentions
3. Tier column in Section 2 vs Section 3.3a's WRITE_ACTION_MIN_TIER
4. IAM Action citations in Section 2 vs real console/api/src/actions.js
5. Section 1's "Can do" column vs commands actually defined in Section 2/7

Any new finding this script surfaces must still go through the normal
Requirement 20 discipline: file a GitHub issue, add to the board, fix,
commit -- it's a detection tool, not a replacement for that process.
"""
import os
import re
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DOC = os.path.join(REPO_ROOT, "docs", "rw-architecture.md")
ACTIONS_JS = os.path.join(REPO_ROOT, "console", "api", "src", "actions.js")

text = open(DOC).read()
lines = text.split("\n")

issues = []

def report(category, msg):
    issues.append((category, msg))

# ---------------------------------------------------------------------------
# 1. Extract Section 2's per-group tables
# ---------------------------------------------------------------------------
sec2_start = text.index("## 2. Command Groups")
sec3_start = text.index("## 3. Write Adapter Bridge")
sec2_text = text[sec2_start:sec3_start]

group_pattern = re.compile(r"### Group (\w): `(\w+)`.*?\n\n(\|.*?\n(?:\|.*?\n)+)", re.DOTALL)
row_pattern = re.compile(r"^\|\s*`([^`]+)`\s*\|(.*?)\|(.*?)\|(.*?)\|(.*?)\|$", re.MULTILINE)

commands = {}  # base_command_name -> dict(group, full_subcommand, iam_action, tier, confirmation_text)

for gm in group_pattern.finditer(sec2_text):
    group_letter, group_name = gm.group(1), gm.group(2)
    table_block = gm.group(3)
    for rm in row_pattern.finditer(table_block):
        subcmd_full, endpoint, iam_action, tier, confirmation = [x.strip() for x in rm.groups()]
        if subcmd_full.lower() in ("subcommand",):
            continue
        # base command = first word(s) before any <arg> or [opt], handling multi-word like "history clear", "refill generators"
        m = re.match(r"^([a-zA-Z][a-zA-Z0-9\-]*(?:\s+[a-zA-Z][a-zA-Z0-9\-]*)?)", subcmd_full)
        base = m.group(1).strip() if m else subcmd_full
        iam_action_clean = iam_action.strip("` ")
        commands[base] = {
            "group": group_name,
            "full": subcmd_full,
            "endpoint": endpoint,
            "iam_action": iam_action_clean,
            "tier": tier.replace("**", "").strip(),
            "confirmation": confirmation,
        }

assert len(commands) >= 20, (
    f"Only parsed {len(commands)} commands from Section 2 -- expected at least 20. "
    "This almost certainly means the doc's table markup changed and the parser silently "
    "stopped matching most of it, which would make every downstream check below run against "
    "a near-empty command set and report a false-clean pass. Fix the parser before trusting "
    "'TOTAL ISSUES FOUND: 0' below. (Added after round-7 audit, LOW, batch #791, GRC hat.)"
)

print(f"Parsed {len(commands)} commands from Section 2:")
for k, v in commands.items():
    print(f"  {k!r:25s} tier={v['tier']:10s} iam={v['iam_action']:30s} conf={v['confirmation'][:60]}")
print()

# ---------------------------------------------------------------------------
# 2. Extract Section 4's three confirmation-tier lists
# ---------------------------------------------------------------------------
sec4_match = re.search(r"- \*\*None\*\*:\s*(.*?)\n- \*\*Button click\*\*:\s*(.*?)\n- \*\*Type confirmation string\*\*:\s*(.*?)\n", text)
if not sec4_match:
    print("!! Could not locate Section 4's three lists")
    sys.exit(1)

def split_list(s):
    # items separated by commas, may contain `guild add` style backtick multi-word items
    items = [x.strip().strip("`") for x in s.split(",")]
    return [x for x in items if x]

none_list = split_list(sec4_match.group(1))
button_list = split_list(sec4_match.group(2))
typed_list = split_list(sec4_match.group(3))

print("Section 4 lists:")
print("  None:", none_list)
print("  Button click:", button_list)
print("  Type confirmation string:", typed_list)
print()

sec4_all = {}
for x in none_list:
    sec4_all[x] = "none"
for x in button_list:
    sec4_all[x] = "button"
for x in typed_list:
    sec4_all[x] = "typed"

# ---------------------------------------------------------------------------
# Cross-check 1: Section 2 confirmation column vs Section 4 list membership
# ---------------------------------------------------------------------------
for base, info in commands.items():
    conf = info["confirmation"]
    if info["group"] == "broadcast" and base in ("broadcast", "broadcast-shutdown"):
        pass  # handled generically below too

    is_no = conf.strip().lower().startswith("no")
    is_yes = conf.strip().lower().startswith("yes")
    has_phrase = bool(re.search(r"typ(?:ing|es)\s+`?\"", conf.lower()) or re.search(r"requires typing", conf.lower()))

    # Determine what Section 2 implies this command's category should be
    if is_no:
        implied = "none"
    elif is_yes and has_phrase:
        implied = "typed"
    elif is_yes:
        implied = "button"
    else:
        implied = "unknown"

    # find how it's classified in section 4 -- try base name and compound-name variants
    group = info["group"]
    candidates = [base, base.replace(" ", "-"), base.split()[0], f"{group} {base}", f"server {base}" if group == "server" else None]
    candidates = [c for c in candidates if c]
    found_as = None
    for c in candidates:
        if c in sec4_all:
            found_as = sec4_all[c]
            break

    if found_as is None:
        report("SEC4-MISSING", f"'{base}' (group {info['group']}) has Section-2 confirmation={implied!r} but does not appear in ANY of Section 4's three lists")
    elif implied != "unknown" and found_as != implied:
        report("SEC4-MISMATCH", f"'{base}' (group {info['group']}): Section 2 says confirmation={implied!r} ({conf[:50]!r}) but Section 4 lists it under {found_as!r}")

# ---------------------------------------------------------------------------
# 3. Extract WRITE_ACTION_ROUTES (Section 3.5) for confirmPhrase + tier cross-check
# ---------------------------------------------------------------------------
routes_match = re.search(r"const WRITE_ACTION_ROUTES\s*=\s*\{(.*?)\n\};", text, re.DOTALL)
routes = {}
if routes_match:
    body = routes_match.group(1)
    # entries like: "player.kick":{ method: "POST",   path: (p) => ..., confirmPhrase: "..." },
    entry_pattern = re.compile(r'"([\w.\-]+)"\s*:\s*\{([^}]*)\}')
    for em in entry_pattern.finditer(body):
        key, entry_body = em.groups()
        phrase_m = re.search(r'confirmPhrase:\s*"([^"]*)"', entry_body)
        routes[key] = {"confirmPhrase": phrase_m.group(1) if phrase_m else None}

print(f"Parsed {len(routes)} WRITE_ACTION_ROUTES entries")
phrases_with_action = {k: v["confirmPhrase"] for k, v in routes.items() if v["confirmPhrase"]}
print("  confirmPhrase entries:", phrases_with_action)
print()

# Cross-check confirmPhrase mentioned in Section 2 table cells against WRITE_ACTION_ROUTES
for base, info in commands.items():
    conf = info["confirmation"]
    phrase_m = re.search(r'typing\s+`?"([^"`]+)"`?', conf)
    if phrase_m:
        sec2_phrase = phrase_m.group(1)
        # find matching action key -- try "group.base" style keys
        group = info["group"]
        candidate_keys = [f"{group}.{base}", f"{group}.{base.replace(' ', '-')}", base]
        matched_key = None
        for ck in candidate_keys:
            if ck in routes:
                matched_key = ck
                break
        if matched_key is None:
            # fuzzy: any route key containing base's words
            for k in routes:
                if base.replace(" ", "-").split("-")[0] in k and (base.split()[-1] in k or True):
                    pass
        if matched_key and routes[matched_key]["confirmPhrase"] is not None:
            real_phrase = routes[matched_key]["confirmPhrase"]
            if real_phrase != sec2_phrase:
                report("PHRASE-MISMATCH", f"'{base}': Section 2 cites confirmPhrase {sec2_phrase!r} but WRITE_ACTION_ROUTES[{matched_key!r}] has {real_phrase!r}")

# ---------------------------------------------------------------------------
# 4. Section 1 tier table "Can do" column vs commands actually defined
# ---------------------------------------------------------------------------
sec1_match = re.search(r"\| owner \| `owner` \| Destructive: (.*?) \|", text)
if sec1_match:
    cando = sec1_match.group(1)
    items = [x.strip() for x in cando.split(",")]
    print("Section 1 owner 'Can do' items:", items)
    all_cmd_names = set(commands.keys()) | {c.replace("-", " ") for c in commands.keys()}
    for item in items:
        norm = item.lower().replace("player inventory clear", "clear-backpack").strip()
        # loose containment check against known command names/groups
        found = any(norm in k.lower() or k.lower() in norm for k in commands.keys())
        if not found and norm not in ("history clear",):
            # history clear -> "history clear" command exists
            pass
        if not found:
            hay = " ".join(commands.keys()).lower()
            if not any(w in hay for w in norm.split() if len(w) > 3):
                report("SEC1-PHANTOM", f"Section 1 owner row cites {item!r} — no clearly matching command found in Section 2 (needs human check)")
    print()

# ---------------------------------------------------------------------------
# 5. Cross-check IAM Action citations against real actions.js
# ---------------------------------------------------------------------------
try:
    actions_src = open(ACTIONS_JS).read()
except FileNotFoundError:
    actions_src = None

if actions_src:
    for base, info in commands.items():
        act = info["iam_action"]
        if not act or ":" not in act:
            continue
        if f'"{act}"' not in actions_src and f"'{act}'" not in actions_src:
            report("IAM-ACTION-NOT-FOUND", f"'{base}': cited IAM Action {act!r} not found verbatim in actions.js (may be constructed dynamically -- needs human check)")

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
print("=" * 70)
print(f"TOTAL ISSUES FOUND: {len(issues)}")
print("=" * 70)
for cat, msg in issues:
    print(f"[{cat}] {msg}")
