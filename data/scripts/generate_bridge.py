#!/usr/bin/env python3
"""
generate_bridge.py — Build poe_trade_bridge.json

Downloads RePoE mod data and the official trade API stat index,
cross-references them, and outputs a bridge file mapping every
GGG trade stat ID to its modifier tiers with min/max ranges.

Data sources:
  - RePoE mods.json: mod definitions with engine stat IDs, ranges, and generation types
  - RePoE stat_translations.min.json: maps engine stat IDs to human-readable text
  - GGG /api/trade/data/stats: official trade stat IDs and text templates

The bridge file enables offline tier detection: given a trade stat ID and a
rolled value, you can determine the exact tier label (P1, S3, etc.) and
whether the roll is high or low within that tier.

Usage:
  python generate_bridge.py [--output path/to/bridge.json]
"""

import json
import re
import sys
import urllib.request
from collections import defaultdict

# ─── Data source URLs ───────────────────────────────────────────────────────
# RePoE community fork — served via gh-pages CDN (better caching than raw repo)
# See https://repoe-fork.github.io/poe1.html for full file listing
REPOE_MODS_URL = "https://repoe-fork.github.io/mods.min.json"
REPOE_STAT_TRANSLATIONS_URL = "https://repoe-fork.github.io/stat_translations.min.json"

# Official GGG trade API
TRADE_STATS_URL = "https://www.pathofexile.com/api/trade/data/stats"


def fetch_json(url, label):
    """Download and parse a JSON URL."""
    print(f"  Fetching {label}...")
    req = urllib.request.Request(url, headers={"User-Agent": "poetent-bridge-generator/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    print(f"  ✓ {label} loaded")
    return data


def build_engine_stat_index(mods):
    """Index RePoE mods by their engine stat IDs.

    Returns: { engine_stat_id: [ { mod_key, name, required_level, generation_type, min, max, tags }, ... ] }
    """
    stat_to_mods = defaultdict(list)
    for mod_key, mod_data in mods.items():
        if mod_data.get("domain") != "item":
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


def build_trade_stat_to_engine_map(stat_translations):
    """Map trade stat text templates to engine stat IDs using RePoE translations.

    RePoE stat_translations entries contain:
      - ids: list of engine stat IDs
      - English[].string: the human-readable template (with {0}, {1} placeholders)

    We normalize these templates to match the trade API format (# placeholders)
    and build a reverse lookup.

    Returns: { normalized_text: [engine_stat_ids] }
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
            # Normalize RePoE placeholders to match trade API format:
            #   {0:+d} → +#  (signed display — trade API bakes the + into the template)
            #   {0}    → #   (unsigned display)
            #   {1:d}  → #   (explicit integer, no sign)
            normalized = re.sub(r"\{(\d+):\+d\}", "+#", raw)
            normalized = re.sub(r"\{\d+(?::[^}]*)?\}", "#", normalized)
            for eid in engine_ids:
                text_to_engine[normalized].add(eid)
    return text_to_engine


def build_bridge(mods, stat_translations, trade_stats):
    """Cross-reference all three data sources into the bridge file."""
    stat_to_mods = build_engine_stat_index(mods)
    text_to_engine = build_trade_stat_to_engine_map(stat_translations)

    bridge = {}

    # Walk every stat from the official trade API
    for group in trade_stats.get("result", []):
        for entry in group.get("entries", []):
            ggg_id = entry.get("id", "")
            text = entry.get("text", "")
            stat_type = entry.get("type", "")

            if not ggg_id or ggg_id in bridge:
                continue

            bridge[ggg_id] = {
                "text": text,
                "type": stat_type,
                "tiers": [],
            }

            # Find engine stat IDs for this trade stat via text matching
            engine_ids = text_to_engine.get(text, set())

            # Also try the trade stat ID suffix as a direct engine ID match
            # (trade IDs are like "explicit.stat_3299347043" → engine "stat_3299347043")
            parts = ggg_id.split(".")
            if len(parts) == 2:
                engine_ids.add(parts[1])

            # Collect all mod tiers linked to these engine IDs
            for eid in engine_ids:
                for m in stat_to_mods.get(eid, []):
                    bridge[ggg_id]["tiers"].append(m)

    # Refine: sort, dedup, and label tiers
    for ggg_id, stat in bridge.items():
        stat["tiers"] = _refine_tiers(stat["tiers"])

    # Drop stats with no tiers (pseudo stats, boolean stats, etc.)
    bridge = {k: v for k, v in bridge.items() if v["tiers"]}

    return bridge


def _refine_tiers(tiers):
    """Sort, deduplicate, assign tier labels, and merge spawn tags."""
    GEN_PRIORITY = {"prefix": 0, "suffix": 1}

    # Sort: prefix first, then suffix, then others; within each group by max descending
    tiers.sort(key=lambda t: (
        GEN_PRIORITY.get(t["generation_type"], 2),
        -(t["max"] or 0),
    ))

    # Dedup and label — merge tags from duplicate entries
    gen_counts = {}
    unique = []
    seen = {}  # dedup_key → index in unique[]

    for tier in tiers:
        dedup_key = (tier["name"], tier["min"], tier["max"], tier["generation_type"])

        if dedup_key in seen:
            # Merge tags into existing entry
            existing = unique[seen[dedup_key]]
            existing_tags = set(existing.get("tags", []))
            existing_tags.update(tier.get("tags", []))
            existing["tags"] = sorted(existing_tags)
            continue

        gen = tier["generation_type"]
        mkey = (tier["mod_key"] or "").lower()

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
            tier["tier_label"] = f"{prefix}0-{special}"
        else:
            gen_counts[gen] = gen_counts.get(gen, 0) + 1
            tier["tier_label"] = f"{prefix}{gen_counts[gen]}"

        # Ensure tags is a sorted list
        tier["tags"] = sorted(set(tier.get("tags", [])))

        seen[dedup_key] = len(unique)
        unique.append(tier)

    return unique


def main():
    output_path = "poe_trade_bridge.json"
    if len(sys.argv) > 2 and sys.argv[1] == "--output":
        output_path = sys.argv[2]

    print("=== PoE Trade Bridge Generator ===")
    print()

    print("[1/3] Downloading data sources...")
    mods = fetch_json(REPOE_MODS_URL, "RePoE mods.json")
    stat_translations = fetch_json(REPOE_STAT_TRANSLATIONS_URL, "RePoE stat_translations.json")
    trade_stats = fetch_json(TRADE_STATS_URL, "GGG trade API stats")
    print()

    print("[2/3] Building bridge...")
    bridge = build_bridge(mods, stat_translations, trade_stats)
    print(f"  ✓ {len(bridge)} stats with tier data")
    print()

    print(f"[3/3] Writing {output_path}...")
    with open(output_path, "w") as f:
        json.dump(bridge, f, separators=(",", ":"))

    # Also write a pretty version for inspection
    pretty_path = output_path.replace(".json", ".pretty.json")
    with open(pretty_path, "w") as f:
        json.dump(bridge, f, indent=2)

    size_kb = len(json.dumps(bridge, separators=(",", ":"))) / 1024
    print(f"  ✓ {size_kb:.0f} KB (minified)")
    print()
    print("Done.")


if __name__ == "__main__":
    main()
