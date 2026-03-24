# poetent

Trade tools for Path of Exile — userscripts and data files that make the official trade site easier.

## Contents

### `userscript/` — PoE Trade Harvest Grouper
A Tampermonkey userscript that runs on `pathofexile.com/trade`. Detects stat filters that can be harvest-swapped between elemental variants and offers one-click count-group replacements. Also supports clipboard item pasting for quick trade searches.

**Install:** Open `userscript/poe_harvest_grouper.user.js` raw in your browser with Tampermonkey installed.

**Features:**
- Intercepts trade search payloads and detects harvest-swappable stats (elemental resistance, elemental damage)
- Replaces individual stat filters with trade API count groups, broadening search results
- Clipboard paste (📋) — Ctrl+C an item in-game, click paste to create a trade search with all mods matched
- Settings panel with per-group toggles, auto-apply, compact bar mode, and debug logging
- Draggable sidebar with position persistence

### `data/` — Trade Bridge
A JSON file mapping every official trade API stat ID to its modifier tiers (P1, S2, etc.) with min/max roll ranges. Generated weekly from RePoE mod data cross-referenced with the GGG trade stat index.

**Raw URL (for userscripts):**
```
https://raw.githubusercontent.com/ShaneIsley/poetent/main/data/poe_trade_bridge.json
```

## Data Pipeline

The bridge file is regenerated weekly by a GitHub Action:

1. Downloads `mods.json` and `stat_translations.json` from [RePoE](https://github.com/lvlvllvlvllvlvl/RePoE)
2. Downloads the live stat index from `pathofexile.com/api/trade/data/stats`
3. Cross-references engine stat IDs → trade stat IDs → modifier tiers
4. Commits the updated bridge if any stats changed

## License

MIT
