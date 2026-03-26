// ==UserScript==
// @name         Poetent
// @namespace    https://github.com/ShaneIsley/poetent
// @version      0.4.1
// @description  Paste items from PoE to instantly search trade. Auto-detects harvest-swappable elemental stats and offers one-click count-group broadening. Pseudo stat uplift and defensive bundles.
// @author       ShaneIsley
// @match        https://www.pathofexile.com/trade/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=pathofexile.com
// @run-at       document-start
// @connect      raw.githubusercontent.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================================
    // HARVEST SWAP DEFINITIONS
    // =========================================================================
    const HARVEST_SWAPS = [
        {
            id: 'ele_res',
            label: 'Elemental Resistances',
            icon: '🔥',
            cost: '500 Lifeforce',
            description: 'Swap Fire / Cold / Lightning resistance at the same tier.',
            elements: [
                { keyword: 'Fire Resistance',      short: 'Fire',  color: '#e25822' },
                { keyword: 'Cold Resistance',       short: 'Cold',  color: '#5bcefa' },
                { keyword: 'Lightning Resistance',  short: 'Light', color: '#ffd700' },
            ],
        },
        {
            id: 'ele_dmg',
            label: 'Elemental Damage',
            icon: '⚡',
            cost: '500 Lifeforce + 1 Rancour',
            description: 'Swap Fire / Cold / Lightning damage mods at the same tier.',
            elements: [
                { keyword: 'Fire Damage',      short: 'Fire',  color: '#e25822' },
                { keyword: 'Cold Damage',       short: 'Cold',  color: '#5bcefa' },
                { keyword: 'Lightning Damage',  short: 'Light', color: '#ffd700' },
            ],
            excludeIf: [
                'Elemental Damage',
                'and Fire Damage',
                'and Cold Damage',
                'and Lightning Damage',
            ],
        },
    ];

    // =========================================================================
    // PSEUDO STAT RULES — maps individual stat text to pseudo categories
    // Each rule defines a pseudo category with:
    //   - pseudoTextHint: fragment to locate the pseudo stat ID in trade API data
    //   - match(text): returns truthy if a stat contributes to this pseudo
    //   - exclude(text): returns truthy if a stat should NOT be counted
    //   - adjust(value, text): optional value multiplier (e.g. "all Ele Res" × 3)
    // =========================================================================
    const PSEUDO_RULES = [
        {
            id: 'total_life',
            label: 'Total Life',
            icon: '❤️',
            pseudoTextHint: 'total maximum Life',
            match:   (t) => /to maximum Life/i.test(t),
            exclude: (t) => /Minion|Recovery|Regenerat|Leech|on Kill|gained|per second/i.test(t),
        },
        {
            id: 'total_es',
            label: 'Total ES',
            icon: '🛡️',
            pseudoTextHint: 'total maximum Energy Shield',
            match:   (t) => /to maximum Energy Shield/i.test(t),
            exclude: (t) => /Recharge|Regenerat|Leech|Delay|Recovery/i.test(t),
        },
        {
            id: 'total_mana',
            label: 'Total Mana',
            icon: '🔵',
            pseudoTextHint: 'total maximum Mana',
            match:   (t) => /to maximum Mana/i.test(t),
            exclude: (t) => /Regenerat|Leech|Recovery|Cost|Reservation|per second/i.test(t),
        },
        {
            id: 'total_fire_res',
            label: 'Fire Res',
            icon: '🔥',
            pseudoTextHint: 'total to Fire Resistance',
            match:   (t) => /to Fire Resistance/i.test(t) || /to all Elemental Resistances/i.test(t),
            exclude: (t) => /maximum|Penetrate|Exposure|nearby|Enemies/i.test(t),
        },
        {
            id: 'total_cold_res',
            label: 'Cold Res',
            icon: '❄️',
            pseudoTextHint: 'total to Cold Resistance',
            match:   (t) => /to Cold Resistance/i.test(t) || /to all Elemental Resistances/i.test(t),
            exclude: (t) => /maximum|Penetrate|Exposure|nearby|Enemies/i.test(t),
        },
        {
            id: 'total_lightning_res',
            label: 'Lightning Res',
            icon: '⚡',
            pseudoTextHint: 'total to Lightning Resistance',
            match:   (t) => /to Lightning Resistance/i.test(t) || /to all Elemental Resistances/i.test(t),
            exclude: (t) => /maximum|Penetrate|Exposure|nearby|Enemies/i.test(t),
        },
        {
            id: 'total_ele_res',
            label: 'Total Ele Res',
            icon: '🌈',
            pseudoTextHint: 'total Elemental Resistance',
            match:   (t) => /to (Fire|Cold|Lightning) Resistance/i.test(t) || /to all Elemental Resistances/i.test(t),
            exclude: (t) => /maximum|Penetrate|Exposure|nearby|Enemies/i.test(t),
            adjust:  (v, t) => /all Elemental Resistances/i.test(t) ? v * 3 : v,
        },
        {
            id: 'total_chaos_res',
            label: 'Chaos Res',
            icon: '☠️',
            pseudoTextHint: 'total to Chaos Resistance',
            match:   (t) => /to Chaos Resistance/i.test(t),
            exclude: (t) => /maximum|Penetrate|nearby|Enemies/i.test(t),
        },
        {
            id: 'total_str',
            label: 'Strength',
            icon: '💪',
            pseudoTextHint: 'total to Strength',
            match:   (t) => /to Strength/i.test(t) || /to all Attributes/i.test(t),
            exclude: (t) => /Requirement|during|recently|per\b|Minion/i.test(t),
        },
        {
            id: 'total_dex',
            label: 'Dexterity',
            icon: '🏃',
            pseudoTextHint: 'total to Dexterity',
            match:   (t) => /to Dexterity/i.test(t) || /to all Attributes/i.test(t),
            exclude: (t) => /Requirement|during|recently|per\b|Minion/i.test(t),
        },
        {
            id: 'total_int',
            label: 'Intelligence',
            icon: '🧠',
            pseudoTextHint: 'total to Intelligence',
            match:   (t) => /to Intelligence/i.test(t) || /to all Attributes/i.test(t),
            exclude: (t) => /Requirement|during|recently|per\b|Minion/i.test(t),
        },
    ];

    // =========================================================================
    // SETTINGS
    // =========================================================================
    const SETTINGS_KEY = 'poe_harvest_grouper_settings';

    const Settings = {
        defaults: {
            autoApply: false,
            uiMode: 'sidebar',
            enabledGroups: {},
            posX: null,
            posY: null,
            barPosX: null,
            barPosY: null,
            // Pseudo modules — each independently togglable
            pseudoUplift:  true,   // Collapse multiple mods into pseudo totals
            pseudoBroaden: false,  // Offer pseudo even for single mods (broader search)
            pseudoBundles: true,   // Offer defensive count-group bundles
        },
        data: {},

        init() {
            HARVEST_SWAPS.forEach(s => { this.defaults.enabledGroups[s.id] = true; });
            try {
                const raw = GM_getValue(SETTINGS_KEY);
                const saved = raw ? JSON.parse(raw) : {};
                this.data = { ...this.defaults, ...saved };
                this.data.enabledGroups = { ...this.defaults.enabledGroups, ...(saved.enabledGroups || {}) };
            } catch (e) {
                this.data = { ...this.defaults };
            }
        },

        save() {
            GM_setValue(SETTINGS_KEY, JSON.stringify(this.data));
        },

        isGroupEnabled(swapId) {
            return this.data.enabledGroups[swapId] !== false;
        },
    };

    // =========================================================================
    // GAME TEXT MATCHER — fetches awakened-poe-trade NDJSON (purpose-built
    // for matching game client Ctrl+C text to trade stat IDs).
    // This is the principled data source for paste-to-search matching.
    // =========================================================================
    const NDJSON_URL        = 'https://raw.githubusercontent.com/SnosMe/awakened-poe-trade/master/renderer/public/data/en/stats.ndjson';
    const NDJSON_CACHE_KEY  = 'poetent_ndjson_stats_v1';
    const NDJSON_CACHE_HOURS = 24;

    const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const fetchGM = (url) => new Promise((res, rej) =>
        GM_xmlhttpRequest({
            method: 'GET', url,
            onload: r => r.status < 300 ? res(r.responseText) : rej(r.status),
            onerror: rej,
        })
    );

    const GameTextMatcher = {
        patterns: [],   // { regex, ids: { explicit:[], implicit:[], ... }, value, raw }
        prefixIndex: new Map(),
        loaded: false,

        async init() {
            if (this.loaded) return;

            let text = this._loadCache();
            if (!text) {
                try {
                    text = await fetchGM(NDJSON_URL);
                    this._saveCache(text);
                } catch (e) {
                    console.error('[Poetent] Failed to fetch NDJSON stats', e);
                    return;
                }
            }

            this._parse(text);
            this.loaded = true;
        },

        _parse(text) {
            this.patterns = [];

            text.split('\n').forEach(line => {
                if (!line) return;
                try {
                    const entry = JSON.parse(line);
                    if (!entry.matchers || !entry.trade?.ids) return;

                    entry.matchers.forEach(m => {
                        let rx = escapeRegExp(m.string);
                        rx = rx.replace(/\\\+/g, '\\+?');
                        rx = rx.replace(/#/g, '([\\-\\+]?[\\d\\.]+)');
                        rx = rx.replace(/\s/g, '\\s+');

                        try {
                            this.patterns.push({
                                regex: new RegExp(`^${rx}$`, 'i'),
                                ids: entry.trade.ids,
                                value: m.value,
                                raw: m.string,
                            });
                        } catch (e) { /* invalid regex — skip */ }
                    });
                } catch (e) {}
            });

            // Build prefix index for fast lookups (same technique as poecurer)
            this.prefixIndex.clear();
            this.patterns.forEach((p, idx) => {
                const prefix = this._extractPrefix(p.raw);
                if (prefix) {
                    if (!this.prefixIndex.has(prefix)) this.prefixIndex.set(prefix, []);
                    this.prefixIndex.get(prefix).push(idx);
                }
            });
        },

        _extractPrefix(str) {
            const words = str.replace(/#/g, '').replace(/[+%]/g, '').trim().split(/\s+/);
            for (const w of words) {
                if (w.length > 1 && !/^\d+$/.test(w)) return w.toLowerCase();
            }
            return null;
        },

        /**
         * Match game client mod text against NDJSON patterns.
         * Returns { id, value, text, source } or null.
         */
        matchMod(modText, source) {
            const prefix = this._extractPrefix(modText);

            // Try indexed candidates first
            if (prefix && this.prefixIndex.has(prefix)) {
                for (const idx of this.prefixIndex.get(prefix)) {
                    const result = this._tryPattern(this.patterns[idx], modText, source);
                    if (result) return result;
                }
            }

            // Full scan fallback
            for (const p of this.patterns) {
                const result = this._tryPattern(p, modText, source);
                if (result) return result;
            }

            return null;
        },

        _tryPattern(p, modText, source) {
            const m = modText.match(p.regex);
            if (!m) return null;

            // Select the correct stat ID based on source namespace
            let id;
            switch (source) {
                case 'implicit': id = p.ids.implicit?.[0] || p.ids.explicit?.[0]; break;
                case 'enchant':  id = p.ids.enchant?.[0]  || p.ids.implicit?.[0]; break;
                case 'crafted':  id = p.ids.crafted?.[0]  || p.ids.explicit?.[0]; break;
                default:         id = p.ids.explicit?.[0]  || p.ids.crafted?.[0]; break;
            }
            if (!id) return null;

            // Value: use fixed value from matcher, or parse first capture group
            let value = p.value;
            if (value === undefined && m[1]) value = parseFloat(m[1]);

            return {
                id, value, text: p.raw, source,
                values: Array.from(m).slice(1).map(Number),
            };
        },

        _loadCache() {
            try {
                const raw = GM_getValue(NDJSON_CACHE_KEY);
                if (!raw) return null;
                const obj = JSON.parse(raw);
                if ((Date.now() - obj.ts) / 36e5 > NDJSON_CACHE_HOURS) return null;
                return obj.text;
            } catch (e) { return null; }
        },

        _saveCache(text) {
            try {
                GM_setValue(NDJSON_CACHE_KEY, JSON.stringify({ ts: Date.now(), text }));
            } catch (e) {}
        },

        clearCache() {
            try { GM_deleteValue(NDJSON_CACHE_KEY); } catch (e) {}
        },
    };

    // =========================================================================
    // STAT RESOLVER — fetches trade stat database for harvest swap-group
    // lookups and pseudo stat resolution. Does NOT do game text matching
    // (that's GameTextMatcher's job).
    // =========================================================================
    const STATS_CACHE_KEY   = 'poe_harvest_grouper_stats_v2';
    const STATS_CACHE_HOURS = 24;

    const StatResolver = {
        idToMeta: new Map(),          // id → { text, type }
        textToId: new Map(),          // "type|text" → id
        idToSwap: new Map(),          // id → { swap, elementIndex, templateKey }
        templateGroups: new Map(),    // "swap.id|templateKey" → [...]
        loaded: false,

        async init() {
            if (this.loaded) return;

            const cached = this._loadCache();
            if (cached) {
                this._index(cached);
                this.loaded = true;
                return;
            }

            try {
                const resp = await fetch('https://www.pathofexile.com/api/trade/data/stats');
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                this._saveCache(data);
                this._index(data);
                this.loaded = true;
            } catch (e) {
                console.error('[Poetent] Failed to fetch trade API stats', e);
            }
        },

        _index(data) {
            // Step 1: Build text↔ID maps (used by harvest grouping + pseudo)
            (data.result || []).forEach(group => {
                (group.entries || []).forEach(entry => {
                    const key = `${entry.type}|${entry.text}`;
                    this.textToId.set(key, entry.id);
                    this.idToMeta.set(entry.id, { text: entry.text, type: entry.type });
                });
            });

            // Step 2: Build swap-group indexes (for harvest grouping)
            this.idToMeta.forEach((meta, statId) => {
                for (const swap of HARVEST_SWAPS) {
                    if (swap.excludeIf && swap.excludeIf.some(ex => meta.text.includes(ex))) continue;

                    for (let ei = 0; ei < swap.elements.length; ei++) {
                        const kw = swap.elements[ei].keyword;
                        if (meta.text.includes(kw)) {
                            const templateKey = `${meta.type}|${meta.text.replace(kw, '{{ELE}}')}`;
                            this.idToSwap.set(statId, { swap, elementIndex: ei, templateKey });
                            const groupKey = `${swap.id}|${templateKey}`;
                            if (!this.templateGroups.has(groupKey)) this.templateGroups.set(groupKey, []);
                            this.templateGroups.get(groupKey).push({
                                id: statId, elementIndex: ei, element: swap.elements[ei],
                                text: meta.text, type: meta.type,
                            });
                            break;
                        }
                    }
                }
            });

            // Step 3: Initialize PseudoMapper (uses idToMeta for pseudo IDs)
            PseudoMapper.init();
        },

        // Delegate game text matching to GameTextMatcher
        matchMod(modText, source) {
            return GameTextMatcher.matchMod(modText, source);
        },

        getSwapInfo(statId) {
            const entry = this.idToSwap.get(statId);
            if (!entry) return null;
            const groupKey = `${entry.swap.id}|${entry.templateKey}`;
            const siblings = this.templateGroups.get(groupKey);
            if (!siblings || siblings.length < 2) return null;
            return {
                swap: entry.swap,
                detectedElement: entry.swap.elements[entry.elementIndex],
                templateKey: entry.templateKey,
                siblings,
            };
        },

        _loadCache() {
            try {
                const raw = GM_getValue(STATS_CACHE_KEY);
                if (!raw) return null;
                const obj = JSON.parse(raw);
                if ((Date.now() - obj.ts) / 36e5 > STATS_CACHE_HOURS) return null;
                return obj.data;
            } catch (e) { return null; }
        },

        _saveCache(data) {
            try {
                GM_setValue(STATS_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
            } catch (e) {}
        },

        clearCache() {
            try { GM_deleteValue(STATS_CACHE_KEY); } catch (e) {}
        },
    };

    // =========================================================================
    // PSEUDO MAPPER — resolves pseudo stat IDs from trade data,
    // analyzes matched mods for pseudo uplift opportunities + bundles
    // =========================================================================
    const PseudoMapper = {
        // rule.id → resolved pseudo stat ID from trade API
        resolvedIds: new Map(),
        ready: false,

        // Called once after StatResolver finishes indexing
        init() {
            this.resolvedIds.clear();
            this.ready = false;

            for (const rule of PSEUDO_RULES) {
                const hint = rule.pseudoTextHint.toLowerCase();
                let found = null;

                // Search StatResolver's idToMeta for a pseudo entry matching the hint
                for (const [id, meta] of StatResolver.idToMeta) {
                    if (meta.type === 'pseudo' && meta.text.toLowerCase().includes(hint)) {
                        found = id;
                        break;
                    }
                }

                if (found) {
                    this.resolvedIds.set(rule.id, found);
                }
            }

            this.ready = this.resolvedIds.size > 0;
        },

        /**
         * Analyze matched mods from paste-to-search.
         * Returns an array of pseudo suggestions, each containing:
         *   { rule, pseudoId, contributors: [{modIdx, value, text}], total }
         *
         * @param {Array} matchedMods - array of { text, source, stat: { id, value, text } }
         */
        analyze(matchedMods) {
            if (!this.ready) return [];

            const suggestions = [];

            for (const rule of PSEUDO_RULES) {
                const pseudoId = this.resolvedIds.get(rule.id);
                if (!pseudoId) continue;

                const contributors = [];
                let total = 0;

                matchedMods.forEach((mod, idx) => {
                    const statText = mod.stat?.text || mod.text || '';
                    // Check: does this mod contribute to this pseudo?
                    if (!rule.match(statText)) return;
                    if (rule.exclude && rule.exclude(statText)) return;

                    const rawVal = mod.stat?.value;
                    if (rawVal === undefined) return;

                    // Apply value adjustment (e.g. "all Ele Res" counts ×3 for total ele res)
                    const adjusted = rule.adjust ? rule.adjust(rawVal, statText) : rawVal;
                    contributors.push({ modIdx: idx, value: rawVal, adjusted, text: mod.text });
                    total += adjusted;
                });

                // Only suggest if there are contributors
                if (contributors.length === 0) continue;

                // pseudoUplift: require 2+ contributors (or pseudoBroaden allows 1)
                const isUplift = contributors.length >= 2;
                const isBroaden = contributors.length === 1;

                suggestions.push({
                    rule,
                    pseudoId,
                    contributors,
                    total: Math.floor(total),
                    isUplift,
                    isBroaden,
                });
            }

            return suggestions;
        },

        /**
         * Generate defensive bundle suggestions.
         * A bundle is a count-group of pseudo stats: "at least N of these thresholds".
         * Returns at most one bundle per call.
         *
         * @param {Array} pseudoSuggestions - output of analyze()
         */
        buildBundle(pseudoSuggestions) {
            if (!pseudoSuggestions.length) return null;

            // Collect pseudo filters that make sense in a defensive bundle
            const BUNDLE_CATEGORIES = new Set([
                'total_life', 'total_es', 'total_mana',
                'total_fire_res', 'total_cold_res', 'total_lightning_res', 'total_chaos_res',
                'total_ele_res',
                'total_str', 'total_dex', 'total_int',
            ]);

            const filters = [];
            const seen = new Set();

            for (const sug of pseudoSuggestions) {
                if (!BUNDLE_CATEGORIES.has(sug.rule.id)) continue;
                if (seen.has(sug.pseudoId)) continue;
                if (sug.total <= 0) continue;

                seen.add(sug.pseudoId);
                filters.push({
                    rule: sug.rule,
                    pseudoId: sug.pseudoId,
                    min: sug.total,
                });
            }

            if (filters.length < 2) return null;

            // Default count: require at least N-1 of the filters (lenient)
            // This means one stat category can be missing/different
            const countMin = Math.max(1, filters.length - 1);

            return {
                label: 'Defensive Bundle',
                description: `At least ${countMin} of ${filters.length} defensive thresholds`,
                filters,
                countMin,
            };
        },
    };

    // =========================================================================
    // ITEM PARSER — parses Ctrl+C item text from the PoE game client
    // =========================================================================
    const ItemParser = {
        parse(text) {
            if (!text || !text.includes('--------')) return null;

            const sections = text.split(/^--------$/m).map(s => s.trim()).filter(Boolean);
            if (sections.length < 2) return null;

            // ── Parse header section ──
            const headerLines = sections[0].split('\n');
            let rarity = 'Rare', name = '', baseType = '', itemClass = '';

            for (const line of headerLines) {
                if (line.startsWith('Item Class:')) itemClass = line.split(':').slice(1).join(':').trim();
                if (line.startsWith('Rarity:'))     rarity = line.split(':')[1].trim();
            }

            const rarIdx = headerLines.findIndex(l => l.startsWith('Rarity:'));
            if (rarIdx >= 0) {
                name = (headerLines[rarIdx + 1] || '').trim();
                baseType = (headerLines[rarIdx + 2] || name).trim();
            }

            // Normal/Magic: name line IS the base type (no separate name)
            if (rarity === 'Normal' || rarity === 'Magic') {
                baseType = name;
                name = '';
            }

            // ── Scan remaining sections for mods, properties, metadata ──
            const mods = [];
            let ilvl = 0;
            let corrupted = false;
            let fractured = false;
            let synthesised = false;

            const skipRx = /^(Requirements:|Item Level:|Sockets:|Quality|Level:|Note:|Unmodifiable)/;
            // Property lines — these are base item stats, not mods
            const propRx = /^(Armour|Evasion Rating|Evasion|Energy Shield|Physical Damage|Elemental Damage|Attacks per Second|Critical Strike Chance|Critical Strike|Weapon Range|Charm Slots|Ward|Chance to Block|Block Chance|Spirit|Reload Time|Mana Cost|Cooldown Time|Cast Time|Damage|Duration|Stack Size|Map Tier):/;

            // Flavor text detection: sections with no numbers and no stat-like content
            const isFlavorText = (lines) => {
                // Single-line sections with no digits are almost always flavor
                const joined = lines.join(' ');
                if (!joined.match(/\d/)) return true;
                // Multi-line italic flavor: no line starts with + or a digit, no colon-separated stat
                if (lines.every(l => {
                    const t = l.trim();
                    return !t.match(/^[+\-]?\d/) && !t.includes(':') && !t.match(/\d+%/);
                })) return true;
                return false;
            };

            for (let i = 1; i < sections.length; i++) {
                const lines = sections[i].split('\n');
                const first = lines[0].trim();

                // Extract item level
                if (first.startsWith('Item Level:')) {
                    ilvl = parseInt(first.split(':')[1]) || 0;
                    continue;
                }

                // Skip non-mod sections
                if (skipRx.test(first)) continue;
                // Skip property-only sections (all lines are properties)
                if (lines.every(l => propRx.test(l.trim()) || !l.trim())) continue;

                // Check for special flags
                if (first === 'Corrupted') { corrupted = true; continue; }
                if (first === 'Fractured Item') { fractured = true; continue; }
                if (first === 'Synthesised Item') { synthesised = true; continue; }
                if (first === 'Mirrored') continue;
                if (first.startsWith('Note:')) continue;

                // Skip flavor text sections
                if (isFlavorText(lines)) continue;

                // Merge multiline mods: lines ending with conjunctions/prepositions
                // continue onto the next line (e.g. "Minions deal X% increased\nDamage")
                const mergedLines = [];
                for (let j = 0; j < lines.length; j++) {
                    let current = lines[j].trim();
                    while (j + 1 < lines.length && /( or| and| the| of| with| by| to| per| while| during| if| when| for| from| as| that| at| in| on)$/i.test(current)) {
                        current += ' ' + lines[j + 1].trim();
                        j++;
                    }
                    mergedLines.push(current);
                }

                // Parse mod lines
                for (const line of mergedLines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('Note:')) continue;
                    if (trimmed === 'Corrupted' || trimmed === 'Fractured Item' || trimmed === 'Synthesised Item') {
                        if (trimmed === 'Corrupted') corrupted = true;
                        if (trimmed === 'Fractured Item') fractured = true;
                        if (trimmed === 'Synthesised Item') synthesised = true;
                        continue;
                    }

                    // Skip individual property lines that appear in mixed sections
                    if (propRx.test(trimmed)) continue;

                    // Detect source from annotation
                    let source = 'explicit';
                    const annoMatch = trimmed.match(/\((implicit|crafted|enchant|fractured)\)\s*$/i);
                    if (annoMatch) {
                        const a = annoMatch[1].toLowerCase();
                        source = (a === 'fractured') ? 'explicit' : a;
                    }

                    // Clean: remove annotations and (augmented) tags
                    let clean = trimmed
                        .replace(/\s*\((implicit|crafted|enchant|fractured|augmented)\)\s*/gi, '')
                        .trim();
                    if (!clean) continue;

                    // Normalize ranges: (10-20) → average
                    clean = clean.replace(/\((\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\)/g, (_, p1, p2) =>
                        String(Math.floor((parseFloat(p1) + parseFloat(p2)) / 2)));

                    mods.push({ text: clean, source, raw: trimmed });
                }
            }

            if (!baseType && !name) return null;

            return { rarity, name, baseType, itemClass, mods, ilvl, corrupted, fractured, synthesised };
        },
    };

    // =========================================================================
    // PASTE SEARCH — modal UI for pasting game items and searching trade
    // =========================================================================
    const PasteSearch = {
        overlay: null,
        _league: null,
        _parsedItem: null,
        _matchedMods: null,
        _pseudoSuggestions: null,
        _pseudoBundle: null,
        _activePseudos: new Set(),   // rule IDs currently toggled ON
        _parseTimer: null,

        init() {},

        open() {
            if (!StatResolver.loaded || !GameTextMatcher.loaded) return;
            this._league = detectLeague();
            this._createOverlay();
            this.overlay.style.display = 'flex';
            const ta = this.overlay.querySelector('[data-ps-textarea]');
            ta.value = '';
            ta.focus();
            this.overlay.querySelector('[data-ps-results]').innerHTML = '';
            this.overlay.querySelector('[data-ps-search]').style.display = 'none';
            this.overlay.querySelector('[data-ps-bundle-btn]').style.display = 'none';
            this._activePseudos.clear();
            this._pseudoSuggestions = null;
            this._pseudoBundle = null;
        },

        close() {
            if (this.overlay) this.overlay.style.display = 'none';
        },

        _createOverlay() {
            if (this.overlay) return;

            this.overlay = document.createElement('div');
            this.overlay.className = 'ps-overlay';
            this.overlay.innerHTML = `
                <div class="ps-modal">
                    <div class="ps-modal-header">
                        <span class="ps-modal-title">📋 Paste Item</span>
                        <span class="ps-modal-close" data-ps-close title="Close">✕</span>
                    </div>
                    <div class="ps-modal-body">
                        <textarea class="ps-textarea" data-ps-textarea placeholder="Ctrl+V an item copied from Path of Exile…&#10;&#10;(Copy an item in-game with Ctrl+C, then paste here)" rows="6" spellcheck="false"></textarea>
                        <div class="ps-league-row">
                            <label>League:</label>
                            <input type="text" class="ps-league-input" data-ps-league placeholder="e.g. Mirage">
                        </div>
                        <div data-ps-results></div>
                        <button class="ps-search-btn" data-ps-search style="display:none">🔍 Search Trade</button>
                        <button class="ps-bundle-btn" data-ps-bundle-btn style="display:none">🎯 Search Defensive Bundle</button>
                    </div>
                </div>
            `;
            document.body.appendChild(this.overlay);

            // Close on overlay click or ✕
            this.overlay.addEventListener('click', (e) => {
                if (e.target === this.overlay) this.close();
            });
            this.overlay.querySelector('[data-ps-close]').addEventListener('click', () => this.close());

            // League pre-fill
            const leagueInput = this.overlay.querySelector('[data-ps-league]');
            if (this._league) leagueInput.value = this._league;

            // Auto-parse on paste
            const textarea = this.overlay.querySelector('[data-ps-textarea]');
            textarea.addEventListener('paste', () => {
                setTimeout(() => this._parseAndRender(), 50);
            });
            textarea.addEventListener('input', () => {
                clearTimeout(this._parseTimer);
                this._parseTimer = setTimeout(() => this._parseAndRender(), 300);
            });

            // Search button
            this.overlay.querySelector('[data-ps-search]').addEventListener('click', () => this._doSearch());
            // Bundle button
            this.overlay.querySelector('[data-ps-bundle-btn]').addEventListener('click', () => this._doBundleSearch());

            // Escape to close
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.overlay?.style.display === 'flex') this.close();
            });
        },

        _parseAndRender() {
            const text = this.overlay.querySelector('[data-ps-textarea]').value;
            const resultsEl = this.overlay.querySelector('[data-ps-results]');
            const searchBtn = this.overlay.querySelector('[data-ps-search]');
            const bundleBtn = this.overlay.querySelector('[data-ps-bundle-btn]');

            const item = ItemParser.parse(text);
            if (!item) {
                resultsEl.innerHTML = '<div class="ps-hint">Paste a valid item (Ctrl+C from game).</div>';
                searchBtn.style.display = 'none';
                bundleBtn.style.display = 'none';
                this._parsedItem = null;
                this._activePseudos.clear();
                return;
            }

            // Match mods against stat patterns
            const matched = [];
            const unmatched = [];

            item.mods.forEach(mod => {
                const result = StatResolver.matchMod(mod.text, mod.source);
                if (result) {
                    matched.push({ ...mod, stat: result });
                } else {
                    unmatched.push(mod);
                }
            });

            this._parsedItem = item;
            this._matchedMods = matched;
            this._activePseudos.clear();

            // ── Pseudo analysis ──
            this._pseudoSuggestions = [];
            this._pseudoBundle = null;

            if (PseudoMapper.ready && matched.length > 0) {
                const allPseudos = PseudoMapper.analyze(matched);

                // Filter based on settings
                this._pseudoSuggestions = allPseudos.filter(sug => {
                    if (sug.isUplift && Settings.data.pseudoUplift) return true;
                    if (sug.isBroaden && Settings.data.pseudoBroaden) return true;
                    return false;
                });

                // Build defensive bundle (uses all pseudos, not just visible ones)
                if (Settings.data.pseudoBundles) {
                    this._pseudoBundle = PseudoMapper.buildBundle(allPseudos);
                }
            }

            // ── Render ──
            const rarCol = { Unique: '#af6025', Rare: '#ff7', Magic: '#8888ff', Normal: '#c8c8c8', Gem: '#1ba29b' };
            const nameColor = rarCol[item.rarity] || '#c8c8c8';
            const displayName = item.name || item.baseType;
            const subLine = item.name ? item.baseType : '';

            let html = `
                <div class="ps-item-header">
                    <div class="ps-item-name" style="color:${nameColor}">${esc(displayName)}</div>
                    ${subLine ? `<div class="ps-item-base">${esc(subLine)}</div>` : ''}
                    <div class="ps-item-meta">
                        ${item.ilvl ? `iLvl ${item.ilvl}` : ''}
                        ${item.corrupted ? ' · <span style="color:#d44">Corrupted</span>' : ''}
                        ${item.fractured ? ' · <span style="color:#a16207">Fractured</span>' : ''}
                        ${item.synthesised ? ' · <span style="color:#6d28d9">Synthesised</span>' : ''}
                    </div>
                </div>
            `;

            // ── Matched mods ──
            if (matched.length > 0) {
                html += '<div class="ps-mod-list">';
                matched.forEach((mod, idx) => {
                    const srcTag = mod.source !== 'explicit'
                        ? `<span class="ps-src-tag ps-src-${mod.source}">${mod.source}</span>`
                        : '';
                    const valStr = mod.stat.value !== undefined ? `≥${mod.stat.value}` : '';
                    html += `
                        <label class="ps-mod-row" data-ps-mod-row="${idx}">
                            <input type="checkbox" checked data-ps-mod="${idx}">
                            <span class="ps-mod-text">${esc(mod.text)}</span>
                            ${srcTag}
                            <span class="ps-mod-val">${esc(valStr)}</span>
                        </label>
                    `;
                });
                html += '</div>';
            }

            // ── Pseudo suggestions ──
            if (this._pseudoSuggestions.length > 0) {
                html += '<div class="ps-pseudo-section">';
                html += '<div class="ps-pseudo-header">Pseudo Alternatives</div>';

                this._pseudoSuggestions.forEach(sug => {
                    const contribText = sug.contributors.map(c => esc(c.text)).join(', ');
                    const typeLabel = sug.isUplift ? 'uplift' : 'broaden';
                    const contribCount = sug.contributors.length;
                    const desc = sug.isUplift
                        ? `Replaces ${contribCount} mods`
                        : 'Broader search';

                    html += `
                        <label class="ps-pseudo-row" data-ps-pseudo-row="${sug.rule.id}">
                            <input type="checkbox" data-ps-pseudo="${sug.rule.id}">
                            <span class="ps-pseudo-icon">${sug.rule.icon}</span>
                            <span class="ps-pseudo-label">${esc(sug.rule.label)} ≥${sug.total}</span>
                            <span class="ps-pseudo-type ps-pseudo-type-${typeLabel}">${desc}</span>
                        </label>
                    `;
                });
                html += '</div>';
            }

            // ── Unmatched mods ──
            if (unmatched.length > 0) {
                html += '<div class="ps-unmatched-header">Unmatched (' + unmatched.length + ')</div>';
                html += '<div class="ps-unmatched-list">';
                unmatched.forEach(mod => {
                    const srcTag = mod.source !== 'explicit'
                        ? `<span class="ps-src-tag ps-src-${mod.source}">${mod.source}</span>`
                        : '';
                    html += `<div class="ps-mod-row ps-mod-dim"><span class="ps-mod-text">${esc(mod.text)}</span>${srcTag}</div>`;
                });
                html += '</div>';
            }

            html += `<div class="ps-match-summary">${matched.length} of ${item.mods.length} mods matched</div>`;

            resultsEl.innerHTML = html;
            searchBtn.style.display = matched.length > 0 ? 'block' : 'none';
            bundleBtn.style.display = this._pseudoBundle ? 'block' : 'none';

            // ── Bind pseudo toggle events ──
            resultsEl.querySelectorAll('[data-ps-pseudo]').forEach(cb => {
                cb.addEventListener('change', () => this._onPseudoToggle(cb));
            });
        },

        // When a pseudo toggle is changed, dim/undim the mods it replaces
        _onPseudoToggle(checkbox) {
            const ruleId = checkbox.dataset.psPseudo;
            const sug = this._pseudoSuggestions.find(s => s.rule.id === ruleId);
            if (!sug) return;

            if (checkbox.checked) {
                this._activePseudos.add(ruleId);
                // Uncheck and dim the individual mods this pseudo replaces
                sug.contributors.forEach(c => {
                    const modRow = this.overlay.querySelector(`[data-ps-mod-row="${c.modIdx}"]`);
                    if (modRow) {
                        const modCb = modRow.querySelector('input[type=checkbox]');
                        if (modCb) modCb.checked = false;
                        modRow.classList.add('ps-mod-pseudo-replaced');
                    }
                });
            } else {
                this._activePseudos.delete(ruleId);
                // Re-check and undim the individual mods
                sug.contributors.forEach(c => {
                    const modRow = this.overlay.querySelector(`[data-ps-mod-row="${c.modIdx}"]`);
                    if (modRow) {
                        const modCb = modRow.querySelector('input[type=checkbox]');
                        if (modCb) modCb.checked = true;
                        modRow.classList.remove('ps-mod-pseudo-replaced');
                    }
                });
            }
        },

        async _doSearch() {
            const item = this._parsedItem;
            const matched = this._matchedMods;
            if (!item || !matched?.length) return;

            const league = this.overlay.querySelector('[data-ps-league]').value || detectLeague();
            if (!league) return;

            const searchBtn = this.overlay.querySelector('[data-ps-search]');
            searchBtn.disabled = true;
            searchBtn.textContent = 'Searching…';

            // Collect checked mods (skipping those replaced by active pseudos)
            const replacedIndices = new Set();
            this._activePseudos.forEach(ruleId => {
                const sug = this._pseudoSuggestions.find(s => s.rule.id === ruleId);
                if (sug) sug.contributors.forEach(c => replacedIndices.add(c.modIdx));
            });

            const checkedMods = [];
            this.overlay.querySelectorAll('[data-ps-mod]').forEach(cb => {
                const idx = parseInt(cb.dataset.psMod);
                if (cb.checked && !replacedIndices.has(idx) && matched[idx]) {
                    checkedMods.push(matched[idx]);
                }
            });

            // Build active pseudo filters
            const activePseudoFilters = [];
            this._activePseudos.forEach(ruleId => {
                const sug = this._pseudoSuggestions.find(s => s.rule.id === ruleId);
                if (sug) {
                    activePseudoFilters.push({
                        id: sug.pseudoId,
                        disabled: false,
                        value: { min: sug.total },
                    });
                }
            });

            if (!checkedMods.length && !activePseudoFilters.length) {
                searchBtn.disabled = false;
                searchBtn.textContent = '🔍 Search Trade';
                return;
            }

            // Build payload
            const statFilters = checkedMods.map(mod => ({
                id: mod.stat.id,
                disabled: false,
                value: mod.stat.value !== undefined ? { min: mod.stat.value } : undefined,
            })).filter(f => f.id);

            // Merge pseudo filters into the same "and" group
            const allFilters = [...statFilters, ...activePseudoFilters];

            const payload = {
                query: {
                    status: { option: 'online' },
                    type: item.baseType,
                    stats: [{
                        type: 'and',
                        disabled: false,
                        filters: allFilters,
                    }],
                    filters: {
                        trade_filters: { disabled: false, filters: { sale_type: { option: 'priced' } } },
                    },
                },
                sort: { price: 'asc' },
            };

            if (item.rarity === 'Unique' && item.name) {
                payload.query.name = item.name;
            }

            const misc = {};
            if (item.corrupted)   misc.corrupted       = { option: 'true' };
            if (item.fractured)   misc.fractured_item   = { option: 'true' };
            if (item.synthesised) misc.synthesised_item  = { option: 'true' };
            if (Object.keys(misc).length) {
                payload.query.filters.misc_filters = { filters: misc };
            }

            await this._submitPayload(payload, league, searchBtn, '🔍 Search Trade');
        },

        // Defensive bundle search — count group of pseudo stats
        async _doBundleSearch() {
            const item = this._parsedItem;
            const bundle = this._pseudoBundle;
            if (!item || !bundle) return;

            const league = this.overlay.querySelector('[data-ps-league]').value || detectLeague();
            if (!league) return;

            const bundleBtn = this.overlay.querySelector('[data-ps-bundle-btn]');
            bundleBtn.disabled = true;
            bundleBtn.textContent = 'Searching…';

            const payload = {
                query: {
                    status: { option: 'online' },
                    type: item.baseType,
                    stats: [{
                        type: 'count',
                        value: { min: bundle.countMin },
                        disabled: false,
                        filters: bundle.filters.map(f => ({
                            id: f.pseudoId,
                            disabled: false,
                            value: { min: f.min },
                        })),
                    }],
                    filters: {
                        trade_filters: { disabled: false, filters: { sale_type: { option: 'priced' } } },
                    },
                },
                sort: { price: 'asc' },
            };

            if (item.rarity === 'Unique' && item.name) {
                payload.query.name = item.name;
            }

            await this._submitPayload(payload, league, bundleBtn, '🎯 Search Defensive Bundle');
        },

        async _submitPayload(payload, league, btn, resetLabel) {
            _isGroupedSubmit = true;
            try {
                const resp = await fetch(`https://www.pathofexile.com/api/trade/search/${league}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });

                if (resp.status === 429) {
                    const retry = resp.headers.get('Retry-After') || '60';
                    btn.disabled = false;
                    btn.textContent = `⏳ Rate limited — ${retry}s`;
                    return;
                }
                if (!resp.ok) {
                    let msg = `HTTP ${resp.status}`;
                    try { const e = await resp.json(); msg = e.error?.message || msg; } catch (_) {}
                    btn.disabled = false;
                    btn.textContent = `❌ ${msg}`;
                    return;
                }

                const data = await resp.json();
                if (data.id) {
                    this.close();
                    window.location.href = `https://www.pathofexile.com/trade/search/${league}/${data.id}`;
                } else {
                    btn.disabled = false;
                    btn.textContent = '❌ No search ID';
                }
            } catch (e) {
                btn.disabled = false;
                btn.textContent = '❌ Network error';
            } finally {
                _isGroupedSubmit = false;
            }
        },
    };

    // =========================================================================
    // QUERY INTERCEPTOR
    // =========================================================================
    let _lastPayload  = null;
    let _lastLeague   = null;
    let _lastSearchId = null;
    let _isGroupedSubmit = false;

    const SEARCH_URL_RE = /\/api\/trade\/search\/([^/]+)$/;

    function installInterceptor() {
        const uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

        if (uw.fetch) {
            const origFetch = uw.fetch;
            uw.fetch = function (...args) {
                const promise = origFetch.apply(this, args);
                try {
                    if (_isGroupedSubmit) return promise;
                    const input = args[0];
                    const url = typeof input === 'string' ? input : input?.url || '';
                    const opts = typeof input === 'string' ? (args[1] || {}) : input;
                    const m = url.match(SEARCH_URL_RE);
                    if (m && (opts.method || '').toUpperCase() === 'POST') {
                        try {
                            const body = typeof opts.body === 'string' ? opts.body : null;
                            if (body) {
                                _lastPayload = JSON.parse(body);
                                _lastLeague  = m[1];
                                const capturedPayload = _lastPayload;
                                const capturedLeague = _lastLeague;
                                promise.then(resp => resp.clone().json()).then(data => {
                                    if (data.id) {
                                        _lastSearchId = data.id;
                                        _lastPayload = capturedPayload;
                                        _lastLeague = capturedLeague;
                                        Sidebar.analyze(capturedPayload, capturedLeague);
                                    }
                                }).catch(() => {});
                            }
                        } catch (e) {}
                    }
                } catch (e) {}
                return promise;
            };
        }

        if (uw.XMLHttpRequest) {
            const origOpen = uw.XMLHttpRequest.prototype.open;
            const origSend = uw.XMLHttpRequest.prototype.send;
            uw.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                this._hg_method = method;
                this._hg_url = url;
                return origOpen.call(this, method, url, ...rest);
            };
            uw.XMLHttpRequest.prototype.send = function (body) {
                try {
                    if (_isGroupedSubmit) return origSend.call(this, body);
                    const m = (this._hg_url || '').match(SEARCH_URL_RE);
                    if (m && (this._hg_method || '').toUpperCase() === 'POST' && typeof body === 'string') {
                        const parsed = JSON.parse(body);
                        _lastPayload = parsed;
                        _lastLeague  = m[1];
                        const capturedPayload = parsed;
                        const capturedLeague = m[1];
                        this.addEventListener('load', () => {
                            try {
                                const data = JSON.parse(this.responseText);
                                if (data.id) {
                                    _lastSearchId = data.id;
                                    _lastPayload = capturedPayload;
                                    _lastLeague = capturedLeague;
                                    Sidebar.analyze(capturedPayload, capturedLeague);
                                }
                            } catch (e) {}
                        });
                    }
                } catch (e) {}
                return origSend.call(this, body);
            };
        }
    }

    // =========================================================================
    // LEAGUE DETECTION
    // =========================================================================
    function detectLeague() {
        if (_lastLeague) return _lastLeague;
        const m = window.location.pathname.match(/\/trade\/search\/([^/]+)/);
        return m ? m[1] : null;
    }

    // =========================================================================
    // SIDEBAR UI
    // =========================================================================
    const Sidebar = {
        panel: null,
        content: null,
        badge: null,
        bar: null,
        barBody: null,
        barBadge: null,
        suggestions: [],
        pseudoSuggestions: [],
        minimized: false,

        init() {
            if (this.panel) return;

            const style = document.createElement('style');
            style.textContent = `
                /* ══════════════════════════════════════════
                   Sidebar panel (full mode)
                   ══════════════════════════════════════════ */
                .hg-panel{position:fixed;right:12px;top:120px;width:340px;max-height:72vh;background:#0c0c0e;border:1px solid #3a3a3a;border-radius:6px;z-index:100000;font-family:'FontinSmallCaps',Verdana,Arial,sans-serif;font-size:13px;color:#c8c8c8;box-shadow:0 4px 24px rgba(0,0,0,.7);display:flex;flex-direction:column;overflow:hidden;transition:opacity .2s}
                .hg-panel.hg-empty{opacity:.7;pointer-events:auto}
                .hg-panel.hg-min.hg-empty{opacity:1}
                .hg-panel.hg-compact-mode{display:none}
                .hg-header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#1a1a1e;border-bottom:1px solid #3a3a3a;user-select:none;cursor:grab}
                .hg-header:active{cursor:grabbing}
                .hg-header:hover{background:#222226}
                .hg-title{font-weight:bold;color:#7fcc5a;font-size:13px;display:flex;align-items:center;gap:6px}
                .hg-header-btns{display:flex;align-items:center;gap:8px}
                .hg-header-btn{cursor:pointer;color:#888;font-size:14px;transition:color .15s}
                .hg-header-btn:hover{color:#ccc}
                .hg-badge{background:#7fcc5a;color:#0c0c0e;font-size:10px;font-weight:bold;padding:1px 6px;border-radius:10px;min-width:14px;text-align:center}
                .hg-badge.hg-zero{background:#555;color:#999}
                .hg-toggle{color:#888;font-size:16px;transition:transform .2s;cursor:pointer}
                .hg-panel.hg-min .hg-toggle{transform:rotate(180deg)}
                .hg-panel.hg-min .hg-header{border-bottom:none}
                .hg-body{padding:10px 12px;overflow-y:auto;flex:1}
                .hg-panel.hg-min .hg-body{display:none}
                .hg-panel.hg-min .hg-status{display:none}
                .hg-empty-msg{color:#666;font-style:italic;font-size:12px;text-align:center;padding:12px 0}
                .hg-sug{background:#151518;border:1px solid #2a2a2e;border-radius:5px;padding:8px 10px;margin-bottom:6px}
                .hg-sug:last-child{margin-bottom:0}
                .hg-sug-head{display:flex;align-items:center;gap:6px;margin-bottom:6px;font-weight:bold;color:#ddd;font-size:13px}
                .hg-sug-icon{font-size:15px}
                .hg-sug-cost{font-size:10px;color:#7a7;font-weight:normal;margin-left:auto}
                .hg-sug-flow{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-bottom:8px}
                .hg-sug-arrow{color:#666;font-size:13px;margin:0 2px}
                .hg-chip{font-size:11px;padding:2px 8px;border-radius:3px;border:1px solid;font-weight:bold}
                .hg-chip-orig{outline:2px solid rgba(255,255,255,.15);outline-offset:1px}
                .hg-apply{display:block;width:100%;padding:7px 0;background:linear-gradient(135deg,#2e7d32,#1b5e20);color:#c8e6c9;border:1px solid #4caf50;border-radius:4px;font-family:inherit;font-size:12px;font-weight:bold;cursor:pointer;text-align:center;transition:background .15s}
                .hg-apply:hover{background:linear-gradient(135deg,#388e3c,#2e7d32);color:#fff}
                .hg-apply:active{transform:scale(.98)}
                .hg-apply:disabled{background:#333;border-color:#555;color:#777;cursor:not-allowed}
                .hg-apply-pseudo{background:linear-gradient(135deg,#6d4c00,#4a3300);color:#ffd700;border:1px solid #b8860b}
                .hg-apply-pseudo:hover{background:linear-gradient(135deg,#7d5c10,#5a4310);color:#fff}
                .hg-sug-pseudo{border-color:#3a3520}
                .hg-status{font-size:11px;padding:6px 12px;border-top:1px solid #2a2a2e;color:#666;background:#0e0e10;text-align:center}
                .hg-status a{color:#7fcc5a;text-decoration:none}
                .hg-status a:hover{text-decoration:underline}

                /* ── Sidebar settings ── */
                .hg-settings{padding:8px 12px;display:none;flex-direction:column;gap:0}
                .hg-panel.hg-show-settings .hg-body{display:none}
                .hg-panel.hg-show-settings .hg-status{display:none}
                .hg-panel.hg-show-settings .hg-settings{display:flex}

                /* ── Shared settings styles ── */
                .hg-set-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
                .hg-set-heading{font-size:13px;font-weight:bold;color:#ccc}
                .hg-set-save{width:28px;height:28px;background:#2e7d32;color:#c8e6c9;border:1px solid #4caf50;border-radius:4px;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1}
                .hg-set-save:hover{background:#388e3c;color:#fff}
                .hg-set-section{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;padding:6px 0 2px}
                .hg-set-row{display:flex;align-items:center;gap:8px;font-size:13px;padding:3px 0}
                .hg-set-row input[type=checkbox]{accent-color:#7fcc5a;width:14px;height:14px;cursor:pointer;flex-shrink:0}
                .hg-set-row label{cursor:pointer;flex:1;color:#c8c8c8}
                .hg-set-cache{display:flex;align-items:center;justify-content:space-between;padding:6px 0 2px}
                .hg-set-cache-info{font-size:11px;color:#888}
                .hg-set-cache-btn{background:#b71c1c;color:#ef9a9a;border:1px solid #e53e3e;border-radius:3px;padding:2px 8px;font-family:inherit;font-size:10px;cursor:pointer}
                .hg-set-cache-btn:hover{background:#c62828;color:#fff}

                /* ══════════════════════════════════════════
                   Compact bar
                   ══════════════════════════════════════════ */
                .hg-bar{position:fixed;right:12px;top:120px;width:290px;z-index:100000;font-family:'FontinSmallCaps',Verdana,Arial,sans-serif;font-size:12px;color:#c8c8c8;display:none;flex-direction:column;background:#0c0c0e;border:1px solid #3a3a3a;border-radius:6px;box-shadow:0 4px 24px rgba(0,0,0,.7);overflow:visible}
                .hg-bar.hg-bar-active{display:flex}
                .hg-bar-header{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#1a1a1e;border-bottom:1px solid #3a3a3a;border-radius:6px 6px 0 0;user-select:none;cursor:grab}
                .hg-bar-header:active{cursor:grabbing}
                .hg-bar-header:hover{background:#222226}
                .hg-bar-htitle{font-weight:bold;color:#7fcc5a;font-size:12px;display:flex;align-items:center;gap:6px}
                .hg-bar-hbtns{display:flex;align-items:center;gap:8px}
                .hg-bar-hbtn{cursor:pointer;color:#888;font-size:13px;transition:color .15s;padding:2px}
                .hg-bar-hbtn:hover{color:#ccc}
                .hg-bar.hg-bar-settings-open .hg-bar-hbtn[data-hg-bar-gear]{color:#7fcc5a}
                .hg-bar-body{padding:6px}
                .hg-bar-empty{color:#666;font-style:italic;font-size:11px;text-align:center;padding:6px 0}
                .hg-bar-row{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:3px;margin-bottom:3px}
                .hg-bar-row:last-child{margin-bottom:0}
                .hg-bar-row:hover{background:#1a1a1e}
                .hg-bar-icon{font-size:13px;flex-shrink:0}
                .hg-bar-label{color:#c8c8c8;font-weight:bold}
                .hg-bar-det{color:#888;font-size:11px;margin-left:auto;white-space:nowrap}
                .hg-bar-go{background:#2e7d32;color:#c8e6c9;border:1px solid #4caf50;border-radius:3px;padding:2px 8px;font-family:inherit;font-size:11px;font-weight:bold;cursor:pointer;flex-shrink:0}
                .hg-bar-go:hover{background:#388e3c;color:#fff}
                .hg-bar-go:disabled{background:#333;border-color:#555;color:#777;cursor:not-allowed}
                .hg-bar-footer{display:flex;justify-content:flex-end;padding:0 6px 6px;gap:4px}
                .hg-bar-flyout{display:none;position:absolute;top:0;right:calc(100% + 6px);width:220px;background:#0c0c0e;border:1px solid #3a3a3a;border-radius:6px;box-shadow:0 4px 24px rgba(0,0,0,.7);padding:10px 12px;flex-direction:column;gap:0;font-size:12px}
                .hg-bar.hg-bar-settings-open .hg-bar-flyout{display:flex}

                /* ══════════════════════════════════════════
                   Paste Search modal
                   ══════════════════════════════════════════ */
                .ps-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:200000;justify-content:center;align-items:center;font-family:'FontinSmallCaps',Verdana,Arial,sans-serif}
                .ps-modal{background:#0c0c0e;border:1px solid #3a3a3a;border-radius:8px;width:480px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.9);overflow:hidden}
                .ps-modal-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#1a1a1e;border-bottom:1px solid #3a3a3a}
                .ps-modal-title{font-weight:bold;color:#7fcc5a;font-size:14px}
                .ps-modal-close{cursor:pointer;color:#888;font-size:16px;transition:color .15s}
                .ps-modal-close:hover{color:#ccc}
                .ps-modal-body{padding:12px 14px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:10px}
                .ps-textarea{width:100%;background:#151518;border:1px solid #3a3a3a;border-radius:4px;color:#c8c8c8;font-family:'Consolas','Courier New',monospace;font-size:11px;padding:8px;resize:vertical;box-sizing:border-box}
                .ps-textarea:focus{border-color:#7fcc5a;outline:none}
                .ps-textarea::placeholder{color:#555}
                .ps-league-row{display:flex;align-items:center;gap:8px;font-size:12px;color:#aaa}
                .ps-league-input{background:#151518;border:1px solid #3a3a3a;border-radius:4px;color:#c8c8c8;padding:4px 8px;font-family:inherit;font-size:12px;width:120px}
                .ps-league-input:focus{border-color:#7fcc5a;outline:none}
                .ps-hint{color:#555;font-size:12px;font-style:italic;text-align:center;padding:10px 0}
                .ps-item-header{border:1px solid #3a3a3a;border-radius:4px;padding:8px 10px;background:#151518;text-align:center;margin-bottom:4px}
                .ps-item-name{font-size:15px;font-weight:bold}
                .ps-item-base{font-size:12px;color:#aaa;margin-top:2px}
                .ps-item-meta{font-size:11px;color:#888;margin-top:4px}
                .ps-mod-list{display:flex;flex-direction:column;gap:2px}
                .ps-mod-row{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:3px;font-size:12px;color:#c8c8c8;cursor:pointer;transition:opacity .15s}
                .ps-mod-row:hover{background:#1a1a1e}
                .ps-mod-row input[type=checkbox]{accent-color:#7fcc5a;width:13px;height:13px;cursor:pointer;flex-shrink:0}
                .ps-mod-text{flex:1}
                .ps-mod-val{color:#68d391;font-size:11px;flex-shrink:0}
                .ps-mod-dim{opacity:.45;cursor:default}
                .ps-mod-dim:hover{background:none}
                .ps-mod-pseudo-replaced{opacity:.35;text-decoration:line-through;pointer-events:none}
                .ps-src-tag{font-size:9px;padding:1px 5px;border-radius:2px;font-weight:bold;flex-shrink:0}
                .ps-src-implicit{background:#2a2a40;color:#aab}
                .ps-src-crafted{background:#2a3a2a;color:#8d8}
                .ps-src-enchant{background:#3a2a3a;color:#d8d}
                .ps-unmatched-header{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;padding:6px 0 2px}
                .ps-unmatched-list{display:flex;flex-direction:column;gap:1px}
                .ps-match-summary{font-size:11px;color:#888;text-align:center;padding:4px 0}
                .ps-search-btn{display:block;width:100%;padding:10px 0;background:linear-gradient(135deg,#1565c0,#0d47a1);color:#bbdefb;border:1px solid #1e88e5;border-radius:4px;font-family:inherit;font-size:13px;font-weight:bold;cursor:pointer;text-align:center;transition:background .15s}
                .ps-search-btn:hover{background:linear-gradient(135deg,#1976d2,#1565c0);color:#fff}
                .ps-search-btn:active{transform:scale(.98)}
                .ps-search-btn:disabled{background:#333;border-color:#555;color:#777;cursor:not-allowed}

                /* ── Pseudo section in paste modal ── */
                .ps-pseudo-section{border-top:1px solid #2a2a2e;padding-top:6px;margin-top:4px}
                .ps-pseudo-header{font-size:10px;color:#b8860b;text-transform:uppercase;letter-spacing:.5px;padding:0 0 4px;font-weight:bold}
                .ps-pseudo-row{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:3px;font-size:12px;color:#c8c8c8;cursor:pointer;border:1px solid transparent;transition:border-color .15s}
                .ps-pseudo-row:hover{background:#1a1a1e;border-color:#3a3a3a}
                .ps-pseudo-row input[type=checkbox]{accent-color:#b8860b;width:13px;height:13px;cursor:pointer;flex-shrink:0}
                .ps-pseudo-icon{font-size:14px;flex-shrink:0}
                .ps-pseudo-label{flex:1;font-weight:bold;color:#daa520}
                .ps-pseudo-type{font-size:9px;padding:1px 5px;border-radius:2px;font-weight:bold;flex-shrink:0}
                .ps-pseudo-type-uplift{background:#2a2a10;color:#daa520}
                .ps-pseudo-type-broaden{background:#1a2a3a;color:#6ba3d6}

                /* ── Bundle button ── */
                .ps-bundle-btn{display:block;width:100%;padding:10px 0;background:linear-gradient(135deg,#6d28d9,#4c1d95);color:#c4b5fd;border:1px solid #7c3aed;border-radius:4px;font-family:inherit;font-size:13px;font-weight:bold;cursor:pointer;text-align:center;transition:background .15s;margin-top:4px}
                .ps-bundle-btn:hover{background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff}
                .ps-bundle-btn:active{transform:scale(.98)}
                .ps-bundle-btn:disabled{background:#333;border-color:#555;color:#777;cursor:not-allowed}
            `;
            document.head.appendChild(style);

            // ── Sidebar panel ──
            this.panel = document.createElement('div');
            this.panel.className = 'hg-panel hg-empty';
            this.panel.innerHTML = `
                <div class="hg-header">
                    <span class="hg-title">
                        🌿 Poetent
                        <span class="hg-badge hg-zero" data-hg-badge>0</span>
                    </span>
                    <span class="hg-header-btns">
                        <span class="hg-header-btn" data-hg-paste title="Paste Item Search">📋</span>
                        <span class="hg-header-btn" data-hg-gear title="Settings">⚙</span>
                        <span class="hg-toggle" data-hg-collapse title="Collapse">▾</span>
                    </span>
                </div>
                <div class="hg-body">
                    <div class="hg-empty-msg">Run a search to detect swappable stats.</div>
                </div>
                <div class="hg-settings" data-hg-settings></div>
                <div class="hg-status">Listening for searches…</div>
            `;
            document.body.appendChild(this.panel);

            this.content = this.panel.querySelector('.hg-body');
            this.badge   = this.panel.querySelector('[data-hg-badge]');

            // ── Compact bar ──
            this.bar = document.createElement('div');
            this.bar.className = 'hg-bar';
            this.bar.innerHTML = `
                <div class="hg-bar-header">
                    <span class="hg-bar-htitle">
                        🌿 Poetent
                        <span class="hg-badge hg-zero" data-hg-bar-badge>0</span>
                    </span>
                    <span class="hg-bar-hbtns">
                        <span class="hg-bar-hbtn" data-hg-bar-paste title="Paste Item Search">📋</span>
                        <span class="hg-bar-hbtn" data-hg-bar-gear title="Settings">⚙</span>
                    </span>
                </div>
                <div class="hg-bar-body" data-hg-bar-body>
                    <div class="hg-bar-empty">Run a search to detect swaps.</div>
                </div>
                <div class="hg-bar-flyout" data-hg-bar-flyout></div>
            `;
            document.body.appendChild(this.bar);

            this.barBody  = this.bar.querySelector('[data-hg-bar-body]');
            this.barBadge = this.bar.querySelector('[data-hg-bar-badge]');

            // ── Build settings panels ──
            this._buildSettingsPanel();
            this._buildBarSettingsPanel();

            // ── Sidebar events ──
            this.panel.querySelector('[data-hg-collapse]').addEventListener('click', (e) => {
                e.stopPropagation();
                this.minimized = !this.minimized;
                this.panel.classList.toggle('hg-min', this.minimized);
            });
            this.panel.querySelector('[data-hg-gear]').addEventListener('click', (e) => {
                e.stopPropagation();
                this.panel.classList.toggle('hg-show-settings');
            });
            this.panel.querySelector('[data-hg-paste]').addEventListener('click', (e) => {
                e.stopPropagation();
                PasteSearch.open();
            });

            // ── Compact bar events ──
            this.bar.querySelector('[data-hg-bar-gear]').addEventListener('click', (e) => {
                e.stopPropagation();
                this.bar.classList.toggle('hg-bar-settings-open');
            });
            this.bar.querySelector('[data-hg-bar-paste]').addEventListener('click', (e) => {
                e.stopPropagation();
                PasteSearch.open();
            });

            // ── Sidebar drag ──
            this._initDrag(
                this.panel,
                this.panel.querySelector('.hg-header'),
                '[data-hg-gear], [data-hg-collapse], [data-hg-paste]',
                (x, y) => { Settings.data.posX = x; Settings.data.posY = y; Settings.save(); }
            );

            // ── Compact bar drag ──
            this._initDrag(
                this.bar,
                this.bar.querySelector('.hg-bar-header'),
                '[data-hg-bar-gear], [data-hg-bar-paste]',
                (x, y) => { Settings.data.barPosX = x; Settings.data.barPosY = y; Settings.save(); }
            );

            // Restore positions
            if (Settings.data.posX && Settings.data.posY) {
                this.panel.style.right = 'auto';
                this.panel.style.left = Settings.data.posX;
                this.panel.style.top = Settings.data.posY;
            }
            if (Settings.data.barPosX && Settings.data.barPosY) {
                this.bar.style.right = 'auto';
                this.bar.style.left = Settings.data.barPosX;
                this.bar.style.top = Settings.data.barPosY;
            }

            this._applyUIMode();
        },

        _initDrag(element, handle, ignoreSelector, onDrop) {
            let dragging = false, dragX = 0, dragY = 0;
            handle.addEventListener('mousedown', (e) => {
                if (e.target.closest(ignoreSelector)) return;
                dragging = true;
                const rect = element.getBoundingClientRect();
                dragX = e.clientX - rect.left;
                dragY = e.clientY - rect.top;
                element.style.right = 'auto';
                element.style.left = rect.left + 'px';
                element.style.top = rect.top + 'px';
                e.preventDefault();
            });
            document.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                const newX = Math.max(0, Math.min(e.clientX - dragX, window.innerWidth - element.offsetWidth));
                const newY = Math.max(0, Math.min(e.clientY - dragY, window.innerHeight - 40));
                element.style.left = newX + 'px';
                element.style.top = newY + 'px';
            });
            document.addEventListener('mouseup', () => {
                if (!dragging) return;
                dragging = false;
                onDrop(element.style.left, element.style.top);
            });
        },

        _buildSettingsPanel() {
            const el = this.panel.querySelector('[data-hg-settings]');
            el.innerHTML = this._settingsHTML('sidebar');
            this._bindSettingsEvents(el);
        },

        _buildBarSettingsPanel() {
            const el = this.bar.querySelector('[data-hg-bar-flyout]');
            el.innerHTML = this._settingsHTML('bar');
            this._bindSettingsEvents(el);
        },

        _settingsHTML(prefix) {
            let groupToggles = '';
            HARVEST_SWAPS.forEach(swap => {
                const checked = Settings.isGroupEnabled(swap.id) ? 'checked' : '';
                groupToggles += `
                    <div class="hg-set-row" title="${esc(swap.description)} (${esc(swap.cost)})">
                        <input type="checkbox" id="hg-set-${prefix}-${swap.id}" data-hg-group-toggle="${swap.id}" ${checked}>
                        <label for="hg-set-${prefix}-${swap.id}">${swap.icon} ${esc(swap.label)}</label>
                    </div>`;
            });
            return `
                <div class="hg-set-top">
                    <span class="hg-set-heading">Settings</span>
                    <button class="hg-set-save" data-hg-save title="Save &amp; close">✓</button>
                </div>
                <div class="hg-set-section">Harvest Swap Groups</div>
                ${groupToggles}
                <div class="hg-set-section">Pseudo Stats (Paste Search)</div>
                <div class="hg-set-row" title="When multiple mods feed the same pseudo (e.g. two +Life sources), offer to collapse them into a single pseudo total filter.">
                    <input type="checkbox" id="hg-set-${prefix}-pseudo-uplift" data-hg-pseudo-uplift ${Settings.data.pseudoUplift ? 'checked' : ''}>
                    <label for="hg-set-${prefix}-pseudo-uplift">🔄 Pseudo uplift (2+ mods)</label>
                </div>
                <div class="hg-set-row" title="Offer pseudo alternatives even for single mods, broadening the search to match any source combination.">
                    <input type="checkbox" id="hg-set-${prefix}-pseudo-broaden" data-hg-pseudo-broaden ${Settings.data.pseudoBroaden ? 'checked' : ''}>
                    <label for="hg-set-${prefix}-pseudo-broaden">🔍 Pseudo broaden (single mods)</label>
                </div>
                <div class="hg-set-row" title="Offer a one-click defensive bundle search using a count group of pseudo stat thresholds.">
                    <input type="checkbox" id="hg-set-${prefix}-pseudo-bundles" data-hg-pseudo-bundles ${Settings.data.pseudoBundles ? 'checked' : ''}>
                    <label for="hg-set-${prefix}-pseudo-bundles">🎯 Defensive bundles</label>
                </div>
                <div class="hg-set-section">Behavior</div>
                <div class="hg-set-row" title="Automatically submit grouped search when swappable stats are detected.">
                    <input type="checkbox" id="hg-set-${prefix}-auto" data-hg-auto ${Settings.data.autoApply ? 'checked' : ''}>
                    <label for="hg-set-${prefix}-auto">Auto-apply on search</label>
                </div>
                <div class="hg-set-section">Display</div>
                <div class="hg-set-row" title="Show a minimal floating bar instead of the full sidebar.">
                    <input type="checkbox" id="hg-set-${prefix}-compact" data-hg-compact ${Settings.data.uiMode === 'compact' ? 'checked' : ''}>
                    <label for="hg-set-${prefix}-compact">Compact bar mode</label>
                </div>
                <div class="hg-set-section">Data</div>
                <div class="hg-set-cache">
                    <span class="hg-set-cache-info" data-hg-cache-info>…</span>
                    <button class="hg-set-cache-btn" data-hg-cache-clear>Clear cache</button>
                </div>`;
        },

        _bindSettingsEvents(container) {
            container.querySelector('[data-hg-save]').addEventListener('click', () => {
                container.querySelectorAll('[data-hg-group-toggle]').forEach(cb => {
                    Settings.data.enabledGroups[cb.dataset.hgGroupToggle] = cb.checked;
                });
                Settings.data.autoApply = container.querySelector('[data-hg-auto]').checked;
                Settings.data.uiMode = container.querySelector('[data-hg-compact]').checked ? 'compact' : 'sidebar';
                // Pseudo settings
                Settings.data.pseudoUplift  = container.querySelector('[data-hg-pseudo-uplift]').checked;
                Settings.data.pseudoBroaden = container.querySelector('[data-hg-pseudo-broaden]').checked;
                Settings.data.pseudoBundles = container.querySelector('[data-hg-pseudo-bundles]').checked;
                Settings.save();
                this.panel.classList.remove('hg-show-settings');
                this.bar.classList.remove('hg-bar-settings-open');
                this._syncSettingsPanels();
                this._applyUIMode();
                if (_lastPayload) this.analyze(_lastPayload, _lastLeague || detectLeague());
            });

            const cacheInfo = container.querySelector('[data-hg-cache-info]');
            try {
                const raw = GM_getValue(STATS_CACHE_KEY);
                if (raw) {
                    const obj = JSON.parse(raw);
                    cacheInfo.textContent = `Cache: ${((Date.now() - obj.ts) / 36e5).toFixed(1)}h old`;
                } else { cacheInfo.textContent = 'Cache: empty'; }
            } catch (e) { cacheInfo.textContent = 'Cache: error'; }

            container.querySelector('[data-hg-cache-clear]').addEventListener('click', () => {
                StatResolver.clearCache();
                GameTextMatcher.clearCache();
                document.querySelectorAll('[data-hg-cache-info]').forEach(el => { el.textContent = 'Cache: cleared!'; });
            });
        },

        _syncSettingsPanels() {
            [this.panel.querySelector('[data-hg-settings]'), this.bar.querySelector('[data-hg-bar-flyout]')].forEach(p => {
                p.querySelectorAll('[data-hg-group-toggle]').forEach(cb => { cb.checked = Settings.isGroupEnabled(cb.dataset.hgGroupToggle); });
                const a = p.querySelector('[data-hg-auto]'); if (a) a.checked = Settings.data.autoApply;
                const c = p.querySelector('[data-hg-compact]'); if (c) c.checked = Settings.data.uiMode === 'compact';
                const pu = p.querySelector('[data-hg-pseudo-uplift]');  if (pu) pu.checked = Settings.data.pseudoUplift;
                const pb = p.querySelector('[data-hg-pseudo-broaden]'); if (pb) pb.checked = Settings.data.pseudoBroaden;
                const pn = p.querySelector('[data-hg-pseudo-bundles]'); if (pn) pn.checked = Settings.data.pseudoBundles;
            });
        },

        _applyUIMode() {
            if (Settings.data.uiMode === 'compact') {
                this.panel.classList.add('hg-compact-mode');
                this.bar.classList.add('hg-bar-active');
            } else {
                this.panel.classList.remove('hg-compact-mode');
                this.bar.classList.remove('hg-bar-active');
                this.bar.classList.remove('hg-bar-settings-open');
            }
        },

        // ── Core analysis (harvest grouping + pseudo uplift) ──
        analyze(payload, league) {
            if (!StatResolver.loaded) return;
            this.suggestions = [];
            this.pseudoSuggestions = [];
            const claimed = new Set();
            const statGroups = payload?.query?.stats || [];
            const isUnique = !!payload?.query?.name;

            // ── Harvest swap detection — skip for unique items (can't harvest-craft uniques) ──
            if (!isUnique) {
                statGroups.forEach(sg => {
                    if (sg.type !== 'and') return;
                    (sg.filters || []).forEach(filter => {
                        if (filter.disabled || claimed.has(filter.id)) return;
                        const info = StatResolver.getSwapInfo(filter.id);
                        if (!info) return;
                        const andFiltersFlat = [];
                        statGroups.forEach(g => { if (g.type === 'and') (g.filters || []).forEach(f => andFiltersFlat.push(f)); });
                        const detected = [];
                        info.siblings.forEach(sib => {
                            const existing = andFiltersFlat.find(f => f.id === sib.id && !f.disabled);
                            if (existing) {
                                detected.push({ ...sib, min: existing.value?.min, max: existing.value?.max });
                                claimed.add(sib.id);
                            }
                        });
                        this.suggestions.push({
                            swap: info.swap,
                            templateKey: info.templateKey,
                            templateDisplay: info.templateKey.split('|')[1].replace('{{ELE}}', '⟨element⟩'),
                            detected, allSiblings: info.siblings,
                            suggestedMin: Math.max(...detected.map(d => d.min || 0)),
                            suggestedCount: 1,
                        });
                    });
                });

                const bestBySwap = new Map();
                this.suggestions.forEach(sug => {
                    const existing = bestBySwap.get(sug.swap.id);
                    if (!existing || sug.detected.length > existing.detected.length ||
                        (sug.detected.length === existing.detected.length && sug.templateDisplay.length < existing.templateDisplay.length)) {
                        bestBySwap.set(sug.swap.id, sug);
                    }
                });
                this.suggestions = Array.from(bestBySwap.values()).filter(s => Settings.isGroupEnabled(s.swap.id));
            }

            // ── Pseudo uplift detection (works for all item rarities including uniques) ──
            if (Settings.data.pseudoUplift || Settings.data.pseudoBroaden) {
                this._detectPseudos(statGroups);
            }

            this._render(league);
            this._renderBar(league);
            if (Settings.data.autoApply && this.suggestions.length > 0) this._applyAll(league);
        },

        // Scan payload filters for stats that feed the same pseudo category
        _detectPseudos(statGroups) {
            this.pseudoSuggestions = [];

            // Collect all active filters from "and" groups
            const activeFilters = [];
            statGroups.forEach(sg => {
                if (sg.type !== 'and') return;
                (sg.filters || []).forEach(f => {
                    if (!f.disabled && f.id) activeFilters.push(f);
                });
            });

            if (!activeFilters.length) return;

            for (const rule of PSEUDO_RULES) {
                const pseudoId = PseudoMapper.resolvedIds.get(rule.id);
                if (!pseudoId) continue;

                const contributors = [];
                let total = 0;

                activeFilters.forEach(filter => {
                    const meta = StatResolver.idToMeta.get(filter.id);
                    if (!meta) return;

                    // Skip filters that are already pseudo stats (prevents feedback loop
                    // where an applied pseudo filter gets re-detected as swappable)
                    if (meta.type === 'pseudo') return;

                    // Check: does this stat contribute to this pseudo?
                    if (!rule.match(meta.text)) return;
                    if (rule.exclude && rule.exclude(meta.text)) return;

                    const rawVal = filter.value?.min;
                    if (rawVal === undefined) return;

                    const adjusted = rule.adjust ? rule.adjust(rawVal, meta.text) : rawVal;
                    contributors.push({
                        filterId: filter.id,
                        filterText: meta.text,
                        value: rawVal,
                        adjusted,
                    });
                    total += adjusted;
                });

                if (contributors.length === 0) continue;

                const isUplift = contributors.length >= 2;
                const isBroaden = contributors.length === 1;

                // Filter by settings
                if (isUplift && !Settings.data.pseudoUplift) continue;
                if (isBroaden && !Settings.data.pseudoBroaden) continue;

                this.pseudoSuggestions.push({
                    rule,
                    pseudoId,
                    contributors,
                    total: Math.floor(total),
                    isUplift,
                    isBroaden,
                });
            }
        },

        _render(league) {
            const harvestCount = this.suggestions.length;
            const pseudoCount = this.pseudoSuggestions.length;
            const totalCount = harvestCount + pseudoCount;
            this.badge.textContent = totalCount;
            this.badge.classList.toggle('hg-zero', totalCount === 0);
            this.panel.classList.toggle('hg-empty', totalCount === 0);

            if (totalCount === 0) {
                this.content.innerHTML = '<div class="hg-empty-msg">No swappable or pseudo-upliftable stats detected.</div>';
                this.panel.querySelector('.hg-status').textContent = 'Listening for searches…';
                return;
            }

            const parts = [];
            if (harvestCount) parts.push(`${harvestCount} swap`);
            if (pseudoCount) parts.push(`${pseudoCount} pseudo`);
            this.panel.querySelector('.hg-status').innerHTML = totalCount > 1
                ? `${parts.join(' · ')} · <a href="#" data-hg-apply-all>Apply all</a>`
                : `${parts.join(' · ')} available`;

            let html = '';

            // ── Harvest suggestions ──
            this.suggestions.forEach((sug, idx) => {
                const detHtml = sug.detected.map(d =>
                    `<span class="hg-chip hg-chip-orig" style="border-color:${d.element.color};color:${d.element.color}">${esc(d.element.short)} ≥${d.min ?? '?'}</span>`
                ).join(' ');
                const grpHtml = sug.allSiblings.map(sib => {
                    const isDet = sug.detected.some(d => d.id === sib.id);
                    return `<span class="hg-chip${isDet ? ' hg-chip-orig' : ''}" style="border-color:${sib.element.color};color:${sib.element.color}">${esc(sib.element.short)} ≥${sug.suggestedMin || '?'}</span>`;
                }).join('');
                html += `
                    <div class="hg-sug" data-sug-idx="${idx}">
                        <div class="hg-sug-head"><span class="hg-sug-icon">${sug.swap.icon}</span>${esc(sug.swap.label)}<span class="hg-sug-cost">${esc(sug.swap.cost)}</span></div>
                        <div class="hg-sug-flow">${detHtml}<span class="hg-sug-arrow">→</span>${grpHtml}</div>
                        <button class="hg-apply" data-hg-apply="${idx}">🌿 Apply (count ≥${sug.suggestedCount})</button>
                    </div>`;
            });

            // ── Pseudo suggestions ──
            this.pseudoSuggestions.forEach((psug, idx) => {
                const contribHtml = psug.contributors.map(c => {
                    // Trim stat text for display: replace # with the value
                    const short = c.filterText.replace(/#/g, String(c.value)).substring(0, 50);
                    return `<span class="hg-chip" style="border-color:#daa520;color:#c8c8c8">${esc(short)}</span>`;
                }).join(' ');
                const typeLabel = psug.isUplift ? 'uplift' : 'broaden';
                const desc = psug.isUplift
                    ? `Replaces ${psug.contributors.length} filters`
                    : 'Broader search';
                html += `
                    <div class="hg-sug hg-sug-pseudo" data-psug-idx="${idx}">
                        <div class="hg-sug-head"><span class="hg-sug-icon">${psug.rule.icon}</span>${esc(psug.rule.label)}<span class="hg-sug-cost ps-pseudo-type-${typeLabel}" style="font-size:10px">${desc}</span></div>
                        <div class="hg-sug-flow">${contribHtml}<span class="hg-sug-arrow">→</span><span class="hg-chip" style="border-color:#daa520;color:#daa520;font-weight:bold">${esc(psug.rule.label)} ≥${psug.total}</span></div>
                        <button class="hg-apply hg-apply-pseudo" data-hg-apply-pseudo="${idx}">🔄 Apply Pseudo</button>
                    </div>`;
            });

            this.content.innerHTML = html;

            // ── Bind harvest apply buttons ──
            this.content.querySelectorAll('[data-hg-apply]').forEach(btn => {
                btn.addEventListener('click', e => this._applyGroup(parseInt(e.currentTarget.dataset.hgApply), league));
            });
            // ── Bind pseudo apply buttons ──
            this.content.querySelectorAll('[data-hg-apply-pseudo]').forEach(btn => {
                btn.addEventListener('click', e => this._applyPseudo(parseInt(e.currentTarget.dataset.hgApplyPseudo), league));
            });
            const applyAll = this.panel.querySelector('[data-hg-apply-all]');
            if (applyAll) applyAll.addEventListener('click', e => { e.preventDefault(); this._applyAll(league); });
        },

        _renderBar(league) {
            if (!this.barBody) return;
            const harvestCount = this.suggestions.length;
            const pseudoCount = this.pseudoSuggestions.length;
            const totalCount = harvestCount + pseudoCount;
            this.barBadge.textContent = totalCount;
            this.barBadge.classList.toggle('hg-zero', totalCount === 0);
            if (totalCount === 0) { this.barBody.innerHTML = '<div class="hg-bar-empty">No suggestions.</div>'; return; }

            let html = '';
            // Harvest rows
            this.suggestions.forEach((sug, idx) => {
                const detNames = sug.detected.map(d => `<span style="color:${d.element.color}">${esc(d.element.short)}</span>`).join(', ');
                html += `<div class="hg-bar-row"><span class="hg-bar-icon">${sug.swap.icon}</span><span class="hg-bar-label">${detNames}</span><span class="hg-bar-det">→ ${sug.allSiblings.length} var</span><button class="hg-bar-go" data-hg-bar-apply="${idx}">▶ Group</button></div>`;
            });
            // Pseudo rows
            this.pseudoSuggestions.forEach((psug, idx) => {
                const desc = psug.isUplift ? `${psug.contributors.length}→1` : 'broad';
                html += `<div class="hg-bar-row"><span class="hg-bar-icon">${psug.rule.icon}</span><span class="hg-bar-label" style="color:#daa520">${esc(psug.rule.label)}</span><span class="hg-bar-det">≥${psug.total} (${desc})</span><button class="hg-bar-go" data-hg-bar-pseudo="${idx}">▶ Pseudo</button></div>`;
            });
            if (totalCount > 1) html += '<div class="hg-bar-footer"><button class="hg-bar-go" data-hg-bar-all>▶ Apply All</button></div>';
            this.barBody.innerHTML = html;

            this.barBody.querySelectorAll('[data-hg-bar-apply]').forEach(btn => {
                btn.addEventListener('click', e => this._applyGroup(parseInt(e.currentTarget.dataset.hgBarApply), league));
            });
            this.barBody.querySelectorAll('[data-hg-bar-pseudo]').forEach(btn => {
                btn.addEventListener('click', e => this._applyPseudo(parseInt(e.currentTarget.dataset.hgBarPseudo), league));
            });
            const barAll = this.barBody.querySelector('[data-hg-bar-all]');
            if (barAll) barAll.addEventListener('click', () => this._applyAll(league));
        },

        _buildGroupedPayload(harvestSugs, pseudoSugs) {
            const payload = JSON.parse(JSON.stringify(_lastPayload));

            // ── Harvest: disable originals, add count groups ──
            const harvestIdsToDisable = new Set();
            (harvestSugs || []).forEach(sug => sug.detected.forEach(d => harvestIdsToDisable.add(d.id)));

            // ── Pseudo: disable contributor filters, add pseudo filters ──
            const pseudoIdsToDisable = new Set();
            const pseudoFiltersToAdd = [];
            (pseudoSugs || []).forEach(psug => {
                psug.contributors.forEach(c => pseudoIdsToDisable.add(c.filterId));
                pseudoFiltersToAdd.push({
                    id: psug.pseudoId,
                    disabled: false,
                    value: { min: psug.total },
                });
            });

            // Disable all originals in one pass
            const allDisable = new Set([...harvestIdsToDisable, ...pseudoIdsToDisable]);
            (payload.query.stats || []).forEach(sg => {
                (sg.filters || []).forEach(f => {
                    if (allDisable.has(f.id)) f.disabled = true;
                });
            });

            // Add harvest count groups
            (harvestSugs || []).forEach(sug => {
                payload.query.stats.push({
                    type: 'count', value: { min: sug.suggestedCount }, disabled: false,
                    filters: sug.allSiblings.map(sib => ({ id: sib.id, disabled: false, value: sug.suggestedMin ? { min: sug.suggestedMin } : undefined })),
                });
            });

            // Add pseudo filters in a new AND group (keeps them separate from the user's original filters)
            if (pseudoFiltersToAdd.length > 0) {
                payload.query.stats.push({
                    type: 'and',
                    disabled: false,
                    filters: pseudoFiltersToAdd,
                });
            }

            return payload;
        },

        async _applyGroup(sugIdx, league) {
            const sug = this.suggestions[sugIdx];
            if (!sug || !_lastPayload) return;
            const sideBtn = this.content.querySelector(`[data-hg-apply="${sugIdx}"]`);
            const barBtn  = this.barBody.querySelector(`[data-hg-bar-apply="${sugIdx}"]`);
            if (sideBtn) { sideBtn.disabled = true; sideBtn.textContent = 'Searching…'; }
            if (barBtn)  { barBtn.disabled = true; barBtn.textContent = '…'; }
            await this._submitSearch(this._buildGroupedPayload([sug], []), league || detectLeague(), sideBtn || barBtn);
        },

        async _applyPseudo(psugIdx, league) {
            const psug = this.pseudoSuggestions[psugIdx];
            if (!psug || !_lastPayload) return;
            const sideBtn = this.content.querySelector(`[data-hg-apply-pseudo="${psugIdx}"]`);
            const barBtn  = this.barBody.querySelector(`[data-hg-bar-pseudo="${psugIdx}"]`);
            if (sideBtn) { sideBtn.disabled = true; sideBtn.textContent = 'Searching…'; }
            if (barBtn)  { barBtn.disabled = true; barBtn.textContent = '…'; }
            await this._submitSearch(this._buildGroupedPayload([], [psug]), league || detectLeague(), sideBtn || barBtn);
        },

        async _applyAll(league) {
            if ((!this.suggestions.length && !this.pseudoSuggestions.length) || !_lastPayload) return;
            this.content.querySelectorAll('.hg-apply, .hg-apply-pseudo').forEach(b => { b.disabled = true; b.textContent = 'Searching…'; });
            this.barBody.querySelectorAll('.hg-bar-go').forEach(b => { b.disabled = true; });
            await this._submitSearch(
                this._buildGroupedPayload(this.suggestions, this.pseudoSuggestions),
                league || detectLeague(),
                this.content.querySelector('.hg-apply, .hg-apply-pseudo') || this.barBody.querySelector('.hg-bar-go')
            );
        },

        async _submitSearch(payload, league, btn) {
            if (!league) { if (btn) { btn.disabled = false; btn.textContent = '❌ No league'; } return; }
            _isGroupedSubmit = true;
            try {
                const resp = await fetch(`https://www.pathofexile.com/api/trade/search/${league}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
                });
                if (resp.status === 429) { const r = resp.headers.get('Retry-After') || '60'; if (btn) { btn.disabled = false; btn.textContent = `⏳ ${r}s`; } return; }
                if (!resp.ok) { let msg = `HTTP ${resp.status}`; try { const e = await resp.json(); msg = e.error?.message || msg; } catch (_) {} if (btn) { btn.disabled = false; btn.textContent = `❌ ${msg}`; } return; }
                const data = await resp.json();
                if (data.id) { window.location.href = `https://www.pathofexile.com/trade/search/${league}/${data.id}`; }
                else { if (btn) { btn.disabled = false; btn.textContent = '❌ No ID'; } }
            } catch (e) { if (btn) { btn.disabled = false; btn.textContent = '❌ Net err'; } }
            finally { _isGroupedSubmit = false; }
        },
    };

    // =========================================================================
    // HELPERS
    // =========================================================================
    const _escMap = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
    const esc = (s) => String(s||'').replace(/[&<>"']/g, c => _escMap[c]);

    // =========================================================================
    // BOOT
    // =========================================================================
    installInterceptor();

    function boot() {
        if (!window.location.pathname.startsWith('/trade')) return;

        Settings.init();
        Sidebar.init();

        StatResolver.init().then(() => {
            if (_lastPayload) Sidebar.analyze(_lastPayload, _lastLeague);
            if (!_lastPayload) Sidebar.panel.querySelector('.hg-status').textContent = 'Click Search to detect stats.';
        });

        // Fetch NDJSON for paste-to-search (parallel with trade API)
        GameTextMatcher.init();

        let lastUrl = window.location.href;
        new MutationObserver(() => {
            if (window.location.href !== lastUrl) {
                lastUrl = window.location.href;
                setTimeout(() => {
                    if (_lastPayload) Sidebar.analyze(_lastPayload, _lastLeague || detectLeague());
                }, 1500);
            }
        }).observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

})();
