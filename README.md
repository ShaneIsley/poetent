# poetent

Trade tools for Path of Exile.

## Contents

### `userscript/` — PoE Trade Harvest Grouper
A userscript that runs on `pathofexile.com/trade`. Detects stat filters that can be harvest-swapped between elemental variants and offers one-click count-group replacements. Also supports clipboard item pasting for quick trade searches.

**Install:** Open `userscript/poetent.user.js` raw in your browser with Tampermonkey installed.

**Features:**
- Intercepts trade search payloads and detects harvest-swappable stats (elemental resistance, elemental damage)
- Replaces individual stat filters with trade API count groups, broadening search results
- Clipboard paste (📋) — Ctrl+C an item in-game, click paste to create a trade search with all mods matched
- Settings panel with per-group toggles, auto-apply, compact bar mode, and debug logging
- Draggable sidebar with position persistence

## License

MIT
