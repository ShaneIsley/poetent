# poetent

Trade site enhancer for Path of Exile. Runs on pathofexile.com/trade.

**Install:** Open [poetent.user.js](./userscript/poetent.user.js) in your browser with [Violentmonkey](https://violentmonkey.github.io/), or similar, installed.

## Features

- **Harvest swap detection** — finds elemental stats that Harvest can reroll between elements, offers one-click count-group broadening
- **Paste-to-search** — Ctrl+C an item in-game, paste it to build a trade search with all mods matched
- **Pseudo stats** — collapses related mods into pseudo totals (e.g. two +Life sources → Total Life), offers defensive bundle searches
- **Two UI modes** — full sidebar or compact floating bar, both draggable with position persistence

## How It Works

Poetent intercepts trade search requests as they happen, analyzes the stat filters, and surfaces suggestions in a sidebar panel. Clicking a suggestion resubmits the search with broadened filters. The paste flow is separate — it parses item text copied from the game client, matches mods against a stat database, and builds a new search payload.

## Feature Detail

### Harvest Swaps

Harvest crafting in PoE can swap a resistance or damage mod between fire, cold, and lightning at the same tier. If your search includes "+40 to Fire Resistance," the tool detects that cold and lightning versions exist at the same threshold and offers to replace the single filter with a count group that matches any element. This widens results to include items one Harvest craft away from what you need.

Supported groups: Elemental Resistances, Elemental Damage.

### Paste Search

Click 📋 in the sidebar to open the paste modal. Copy an item in-game (Ctrl+C), paste it in. Poetent parses the item text, identifies each mod's source (explicit, implicit, crafted, enchant), and matches them against stat IDs. You get checkboxes for every matched mod — uncheck what you don't care about, then hit Search.

### Pseudo Stats

The official trade API supports "pseudo" stats — computed totals like "Total maximum Life" that sum across all contributing mods on an item. Poetent detects when your search has multiple mods feeding the same pseudo and offers to replace them with one pseudo filter.

Three modes (togglable in settings):

- **Uplift** — two or more mods collapse into a pseudo total
- **Broaden** — even single mods can be replaced with their pseudo equivalent for wider results
- **Defensive bundles** — a count-group search across multiple pseudo thresholds (e.g. "at least 3 of: Life ≥80, Fire Res ≥35, Cold Res ≥30, ES ≥40")

### UI

Settings are accessible via ⚙ in either UI mode. Per-group toggles, auto-apply on search, and compact bar mode. Stat data is cached for 24 hours and clearable from settings.

## Notes

- Stat matching uses [awakened-poe-trade](https://github.com/SnosMe/awakened-poe-trade) files and the pathofexile.com trade site
- Runs only on `pathofexile.com/trade/*`
- Respects trade API rate limits

## License

MIT
