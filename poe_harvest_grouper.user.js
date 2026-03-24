// ==UserScript==
// @name         PoE Trade Harvest Grouper
// @namespace    https://github.com/ShaneIsley/poetent
// @version      0.3.4
// @description  Detect harvest-swappable stats on pathofexile.com/trade and offer count-group replacements. Supports ele res + ele damage swaps.
// @author       ShaneIsley
// @match        https://www.pathofexile.com/trade/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=pathofexile.com
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================================
    // HARVEST SWAP DEFINITIONS — substitution-based
    // =========================================================================
    // Each swap rule defines a set of element keywords that Harvest can convert
    // between at the same tier.  Instead of listing every possible stat template,
    // we detect the element keyword inside any stat's text and generate parallel
    // variants via string substitution.
    //
    // This automatically covers ALL mod templates for that element:
    //   "+#% to Fire Resistance"  →  "+#% to Cold Resistance" / "+#% to Lightning Resistance"
    //   "Adds # to # Fire Damage to Attacks"  →  "Adds # to # Cold Damage to Attacks"
    //   "#% increased Fire Damage"  →  "#% increased Cold Damage"
    //   etc.
    //
    // From poedb.tw/us/Horticrafting — the two "Change a modifier" swap groups:
    //   1. Ele Resistance: Fire/Cold/Lightning Resistance (500 Lifeforce)
    //   2. Ele Damage: Fire/Cold/Lightning Damage (500 Lifeforce + 1 Crystallised Rancour)
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
            // Prevents false positives from combined-element or generic stats
            excludeIf: [
                'Elemental Damage',
                'and Fire Damage',
                'and Cold Damage',
                'and Lightning Damage',
            ],
        },
    ];

    // =========================================================================
    // SETTINGS — persisted via GM_setValue
    // =========================================================================
    const SETTINGS_KEY = 'poe_harvest_grouper_settings';

    const Settings = {
        defaults: {
            autoApply: false,           // Auto-apply all groups when a search is intercepted
            uiMode: 'sidebar',          // 'sidebar' | 'compact'
            enabledGroups: {},          // { ele_res: true, ele_dmg: true } — populated from HARVEST_SWAPS
            posX: null,                 // Saved panel position (left)
            posY: null,                 // Saved panel position (top)
            debug: false,               // Verbose logging to F12 console
        },
        data: {},

        init() {
            // Build default enabledGroups from swap definitions
            HARVEST_SWAPS.forEach(s => { this.defaults.enabledGroups[s.id] = true; });
            try {
                const raw = GM_getValue(SETTINGS_KEY);
                const saved = raw ? JSON.parse(raw) : {};
                this.data = { ...this.defaults, ...saved };
                // Merge enabledGroups so new swap groups get default true
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
    // LOGGER — all diagnostic output gated behind Settings.data.debug
    // =========================================================================
    const Logger = {
        log:      (m, ...a) => { if (Settings.data.debug) console.log(`%c[HarvestGrouper] ${m}`, 'color:#a0aec0', ...a); },
        info:     (m, ...a) => { if (Settings.data.debug) console.log(`%c[HarvestGrouper] ℹ️ ${m}`, 'color:#7fcc5a', ...a); },
        warn:     (m, ...a) => { if (Settings.data.debug) console.warn(`[HarvestGrouper] ${m}`, ...a); },
        error:    (m, ...a) => { console.error(`[HarvestGrouper] ${m}`, ...a); }, // errors always visible
        group:    (m)       => { if (Settings.data.debug) console.group(`%c[HarvestGrouper] ${m}`, 'color:#7fcc5a;font-weight:bold'); },
        groupEnd: ()        => { if (Settings.data.debug) console.groupEnd(); },
    };

    // =========================================================================
    // STAT RESOLVER — fetches trade stat database, maps text ↔ ID,
    // and builds swap-group lookups via keyword substitution
    // =========================================================================
    const STATS_CACHE_KEY   = 'poe_harvest_grouper_stats_v2';
    const STATS_CACHE_HOURS = 24;

    const StatResolver = {
        idToMeta: new Map(),          // id → { text, type }
        textToId: new Map(),          // "type|text" → id
        idToSwap: new Map(),          // id → { swap, elementIndex, templateKey }
        templateGroups: new Map(),    // "swap.id|templateKey" → [{ id, elementIndex, element, text, type }]
        loaded: false,

        async init() {
            if (this.loaded) return;

            const cached = this._loadCache();
            if (cached) {
                this._index(cached);
                this.loaded = true;
                Logger.info('Stats loaded from cache');
                return;
            }

            try {
                const resp = await fetch('https://www.pathofexile.com/api/trade/data/stats');
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                this._saveCache(data);
                this._index(data);
                this.loaded = true;
                Logger.info(`Stats fetched: ${this.idToMeta.size} entries`);
            } catch (e) {
                Logger.error('Failed to fetch stats', e);
            }
        },

        _index(data) {
            // Step 1: Build text↔ID maps
            (data.result || []).forEach(group => {
                (group.entries || []).forEach(entry => {
                    const key = `${entry.type}|${entry.text}`;
                    this.textToId.set(key, entry.id);
                    this.idToMeta.set(entry.id, { text: entry.text, type: entry.type });
                });
            });

            // Step 2: For every stat, check if its text contains a swap keyword.
            //         Compute a "template key" (text with keyword → {{ELE}}) and
            //         index it for group lookups.
            this.idToMeta.forEach((meta, statId) => {
                for (const swap of HARVEST_SWAPS) {
                    if (swap.excludeIf && swap.excludeIf.some(ex => meta.text.includes(ex))) continue;

                    for (let ei = 0; ei < swap.elements.length; ei++) {
                        const kw = swap.elements[ei].keyword;
                        if (meta.text.includes(kw)) {
                            const templateKey = `${meta.type}|${meta.text.replace(kw, '{{ELE}}')}`;

                            this.idToSwap.set(statId, { swap, elementIndex: ei, templateKey });

                            const groupKey = `${swap.id}|${templateKey}`;
                            if (!this.templateGroups.has(groupKey)) {
                                this.templateGroups.set(groupKey, []);
                            }
                            this.templateGroups.get(groupKey).push({
                                id: statId,
                                elementIndex: ei,
                                element: swap.elements[ei],
                                text: meta.text,
                                type: meta.type,
                            });
                            break; // matched this swap rule, next stat
                        }
                    }
                }
            });

            Logger.info(`Indexed ${this.idToSwap.size} swappable stats across ${this.templateGroups.size} template groups`);
        },

        // Given a stat ID, return the full swap group info
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
    };

    // =========================================================================
    // QUERY INTERCEPTOR — hooks both fetch() and XMLHttpRequest on the PAGE's
    // real window (unsafeWindow) so the hook survives the GM sandbox.
    // The PoE trade site may use either mechanism depending on version.
    // =========================================================================
    let _lastPayload  = null;
    let _lastLeague   = null;
    let _lastSearchId = null;

    const SEARCH_URL_RE = /\/api\/trade\/search\/([^/]+)$/;

    function installInterceptor() {
        const uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

        // ── Hook fetch() ──
        if (uw.fetch) {
            const origFetch = uw.fetch;
            uw.fetch = function (...args) {
                const promise = origFetch.apply(this, args);

                try {
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
                                // Capture local refs — _lastPayload may be nulled by
                                // MutationObserver before the promise resolves
                                const capturedPayload = _lastPayload;
                                const capturedLeague = _lastLeague;
                                Logger.group('Captured search payload via fetch → ' + _lastLeague);
                                Logger.log('Full payload:', JSON.stringify(_lastPayload, null, 2));
                                Logger.log('Stat groups:', (_lastPayload.query?.stats || []).map((sg, i) =>
                                    `[${i}] type="${sg.type}" min=${sg.min} max=${sg.max} value=${JSON.stringify(sg.value)} filters=${sg.filters?.length || 0}`
                                ));
                                (_lastPayload.query?.stats || []).forEach((sg, i) => {
                                    if (sg.type !== 'and') {
                                        Logger.log(`  Stat group [${i}] type="${sg.type}" — full object:`, JSON.stringify(sg, null, 2));
                                    }
                                });
                                Logger.groupEnd();

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

        // ── Hook XMLHttpRequest (fallback — some trade site versions use XHR) ──
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
                    const m = (this._hg_url || '').match(SEARCH_URL_RE);
                    if (m && (this._hg_method || '').toUpperCase() === 'POST' && typeof body === 'string') {
                        const parsed = JSON.parse(body);
                        _lastPayload = parsed;
                        _lastLeague  = m[1];
                        // Capture local refs — _lastPayload may be nulled by
                        // MutationObserver before the load event fires
                        const capturedPayload = parsed;
                        const capturedLeague = m[1];
                        Logger.group('Captured search payload via XHR → ' + _lastLeague);
                        Logger.log('Full payload:', JSON.stringify(_lastPayload, null, 2));
                        Logger.log('Stat groups:', (_lastPayload.query?.stats || []).map((sg, i) =>
                            `[${i}] type="${sg.type}" min=${sg.min} max=${sg.max} value=${JSON.stringify(sg.value)} filters=${sg.filters?.length || 0}`
                        ));
                        (_lastPayload.query?.stats || []).forEach((sg, i) => {
                            if (sg.type !== 'and') {
                                Logger.log(`  Stat group [${i}] type="${sg.type}" — full object:`, JSON.stringify(sg, null, 2));
                            }
                        });
                        Logger.groupEnd();

                        this.addEventListener('load', () => {
                            try {
                                const data = JSON.parse(this.responseText);
                                if (data.id) {
                                    _lastSearchId = data.id;
                                    // Restore globals in case observer cleared them
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
    // CLIPBOARD ITEM PARSER — parses PoE Ctrl+C item text into trade payload
    // =========================================================================
    const ClipboardParser = {
        parse(text) {
            const sections = text.split(/^--------$/m).map(s => s.trim()).filter(s => s);
            if (sections.length < 2) return null;

            // ── Header: Item Class, Rarity, Name, Base Type ──
            const header = sections[0].split('\n').map(l => l.trim());
            const rarityLine = header.find(l => l.startsWith('Rarity:'));
            if (!rarityLine) return null;

            const rarity = rarityLine.split(':').slice(1).join(':').trim();
            const itemClassLine = header.find(l => l.startsWith('Item Class:'));
            const itemClass = itemClassLine ? itemClassLine.split(':').slice(1).join(':').trim() : '';

            const ri = header.indexOf(rarityLine);
            let name = header[ri + 1] || '';
            let baseType = header[ri + 2] || name;

            // Normal/Magic: name line IS the base type (no separate name)
            if (rarity === 'Normal' || rarity === 'Magic') {
                baseType = name;
                name = '';
            }

            // ── Parse mods from remaining sections ──
            const mods = [];
            let modLineCount = 0;

            for (let i = 1; i < sections.length; i++) {
                const lines = sections[i].split('\n').map(l => l.trim()).filter(l => l);
                const first = lines[0] || '';

                // Skip property/requirement/meta sections
                if (first.startsWith('Quality') ||
                    first.startsWith('Requirements') ||
                    first.startsWith('Item Level') ||
                    first.startsWith('Sockets') ||
                    first === 'Corrupted' ||
                    first === 'Mirrored' ||
                    first === 'Unidentified') continue;

                for (const line of lines) {
                    if (/^(Item Class|Rarity|Quality|Requirements|Level|Str|Dex|Int|Item Level|Sockets|Corrupted|Mirrored|Unidentified|Split)[:\s]/i.test(line)) continue;
                    if (line === 'Corrupted' || line === 'Mirrored') continue;

                    // Detect source annotation
                    const isImplicit  = /\(implicit\)\s*$/i.test(line);
                    const isCrafted   = /\(crafted\)\s*$/i.test(line);
                    const isEnchant   = /\(enchant\)\s*$/i.test(line);

                    const source = isImplicit ? 'implicit'
                                 : isCrafted  ? 'crafted'
                                 : isEnchant  ? 'enchant'
                                 : 'explicit';

                    // Strip annotation
                    const clean = line.replace(/\s*\((implicit|crafted|enchant|fractured|scourge)\)\s*$/gi, '').trim();
                    if (!clean) continue;

                    modLineCount++;
                    const matched = this._matchMod(clean, source);
                    if (matched) mods.push(matched);
                }
            }

            return { name, baseType, rarity, itemClass, mods, modLineCount };
        },

        _matchMod(line, source) {
            if (!StatResolver.loaded) return null;

            // Namespace fallback order
            const types = source === 'implicit' ? ['implicit', 'explicit']
                        : source === 'crafted'  ? ['crafted', 'explicit']
                        : source === 'enchant'  ? ['enchant', 'implicit']
                        : ['explicit', 'crafted'];

            const hasDigits = /\d/.test(line);

            if (!hasDigits) {
                // Boolean stat — look up text as-is, no value
                // e.g. "Implicit Modifiers Cannot Be Changed", "Suffixes Cannot Be Changed"
                for (const type of types) {
                    const id = StatResolver.textToId.get(`${type}|${line}`);
                    if (id) return { id, value: undefined, source, text: line };
                }
                return null;
            }

            // Build template: replace digit sequences with #
            // "+159 to maximum Life"  →  "+# to maximum Life"
            // "Adds 20 to 31 Cold Damage"  →  "Adds # to # Cold Damage"
            const template = line.replace(/\d+(\.\d+)?/g, '#');

            // Also build a sign-flipped variant for negative values:
            // "-# Suffix Modifier allowed"  →  "+# Suffix Modifier allowed"
            // because the trade API template uses +# for stats that can be negative
            const templates = [template];
            if (template.startsWith('-#')) {
                templates.push('+#' + template.slice(2));
            }

            // Extract numeric values (preserving sign context)
            const nums = [];
            const signedRe = /(-?\d+(\.\d+)?)/g;
            let sm;
            while ((sm = signedRe.exec(line)) !== null) {
                nums.push(Number(sm[1]));
            }

            for (const type of types) {
                for (const tmpl of templates) {
                    const id = StatResolver.textToId.get(`${type}|${tmpl}`);
                    if (id) {
                        return {
                            id,
                            value: nums.length > 0 ? nums[0] : undefined,
                            source,
                            text: line,
                        };
                    }
                }
            }
            return null;
        },

        buildPayload(item) {
            const filters = item.mods
                .filter(m => m.id)
                .map(m => {
                    const f = { id: m.id, disabled: false };
                    if (m.value !== undefined) {
                        // Negative values (e.g. "-1 Suffix Modifier allowed") use max
                        f.value = m.value < 0 ? { max: m.value } : { min: m.value };
                    }
                    return f;
                });

            const payload = {
                query: {
                    status: { option: 'securable' },
                    type: item.baseType,
                    stats: [{ type: 'and', disabled: false, filters }],
                    filters: {
                        trade_filters: { disabled: false, filters: { sale_type: { option: 'priced' } } },
                    },
                },
                sort: { price: 'asc' },
            };

            if (item.rarity === 'Unique' && item.name) {
                payload.query.name = item.name;
            }

            return payload;
        },
    };

    // =========================================================================
    // SIDEBAR UI
    // =========================================================================
    const Sidebar = {
        panel: null,
        content: null,
        badge: null,
        suggestions: [],
        minimized: false,

        init() {
            if (this.panel) return;

            const style = document.createElement('style');
            style.textContent = `
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
                .hg-chips{display:flex;flex-wrap:wrap;gap:4px}
                .hg-chip{font-size:11px;padding:2px 8px;border-radius:3px;border:1px solid;font-weight:bold}
                .hg-chip-orig{outline:2px solid rgba(255,255,255,.15);outline-offset:1px}
                .hg-apply{display:block;width:100%;padding:7px 0;background:linear-gradient(135deg,#2e7d32,#1b5e20);color:#c8e6c9;border:1px solid #4caf50;border-radius:4px;font-family:inherit;font-size:12px;font-weight:bold;cursor:pointer;text-align:center;transition:background .15s}
                .hg-apply:hover{background:linear-gradient(135deg,#388e3c,#2e7d32);color:#fff}
                .hg-apply:active{transform:scale(.98)}
                .hg-apply:disabled{background:#333;border-color:#555;color:#777;cursor:not-allowed}
                .hg-status{font-size:11px;padding:6px 12px;border-top:1px solid #2a2a2e;color:#666;background:#0e0e10;text-align:center}
                .hg-status a{color:#7fcc5a;text-decoration:none}
                .hg-status a:hover{text-decoration:underline}

                /* ── Settings panel ── */
                .hg-settings{padding:8px 12px;display:none;flex-direction:column;gap:0}
                .hg-panel.hg-show-settings .hg-body{display:none}
                .hg-panel.hg-show-settings .hg-status{display:none}
                .hg-panel.hg-show-settings .hg-settings{display:flex}
                .hg-set-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
                .hg-set-heading{font-size:13px;font-weight:bold;color:#ccc}
                .hg-set-save{width:28px;height:28px;background:#2e7d32;color:#c8e6c9;border:1px solid #4caf50;border-radius:4px;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1}
                .hg-set-save:hover{background:#388e3c;color:#fff}
                .hg-set-section{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;padding:6px 0 2px}
                .hg-set-row{display:flex;align-items:center;gap:8px;font-size:13px;padding:3px 0}
                .hg-set-row input[type=checkbox]{accent-color:#7fcc5a;width:14px;height:14px;cursor:pointer;flex-shrink:0}
                .hg-set-row label{cursor:pointer;flex:1;color:#c8c8c8}

                /* ── Compact bar ── */
                .hg-bar{position:fixed;right:12px;top:120px;z-index:100000;font-family:'FontinSmallCaps',Verdana,Arial,sans-serif;font-size:12px;display:none;flex-direction:column;gap:4px;align-items:flex-end}
                .hg-bar.hg-bar-active{display:flex}
                .hg-bar-row{display:flex;align-items:center;gap:6px;background:#0c0c0e;border:1px solid #3a3a3a;border-radius:4px;padding:4px 10px;box-shadow:0 2px 12px rgba(0,0,0,.6);white-space:nowrap}
                .hg-bar-icon{font-size:13px}
                .hg-bar-label{color:#c8c8c8;font-weight:bold}
                .hg-bar-det{color:#888;font-size:11px}
                .hg-bar-go{background:#2e7d32;color:#c8e6c9;border:1px solid #4caf50;border-radius:3px;padding:2px 8px;font-family:inherit;font-size:11px;font-weight:bold;cursor:pointer}
                .hg-bar-go:hover{background:#388e3c;color:#fff}
                .hg-bar-go:disabled{background:#333;border-color:#555;color:#777;cursor:not-allowed}
                .hg-bar-gear{cursor:pointer;color:#888;font-size:12px}
                .hg-bar-gear:hover{color:#ccc}
            `;
            document.head.appendChild(style);

            // ── Sidebar panel ──
            this.panel = document.createElement('div');
            this.panel.className = 'hg-panel hg-empty';
            this.panel.innerHTML = `
                <div class="hg-header">
                    <span class="hg-title">
                        🌿 Harvest Grouper
                        <span class="hg-badge hg-zero" data-hg-badge>0</span>
                    </span>
                    <span class="hg-header-btns">
                        <span class="hg-header-btn" data-hg-paste title="Paste item from clipboard (Ctrl+C in game)">📋</span>
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
            document.body.appendChild(this.bar);

            // ── Settings panel content ──
            this._buildSettingsPanel();

            // ── Event bindings ──
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
                this._handleClipboardPaste();
            });

            // ── Drag to move (with position persistence) ──
            const header = this.panel.querySelector('.hg-header');
            let dragging = false, dragX = 0, dragY = 0;

            header.addEventListener('mousedown', (e) => {
                // Don't drag when clicking buttons
                if (e.target.closest('[data-hg-gear], [data-hg-collapse], [data-hg-paste]')) return;
                dragging = true;
                const rect = this.panel.getBoundingClientRect();
                dragX = e.clientX - rect.left;
                dragY = e.clientY - rect.top;
                // Switch from right-anchored to left-anchored positioning
                this.panel.style.right = 'auto';
                this.panel.style.left = rect.left + 'px';
                this.panel.style.top = rect.top + 'px';
                e.preventDefault();
            });

            document.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                const newX = Math.max(0, Math.min(e.clientX - dragX, window.innerWidth - this.panel.offsetWidth));
                const newY = Math.max(0, Math.min(e.clientY - dragY, window.innerHeight - 40));
                this.panel.style.left = newX + 'px';
                this.panel.style.top = newY + 'px';
            });

            document.addEventListener('mouseup', () => {
                if (!dragging) return;
                dragging = false;
                Settings.data.posX = this.panel.style.left;
                Settings.data.posY = this.panel.style.top;
                Settings.save();
            });

            // Restore saved position (clamped to current viewport)
            if (Settings.data.posX && Settings.data.posY) {
                const x = parseFloat(Settings.data.posX) || 0;
                const y = parseFloat(Settings.data.posY) || 0;
                const clampedX = Math.max(0, Math.min(x, window.innerWidth - 60));
                const clampedY = Math.max(0, Math.min(y, window.innerHeight - 40));
                this.panel.style.right = 'auto';
                this.panel.style.left = clampedX + 'px';
                this.panel.style.top = clampedY + 'px';
            }

            // Apply UI mode from settings
            this._applyUIMode();
        },

        _buildSettingsPanel() {
            const settingsEl = this.panel.querySelector('[data-hg-settings]');

            let groupToggles = '';
            HARVEST_SWAPS.forEach(swap => {
                const checked = Settings.isGroupEnabled(swap.id) ? 'checked' : '';
                const tip = `${swap.description} (${swap.cost})`;
                groupToggles += `
                    <div class="hg-set-row" title="${esc(tip)}">
                        <input type="checkbox" id="hg-set-${swap.id}" data-hg-group-toggle="${swap.id}" ${checked}>
                        <label for="hg-set-${swap.id}">${swap.icon} ${esc(swap.label)}</label>
                    </div>
                `;
            });

            settingsEl.innerHTML = `
                <div class="hg-set-top">
                    <span class="hg-set-heading">Settings</span>
                    <button class="hg-set-save" data-hg-save title="Save &amp; close">✓</button>
                </div>
                <div class="hg-set-section">Swap Groups</div>
                ${groupToggles}
                <div class="hg-set-section">Behavior</div>
                <div class="hg-set-row" title="Automatically submit grouped search when swappable stats are detected. Skips the manual click.">
                    <input type="checkbox" id="hg-set-auto" data-hg-auto ${Settings.data.autoApply ? 'checked' : ''}>
                    <label for="hg-set-auto">Auto-apply on search</label>
                </div>
                <div class="hg-set-section">Display</div>
                <div class="hg-set-row" title="Show a minimal floating bar instead of the full sidebar.">
                    <input type="checkbox" id="hg-set-compact" data-hg-compact ${Settings.data.uiMode === 'compact' ? 'checked' : ''}>
                    <label for="hg-set-compact">Compact bar mode</label>
                </div>
                <div class="hg-set-section">Advanced</div>
                <div class="hg-set-row" title="Log intercepted payloads, stat resolution, and swap analysis to the F12 console.">
                    <input type="checkbox" id="hg-set-debug" data-hg-debug ${Settings.data.debug ? 'checked' : ''}>
                    <label for="hg-set-debug">Debug logging (F12)</label>
                </div>
            `;

            settingsEl.querySelector('[data-hg-save]').addEventListener('click', () => {
                // Read all toggles
                settingsEl.querySelectorAll('[data-hg-group-toggle]').forEach(cb => {
                    Settings.data.enabledGroups[cb.dataset.hgGroupToggle] = cb.checked;
                });
                Settings.data.autoApply = settingsEl.querySelector('[data-hg-auto]').checked;
                Settings.data.uiMode = settingsEl.querySelector('[data-hg-compact]').checked ? 'compact' : 'sidebar';
                Settings.data.debug = settingsEl.querySelector('[data-hg-debug]').checked;
                Settings.save();

                this.panel.classList.remove('hg-show-settings');
                this._applyUIMode();

                // Re-analyze with new settings if we have a payload
                if (_lastPayload) {
                    this.analyze(_lastPayload, _lastLeague || detectLeague());
                }
            });
        },

        _applyUIMode() {
            if (Settings.data.uiMode === 'compact') {
                this.panel.classList.add('hg-compact-mode');
                this.bar.classList.add('hg-bar-active');
                // Sync bar position with saved panel position (clamped)
                if (Settings.data.posX && Settings.data.posY) {
                    const x = parseFloat(Settings.data.posX) || 0;
                    const y = parseFloat(Settings.data.posY) || 0;
                    this.bar.style.right = 'auto';
                    this.bar.style.left = Math.max(0, Math.min(x, window.innerWidth - 60)) + 'px';
                    this.bar.style.top = Math.max(0, Math.min(y, window.innerHeight - 40)) + 'px';
                }
            } else {
                this.panel.classList.remove('hg-compact-mode');
                this.bar.classList.remove('hg-bar-active');
            }
        },

        // ── Clipboard paste: parse PoE item text and submit a fresh trade search ──
        async _handleClipboardPaste() {
            const status = this.panel.querySelector('.hg-status');

            // Expand panel if minimized so user sees status feedback
            if (this.minimized) {
                this.minimized = false;
                this.panel.classList.remove('hg-min');
            }

            let text;
            try {
                text = await navigator.clipboard.readText();
            } catch (e) {
                status.textContent = '❌ Clipboard access denied — copy an item in-game first.';
                return;
            }

            if (!text || !text.includes('--------')) {
                status.textContent = '❌ No PoE item in clipboard. Ctrl+C an item in-game.';
                return;
            }

            if (!StatResolver.loaded) {
                status.textContent = '❌ Stat database not loaded yet. Try again shortly.';
                return;
            }

            const item = ClipboardParser.parse(text);
            if (!item) {
                status.textContent = '❌ Could not parse item data.';
                return;
            }

            const league = detectLeague();
            if (!league) {
                status.textContent = '❌ No league detected — run a search first.';
                return;
            }

            const label = item.name || item.baseType;
            status.textContent = `📋 ${label}: ${item.mods.length}/${item.modLineCount} mods matched — searching…`;

            Logger.group('Clipboard paste → trade search');
            Logger.log('Parsed item:', JSON.stringify(item, null, 2));

            const payload = ClipboardParser.buildPayload(item);
            Logger.log('Payload:', JSON.stringify(payload, null, 2));
            Logger.groupEnd();

            try {
                const resp = await fetch(`https://www.pathofexile.com/api/trade/search/${league}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });

                if (resp.status === 429) {
                    const retry = resp.headers.get('Retry-After') || '60';
                    status.textContent = `⏳ Rate limited — ${retry}s`;
                    return;
                }
                if (!resp.ok) {
                    let msg = `HTTP ${resp.status}`;
                    try { const e = await resp.json(); msg = e.error?.message || msg; } catch (_) {}
                    status.textContent = `❌ ${msg}`;
                    return;
                }

                const data = await resp.json();
                if (data.id) {
                    status.textContent = `📋 ${label}: ${item.mods.length} mods → opening results…`;
                    window.location.href = `https://www.pathofexile.com/trade/search/${league}/${data.id}`;
                } else {
                    status.textContent = '❌ No search ID returned.';
                }
            } catch (e) {
                Logger.error('Clipboard search failed', e);
                status.textContent = '❌ Network error.';
            }
        },

        // ── Core: analyze a captured search payload for swappable stats ──
        analyze(payload, league) {
            if (!StatResolver.loaded) {
                Logger.warn('Stats not loaded yet');
                return;
            }

            Logger.group('Analyze payload');
            if (Settings.data.debug) {
                const allFilterIds = (payload?.query?.stats || [])
                    .flatMap(sg => (sg.filters || []).map(f => f.id + (f.disabled ? ' [DIS]' : '')));
                Logger.log('Payload filter IDs:', allFilterIds);
                Logger.log('idToSwap size:', StatResolver.idToSwap.size, '| idToMeta size:', StatResolver.idToMeta.size);
                allFilterIds.forEach(raw => {
                    const id = raw.replace(' [DIS]', '');
                    const meta = StatResolver.idToMeta.get(id);
                    const swap = StatResolver.idToSwap.get(id);
                    let sibCount = 'n/a';
                    if (swap) {
                        const gk = `${swap.swap.id}|${swap.templateKey}`;
                        sibCount = StatResolver.templateGroups.get(gk)?.length || 0;
                    }
                    Logger.log(`  ${id}: meta=${meta ? '"' + meta.text + '"' : 'MISSING'} swap=${swap ? swap.swap.id : 'NONE'} siblings=${sibCount}`);
                });
            }

            this.suggestions = [];
            const claimed = new Set();

            const statGroups = payload?.query?.stats || [];

            statGroups.forEach(sg => {
                if (sg.type !== 'and') return;
                (sg.filters || []).forEach(filter => {
                    if (filter.disabled) {
                        Logger.log(`  skip ${filter.id} (disabled)`);
                        return;
                    }
                    if (claimed.has(filter.id)) return;

                    const info = StatResolver.getSwapInfo(filter.id);
                    if (!info) return;

                    // Collect siblings that are also present in 'and' groups
                    // (NOT count groups — those may exist from a previous apply)
                    const andFiltersFlat = [];
                    statGroups.forEach(g => {
                        if (g.type === 'and') (g.filters || []).forEach(f => andFiltersFlat.push(f));
                    });

                    const detected = [];
                    info.siblings.forEach(sib => {
                        const existing = andFiltersFlat.find(f => f.id === sib.id && !f.disabled);
                        if (existing) {
                            detected.push({
                                ...sib,
                                min: existing.value?.min,
                                max: existing.value?.max,
                            });
                            claimed.add(sib.id);
                        }
                    });

                    const templateDisplay = info.templateKey
                        .split('|')[1]
                        .replace('{{ELE}}', '⟨element⟩');

                    this.suggestions.push({
                        swap: info.swap,
                        templateKey: info.templateKey,
                        templateDisplay,
                        detected,
                        allSiblings: info.siblings,
                        suggestedMin: Math.max(...detected.map(d => d.min || 0)),
                        // Count = 1: harvest swaps one mod at a time, so we need
                        // at least 1 of the variants to exist on the item
                        suggestedCount: 1,
                    });
                });
            });

            // ── Deduplicate: keep only one suggestion per swap group ID ──
            // When multiple templates match for the same swap (e.g., "+#% to ⟨element⟩"
            // and "+#% to ⟨element⟩ when Socketed with a Red Gem"), keep the one with
            // the most detected stats, then shortest template as tiebreaker (simplest mod).
            const preDedup = this.suggestions.length;
            const bestBySwap = new Map();
            this.suggestions.forEach(sug => {
                const key = sug.swap.id;
                const existing = bestBySwap.get(key);
                if (!existing ||
                    sug.detected.length > existing.detected.length ||
                    (sug.detected.length === existing.detected.length &&
                     sug.templateDisplay.length < existing.templateDisplay.length)) {
                    bestBySwap.set(key, sug);
                }
            });
            this.suggestions = Array.from(bestBySwap.values());

            // Filter by enabled groups from settings
            this.suggestions = this.suggestions.filter(s => Settings.isGroupEnabled(s.swap.id));

            Logger.info(`${this.suggestions.length} swap suggestion(s) found`);

            Logger.log(`Dedup: ${preDedup} raw → ${this.suggestions.length} after (1 per swap group)`);
            this.suggestions.forEach(s => Logger.log(`  → ${s.swap.id}: "${s.templateDisplay}" (${s.detected.length} detected, min=${s.suggestedMin})`));
            Logger.groupEnd();

            this._render(league);
            this._renderBar(league);

            // Auto-apply if enabled and we have suggestions
            if (Settings.data.autoApply && this.suggestions.length > 0) {
                Logger.info('Auto-applying all groups');
                this._applyAll(league);
            }
        },

        _render(league) {
            const count = this.suggestions.length;
            this.badge.textContent = count;
            this.badge.classList.toggle('hg-zero', count === 0);
            this.panel.classList.toggle('hg-empty', count === 0);

            if (count === 0) {
                this.content.innerHTML = '<div class="hg-empty-msg">No harvest-swappable stats detected in this search.</div>';
                this.panel.querySelector('.hg-status').textContent = 'Listening for searches…';
                return;
            }

            this.panel.querySelector('.hg-status').innerHTML = count > 1
                ? `${count} groups · <a href="#" data-hg-apply-all>Apply all</a>`
                : `${count} group available`;

            let html = '';
            this.suggestions.forEach((sug, idx) => {
                // Detected chips (what's in the search)
                const detHtml = sug.detected.map(d =>
                    `<span class="hg-chip hg-chip-orig" style="border-color:${d.element.color};color:${d.element.color}">${esc(d.element.short)} ≥${d.min ?? '?'}</span>`
                ).join(' ');

                // All variant chips for the count group
                const grpHtml = sug.allSiblings.map(sib => {
                    const isDet = sug.detected.some(d => d.id === sib.id);
                    const cls = isDet ? 'hg-chip hg-chip-orig' : 'hg-chip';
                    return `<span class="${cls}" style="border-color:${sib.element.color};color:${sib.element.color}">${esc(sib.element.short)} ≥${sug.suggestedMin || '?'}</span>`;
                }).join('');

                html += `
                    <div class="hg-sug" data-sug-idx="${idx}">
                        <div class="hg-sug-head">
                            <span class="hg-sug-icon">${sug.swap.icon}</span>
                            ${esc(sug.swap.label)}
                            <span class="hg-sug-cost">${esc(sug.swap.cost)}</span>
                        </div>
                        <div class="hg-sug-flow">${detHtml} <span class="hg-sug-arrow">→</span> ${grpHtml}</div>
                        <button class="hg-apply" data-hg-apply="${idx}">🌿 Apply (count ≥${sug.suggestedCount})</button>
                    </div>
                `;
            });

            this.content.innerHTML = html;

            // Bind individual apply buttons
            this.content.querySelectorAll('[data-hg-apply]').forEach(btn => {
                btn.addEventListener('click', e => {
                    this._applyGroup(parseInt(e.currentTarget.dataset.hgApply), league);
                });
            });

            // Bind "apply all"
            const applyAll = this.panel.querySelector('[data-hg-apply-all]');
            if (applyAll) {
                applyAll.addEventListener('click', e => {
                    e.preventDefault();
                    this._applyAll(league);
                });
            }
        },

        // ── Compact bar rendering ──
        _renderBar(league) {
            if (!this.bar) return;

            if (this.suggestions.length === 0) {
                this.bar.innerHTML = '';
                return;
            }

            let html = '';
            this.suggestions.forEach((sug, idx) => {
                const detNames = sug.detected.map(d =>
                    `<span style="color:${d.element.color}">${esc(d.element.short)}</span>`
                ).join(', ');

                html += `
                    <div class="hg-bar-row">
                        <span class="hg-bar-icon">${sug.swap.icon}</span>
                        <span class="hg-bar-label">${detNames}</span>
                        <span class="hg-bar-det">→ ${sug.allSiblings.length} variants</span>
                        <button class="hg-bar-go" data-hg-bar-apply="${idx}">▶ Group</button>
                    </div>
                `;
            });

            // Add a gear icon row if there are suggestions
            html += `
                <div class="hg-bar-row" style="padding:2px 8px;justify-content:flex-end;gap:10px">
                    ${this.suggestions.length > 1 ? '<button class="hg-bar-go" data-hg-bar-all>▶ All</button>' : ''}
                    <span class="hg-bar-gear" data-hg-bar-gear title="Settings">⚙</span>
                </div>
            `;

            this.bar.innerHTML = html;

            // Bind bar apply buttons
            this.bar.querySelectorAll('[data-hg-bar-apply]').forEach(btn => {
                btn.addEventListener('click', e => {
                    this._applyGroup(parseInt(e.currentTarget.dataset.hgBarApply), league);
                });
            });

            const barAll = this.bar.querySelector('[data-hg-bar-all]');
            if (barAll) {
                barAll.addEventListener('click', () => this._applyAll(league));
            }

            // Gear opens the sidebar settings
            const barGear = this.bar.querySelector('[data-hg-bar-gear]');
            if (barGear) {
                barGear.addEventListener('click', () => {
                    // Temporarily show sidebar for settings
                    this.panel.classList.remove('hg-compact-mode');
                    this.panel.classList.add('hg-show-settings');
                });
            }
        },

        // ── Build a modified payload: disable detected stats, append count group ──
        // ONLY touches the specific detected stats (sets disabled:true) and appends
        // the count group.  All other filters remain exactly as they were.
        _buildGroupedPayload(suggestions) {
            const payload = JSON.parse(JSON.stringify(_lastPayload));

            // Collect stat IDs that will be represented by count groups instead
            const idsToDisable = new Set();
            suggestions.forEach(sug => {
                sug.detected.forEach(d => idsToDisable.add(d.id));
            });

            // Disable (not remove) those stats in existing groups
            (payload.query.stats || []).forEach(sg => {
                (sg.filters || []).forEach(f => {
                    if (idsToDisable.has(f.id)) {
                        f.disabled = true;
                    }
                });
            });

            // Append count groups for each suggestion
            suggestions.forEach(sug => {
                payload.query.stats.push({
                    type: 'count',
                    value: { min: sug.suggestedCount },
                    disabled: false,
                    filters: sug.allSiblings.map(sib => ({
                        id: sib.id,
                        disabled: false,
                        value: sug.suggestedMin ? { min: sug.suggestedMin } : undefined,
                    })),
                });
            });

            return payload;
        },

        async _applyGroup(sugIdx, league) {
            const sug = this.suggestions[sugIdx];
            if (!sug || !_lastPayload) return;

            const btn = this.content.querySelector(`[data-hg-apply="${sugIdx}"]`);
            if (btn) { btn.disabled = true; btn.textContent = 'Searching…'; }

            await this._submitSearch(this._buildGroupedPayload([sug]), league || detectLeague(), btn);
        },

        async _applyAll(league) {
            if (!this.suggestions.length || !_lastPayload) return;

            const btns = this.content.querySelectorAll('.hg-apply');
            btns.forEach(b => { b.disabled = true; b.textContent = 'Searching…'; });

            await this._submitSearch(this._buildGroupedPayload(this.suggestions), league || detectLeague(), btns[0]);
        },

        async _submitSearch(payload, league, btn) {
            if (!league) {
                if (btn) { btn.disabled = false; btn.textContent = '❌ No league detected'; }
                return;
            }

            Logger.group('OUTGOING grouped payload → ' + league);
            Logger.log('Full payload:', JSON.stringify(payload, null, 2));
            (payload.query?.stats || []).forEach((sg, i) => {
                Logger.log(`  Stat group [${i}] type="${sg.type}"`,
                    sg.type === 'count' ? JSON.stringify(sg, null, 2) : `${sg.filters?.length || 0} filters`);
            });
            Logger.groupEnd();

            try {
                const resp = await fetch(`https://www.pathofexile.com/api/trade/search/${league}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });

                if (resp.status === 429) {
                    const retry = resp.headers.get('Retry-After') || '60';
                    if (btn) { btn.disabled = false; btn.textContent = `⏳ Rate limited — ${retry}s`; }
                    return;
                }
                if (!resp.ok) {
                    let msg = `HTTP ${resp.status}`;
                    try { const e = await resp.json(); msg = e.error?.message || msg; } catch (_) {}
                    if (btn) { btn.disabled = false; btn.textContent = `❌ ${msg}`; }
                    return;
                }

                const data = await resp.json();
                if (data.id) {
                    window.location.href = `https://www.pathofexile.com/trade/search/${league}/${data.id}`;
                } else {
                    if (btn) { btn.disabled = false; btn.textContent = '❌ No search ID'; }
                }
            } catch (e) {
                Logger.error('Submit failed', e);
                if (btn) { btn.disabled = false; btn.textContent = '❌ Network error'; }
            }
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
            Logger.info('StatResolver ready');

            // If a payload was already captured during init, analyze it
            if (_lastPayload) {
                Sidebar.analyze(_lastPayload, _lastLeague);
            }

            if (!_lastPayload) {
                Sidebar.panel.querySelector('.hg-status').textContent = 'Click Search to detect stats.';
            }
        });

        // Observe DOM changes for SPA navigation and re-search
        let lastUrl = window.location.href;
        let debounceTimer = null;
        new MutationObserver(() => {
            // URL change = SPA navigation
            if (window.location.href !== lastUrl) {
                lastUrl = window.location.href;
                // Don't null _lastPayload — the interceptor overwrites it on
                // every new search POST, and nulling it here races with the
                // XHR load handler that needs it.
                setTimeout(() => {
                    if (_lastPayload) {
                        Sidebar.analyze(_lastPayload, _lastLeague || detectLeague());
                    }
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
