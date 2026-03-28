#!/usr/bin/env python3
“””
generate_bridge.py — Build poe_trade_bridge.json (v2: tag-aware tiers)

Downloads RePoE mod data and the official trade API stat index,
cross-references them, and outputs a bridge file mapping every
GGG trade stat ID to its modifier tiers grouped by item type tag.

New in v2: tiers are keyed by spawn_weight tag (ring, body_armour, default, etc.)
so that “T1 Life” correctly resolves to different ranges per item slot.

Data sources:

- RePoE mods.json: mod definitions with engine stat IDs, ranges, and generation types
- RePoE stat_translations.min.json: maps engine stat IDs to human-readable text
- GGG /api/trade/data/stats: official trade stat IDs and text templates

Schema (v2):
{
“explicit.stat_3299347043”: {
“text”: “+# to maximum Life”,
“type”: “explicit”,
“tiers_by_tag”: {
“ring”:        [{ “tier_label”: “P1”, “name”: “Virile”,  “min”: 70, “max”: 79, … }],
“body_armour”: [{ “tier_label”: “P1”, “name”: “Prime”,   “min”: 120, “max”: 129, … }],
“default”:     [{ “tier_label”: “P1”, “name”: “Fecund”,  “min”: 90, “max”: 99, … }]
}
}
}

Usage:
python generate_bridge.py [–output path/to/bridge.json]
“””

import json
import sys
import urllib.request
from collections import defaultdict

# ─── Data source URLs ───────────────────────────────────────────────────────

REPOE_MODS_URL = “https://repoe-fork.github.io/mods.min.json”
REPOE_STAT_TRANSLATIONS_URL = “https://repoe-fork.github.io/stat_translations.min.json”
TRADE_STATS_URL = “https://www.pathofexile.com/api/trade/data/stats”

def fetch_json(url, label):
“”“Download and parse a JSON URL.”””
print(f”  Fetching {label}…”)
req = urllib.request.Request(url, headers={“User-Agent”: “poetent-bridge-generator/1.0”})
with urllib.request.urlopen(req, timeout=30) as resp:
data = json.loads(resp.read().decode(“utf-8”))
print(f”  ✓ {label} loaded”)
return data

# ═══════════════════════════════════════════════════════════════════════════

# Phase 1.1: Engine stat indexing

# ═══════════════════════════════════════════════════════════════════════════

def build_engine_stat_index(mods):
“”“Index RePoE mods by their engine stat IDs.

```
Filters:
  - Only domain="item" mods
  - Excludes generation_type="unique" (unique-only mods aren't user-tierable)

Returns: { engine_stat_id: [ { mod_key, name, required_level, generation_type, min, max, tags }, ... ] }
"""
stat_to_mods = defaultdict(list)
for mod_key, mod_data in mods.items():
    if mod_data.get("domain") != "item":
        continue
    if mod_data.get("generation_type") == "unique":
        continue

    # Extract spawn tags — only item types where weight > 0
    tags = [sw["tag"] for sw in mod_data.get("spawn_weights", [])
            if sw.get("weight", 0) > 0]

    for stat in mod_data.get("stats", []):
        stat_id = stat.get("id")
        if not stat_id:
            continue
        stat_to_mods[stat_id].append({
            "mod_key": mod_key,
            "name": mod_data.get("name", ""),
            "required_level": mod_data.get("required_level", 0),
            "generation_type": mod_data.get("generation_type", ""),
            "min": stat.get("min"),
            "max": stat.get("max"),
            "tags": tags,
        })
return stat_to_mods
```

# ═══════════════════════════════════════════════════════════════════════════

# Phase 1.2: Group tiers by spawn_weight tag

# ═══════════════════════════════════════════════════════════════════════════

def group_tiers_by_tag(mod_entries):
“”“Group a list of mod entries by their spawn_weight tags.

```
Each mod entry has a `tags` list of item types where it can spawn.
A mod with tags ["str_armour", "str_dex_armour"] appears in both groups.

Returns: { tag: [mod_entry, ...] }
"""
if not mod_entries:
    return {}

groups = defaultdict(list)
for entry in mod_entries:
    for tag in entry.get("tags", []):
        groups[tag].append(entry)
return dict(groups)
```

# ═══════════════════════════════════════════════════════════════════════════

# Phase 1.3: Refine tiers within a single tag group

# ═══════════════════════════════════════════════════════════════════════════

def refine_tiers_for_tag(tiers):
“”“Sort, deduplicate, assign tier labels within a single tag group.

```
Sorting: prefixes first, then suffixes; within each, by max descending.
Labeling: P1, P2, ... for prefixes; S1, S2, ... for suffixes.
Special: Essence/Delve/Incursion/Veiled mods get P0-Essence etc.

Returns a clean list of tier dicts with only the fields needed by the client:
  tier_label, name, min, max, required_level, generation_type
"""
GEN_PRIORITY = {"prefix": 0, "suffix": 1}

# Sort: prefix first, then suffix, then others; within each group by max descending
sorted_tiers = sorted(tiers, key=lambda t: (
    GEN_PRIORITY.get(t["generation_type"], 2),
    -(t["max"] or 0),
))

# Dedup by (name, min, max, generation_type)
gen_counts = {}
unique = []
seen = set()

for tier in sorted_tiers:
    dedup_key = (tier["name"], tier["min"], tier["max"], tier["generation_type"])
    if dedup_key in seen:
        continue
    seen.add(dedup_key)

    gen = tier["generation_type"]
    mkey = (tier.get("mod_key") or "").lower()

    # Detect special (T0) sources
    special = None
    if "essence" in mkey:
        special = "Essence"
    elif "delve" in mkey:
        special = "Delve"
    elif "incursion" in mkey:
        special = "Incursion"
    elif "veiled" in mkey:
        special = "Veiled"

    prefix = "P" if gen == "prefix" else "S" if gen == "suffix" else "T"

    if special:
        tier_label = f"{prefix}0-{special}"
    else:
        gen_counts[gen] = gen_counts.get(gen, 0) + 1
        tier_label = f"{prefix}{gen_counts[gen]}"

    # Output only client-needed fields (drop mod_key, tags)
    unique.append({
        "tier_label": tier_label,
        "name": tier["name"],
        "min": tier["min"],
        "max": tier["max"],
        "required_level": tier["required_level"],
        "generation_type": tier["generation_type"],
    })

return unique
```

# ═══════════════════════════════════════════════════════════════════════════

# Text normalization: trade API text ↔ engine stat IDs

# ═══════════════════════════════════════════════════════════════════════════

def build_trade_stat_to_engine_map(stat_translations):
“”“Map trade stat text templates to engine stat IDs using RePoE translations.

```
Returns: { normalized_text: set(engine_stat_ids) }
"""
text_to_engine = defaultdict(set)
for entry in stat_translations:
    engine_ids = entry.get("ids", [])
    if not engine_ids:
        continue
    for lang_entry in entry.get("English", []):
        raw = lang_entry.get("string", "")
        if not raw:
            continue
        formats = lang_entry.get("format", [])

        normalized = raw
        for i in range(9, -1, -1):
            placeholder = f"{{{i}}}"
            if placeholder not in normalized:
                for pattern in [f"{{{i}:+d}}", f"{{{i}:d}}"]:
                    if pattern in normalized:
                        replacement = "+#" if ":+d" in pattern else "#"
                        normalized = normalized.replace(pattern, replacement)
                continue
            fmt = formats[i] if i < len(formats) else None
            replacement = "+#" if fmt == "+#" else "#"
            normalized = normalized.replace(placeholder, replacement)

        for eid in engine_ids:
            text_to_engine[normalized].add(eid)
return text_to_engine
```

# ═══════════════════════════════════════════════════════════════════════════

# Phase 1.4: Full bridge pipeline

# ═══════════════════════════════════════════════════════════════════════════

def build_bridge(mods, stat_translations, trade_stats):
“”“Cross-reference all three data sources into the bridge file.

```
Output schema (v2): each stat has tiers_by_tag instead of flat tiers.
"""
stat_to_mods = build_engine_stat_index(mods)
text_to_engine = build_trade_stat_to_engine_map(stat_translations)

bridge = {}

for group in trade_stats.get("result", []):
    for entry in group.get("entries", []):
        ggg_id = entry.get("id", "")
        text = entry.get("text", "")
        stat_type = entry.get("type", "")

        if not ggg_id or ggg_id in bridge:
            continue

        # Find engine stat IDs for this trade stat
        engine_ids = set(text_to_engine.get(text, set()))

        # Also try the trade stat ID suffix as a direct engine ID
        parts = ggg_id.split(".")
        if len(parts) == 2:
            engine_ids.add(parts[1])

        # Collect all mod entries linked to these engine IDs
        all_mod_entries = []
        for eid in engine_ids:
            all_mod_entries.extend(stat_to_mods.get(eid, []))

        # Group by tag, then refine each group independently
        grouped = group_tiers_by_tag(all_mod_entries)
        tiers_by_tag = {}
        for tag, tag_entries in grouped.items():
            refined = refine_tiers_for_tag(tag_entries)
            if refined:
                tiers_by_tag[tag] = refined

        if not tiers_by_tag:
            continue  # Skip stats with no tiers (pseudo, boolean, etc.)

        bridge[ggg_id] = {
            "text": text,
            "type": stat_type,
            "tiers_by_tag": tiers_by_tag,
        }

return bridge
```

# ═══════════════════════════════════════════════════════════════════════════

# Phase 2: Item class → tag resolution

# ═══════════════════════════════════════════════════════════════════════════

# Maps the paste parser’s itemClass string to RePoE spawn_weight tags.

# “default” is always included as a fallback (most generic mods use it).

# Specific tags are tried first; “default” serves as the ultimate fallback.

ITEM_CLASS_TAG_MAP = {
“Rings”:                    [“ring”, “default”],
“Amulets”:                  [“amulet”, “default”],
“Belts”:                    [“belt”, “default”],
“Body Armours”:             [“body_armour”, “default”],
“Shields”:                  [“shield”, “default”],
“Gloves”:                   [“gloves”, “default”],
“Boots”:                    [“boots”, “default”],
“Helmets”:                  [“helmet”, “default”],
“Bows”:                     [“bow”, “default”],
“Wands”:                    [“wand”, “default”],
“Daggers”:                  [“dagger”, “default”],
“Rune Daggers”:             [“dagger”, “default”],
“Claws”:                    [“claw”, “default”],
“Sceptres”:                 [“sceptre”, “default”],
“Staves”:                   [“staff”, “default”],
“Warstaves”:                [“warstaff”, “default”],
“One Hand Swords”:          [“one_hand_weapon”, “sword”, “default”],
“Thrusting One Hand Swords”:[“one_hand_weapon”, “sword”, “default”],
“Two Hand Swords”:          [“two_hand_weapon”, “sword”, “default”],
“One Hand Axes”:            [“one_hand_weapon”, “axe”, “default”],
“Two Hand Axes”:            [“two_hand_weapon”, “axe”, “default”],
“One Hand Maces”:           [“one_hand_weapon”, “mace”, “default”],
“Two Hand Maces”:           [“two_hand_weapon”, “mace”, “default”],
“Quivers”:                  [“quiver”, “default”],
“Jewels”:                   [“jewel”, “default”],
“Abyss Jewels”:             [“abyss_jewel”, “default”],
“Flasks”:                   [“flask”, “default”],
“Life Flasks”:              [“flask”, “default”],
“Mana Flasks”:              [“flask”, “default”],
“Utility Flasks”:           [“flask”, “default”],
}

def itemclass_to_tags(item_class):
“”“Map a paste parser itemClass string to a list of RePoE spawn_weight tags.

```
Always includes "default" as a fallback. Returns ["default"] for unknown classes.
"""
return ITEM_CLASS_TAG_MAP.get(item_class, ["default"])
```

def resolve_tiers(bridge, stat_id, item_class):
“”“Look up tier list for a stat_id and item_class.

```
Tries each tag from itemclass_to_tags in order, returning the first
tag group that exists in the bridge. Falls back to "default".

Returns: list of tier dicts, or [] if stat not in bridge.
"""
entry = bridge.get(stat_id)
if not entry:
    return []

tiers_by_tag = entry.get("tiers_by_tag", {})
tags = itemclass_to_tags(item_class)

for tag in tags:
    if tag in tiers_by_tag:
        return tiers_by_tag[tag]

# Ultimate fallback: try "default" even if not in the tag list
return tiers_by_tag.get("default", [])
```

# ═══════════════════════════════════════════════════════════════════════════

# CLI entry point

# ═══════════════════════════════════════════════════════════════════════════

def main():
output_path = “poe_trade_bridge.json”
if len(sys.argv) > 2 and sys.argv[1] == “–output”:
output_path = sys.argv[2]

```
print("=== PoE Trade Bridge Generator (v2: tag-aware) ===")
print()

print("[1/3] Downloading data sources...")
mods = fetch_json(REPOE_MODS_URL, "RePoE mods.json")
stat_translations = fetch_json(REPOE_STAT_TRANSLATIONS_URL, "RePoE stat_translations.json")
trade_stats = fetch_json(TRADE_STATS_URL, "GGG trade API stats")
print()

print("[2/3] Building bridge...")
bridge = build_bridge(mods, stat_translations, trade_stats)

# Stats summary
total_stats = len(bridge)
total_tags = sum(len(v["tiers_by_tag"]) for v in bridge.values())
total_tiers = sum(
    len(tiers)
    for v in bridge.values()
    for tiers in v["tiers_by_tag"].values()
)
print(f"  ✓ {total_stats} stats, {total_tags} tag groups, {total_tiers} total tiers")
print()

print(f"[3/3] Writing {output_path}...")
with open(output_path, "w") as f:
    json.dump(bridge, f, separators=(",", ":"))

pretty_path = output_path.replace(".json", ".pretty.json")
with open(pretty_path, "w") as f:
    json.dump(bridge, f, indent=2)

size_kb = len(json.dumps(bridge, separators=(",", ":"))) / 1024
print(f"  ✓ {size_kb:.0f} KB (minified)")
print()

# Also write the item_class_tags map as a standalone JSON for the userscript
tags_path = output_path.replace("bridge.json", "item_class_tags.json")
with open(tags_path, "w") as f:
    json.dump(ITEM_CLASS_TAG_MAP, f, indent=2)
print(f"  ✓ Item class → tag map written to {tags_path}")
print()
print("Done.")
```

if **name** == “**main**”:
main()