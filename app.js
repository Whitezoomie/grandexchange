// ========================================
// OSRS Grand Exchange Tracker - Main App
// ========================================

(function () {
    'use strict';

    // --- Constants ---
    const API_BASE = 'https://prices.runescape.wiki/api/v1/osrs';
    const WIKI_IMAGE_BASE = 'https://oldschool.runescape.wiki/images';
    const WIKI_PAGE_BASE = 'https://oldschool.runescape.wiki/w';
    const ITEMS_PER_PAGE = 100;
    const USER_AGENT = 'OSRS GE Tracker - Personal Project';
    const DEBOUNCE_MS = 300;

    // ========================================
    // FEEDBACK — replaces changelog
    // ========================================

    // ========================================
    // URL Routing Helpers
    // ========================================

    function slugify(name) {
        return name
            .toLowerCase()
            .replace(/['']/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    function findItemBySlug(slug) {
        return allItems.find(item => slugify(item.name) === slug);
    }

    function getItemUrlPath(item) {
        return '/' + slugify(item.name);
    }

    // Items to hide (removed from game / no GE value)
    const BLACKLISTED_NAMES = new Set([
        'blighted snare sack',
        'blighted bind sack',
        'not meat',
        'fish chunks',
        'chitin',
        "morrigan's javelin",
    ]);

    // Custom items not in the API (e.g. Deadman reward store)
    const CUSTOM_ITEMS = [
        { id: 'dm_annihilation_scroll', name: 'Annihilation weapon scroll', examine: 'A scroll that can be used to unlock the Annihilation weapon.', icon: 'Annihilation_weapon_scroll.png', members: true, value: 0, highalch: 0, lowalch: 0, limit: 5 },
        { id: 'dm_annihilation_bp', name: 'Annihilation blueprints', examine: 'Blueprints for crafting the devastating Annihilation weapon.', icon: 'Annihilation_blueprints.png', members: true, value: 0, highalch: 0, lowalch: 0, limit: 5 },
        { id: 'dm_annihilation_tp', name: 'Annihilation teleport scroll', examine: 'A scroll that teleports you to the Annihilation arena.', icon: 'Annihilation_teleport_scroll.png', members: true, value: 0, highalch: 0, lowalch: 0, limit: 5 },
    ];

    // --- State ---
    let allItems = [];           // merged item data
    let filteredItems = [];      // after search/filter
    let currentPage = 1;
    let currentView = 'grid';
    let isLoading = true;
    let showFavoritesOnly = false;
    let favorites = loadFavorites();
    let priceChartInstance = null;
    let volumeChartInstance = null;
    let currentModalItemId = null;
    let dataLoadedAt = null;
    let lastUpdatedInterval = null;
    let effectsEnabled = localStorage.getItem('ge_effects') !== 'off';
    let previousPrices = {};  // track old prices for pulse

    // --- DOM References ---
    const $ = (id) => document.getElementById(id);
    const dom = {
        searchInput: $('searchInput'),
        clearSearch: $('clearSearch'),
        membersFilter: $('membersFilter'),
        minPrice: $('minPrice'),
        maxPrice: $('maxPrice'),
        minMargin: $('minMargin'),
        maxMargin: $('maxMargin'),
        minVolume: $('minVolume'),
        maxVolume: $('maxVolume'),
        minBuyLimit: $('minBuyLimit'),
        maxBuyLimit: $('maxBuyLimit'),
        sortBy: $('sortBy'),
        saveFilters: $('saveFilters'),
        resetFilters: $('resetFilters'),
        loadingContainer: $('loadingContainer'),
        loadingStatus: $('loadingStatus'),
        errorContainer: $('errorContainer'),
        errorMessage: $('errorMessage'),
        retryBtn: $('retryBtn'),
        mainContent: $('mainContent'),
        itemsContainer: $('itemsContainer'),
        pagination: $('pagination'),
        prevPage: $('prevPage'),
        nextPage: $('nextPage'),
        currentPage: $('currentPage'),
        totalPages: $('totalPages'),
        totalItems: $('totalItems'),
        lastUpdated: $('lastUpdated'),
        shownItems: $('shownItems'),
        modalOverlay: $('modalOverlay'),
        modalClose: $('modalClose'),
        modalFavBtn: $('modalFavBtn'),
        filterAll: $('filterAll'),
        filterFavorites: $('filterFavorites'),
        favoritesCount: $('favoritesCount'),
        favoritesStatBox: $('favoritesStatBox'),
        priceChart: $('priceChart'),
        volumeChart: $('volumeChart'),
        historyLoading: $('historyLoading'),
        historyError: $('historyError'),
        backToTop: $('backToTop'),
    };

    // ========================================
    // Favorites (localStorage)
    // ========================================

    function loadFavorites() {
        try {
            const stored = localStorage.getItem('osrs_ge_favorites');
            return stored ? new Set(JSON.parse(stored)) : new Set();
        } catch {
            return new Set();
        }
    }

    function saveFavorites() {
        localStorage.setItem('osrs_ge_favorites', JSON.stringify([...favorites]));
    }

    function toggleFavorite(itemId) {
        if (favorites.has(itemId)) {
            favorites.delete(itemId);
        } else {
            favorites.add(itemId);
        }
        saveFavorites();
        updateFavoritesCount();
        updatePortfolioValue();
    }

    function isFavorite(itemId) {
        return favorites.has(itemId);
    }

    function updateFavoritesCount() {
        dom.favoritesCount.textContent = favorites.size;
    }

    // ========================================
    // Number Parsing with k/m suffix
    // ========================================
    /**
     * Parse a number string that may contain 'k' or 'm' suffix
     * Examples: "10k" -> 10000, "1m" -> 1000000, "500" -> 500
     */
    function parseNumberWithSuffix(value) {
        if (!value || typeof value !== 'string') {
            return parseFloat(value) || 0;
        }

        const trimmed = value.trim().toLowerCase();
        if (!trimmed) return 0;

        // Check for k or m suffix (only these two letters allowed)
        const match = trimmed.match(/^([\d.]+)\s*([km])$/);
        if (!match) {
            // No valid suffix, parse as regular number
            return parseFloat(trimmed) || 0;
        }

        const number = parseFloat(match[1]);
        const suffix = match[2];

        if (isNaN(number)) return 0;

        if (suffix === 'k') {
            return number * 1000;
        } else if (suffix === 'm') {
            return number * 1000000;
        }

        return number;
    }

    // ========================================
    // Portfolio Value (Animated GP Counter)
    // ========================================

    let portfolioDisplayValue = 0; // current displayed value for animation
    let portfolioAnimFrame = null;

    function getPortfolioTotal() {
        let total = 0;
        favorites.forEach(id => {
            const item = allItems.find(i => i.id === id);
            if (item) {
                total += item.buyPrice || item.sellPrice || 0;
            }
        });
        return total;
    }

    function formatPortfolioGp(value) {
        if (value === 0) return '0 gp';
        if (value >= 1e9) return (value / 1e9).toFixed(2) + 'B gp';
        if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M gp';
        if (value >= 1e3) return (value / 1e3).toFixed(1) + 'K gp';
        return value.toLocaleString() + ' gp';
    }

    function updatePortfolioValue() {
        const el = document.getElementById('portfolioValue');
        if (!el) return;

        if (favorites.size === 0 || allItems.length === 0) {
            portfolioDisplayValue = 0;
            el.textContent = '-';
            return;
        }

        const target = getPortfolioTotal();

        if (!effectsEnabled || portfolioDisplayValue === 0) {
            portfolioDisplayValue = target;
            el.textContent = formatPortfolioGp(target);
            return;
        }

        // Animate from current displayed value to new target
        const from = portfolioDisplayValue;
        const diff = target - from;
        if (diff === 0) return;

        if (portfolioAnimFrame) cancelAnimationFrame(portfolioAnimFrame);

        const duration = 800;
        const start = performance.now();

        function tick(now) {
            const elapsed = now - start;
            const progress = Math.min(elapsed / duration, 1);
            // ease-out cubic
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = Math.round(from + diff * eased);
            portfolioDisplayValue = current;
            el.textContent = formatPortfolioGp(current);
            if (progress < 1) {
                portfolioAnimFrame = requestAnimationFrame(tick);
            } else {
                portfolioDisplayValue = target;
                el.textContent = formatPortfolioGp(target);
                portfolioAnimFrame = null;
            }
        }
        portfolioAnimFrame = requestAnimationFrame(tick);
    }

    // ========================================
    // API Functions
    // ========================================

    async function fetchWithRetry(url, retries = 3) {
        for (let i = 0; i < retries; i++) {
            try {
                const res = await fetch(url, {
                    headers: { 'User-Agent': USER_AGENT }
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return await res.json();
            } catch (err) {
                if (i === retries - 1) throw err;
                await new Promise(r => setTimeout(r, 1000 * (i + 1)));
            }
        }
    }

    async function loadData() {
        showLoading();
        try {
            dom.loadingStatus.textContent = 'Fetching item database...';
            const mappingData = await fetchWithRetry(`${API_BASE}/mapping`);

            dom.loadingStatus.textContent = 'Fetching latest prices...';
            const latestData = await fetchWithRetry(`${API_BASE}/latest`);

            dom.loadingStatus.textContent = 'Fetching trade volumes...';
            let volumeData = {};
            try {
                const vol = await fetchWithRetry(`${API_BASE}/volumes`);
                volumeData = vol.data || vol;
            } catch (e) {
                // volumes are optional
            }

            dom.loadingStatus.textContent = 'Processing data...';
            mergeData(mappingData, latestData.data || {}, volumeData);

            showMain();
            dom.totalItems.textContent = allItems.length.toLocaleString();
            initSpotlight();

            // Start continuous last-updated timer
            dataLoadedAt = Date.now();
            dom.lastUpdated.textContent = 'Just now';
            if (lastUpdatedInterval) clearInterval(lastUpdatedInterval);
            lastUpdatedInterval = setInterval(updateLastUpdatedTimer, 1000);

            loadSavedFilters();
            applyFilters();
            updatePortfolioValue();

            // Deep-link: open specific item if specified
            // First check for data-initial-item attribute (pre-rendered pages)
            const initialItemId = document.body.getAttribute('data-initial-item');
            if (initialItemId) {
                const item = allItems.find(i => i.id == initialItemId);
                if (item) {
                    openModal(item);
                }
            } else {
                // Otherwise check URL slug (client-side navigation)
                const urlSlug = window.location.pathname.replace(/^\//, '').split('/')[0];
                if (urlSlug) {
                    const item = findItemBySlug(urlSlug);
                    if (item) {
                        // Replace state so back button goes to root
                        history.replaceState({ itemSlug: urlSlug }, '', '/' + urlSlug);
                        openModal(item);
                    }
                }
            }
        } catch (err) {
            showError(err.message);
        }
    }

    function mergeData(mapping, prices, volumes) {
        // Filter out blacklisted items
        const filtered = mapping.filter(item => !BLACKLISTED_NAMES.has((item.name || '').toLowerCase()));

        allItems = filtered.map(item => {
            const price = prices[item.id] || {};
            const buyPrice = price.high || null;  // instant buy = someone's sell offer
            const sellPrice = price.low || null;   // instant sell = someone's buy offer
            const tax = buyPrice ? Math.min(Math.floor(buyPrice * 0.02), 5000000) : 0;
            const margin = (buyPrice && sellPrice) ? buyPrice - sellPrice - tax : null;

            return {
                id: item.id,
                name: item.name || 'Unknown',
                examine: item.examine || '',
                icon: item.icon || '',
                members: item.members || false,
                value: item.value || 0,
                highalch: item.highalch || 0,
                lowalch: item.lowalch || 0,
                limit: item.limit || 0,
                buyPrice,
                sellPrice,
                buyTime: price.highTime ? new Date(price.highTime * 1000) : null,
                sellTime: price.lowTime ? new Date(price.lowTime * 1000) : null,
                tax,
                margin,
                volume: volumes[item.id] || 0,
            };
        });

        // Append custom Deadman reward store items
        CUSTOM_ITEMS.forEach(ci => {
            allItems.push({
                id: ci.id,
                name: ci.name,
                examine: ci.examine,
                icon: ci.icon,
                members: ci.members,
                value: ci.value,
                highalch: ci.highalch,
                lowalch: ci.lowalch,
                limit: ci.limit,
                buyPrice: null,
                sellPrice: null,
                buyTime: null,
                sellTime: null,
                tax: 0,
                margin: null,
                volume: 0,
            });
        });
    }

    // ========================================
    // Rendering
    // ========================================

    function renderItems() {
        const start = (currentPage - 1) * ITEMS_PER_PAGE;
        const end = start + ITEMS_PER_PAGE;
        const pageItems = filteredItems.slice(start, end);
        const totalPgs = Math.max(1, Math.ceil(filteredItems.length / ITEMS_PER_PAGE));

        dom.shownItems.textContent = filteredItems.length.toLocaleString();
        dom.currentPage.textContent = currentPage;
        dom.totalPages.textContent = totalPgs;
        dom.prevPage.disabled = currentPage <= 1;
        dom.nextPage.disabled = currentPage >= totalPgs;

        if (pageItems.length === 0) {
            dom.itemsContainer.innerHTML = `
                <div class="no-results">
                    <div class="no-results-icon">🔍</div>
                    <h3>No items found</h3>
                    <p>Try adjusting your search or filters</p>
                </div>`;
            return;
        }

        if (currentView === 'grid') {
            dom.itemsContainer.className = 'items-grid';
        } else {
            dom.itemsContainer.className = 'items-grid list-view';
        }

        const fragment = document.createDocumentFragment();
        for (const item of pageItems) {
            fragment.appendChild(createItemCard(item));
        }
        dom.itemsContainer.innerHTML = '';
        dom.itemsContainer.appendChild(fragment);
        animateCardEntry();
    }

    function getItemRarity(item) {
        const price = item.buyPrice || item.sellPrice || 0;
        if (price >= 100000000) return 'mythic';
        if (price >= 10000000) return 'legendary';
        if (price >= 500000) return 'rare';
        if (price >= 10000) return 'uncommon';
        return 'common';
    }

    function createItemCard(item) {
        const card = document.createElement('div');
        const rarity = getItemRarity(item);
        card.className = 'item-card' + (rarity !== 'common' ? ' rarity-' + rarity : '');
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', item.name);
        card.dataset.itemId = item.id;

        const iconUrl = getIconUrl(item.icon);
        const marginClass = item.margin > 0 ? 'positive' : item.margin < 0 ? 'negative' : 'neutral';
        const favClass = isFavorite(item.id) ? 'is-fav' : '';

        card.innerHTML = `
            <button class="card-fav-btn ${favClass}" data-item-id="${item.id}" title="Toggle Favorite">
                <svg class="fav-outline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                <svg class="fav-filled" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
            </button>
            <div class="item-card-header">
                <img class="item-icon" src="${iconUrl}" alt="" loading="lazy" 
                     onerror="this.outerHTML='<div class=\\'item-icon placeholder\\'>📦</div>'">
                <span class="item-name">${escapeHtml(item.name)}</span>
            </div>
            <div class="item-badges">
                ${item.members 
                    ? '<span class="badge badge-members">Members</span>' 
                    : '<span class="badge badge-f2p">F2P</span>'}
                <span class="last-trade">Last trade: ${item.buyTime || item.sellTime ? timeAgo(new Date(Math.max(item.buyTime ? item.buyTime.getTime() : 0, item.sellTime ? item.sellTime.getTime() : 0))) : 'N/A'}</span>
            </div>
            <div class="item-prices">
                <div class="price-box">
                    <span class="label">Buy</span>
                    <span class="value buy-price">${formatGp(item.buyPrice)}</span>
                    <span class="price-change-indicator ${item.buyChange === 'up' ? 'price-increased' : item.buyChange === 'down' ? 'price-decreased' : ''}">${item.buyChange === 'up' ? '▲ increased' : item.buyChange === 'down' ? '▼ decreased' : ''}</span>
                </div>
                <div class="price-box">
                    <span class="label">Sell</span>
                    <span class="value sell-price">${formatGp(item.sellPrice)}</span>
                    <span class="price-change-indicator ${item.sellChange === 'up' ? 'price-increased' : item.sellChange === 'down' ? 'price-decreased' : ''}">${item.sellChange === 'up' ? '▲ increased' : item.sellChange === 'down' ? '▼ decreased' : ''}</span>
                </div>
            </div>
            <div class="item-margin">
                <span class="margin-label">Margin</span>
                <span class="margin-value ${marginClass}">${formatGp(item.margin, true)}</span>
            </div>
            <div class="item-volume">
                <span class="volume-label">Daily Volume</span>
                <span class="volume-value">${item.volume ? item.volume.toLocaleString() : '-'}</span>
            </div>
        `;

        card.addEventListener('click', (e) => {
            if (e.target.closest('.card-fav-btn')) return;
            openModal(item);
        });
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openModal(item);
            }
        });

        // Fav button on card
        const favBtn = card.querySelector('.card-fav-btn');
        favBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const wasFav = isFavorite(item.id);
            toggleFavorite(item.id);
            favBtn.classList.toggle('is-fav');
            if (!wasFav) {
                const rect = favBtn.getBoundingClientRect();
                spawnConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
            }
            // If we're in favorites-only mode and un-faved, re-render
            if (showFavoritesOnly && !isFavorite(item.id)) {
                applyFilters();
            }
        });

        return card;
    }

    function updateCardValues(oldPrices) {
        const cards = dom.itemsContainer.querySelectorAll('.item-card');
        cards.forEach(card => {
            const itemId = parseInt(card.dataset.itemId, 10);
            const item = allItems.find(i => i.id === itemId);
            if (!item) return;

            const buyEl = card.querySelector('.buy-price');
            const sellEl = card.querySelector('.sell-price');
            const marginEl = card.querySelector('.margin-value');
            const tradeEl = card.querySelector('.last-trade');

            const old = oldPrices ? oldPrices[itemId] : null;

            if (buyEl) {
                const oldBuy = old ? old.buy : item.buyPrice;
                animateGpValue(buyEl, oldBuy, item.buyPrice, false);
            }
            if (sellEl) {
                const oldSell = old ? old.sell : item.sellPrice;
                animateGpValue(sellEl, oldSell, item.sellPrice, false);
            }

            // Update buy/sell change indicators
            const buyIndicator = card.querySelector('.price-box:first-child .price-change-indicator');
            const sellIndicator = card.querySelector('.price-box:last-child .price-change-indicator');
            if (buyIndicator) {
                buyIndicator.className = 'price-change-indicator' + (item.buyChange === 'up' ? ' price-increased' : item.buyChange === 'down' ? ' price-decreased' : '');
                buyIndicator.textContent = item.buyChange === 'up' ? '▲ increased' : item.buyChange === 'down' ? '▼ decreased' : '';
            }
            if (sellIndicator) {
                sellIndicator.className = 'price-change-indicator' + (item.sellChange === 'up' ? ' price-increased' : item.sellChange === 'down' ? ' price-decreased' : '');
                sellIndicator.textContent = item.sellChange === 'up' ? '▲ increased' : item.sellChange === 'down' ? '▼ decreased' : '';
            }
            if (marginEl) {
                const oldMargin = old ? ((old.buy || 0) - (old.sell || 0)) : item.margin;
                animateGpValue(marginEl, oldMargin, item.margin, true);
                marginEl.className = 'margin-value ' + (item.margin > 0 ? 'positive' : item.margin < 0 ? 'negative' : 'neutral');
            }
            if (tradeEl) {
                const lastTime = Math.max(item.buyTime ? item.buyTime.getTime() : 0, item.sellTime ? item.sellTime.getTime() : 0);
                tradeEl.textContent = 'Last trade: ' + (lastTime ? timeAgo(new Date(lastTime)) : 'N/A');
            }
            const volEl = card.querySelector('.volume-value');
            if (volEl) volEl.textContent = item.volume ? item.volume.toLocaleString() : '-';

            // Price pulse animation
            if (oldPrices && effectsEnabled) {
                const old = oldPrices[itemId];
                if (old) {
                    const avgOld = ((old.buy || 0) + (old.sell || 0)) / 2;
                    const avgNew = ((item.buyPrice || 0) + (item.sellPrice || 0)) / 2;
                    if (avgNew > avgOld && avgOld > 0) {
                        card.classList.remove('pulse-red');
                        card.classList.add('pulse-green');
                        card.addEventListener('animationend', () => card.classList.remove('pulse-green'), { once: true });
                    } else if (avgNew < avgOld && avgOld > 0) {
                        card.classList.remove('pulse-green');
                        card.classList.add('pulse-red');
                        card.addEventListener('animationend', () => card.classList.remove('pulse-red'), { once: true });
                    }
                }
            }
        });
    }

    function getIconUrl(iconName) {
        if (!iconName) return '';
        // Wiki uses underscores and specific encoding for image names
        const encoded = encodeURIComponent(iconName.replace(/ /g, '_'))
            .replace(/%2F/g, '/')
            .replace(/%27/g, "'")
            .replace(/%28/g, '(')
            .replace(/%29/g, ')');
        return `${WIKI_IMAGE_BASE}/${encoded}`;
    }

    // ========================================
    // Modal
    // ========================================

    function openModal(item) {
        const iconUrl = getIconUrl(item.icon);
        $('modalIcon').src = iconUrl;
        $('modalIcon').onerror = function() { this.style.display = 'none'; };
        $('modalTitle').textContent = item.name;
        $('modalExamine').textContent = item.examine;

        // Tags
        $('modalTags').innerHTML = item.members
            ? '<span class="badge badge-members">Members</span>'
            : '<span class="badge badge-f2p">Free-to-Play</span>';

        // Prices
        $('modalBuyPrice').textContent = formatGp(item.buyPrice);
        $('modalBuyTime').textContent = item.buyTime ? timeAgo(item.buyTime) : 'No data';
        $('modalSellPrice').textContent = formatGp(item.sellPrice);
        $('modalSellTime').textContent = item.sellTime ? timeAgo(item.sellTime) : 'No data';

        // Margin (after 2% GE tax)
        const marginVal = item.margin;
        $('modalMargin').textContent = formatGp(marginVal, true);
        if (item.buyPrice && item.sellPrice && item.sellPrice > 0) {
            const pct = ((marginVal / item.sellPrice) * 100).toFixed(1);
            $('modalMarginPct').textContent = `${pct}% margin (after tax)`;
        } else {
            $('modalMarginPct').textContent = '-';
        }

        // GE Tax
        $('modalGeTax').textContent = item.tax ? formatGp(item.tax) : '-';

        // Details
        $('modalHighAlch').textContent = formatGp(item.highalch);
        $('modalLimit').textContent = item.limit ? item.limit.toLocaleString() : 'Unknown';

        // High Alch Profit
        if (item.highalch && item.buyPrice) {
            const profit = item.highalch - item.buyPrice - 1; // nature rune ~1gp estimate placeholder
            const profitEl = $('modalAlchProfit');
            profitEl.textContent = formatGp(profit, true);
            profitEl.style.color = profit > 0 ? 'var(--green)' : profit < 0 ? 'var(--red)' : '';
        } else {
            $('modalAlchProfit').textContent = '-';
            $('modalAlchProfit').style.color = '';
        }

        // Buy Limit Profit
        if (item.limit && item.margin != null) {
            const limitProfit = item.margin * item.limit;
            const limitProfitEl = $('modalLimitProfit');
            limitProfitEl.textContent = formatGp(limitProfit, true);
            limitProfitEl.style.color = limitProfit > 0 ? 'var(--green)' : limitProfit < 0 ? 'var(--red)' : '';
        } else {
            $('modalLimitProfit').textContent = '-';
            $('modalLimitProfit').style.color = '';
        }

        // Wiki link
        const wikiName = encodeURIComponent(item.name.replace(/ /g, '_'));
        $('modalWikiLink').href = `${WIKI_PAGE_BASE}/${wikiName}`;

        dom.modalOverlay.classList.add('active');
        document.body.style.overflow = 'hidden';

        // Update URL to reflect this item
        const itemPath = getItemUrlPath(item);
        if (window.location.pathname !== itemPath) {
            history.pushState({ itemSlug: slugify(item.name) }, '', itemPath);
        }

        // Set favorite state on modal button
        currentModalItemId = item.id;
        dom.modalFavBtn.classList.toggle('is-fav', isFavorite(item.id));

        // Load price & volume history
        loadHistory(item.id, '5m');
        // Reset active tab
        document.querySelectorAll('.history-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.history-tab[data-period="5m"]').classList.add('active');
    }

    function closeModal(skipPushState) {
        dom.modalOverlay.classList.remove('active');
        document.body.style.overflow = '';
        currentModalItemId = null;
        // Destroy chart instances
        if (priceChartInstance) { priceChartInstance.destroy(); priceChartInstance = null; }
        if (volumeChartInstance) { volumeChartInstance.destroy(); volumeChartInstance = null; }

        // Reset URL back to root (unless triggered by popstate)
        if (!skipPushState && window.location.pathname !== '/') {
            history.pushState({}, '', '/');
        }
    }

    // ========================================
    // Filtering & Sorting
    // ========================================

    function saveFiltersToStorage() {
        const filters = {
            members: dom.membersFilter.value,
            minPrice: dom.minPrice.value,
            maxPrice: dom.maxPrice.value,
            minMargin: dom.minMargin.value,
            maxMargin: dom.maxMargin.value,
            minVolume: dom.minVolume.value,
            maxVolume: dom.maxVolume.value,
            minBuyLimit: dom.minBuyLimit.value,
            maxBuyLimit: dom.maxBuyLimit.value,
            sortBy: dom.sortBy.value,
        };
        localStorage.setItem('ge_saved_filters', JSON.stringify(filters));
        dom.saveFilters.textContent = 'Saved!';
        dom.saveFilters.classList.add('saved');
        setTimeout(() => {
            dom.saveFilters.textContent = 'Save Filters';
            dom.saveFilters.classList.remove('saved');
        }, 1500);
    }

    function loadSavedFilters() {
        const raw = localStorage.getItem('ge_saved_filters');
        if (!raw) return;
        try {
            const f = JSON.parse(raw);
            if (f.members) dom.membersFilter.value = f.members;
            if (f.minPrice) dom.minPrice.value = f.minPrice;
            if (f.maxPrice) dom.maxPrice.value = f.maxPrice;
            if (f.minMargin) dom.minMargin.value = f.minMargin;
            if (f.maxMargin) dom.maxMargin.value = f.maxMargin;
            if (f.minVolume) dom.minVolume.value = f.minVolume;
            if (f.maxVolume) dom.maxVolume.value = f.maxVolume;
            if (f.minBuyLimit) dom.minBuyLimit.value = f.minBuyLimit;
            if (f.maxBuyLimit) dom.maxBuyLimit.value = f.maxBuyLimit;
            if (f.sortBy) dom.sortBy.value = f.sortBy;
        } catch (e) { /* ignore corrupt data */ }
    }

    function resetAllFilters() {
        dom.searchInput.value = '';
        dom.clearSearch.classList.remove('visible');
        dom.membersFilter.value = 'all';
        dom.minPrice.value = '';
        dom.maxPrice.value = '';
        dom.minMargin.value = '';
        dom.maxMargin.value = '';
        dom.minVolume.value = '';
        dom.maxVolume.value = '';
        dom.minBuyLimit.value = '';
        dom.maxBuyLimit.value = '';
        dom.sortBy.value = 'popular-desc';
        // Clear budget mode
        const budgetInp = document.getElementById('budgetInput');
        const budgetBtn = document.getElementById('budgetToggle');
        if (budgetInp) budgetInp.value = '';
        if (budgetBtn) { budgetBtn.classList.remove('active'); budgetBtn.textContent = 'Go'; }
        localStorage.removeItem('ge_saved_filters');
        applyFilters();
    }

    function applyFilters() {
        const search = dom.searchInput.value.toLowerCase().trim();
        const members = dom.membersFilter.value;
        const minP = parseNumberWithSuffix(dom.minPrice.value) || 0;
        const maxP = dom.maxPrice.value ? parseNumberWithSuffix(dom.maxPrice.value) : Infinity;
        const minM = dom.minMargin.value !== '' ? parseNumberWithSuffix(dom.minMargin.value) : -Infinity;
        const maxM = dom.maxMargin.value !== '' ? parseNumberWithSuffix(dom.maxMargin.value) : Infinity;
        const minV = parseNumberWithSuffix(dom.minVolume.value) || 0;
        const maxV = dom.maxVolume.value ? parseNumberWithSuffix(dom.maxVolume.value) : Infinity;
        const minBL = parseNumberWithSuffix(dom.minBuyLimit.value) || 0;
        const maxBL = dom.maxBuyLimit.value ? parseNumberWithSuffix(dom.maxBuyLimit.value) : Infinity;

        const budgetBtn = document.getElementById('budgetToggle');
        const budgetActive = budgetBtn && budgetBtn.classList.contains('active');
        const budgetVal = budgetActive ? (parseNumberWithSuffix(document.getElementById('budgetInput').value) || 0) : 0;

        filteredItems = allItems.filter(item => {
            // Favorites filter
            if (showFavoritesOnly && !isFavorite(item.id)) return false;

            // Hide items with no trade data (e.g. Deadman-only items)
            if (!item.buyPrice && !item.sellPrice) return false;

            // Search
            if (search && !item.name.toLowerCase().includes(search)) return false;

            // Members filter
            if (members === 'true' && !item.members) return false;
            if (members === 'false' && item.members) return false;

            // Price filter
            const price = item.buyPrice || item.sellPrice || 0;
            if (price < minP) return false;
            if (price > maxP) return false;

            // Margin filter
            const margin = item.margin != null ? item.margin : 0;
            if (margin < minM) return false;
            if (margin > maxM) return false;

            // Volume filter
            const vol = item.volume || 0;
            if (vol < minV) return false;
            if (vol > maxV) return false;

            // Buy limit filter
            const limit = item.limit || 0;
            if (limit < minBL) return false;
            if (limit > maxBL) return false;

            // Budget filter (What Can I Afford?)
            if (budgetActive && budgetVal > 0) {
                const itemPrice = item.buyPrice || item.sellPrice || 0;
                if (itemPrice > budgetVal || itemPrice === 0) return false;
            }

            return true;
        });

        // Sort
        const sortVal = dom.sortBy.value;
        filteredItems.sort((a, b) => {
            // If budget mode is active, sort by price descending (best value = most expensive you can afford)
            if (budgetActive && budgetVal > 0) {
                return (b.buyPrice || 0) - (a.buyPrice || 0);
            }
            switch (sortVal) {
                case 'name-asc':
                    return a.name.localeCompare(b.name);
                case 'name-desc':
                    return b.name.localeCompare(a.name);
                case 'price-desc':
                    return (b.buyPrice || 0) - (a.buyPrice || 0);
                case 'price-asc':
                    return (a.buyPrice || 0) - (b.buyPrice || 0);
                case 'margin-desc':
                    return (b.margin || -Infinity) - (a.margin || -Infinity);
                case 'margin-asc':
                    return (a.margin || Infinity) - (b.margin || Infinity);
                case 'volume-desc':
                    return (b.volume || 0) - (a.volume || 0);
                case 'best-flipping':
                    // Score = margin% × volume. Requires volume >= 100. Higher margin + higher volume = better flipping opportunity
                    const volB = b.volume || 0;
                    const volA = a.volume || 0;
                    const scoreB = volB >= 100 ? (b.margin || 0) * volB : -Infinity;
                    const scoreA = volA >= 100 ? (a.margin || 0) * volA : -Infinity;
                    return scoreB - scoreA;
                case 'popular-desc':
                    return ((b.volume || 0) * (b.buyPrice || 0)) - ((a.volume || 0) * (a.buyPrice || 0));
                case 'highalch-desc':
                    return (b.highalch || 0) - (a.highalch || 0);
                case 'traded-desc':
                    return (Math.max(b.buyTime ? b.buyTime.getTime() : 0, b.sellTime ? b.sellTime.getTime() : 0))
                         - (Math.max(a.buyTime ? a.buyTime.getTime() : 0, a.sellTime ? a.sellTime.getTime() : 0));
                case 'traded-asc':
                    return (Math.max(a.buyTime ? a.buyTime.getTime() : 0, a.sellTime ? a.sellTime.getTime() : 0))
                         - (Math.max(b.buyTime ? b.buyTime.getTime() : 0, b.sellTime ? b.sellTime.getTime() : 0));
                default:
                    return 0;
            }
        });

        currentPage = 1;
        renderItems();
    }

    // ========================================
    // Animated Card Entry
    // ========================================

    function animateCardEntry() {
        if (!effectsEnabled) return;
        const cards = dom.itemsContainer.querySelectorAll('.item-card');
        cards.forEach((card, i) => {
            card.classList.add('card-enter');
            card.style.animationDelay = (i * 40) + 'ms';
            card.addEventListener('animationend', function handler() {
                card.classList.remove('card-enter');
                card.style.animationDelay = '';
                card.removeEventListener('animationend', handler);
            }, { once: true });
        });
    }

    // ========================================
    // Price & Volume History (Charts)
    // ========================================

    async function loadHistory(itemId, timestep) {
        // Show loading, hide charts and errors
        dom.historyLoading.style.display = 'flex';
        dom.historyError.style.display = 'none';
        dom.priceChart.parentElement.style.display = 'none';
        dom.volumeChart.parentElement.style.display = 'none';

        // Destroy old charts
        if (priceChartInstance) { priceChartInstance.destroy(); priceChartInstance = null; }
        if (volumeChartInstance) { volumeChartInstance.destroy(); volumeChartInstance = null; }

        // For the 1-year view, use the OSRS Wiki timeseries API with '24h' timestep
        // which returns up to ~365 days of daily price data (same source as wiki Exchange pages)
        const is1Year = (timestep === '1y');
        const apiTimestep = is1Year ? '24h' : timestep;

        try {
            const data = await fetchWithRetry(
                `${API_BASE}/timeseries?timestep=${apiTimestep}&id=${itemId}`
            );

            const points = data.data || [];
            if (points.length === 0) {
                dom.historyLoading.style.display = 'none';
                dom.historyError.style.display = 'block';
                return;
            }

            // Sort by timestamp ascending
            points.sort((a, b) => a.timestamp - b.timestamp);

            // Filter to the correct time window
            const now = Date.now() / 1000;
            let cutoff;
            if (timestep === '5m') {
                cutoff = now - (24 * 60 * 60);           // 24 hours
            } else if (timestep === '1h') {
                cutoff = now - (7 * 24 * 60 * 60);       // 7 days
            } else if (is1Year) {
                cutoff = now - (365 * 24 * 60 * 60);     // 1 year
            } else {
                cutoff = now - (30 * 24 * 60 * 60);      // 30 days
            }
            const filtered = points.filter(p => p.timestamp >= cutoff);

            if (filtered.length === 0) {
                dom.historyLoading.style.display = 'none';
                dom.historyError.style.display = 'block';
                return;
            }

            const labels = filtered.map(p => {
                const d = new Date(p.timestamp * 1000);
                if (timestep === '5m') {
                    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                } else if (timestep === '1h') {
                    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                } else if (is1Year) {
                    return d.toLocaleDateString([], { month: 'short', year: '2-digit' });
                } else {
                    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
                }
            });

            const avgBuyPrices = filtered.map(p => p.avgHighPrice || null);
            const avgSellPrices = filtered.map(p => p.avgLowPrice || null);

            // Fill nulls by carrying last known value forward so there are no gaps
            for (let i = 1; i < avgBuyPrices.length; i++) {
                if (avgBuyPrices[i] === null) avgBuyPrices[i] = avgBuyPrices[i - 1];
            }
            for (let i = 1; i < avgSellPrices.length; i++) {
                if (avgSellPrices[i] === null) avgSellPrices[i] = avgSellPrices[i - 1];
            }
            // Also fill backwards for any leading nulls
            for (let i = avgBuyPrices.length - 2; i >= 0; i--) {
                if (avgBuyPrices[i] === null) avgBuyPrices[i] = avgBuyPrices[i + 1];
            }
            for (let i = avgSellPrices.length - 2; i >= 0; i--) {
                if (avgSellPrices[i] === null) avgSellPrices[i] = avgSellPrices[i + 1];
            }

            const buyVolumes = filtered.map(p => p.highPriceVolume || 0);
            const sellVolumes = filtered.map(p => p.lowPriceVolume || 0);

            dom.historyLoading.style.display = 'none';
            dom.priceChart.parentElement.style.display = 'block';
            dom.volumeChart.parentElement.style.display = 'block';

            renderPriceChart(labels, avgBuyPrices, avgSellPrices);
            renderVolumeChart(labels, buyVolumes, sellVolumes);

        } catch (err) {
            dom.historyLoading.style.display = 'none';
            dom.historyError.style.display = 'block';
        }
    }

    // Crosshair vertical line plugin for price chart
    const crosshairPlugin = {
        id: 'crosshairLine',
        afterDraw(chart) {
            if (chart.tooltip && chart.tooltip._active && chart.tooltip._active.length) {
                const activePoint = chart.tooltip._active[0];
                const ctx = chart.ctx;
                const x = activePoint.element.x;
                const topY = chart.scales.y.top;
                const bottomY = chart.scales.y.bottom;

                ctx.save();
                ctx.beginPath();
                ctx.moveTo(x, topY);
                ctx.lineTo(x, bottomY);
                ctx.lineWidth = 1;
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
                ctx.setLineDash([5, 4]);
                ctx.stroke();
                ctx.restore();
            }
        }
    };

    function renderPriceChart(labels, buyPrices, sellPrices) {
        const ctx = dom.priceChart.getContext('2d');
        priceChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Buy Price',
                        data: buyPrices,
                        borderColor: '#2ecc71',
                        backgroundColor: 'rgba(46, 204, 113, 0.1)',
                        borderWidth: 1.5,
                        pointRadius: 1.5,
                        pointBackgroundColor: '#2ecc71',
                        pointBorderColor: '#2ecc71',
                        pointHoverRadius: 4,
                        pointHitRadius: 10,
                        tension: 0.3,
                        fill: false,
                        spanGaps: true,
                    },
                    {
                        label: 'Sell Price',
                        data: sellPrices,
                        borderColor: '#e74c3c',
                        backgroundColor: 'rgba(231, 76, 60, 0.1)',
                        borderWidth: 1.5,
                        pointRadius: 1.5,
                        pointBackgroundColor: '#e74c3c',
                        pointBorderColor: '#e74c3c',
                        pointHoverRadius: 4,
                        pointHitRadius: 10,
                        tension: 0.3,
                        fill: false,
                        spanGaps: true,
                    }
                ]
            },
            plugins: [crosshairPlugin],
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: {
                        labels: { color: '#9ca0b0', font: { size: 11 } }
                    },
                    tooltip: {
                        backgroundColor: '#1a1d27',
                        titleColor: '#e8e9ed',
                        bodyColor: '#9ca0b0',
                        borderColor: '#2e3348',
                        borderWidth: 1,
                        callbacks: {
                            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y != null ? ctx.parsed.y.toLocaleString() + ' gp' : 'N/A'}`,
                            afterBody: (tooltipItems) => {
                                let buyVal = null;
                                let sellVal = null;
                                for (const item of tooltipItems) {
                                    if (item.dataset.label === 'Buy Price' && item.parsed && item.parsed.y != null) buyVal = item.parsed.y;
                                    if (item.dataset.label === 'Sell Price' && item.parsed && item.parsed.y != null) sellVal = item.parsed.y;
                                }
                                if (buyVal != null && sellVal != null) {
                                    const rawMargin = buyVal - sellVal;
                                    const geTax = Math.min(5000000, Math.max(1, Math.floor(buyVal * 0.02)));
                                    const marginAfterTax = rawMargin - geTax;
                                    const pctMargin = sellVal > 0 ? ((marginAfterTax / sellVal) * 100).toFixed(2) : '0.00';
                                    const lines = [];
                                    lines.push('');
                                    lines.push('GE Tax (2%): -' + geTax.toLocaleString() + ' gp');
                                    lines.push('Margin after tax: ' + marginAfterTax.toLocaleString() + ' gp (' + pctMargin + '%)');
                                    return lines;
                                }
                                if (buyVal != null || sellVal != null) {
                                    return ['', 'Margin: N/A (missing ' + (buyVal == null ? 'buy' : 'sell') + ' price)'];
                                }
                                return [];
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: { color: '#6b6f82', maxTicksLimit: 8, font: { size: 10 } },
                        grid: { color: 'rgba(46, 51, 72, 0.5)' }
                    },
                    y: {
                        ticks: {
                            color: '#6b6f82',
                            font: { size: 10 },
                            callback: (v) => {
                                if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
                                if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
                                if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
                                return v;
                            }
                        },
                        grid: { color: 'rgba(46, 51, 72, 0.5)' }
                    }
                }
            }
        });
    }

    function renderVolumeChart(labels, buyVol, sellVol) {
        const ctx = dom.volumeChart.getContext('2d');
        volumeChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Buy Volume',
                        data: buyVol,
                        backgroundColor: 'rgba(46, 204, 113, 0.5)',
                        borderRadius: 2,
                    },
                    {
                        label: 'Sell Volume',
                        data: sellVol,
                        backgroundColor: 'rgba(231, 76, 60, 0.5)',
                        borderRadius: 2,
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: {
                        labels: { color: '#9ca0b0', font: { size: 11 } }
                    },
                    tooltip: {
                        backgroundColor: '#1a1d27',
                        titleColor: '#e8e9ed',
                        bodyColor: '#9ca0b0',
                        borderColor: '#2e3348',
                        borderWidth: 1,
                    }
                },
                scales: {
                    x: {
                        ticks: { color: '#6b6f82', maxTicksLimit: 8, font: { size: 10 } },
                        grid: { color: 'rgba(46, 51, 72, 0.5)' },
                        stacked: true,
                    },
                    y: {
                        ticks: {
                            color: '#6b6f82',
                            font: { size: 10 },
                            callback: (v) => {
                                if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
                                if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
                                return v;
                            }
                        },
                        grid: { color: 'rgba(46, 51, 72, 0.5)' },
                        stacked: true,
                    }
                }
            }
        });
    }

    // ========================================
    // Helpers
    // ========================================

    function formatGp(value, showSign = false) {
        if (value === null || value === undefined) return '-';
        let formatted = Math.abs(value).toLocaleString();
        if (value < 0) formatted = '-' + formatted;
        if (showSign && value > 0) formatted = '+' + formatted;
        return formatted + ' gp';
    }

    function animateGpValue(el, from, to, showSign) {
        if (from == null || to == null) { el.textContent = formatGp(to, showSign); return; }
        from = Math.round(from);
        to = Math.round(to);
        if (from === to || !effectsEnabled) { el.textContent = formatGp(to, showSign); return; }

        const duration = 600;
        const start = performance.now();
        const diff = to - from;

        function tick(now) {
            const elapsed = now - start;
            const progress = Math.min(elapsed / duration, 1);
            // ease-out quad
            const eased = 1 - (1 - progress) * (1 - progress);
            const current = Math.round(from + diff * eased);
            el.textContent = formatGp(current, showSign);
            if (progress < 1) requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
    }

    function timeAgo(date) {
        const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function debounce(fn, ms) {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), ms);
        };
    }

    function updateLastUpdatedTimer() {
        if (!dataLoadedAt) return;
        const elapsed = Math.floor((Date.now() - dataLoadedAt) / 1000);
        if (elapsed < 5) {
            dom.lastUpdated.textContent = 'Just now';
        } else if (elapsed < 60) {
            dom.lastUpdated.textContent = `${elapsed}s ago`;
        } else if (elapsed < 3600) {
            const m = Math.floor(elapsed / 60);
            const s = elapsed % 60;
            dom.lastUpdated.textContent = `${m}m ${s}s ago`;
        } else {
            const h = Math.floor(elapsed / 3600);
            const m = Math.floor((elapsed % 3600) / 60);
            dom.lastUpdated.textContent = `${h}h ${m}m ago`;
        }
    }

    // ========================================
    // UI State
    // ========================================

    function showLoading() {
        dom.loadingContainer.style.display = 'flex';
        dom.errorContainer.style.display = 'none';
        dom.mainContent.style.display = 'none';
    }

    function showError(msg) {
        dom.loadingContainer.style.display = 'none';
        dom.errorContainer.style.display = 'flex';
        dom.mainContent.style.display = 'none';
        dom.errorMessage.textContent = msg || 'Something went wrong. The OSRS Wiki API might be temporarily unavailable.';
    }

    function showMain() {
        dom.loadingContainer.style.display = 'none';
        dom.errorContainer.style.display = 'none';
        dom.mainContent.style.display = 'block';
        isLoading = false;
        updateFavoritesCount();
    }

    // ========================================
    // Item Spotlight
    // ========================================

    function initSpotlight() {
        const banner = document.getElementById('spotlightBanner');
        if (!banner || allItems.length === 0) return;

        // Pick a random mid-tier item (10K - 10M GP) that has an examine blurb
        const midTier = allItems.filter(item => {
            const price = item.buyPrice || item.sellPrice || 0;
            return price >= 10000 && price <= 10000000 && item.examine;
        });
        if (midTier.length === 0) return;

        const item = midTier[Math.floor(Math.random() * midTier.length)];
        const iconUrl = getIconUrl(item.icon);

        document.getElementById('spotlightIcon').src = iconUrl;
        document.getElementById('spotlightIcon').onerror = function() { this.style.display = 'none'; };
        document.getElementById('spotlightName').textContent = item.name;
        document.getElementById('spotlightLore').textContent = '"' + item.examine + '"';
        document.getElementById('spotlightPrice').textContent = formatGp(item.buyPrice || item.sellPrice);

        banner.style.display = '';
        banner.classList.add('visible');

        document.getElementById('spotlightView').addEventListener('click', () => {
            openModal(item);
        });

        document.getElementById('spotlightClose').addEventListener('click', () => {
            banner.classList.remove('visible');
            banner.style.display = 'none';
        });
    }

    // ========================================
    // Event Listeners
    // ========================================

    function initEvents() {
        // Search
        const debouncedFilter = debounce(applyFilters, DEBOUNCE_MS);
        dom.searchInput.addEventListener('input', () => {
            dom.clearSearch.classList.toggle('visible', dom.searchInput.value.length > 0);
            debouncedFilter();
        });

        dom.clearSearch.addEventListener('click', () => {
            dom.searchInput.value = '';
            dom.clearSearch.classList.remove('visible');
            applyFilters();
            dom.searchInput.focus();
        });

        // Filters
        dom.membersFilter.addEventListener('change', applyFilters);
        dom.minPrice.addEventListener('input', debounce(applyFilters, 500));
        dom.maxPrice.addEventListener('input', debounce(applyFilters, 500));
        dom.minMargin.addEventListener('input', debounce(applyFilters, 500));
        dom.maxMargin.addEventListener('input', debounce(applyFilters, 500));
        dom.minVolume.addEventListener('input', debounce(applyFilters, 500));
        dom.maxVolume.addEventListener('input', debounce(applyFilters, 500));
        dom.minBuyLimit.addEventListener('input', debounce(applyFilters, 500));
        dom.maxBuyLimit.addEventListener('input', debounce(applyFilters, 500));
        dom.sortBy.addEventListener('change', applyFilters);

        // Budget (What Can I Afford?)
        const budgetInput = document.getElementById('budgetInput');
        const budgetToggle = document.getElementById('budgetToggle');
        
        // Clear any auto-filled values from password managers
        budgetInput.addEventListener('focus', () => {
            if (budgetInput.value && isNaN(parseNumberWithSuffix(budgetInput.value))) {
                budgetInput.value = '';
            }
        });
        
        budgetToggle.addEventListener('click', () => {
            budgetToggle.classList.toggle('active');
            budgetToggle.textContent = budgetToggle.classList.contains('active') ? 'On' : 'Go';
            applyFilters();
        });
        budgetInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (!budgetToggle.classList.contains('active')) {
                    budgetToggle.classList.add('active');
                    budgetToggle.textContent = 'On';
                }
                applyFilters();
            }
        });

        // Save Filters
        dom.saveFilters.addEventListener('click', saveFiltersToStorage);

        // Reset
        dom.resetFilters.addEventListener('click', () => {
            resetAllFilters();
        });

        // Logo home reset
        document.getElementById('logoHome').addEventListener('click', () => {
            showFavoritesOnly = false;
            dom.filterAll.classList.add('active');
            dom.filterFavorites.classList.remove('active');
            resetAllFilters();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });

        // View Toggle
        document.querySelectorAll('.view-btn[data-view]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.view-btn[data-view]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentView = btn.dataset.view;
                renderItems();
            });
        });

        // Favorites filter toggle (All / Favorites)
        dom.filterAll.addEventListener('click', () => {
            showFavoritesOnly = false;
            dom.filterAll.classList.add('active');
            dom.filterFavorites.classList.remove('active');
            applyFilters();
        });

        dom.filterFavorites.addEventListener('click', () => {
            showFavoritesOnly = true;
            dom.filterFavorites.classList.add('active');
            dom.filterAll.classList.remove('active');
            applyFilters();
        });

        // Favorites stat box click -> toggle to favorites
        dom.favoritesStatBox.addEventListener('click', () => {
            showFavoritesOnly = true;
            dom.filterFavorites.classList.add('active');
            dom.filterAll.classList.remove('active');
            applyFilters();
        });

        // Set initial active state for filter toggle
        dom.filterAll.classList.add('active');

        // Pagination
        dom.prevPage.addEventListener('click', () => {
            if (currentPage > 1) {
                currentPage--;
                renderItems();
                scrollToItems();
            }
        });

        dom.nextPage.addEventListener('click', () => {
            const totalPgs = Math.ceil(filteredItems.length / ITEMS_PER_PAGE);
            if (currentPage < totalPgs) {
                currentPage++;
                renderItems();
                scrollToItems();
            }
        });

        // Modal
        dom.modalClose.addEventListener('click', () => closeModal());
        dom.modalOverlay.addEventListener('click', (e) => {
            if (e.target === dom.modalOverlay) closeModal();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeModal();
        });

        // Handle browser back/forward navigation
        window.addEventListener('popstate', (e) => {
            const path = window.location.pathname.replace(/^\//, '');
            if (path) {
                const item = findItemBySlug(path);
                if (item) {
                    openModal(item);
                } else {
                    closeModal(true);
                }
            } else {
                closeModal(true);
            }
        });

        // Modal favorite button
        dom.modalFavBtn.addEventListener('click', (e) => {
            if (currentModalItemId != null) {
                const wasFav = isFavorite(currentModalItemId);
                toggleFavorite(currentModalItemId);
                dom.modalFavBtn.classList.toggle('is-fav', isFavorite(currentModalItemId));
                if (!wasFav) {
                    const rect = dom.modalFavBtn.getBoundingClientRect();
                    spawnConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
                }
                // Also update the card's fav button if visible
                const cardBtn = document.querySelector(`.card-fav-btn[data-item-id="${currentModalItemId}"]`);
                if (cardBtn) cardBtn.classList.toggle('is-fav', isFavorite(currentModalItemId));
                // If favorites-only and un-faved, we could close or re-render later
            }
        });

        // History tabs
        document.querySelectorAll('.history-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.history-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                if (currentModalItemId != null) {
                    loadHistory(currentModalItemId, tab.dataset.period);
                }
            });
        });

        // Retry
        dom.retryBtn.addEventListener('click', loadData);

    // Scroll: collapse filters + spotlight once user scrolls, only show when back at very top
        const filtersRow = document.querySelector('.filters-row');
        const mainContent = document.querySelector('.main-content');
        let ticking = false;
        window.addEventListener('scroll', () => {
            if (!ticking) {
                requestAnimationFrame(() => {
                    const currentY = window.scrollY;
                    if (currentY === 0) {
                        filtersRow.classList.remove('collapsed');
                        mainContent.classList.remove('filters-hidden');
                    } else if (!filtersRow.classList.contains('collapsed')) {
                        filtersRow.classList.add('collapsed');
                        mainContent.classList.add('filters-hidden');
                    }
                    dom.backToTop.classList.toggle('visible', currentY > 400);
                    ticking = false;
                });
                ticking = true;
            }
        });
        dom.backToTop.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });

        // Keyboard shortcut: focus search with /
        document.addEventListener('keydown', (e) => {
            if (e.key === '/' && !isInputFocused()) {
                e.preventDefault();
                dom.searchInput.focus();
            }
        });
    }

    function scrollToItems() {
        dom.mainContent.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function isInputFocused() {
        const el = document.activeElement;
        return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
    }

    // ========================================
    // Seasonal Themes
    // ========================================

    function initSeasonalTheme() {
        const season = detectSeason();
        if (!season) return;

        // Check if user dismissed this season's banner
        const dismissed = localStorage.getItem('ge_season_dismissed');
        if (dismissed === season.id) return;

        // Apply season data attribute
        document.documentElement.setAttribute('data-season', season.id);

        // Create banner
        const banner = document.createElement('div');
        banner.className = 'seasonal-banner';
        banner.innerHTML = `
            <span class="seasonal-emoji">${season.emoji}</span>
            ${season.message}
            <span class="seasonal-emoji">${season.emoji}</span>
            <button class="seasonal-close" title="Dismiss">&times;</button>
        `;
        document.body.insertBefore(banner, document.body.firstChild);

        banner.querySelector('.seasonal-close').addEventListener('click', () => {
            banner.remove();
            document.documentElement.removeAttribute('data-season');
            localStorage.setItem('ge_season_dismissed', season.id);
        });
    }

    function detectSeason() {
        const now = new Date();
        const month = now.getMonth(); // 0-indexed
        const day = now.getDate();

        // Christmas: Dec 1 – Dec 31
        if (month === 11) {
            return { id: 'christmas', emoji: '🎄', message: 'Happy Holidays, adventurer! May your drops be merry and bright.' };
        }
        // Halloween: Oct 15 – Oct 31
        if (month === 9 && day >= 15) {
            return { id: 'halloween', emoji: '🎃', message: 'Spooky season in Gielinor! Watch out for revenants...' };
        }
        // Leagues: typically Nov (approximate)
        if (month === 10) {
            return { id: 'leagues', emoji: '🏆', message: 'Leagues season is here! Check out the special game mode.' };
        }
        // Deadman Mode: typically Mar (approximate)
        if (month === 1) {
            return { id: 'dmm', emoji: '💀', message: 'Deadman Mode is live! PvP prices may shift dramatically.' };
        }

        return null;
    }

    // ========================================
    // GE Radio — OSRS Ambient Soundtrack
    // ========================================

    // Direct .ogg links from oldschool.runescape.wiki — all 834 OSRS music tracks
    const GE_RADIO_TRACKS = [
        { name: '7th Realm', url: 'https://oldschool.runescape.wiki/images/7th_Realm.ogg' },
        { name: 'Adventure', url: 'https://oldschool.runescape.wiki/images/Adventure.ogg' },
        { name: 'Al Kharid', url: 'https://oldschool.runescape.wiki/images/Al_Kharid.ogg?2dafe' },
        { name: 'Alchemical Attack!', url: 'https://oldschool.runescape.wiki/images/Alchemical_Attack!.ogg' },
        { name: 'All Aboard', url: 'https://oldschool.runescape.wiki/images/All_Aboard.ogg' },
        { name: 'All the Trimmings', url: 'https://oldschool.runescape.wiki/images/All_the_Trimmings.ogg' },
        { name: 'All\'s Fairy in Love & War', url: 'https://oldschool.runescape.wiki/images/All%27s_Fairy_in_Love_%26_War.ogg' },
        { name: 'Alone', url: 'https://oldschool.runescape.wiki/images/Alone.ogg' },
        { name: 'Altar Ego', url: 'https://oldschool.runescape.wiki/images/Altar_Ego.ogg' },
        { name: 'Alternative Root', url: 'https://oldschool.runescape.wiki/images/Alternative_Root.ogg' },
        { name: 'Amascut\'s Promise', url: 'https://oldschool.runescape.wiki/images/Amascut%27s_Promise.ogg' },
        { name: 'Ambient Jungle', url: 'https://oldschool.runescape.wiki/images/Ambient_Jungle.ogg' },
        { name: 'The Ancient Prison', url: 'https://oldschool.runescape.wiki/images/The_Ancient_Prison.ogg' },
        { name: 'The Angel\'s Fury', url: 'https://oldschool.runescape.wiki/images/The_Angel%27s_Fury.ogg' },
        { name: 'Anywhere', url: 'https://oldschool.runescape.wiki/images/Anywhere.ogg' },
        { name: 'Ape-ex Predator', url: 'https://oldschool.runescape.wiki/images/Ape-ex_Predator.ogg' },
        { name: 'Arabian', url: 'https://oldschool.runescape.wiki/images/Arabian.ogg' },
        { name: 'Arabian 2', url: 'https://oldschool.runescape.wiki/images/Arabian_2.ogg' },
        { name: 'Arabian 3', url: 'https://oldschool.runescape.wiki/images/Arabian_3.ogg' },
        { name: 'Arabique', url: 'https://oldschool.runescape.wiki/images/Arabique.ogg' },
        { name: 'Arachnids of Vampyrium', url: 'https://oldschool.runescape.wiki/images/Arachnids_of_Vampyrium.ogg?b65d6' },
        { name: 'Arboretum', url: 'https://oldschool.runescape.wiki/images/Arboretum.ogg' },
        { name: 'Arcane', url: 'https://oldschool.runescape.wiki/images/Arcane.ogg' },
        { name: 'Architects of Prifddinas', url: 'https://oldschool.runescape.wiki/images/Architects_of_Prifddinas.ogg' },
        { name: 'Are You Not Entertained?', url: 'https://oldschool.runescape.wiki/images/Are_You_Not_Entertained.ogg' },
        { name: 'Armadyl Alliance', url: 'https://oldschool.runescape.wiki/images/Armadyl_Alliance.ogg' },
        { name: 'Armageddon', url: 'https://oldschool.runescape.wiki/images/Armageddon.ogg' },
        { name: 'Army of Darkness', url: 'https://oldschool.runescape.wiki/images/Army_of_Darkness.ogg' },
        { name: 'Arrival', url: 'https://oldschool.runescape.wiki/images/Arrival.ogg' },
        { name: 'Artistry', url: 'https://oldschool.runescape.wiki/images/Artistry.ogg' },
        { name: 'Ascent', url: 'https://oldschool.runescape.wiki/images/Ascent.ogg' },
        { name: 'Assault and Battery', url: 'https://oldschool.runescape.wiki/images/Assault_and_Battery.ogg' },
        { name: 'Attack 1', url: 'https://oldschool.runescape.wiki/images/Attack_1.ogg' },
        { name: 'Attack 2', url: 'https://oldschool.runescape.wiki/images/Attack_2.ogg' },
        { name: 'Attack 3', url: 'https://oldschool.runescape.wiki/images/Attack_3.ogg' },
        { name: 'Attack 4', url: 'https://oldschool.runescape.wiki/images/Attack_4.ogg' },
        { name: 'Attack 5', url: 'https://oldschool.runescape.wiki/images/Attack_5.ogg' },
        { name: 'Attack 6', url: 'https://oldschool.runescape.wiki/images/Attack_6.ogg' },
        { name: 'Attention', url: 'https://oldschool.runescape.wiki/images/Attention.ogg' },
        { name: 'Autumn Voyage', url: 'https://oldschool.runescape.wiki/images/Autumn_Voyage.ogg' },
        { name: 'Awful Anthem', url: 'https://oldschool.runescape.wiki/images/Awful_Anthem.ogg' },
        { name: 'Aye Car Rum Ba', url: 'https://oldschool.runescape.wiki/images/Aye_Car_Rum_Ba.ogg' },
        { name: 'Aztec', url: 'https://oldschool.runescape.wiki/images/Aztec.ogg' },
        { name: 'Back to Life', url: 'https://oldschool.runescape.wiki/images/Back_to_Life.ogg' },
        { name: 'Background', url: 'https://oldschool.runescape.wiki/images/Background.ogg' },
        { name: 'Bait', url: 'https://oldschool.runescape.wiki/images/Bait.ogg' },
        { name: 'Ballad of Enchantment', url: 'https://oldschool.runescape.wiki/images/Ballad_of_Enchantment.ogg' },
        { name: 'Ballad of the Basilisk', url: 'https://oldschool.runescape.wiki/images/Ballad_of_the_Basilisk.ogg' },
        { name: 'Bandit Camp', url: 'https://oldschool.runescape.wiki/images/Bandit_Camp.ogg' },
        { name: 'Bandos Battalion', url: 'https://oldschool.runescape.wiki/images/Bandos_Battalion.ogg' },
        { name: 'Bane', url: 'https://oldschool.runescape.wiki/images/Bane.ogg' },
        { name: 'The Bane of Ashihama', url: 'https://oldschool.runescape.wiki/images/The_Bane_of_Ashihama.ogg' },
        { name: 'Barb Wire', url: 'https://oldschool.runescape.wiki/images/Barb_Wire.ogg' },
        { name: 'Barbarian Workout', url: 'https://oldschool.runescape.wiki/images/Barbarian_Workout.ogg' },
        { name: 'Barbarianism', url: 'https://oldschool.runescape.wiki/images/Barbarianism.ogg' },
        { name: 'Barking Mad', url: 'https://oldschool.runescape.wiki/images/Barking_Mad.ogg' },
        { name: 'Baroque', url: 'https://oldschool.runescape.wiki/images/Baroque.ogg' },
        { name: 'Barren Land', url: 'https://oldschool.runescape.wiki/images/Barren_Land.ogg' },
        { name: 'Beetle Juice', url: 'https://oldschool.runescape.wiki/images/Beetle_Juice.ogg' },
        { name: 'Below the Conch', url: 'https://oldschool.runescape.wiki/images/Below_the_Conch.ogg' },
        { name: 'Beneath Cursed Sands', url: 'https://oldschool.runescape.wiki/images/Beneath_Cursed_Sands.ogg' },
        { name: 'Beneath the Kingdom', url: 'https://oldschool.runescape.wiki/images/Beneath_the_Kingdom.ogg' },
        { name: 'Beneath the Stronghold', url: 'https://oldschool.runescape.wiki/images/Beneath_the_Stronghold.ogg' },
        { name: 'Beyond', url: 'https://oldschool.runescape.wiki/images/Beyond.ogg' },
        { name: 'Beyond the Meadow', url: 'https://oldschool.runescape.wiki/images/Beyond_the_Meadow.ogg' },
        { name: 'Big Chords', url: 'https://oldschool.runescape.wiki/images/Big_Chords.ogg' },
        { name: 'Black of Knight', url: 'https://oldschool.runescape.wiki/images/Black_of_Knight.ogg' },
        { name: 'Blistering Barnacles', url: 'https://oldschool.runescape.wiki/images/Blistering_Barnacles.ogg' },
        { name: 'Blood Rush', url: 'https://oldschool.runescape.wiki/images/Blood_Rush.ogg' },
        { name: 'Bloodbath', url: 'https://oldschool.runescape.wiki/images/Bloodbath.ogg' },
        { name: 'Bob\'s on Holiday', url: 'https://oldschool.runescape.wiki/images/Bob%27s_on_Holiday.ogg' },
        { name: 'Body Parts', url: 'https://oldschool.runescape.wiki/images/Body_Parts.ogg' },
        { name: 'Bolrie\'s Diary', url: 'https://oldschool.runescape.wiki/images/Bolrie%27s_Diary.ogg' },
        { name: 'Bone Dance', url: 'https://oldschool.runescape.wiki/images/Bone_Dance.ogg' },
        { name: 'Bone Dry', url: 'https://oldschool.runescape.wiki/images/Bone_Dry.ogg' },
        { name: 'Book of Spells', url: 'https://oldschool.runescape.wiki/images/Book_of_Spells.ogg' },
        { name: 'Borderland', url: 'https://oldschool.runescape.wiki/images/Borderland.ogg' },
        { name: 'Box of Delights', url: 'https://oldschool.runescape.wiki/images/Box_of_Delights.ogg' },
        { name: 'Brain Battle', url: 'https://oldschool.runescape.wiki/images/Brain_Battle.ogg' },
        { name: 'Breeze', url: 'https://oldschool.runescape.wiki/images/Breeze.ogg' },
        { name: 'Brew Hoo Hoo!', url: 'https://oldschool.runescape.wiki/images/Brew_Hoo_Hoo!.ogg' },
        { name: 'Brimstail\'s Scales', url: 'https://oldschool.runescape.wiki/images/Brimstail%27s_Scales.ogg' },
        { name: 'Bubble and Squeak', url: 'https://oldschool.runescape.wiki/images/Bubble_and_Squeak.ogg' },
        { name: 'Bunny\'s Sugar Rush', url: 'https://oldschool.runescape.wiki/images/Bunny%27s_Sugar_Rush.ogg' },
        { name: 'Burning Desire', url: 'https://oldschool.runescape.wiki/images/Burning_Desire.ogg' },
        { name: 'The Burning Sun', url: 'https://oldschool.runescape.wiki/images/The_Burning_Sun.ogg' },
        { name: 'Cabin Fever', url: 'https://oldschool.runescape.wiki/images/Cabin_Fever.ogg' },
        { name: 'Cain\'s Tutorial', url: 'https://oldschool.runescape.wiki/images/Cain%27s_Tutorial.ogg' },
        { name: 'Call of the Tlati', url: 'https://oldschool.runescape.wiki/images/Call_of_the_Tlati.ogg' },
        { name: 'Camelot', url: 'https://oldschool.runescape.wiki/images/Camelot.ogg' },
        { name: 'Castle Wars', url: 'https://oldschool.runescape.wiki/images/Castle_Wars.ogg' },
        { name: 'Catacombs and Tombs', url: 'https://oldschool.runescape.wiki/images/Catacombs_and_Tombs.ogg' },
        { name: 'Catch Me If You Can', url: 'https://oldschool.runescape.wiki/images/Catch_Me_If_You_Can.ogg' },
        { name: 'Cave Background', url: 'https://oldschool.runescape.wiki/images/Cave_Background.ogg' },
        { name: 'Cave of Beasts', url: 'https://oldschool.runescape.wiki/images/Cave_of_Beasts.ogg' },
        { name: 'Cave of the Goblins', url: 'https://oldschool.runescape.wiki/images/Cave_of_the_Goblins.ogg' },
        { name: 'Cavern', url: 'https://oldschool.runescape.wiki/images/Cavern.ogg' },
        { name: 'The Cellar Dwellers', url: 'https://oldschool.runescape.wiki/images/The_Cellar_Dwellers.ogg' },
        { name: 'Cellar Song', url: 'https://oldschool.runescape.wiki/images/Cellar_Song.ogg' },
        { name: 'Chain of Command', url: 'https://oldschool.runescape.wiki/images/Chain_of_Command.ogg' },
        { name: 'Chamber', url: 'https://oldschool.runescape.wiki/images/Chamber.ogg' },
        { name: 'Chef Surprise', url: 'https://oldschool.runescape.wiki/images/Chef_Surprise.ogg' },
        { name: 'Chickened Out', url: 'https://oldschool.runescape.wiki/images/Chickened_Out.ogg' },
        { name: 'Children of the Sun', url: 'https://oldschool.runescape.wiki/images/Children_of_the_Sun.ogg' },
        { name: 'Chompy Hunt', url: 'https://oldschool.runescape.wiki/images/Chompy_Hunt.ogg' },
        { name: 'The Chosen', url: 'https://oldschool.runescape.wiki/images/The_Chosen.ogg' },
        { name: 'City of the Dead', url: 'https://oldschool.runescape.wiki/images/City_of_the_Dead.ogg' },
        { name: 'The City of Sun', url: 'https://oldschool.runescape.wiki/images/The_City_of_Sun.ogg' },
        { name: 'Clan Wars', url: 'https://oldschool.runescape.wiki/images/Clan_Wars.ogg' },
        { name: 'Clanliness', url: 'https://oldschool.runescape.wiki/images/Clanliness.ogg' },
        { name: 'Claustrophobia', url: 'https://oldschool.runescape.wiki/images/Claustrophobia.ogg' },
        { name: 'Close Quarters', url: 'https://oldschool.runescape.wiki/images/Close_Quarters.ogg' },
        { name: 'Coil', url: 'https://oldschool.runescape.wiki/images/Coil.ogg' },
        { name: 'Colossus of the Deep', url: 'https://oldschool.runescape.wiki/images/Colossus_of_the_Deep.ogg' },
        { name: 'Competition', url: 'https://oldschool.runescape.wiki/images/Competition.ogg' },
        { name: 'Complication', url: 'https://oldschool.runescape.wiki/images/Complication.ogg' },
        { name: 'Confrontation', url: 'https://oldschool.runescape.wiki/images/Confrontation.ogg' },
        { name: 'The Consortium', url: 'https://oldschool.runescape.wiki/images/The_Consortium.ogg' },
        { name: 'Conspiracy', url: 'https://oldschool.runescape.wiki/images/Conspiracy.ogg' },
        { name: 'Contest', url: 'https://oldschool.runescape.wiki/images/Contest.ogg' },
        { name: 'Corporal Punishment', url: 'https://oldschool.runescape.wiki/images/Corporal_Punishment.ogg' },
        { name: 'Corridors of Power', url: 'https://oldschool.runescape.wiki/images/Corridors_of_Power.ogg' },
        { name: 'Country Jig', url: 'https://oldschool.runescape.wiki/images/Country_Jig.ogg' },
        { name: 'Courage', url: 'https://oldschool.runescape.wiki/images/Courage.ogg' },
        { name: 'Crashing Waves', url: 'https://oldschool.runescape.wiki/images/Crashing_Waves.ogg' },
        { name: 'Creature Cruelty', url: 'https://oldschool.runescape.wiki/images/Creature_Cruelty.ogg' },
        { name: 'Creatures of Varlamore', url: 'https://oldschool.runescape.wiki/images/Creatures_of_Varlamore.ogg' },
        { name: 'Creeping Vines', url: 'https://oldschool.runescape.wiki/images/Creeping_Vines.ogg' },
        { name: 'Crest of a Wave', url: 'https://oldschool.runescape.wiki/images/Crest_of_a_Wave.ogg' },
        { name: 'Crystal Castle', url: 'https://oldschool.runescape.wiki/images/Crystal_Castle.ogg' },
        { name: 'Crystal Cave', url: 'https://oldschool.runescape.wiki/images/Crystal_Cave.ogg' },
        { name: 'Crystal Sword', url: 'https://oldschool.runescape.wiki/images/Crystal_Sword.ogg' },
        { name: 'Cursed', url: 'https://oldschool.runescape.wiki/images/Cursed.ogg' },
        { name: 'The Curtain Closes', url: 'https://oldschool.runescape.wiki/images/The_Curtain_Closes.ogg' },
        { name: 'Dagannoth Dawn', url: 'https://oldschool.runescape.wiki/images/Dagannoth_Dawn.ogg' },
        { name: 'Dance of Death', url: 'https://oldschool.runescape.wiki/images/Dance_of_Death.ogg' },
        { name: 'Dance of the Meilyr', url: 'https://oldschool.runescape.wiki/images/Dance_of_the_Meilyr.ogg' },
        { name: 'Dance of the Nylocas', url: 'https://oldschool.runescape.wiki/images/Dance_of_the_Nylocas.ogg' },
        { name: 'Dance of the Undead', url: 'https://oldschool.runescape.wiki/images/Dance_of_the_Undead.ogg' },
        { name: 'Dangerous', url: 'https://oldschool.runescape.wiki/images/Dangerous.ogg' },
        { name: 'A Dangerous Game', url: 'https://oldschool.runescape.wiki/images/A_Dangerous_Game.ogg' },
        { name: 'Dangerous Logic', url: 'https://oldschool.runescape.wiki/images/Dangerous_Logic.ogg' },
        { name: 'Dangerous Road', url: 'https://oldschool.runescape.wiki/images/Dangerous_Road.ogg' },
        { name: 'Dangerous Way', url: 'https://oldschool.runescape.wiki/images/Dangerous_Way.ogg' },
        { name: 'Dark', url: 'https://oldschool.runescape.wiki/images/Dark.ogg' },
        { name: 'The Dark Beast Sotetseg', url: 'https://oldschool.runescape.wiki/images/The_Dark_Beast_Sotetseg.ogg' },
        { name: 'Darkly Altared', url: 'https://oldschool.runescape.wiki/images/Darkly_Altared.ogg' },
        { name: 'Darkmeyer', url: 'https://oldschool.runescape.wiki/images/Darkmeyer.ogg' },
        { name: 'Darkness in the Depths', url: 'https://oldschool.runescape.wiki/images/Darkness_in_the_Depths.ogg' },
        { name: 'Davy Jones\' Locker', url: 'https://oldschool.runescape.wiki/images/Davy_Jones%27_Locker.ogg' },
        { name: 'Dead Can Dance', url: 'https://oldschool.runescape.wiki/images/Dead_Can_Dance.ogg' },
        { name: 'Dead Quiet', url: 'https://oldschool.runescape.wiki/images/Dead_Quiet.ogg' },
        { name: 'Deadlands', url: 'https://oldschool.runescape.wiki/images/Deadlands.ogg' },
        { name: 'Deep Down', url: 'https://oldschool.runescape.wiki/images/Deep_Down.ogg' },
        { name: 'Deep Wildy', url: 'https://oldschool.runescape.wiki/images/Deep_Wildy.ogg' },
        { name: 'Delrith', url: 'https://oldschool.runescape.wiki/images/Delrith.ogg' },
        { name: 'The Depths', url: 'https://oldschool.runescape.wiki/images/The_Depths.ogg' },
        { name: 'Desert Heat', url: 'https://oldschool.runescape.wiki/images/Desert_Heat.ogg' },
        { name: 'Desert Voyage', url: 'https://oldschool.runescape.wiki/images/Desert_Voyage.ogg' },
        { name: 'The Desert', url: 'https://oldschool.runescape.wiki/images/The_Desert.ogg' },
        { name: 'The Desolate Isle', url: 'https://oldschool.runescape.wiki/images/The_Desolate_Isle.ogg' },
        { name: 'The Desolate Mage', url: 'https://oldschool.runescape.wiki/images/The_Desolate_Mage.ogg' },
        { name: 'A Desolate Past', url: 'https://oldschool.runescape.wiki/images/A_Desolate_Past.ogg' },
        { name: 'Devils May Care', url: 'https://oldschool.runescape.wiki/images/Devils_May_Care.ogg' },
        { name: 'Diango\'s Little Helpers', url: 'https://oldschool.runescape.wiki/images/Diango%27s_Little_Helpers.ogg' },
        { name: 'Dies Irae', url: 'https://oldschool.runescape.wiki/images/Dies_Irae.ogg' },
        { name: 'Dimension X', url: 'https://oldschool.runescape.wiki/images/Dimension_X.ogg' },
        { name: 'Distant Land', url: 'https://oldschool.runescape.wiki/images/Distant_Land.ogg' },
        { name: 'Distillery Hilarity', url: 'https://oldschool.runescape.wiki/images/Distillery_Hilarity.ogg' },
        { name: 'Dogs of War', url: 'https://oldschool.runescape.wiki/images/Dogs_of_War.ogg' },
        { name: 'Dogfight', url: 'https://oldschool.runescape.wiki/images/Dogfight.ogg' },
        { name: 'Domain of the Vampyres', url: 'https://oldschool.runescape.wiki/images/Domain_of_the_Vampyres.ogg' },
        { name: 'Don\'t Panic Zanik', url: 'https://oldschool.runescape.wiki/images/Don%27t_Panic_Zanik.ogg' },
        { name: 'The Doom', url: 'https://oldschool.runescape.wiki/images/The_Doom.ogg' },
        { name: 'The Doors of Dinh', url: 'https://oldschool.runescape.wiki/images/The_Doors_of_Dinh.ogg' },
        { name: 'Doorways', url: 'https://oldschool.runescape.wiki/images/Doorways.ogg' },
        { name: 'Dorgeshuun City', url: 'https://oldschool.runescape.wiki/images/Dorgeshuun_City.ogg' },
        { name: 'Dorgeshuun Deep', url: 'https://oldschool.runescape.wiki/images/Dorgeshuun_Deep.ogg' },
        { name: 'Dorgeshuun Treaty', url: 'https://oldschool.runescape.wiki/images/Dorgeshuun_Treaty.ogg' },
        { name: 'Dot\'s Yuletide', url: 'https://oldschool.runescape.wiki/images/Dot%27s_Yuletide.ogg' },
        { name: 'Down and Out', url: 'https://oldschool.runescape.wiki/images/Down_and_Out.ogg' },
        { name: 'Down Below', url: 'https://oldschool.runescape.wiki/images/Down_Below.ogg' },
        { name: 'Down by the Docks', url: 'https://oldschool.runescape.wiki/images/Down_by_the_Docks.ogg' },
        { name: 'Down to Earth', url: 'https://oldschool.runescape.wiki/images/Down_to_Earth.ogg' },
        { name: 'The Dragon Slayer', url: 'https://oldschool.runescape.wiki/images/The_Dragon_Slayer.ogg' },
        { name: 'Dragontooth Island', url: 'https://oldschool.runescape.wiki/images/Dragontooth_Island.ogg' },
        { name: 'Dream', url: 'https://oldschool.runescape.wiki/images/Dream.ogg' },
        { name: 'Dreamstate', url: 'https://oldschool.runescape.wiki/images/Dreamstate.ogg' },
        { name: 'The Dream Theatre', url: 'https://oldschool.runescape.wiki/images/The_Dream_Theatre.ogg' },
        { name: 'Dunes of Eternity', url: 'https://oldschool.runescape.wiki/images/Dunes_of_Eternity.ogg' },
        { name: 'Dunjun', url: 'https://oldschool.runescape.wiki/images/Dunjun.ogg' },
        { name: 'Dusk in Yu\'biusk', url: 'https://oldschool.runescape.wiki/images/Dusk_in_Yu%27biusk.ogg' },
        { name: 'Dwarf Theme', url: 'https://oldschool.runescape.wiki/images/Dwarf_Theme.ogg' },
        { name: 'Dwarven Domain', url: 'https://oldschool.runescape.wiki/images/Dwarven_Domain.ogg' },
        { name: 'Dynasty', url: 'https://oldschool.runescape.wiki/images/Dynasty.ogg' },
        { name: 'Eagles\' Peak', url: 'https://oldschool.runescape.wiki/images/Eagles%27_Peak.ogg' },
        { name: 'Easter Jig', url: 'https://oldschool.runescape.wiki/images/Easter_Jig.ogg' },
        { name: 'Echoes of the North', url: 'https://oldschool.runescape.wiki/images/Echoes_of_the_North.ogg' },
        { name: 'Egypt', url: 'https://oldschool.runescape.wiki/images/Egypt.ogg' },
        { name: 'Elder Wisdom', url: 'https://oldschool.runescape.wiki/images/Elder_Wisdom.ogg' },
        { name: 'Elven Guardians', url: 'https://oldschool.runescape.wiki/images/Elven_Guardians.ogg' },
        { name: 'Elven Mist', url: 'https://oldschool.runescape.wiki/images/Elven_Mist.ogg' },
        { name: 'Elven Seed', url: 'https://oldschool.runescape.wiki/images/Elven_Seed.ogg' },
        { name: 'The Emir\'s Arena', url: 'https://oldschool.runescape.wiki/images/The_Emir%27s_Arena.ogg' },
        { name: 'Emissaries of Twilight', url: 'https://oldschool.runescape.wiki/images/Emissaries_of_Twilight.ogg' },
        { name: 'Emotion', url: 'https://oldschool.runescape.wiki/images/Emotion.ogg' },
        { name: 'Emperor', url: 'https://oldschool.runescape.wiki/images/Emperor.ogg' },
        { name: 'The Enchanter', url: 'https://oldschool.runescape.wiki/images/The_Enchanter.ogg' },
        { name: 'The Enclave', url: 'https://oldschool.runescape.wiki/images/The_Enclave.ogg' },
        { name: 'Escape', url: 'https://oldschool.runescape.wiki/images/Escape.ogg' },
        { name: 'Espionage', url: 'https://oldschool.runescape.wiki/images/Espionage.ogg' },
        { name: 'Etceteria', url: 'https://oldschool.runescape.wiki/images/Etceteria.ogg' },
        { name: 'The Eternal Waves', url: 'https://oldschool.runescape.wiki/images/The_Eternal_Waves.ogg' },
        { name: 'Eve\'s Epinette', url: 'https://oldschool.runescape.wiki/images/Eve%27s_Epinette.ogg' },
        { name: 'Everlasting', url: 'https://oldschool.runescape.wiki/images/Everlasting.ogg' },
        { name: 'Everlasting Fire', url: 'https://oldschool.runescape.wiki/images/Everlasting_Fire.ogg' },
        { name: 'The Everlasting Slumber', url: 'https://oldschool.runescape.wiki/images/The_Everlasting_Slumber.ogg' },
        { name: 'Everywhere', url: 'https://oldschool.runescape.wiki/images/Everywhere.ogg' },
        { name: 'Evil Bob\'s Island', url: 'https://oldschool.runescape.wiki/images/Evil_Bob%27s_Island.ogg' },
        { name: 'The Evil Within', url: 'https://oldschool.runescape.wiki/images/The_Evil_Within.ogg' },
        { name: 'Expanse', url: 'https://oldschool.runescape.wiki/images/Expanse.ogg' },
        { name: 'Expecting', url: 'https://oldschool.runescape.wiki/images/Expecting.ogg' },
        { name: 'Expedition', url: 'https://oldschool.runescape.wiki/images/Expedition.ogg' },
        { name: 'Exposed', url: 'https://oldschool.runescape.wiki/images/Exposed.ogg' },
        { name: 'Eye See You', url: 'https://oldschool.runescape.wiki/images/Eye_See_You.ogg' },
        { name: 'Eye of the Storm', url: 'https://oldschool.runescape.wiki/images/Eye_of_the_Storm.ogg' },
        { name: 'Faerie', url: 'https://oldschool.runescape.wiki/images/Faerie.ogg' },
        { name: 'The Fairy Dragon', url: 'https://oldschool.runescape.wiki/images/The_Fairy_Dragon.ogg' },
        { name: 'Faith of the Hefin', url: 'https://oldschool.runescape.wiki/images/Faith_of_the_Hefin.ogg' },
        { name: 'Faithless', url: 'https://oldschool.runescape.wiki/images/Faithless.ogg' },
        { name: 'The Fallen Empire', url: 'https://oldschool.runescape.wiki/images/The_Fallen_Empire.ogg' },
        { name: 'Fanfare', url: 'https://oldschool.runescape.wiki/images/Fanfare.ogg' },
        { name: 'Fanfare 2', url: 'https://oldschool.runescape.wiki/images/Fanfare_2.ogg' },
        { name: 'Fanfare 3', url: 'https://oldschool.runescape.wiki/images/Fanfare_3.ogg' },
        { name: 'Fangs for the Memory', url: 'https://oldschool.runescape.wiki/images/Fangs_for_the_Memory.ogg' },
        { name: 'Far Away', url: 'https://oldschool.runescape.wiki/images/Far_Away.ogg' },
        { name: 'The Far Side', url: 'https://oldschool.runescape.wiki/images/The_Far_Side.ogg' },
        { name: 'A Farmer\'s Grind', url: 'https://oldschool.runescape.wiki/images/A_Farmer%27s_Grind.ogg' },
        { name: 'The Fat Lady Sings', url: 'https://oldschool.runescape.wiki/images/The_Fat_Lady_Sings.ogg' },
        { name: 'Fe Fi Fo Fum', url: 'https://oldschool.runescape.wiki/images/Fe_Fi_Fo_Fum.ogg' },
        { name: 'Fear and Loathing', url: 'https://oldschool.runescape.wiki/images/Fear_and_Loathing.ogg' },
        { name: 'The Feathered Serpent', url: 'https://oldschool.runescape.wiki/images/The_Feathered_Serpent.ogg' },
        { name: 'Fenkenstrain\'s Refrain', url: 'https://oldschool.runescape.wiki/images/Fenkenstrain%27s_Refrain.ogg' },
        { name: 'A Festive Party', url: 'https://oldschool.runescape.wiki/images/A_Festive_Party.ogg' },
        { name: 'Fight of the Basilisk', url: 'https://oldschool.runescape.wiki/images/Fight_of_the_Basilisk.ogg' },
        { name: 'Fight or Flight', url: 'https://oldschool.runescape.wiki/images/Fight_or_Flight.ogg' },
        { name: 'Find My Way', url: 'https://oldschool.runescape.wiki/images/Find_My_Way.ogg' },
        { name: 'Fire and Brimstone', url: 'https://oldschool.runescape.wiki/images/Fire_and_Brimstone.ogg' },
        { name: 'Fire in the Deep', url: 'https://oldschool.runescape.wiki/images/Fire_in_the_Deep.ogg' },
        { name: 'The Fires of Lletya', url: 'https://oldschool.runescape.wiki/images/The_Fires_of_Lletya.ogg' },
        { name: 'Fishing', url: 'https://oldschool.runescape.wiki/images/Fishing.ogg' },
        { name: 'Floating Free', url: 'https://oldschool.runescape.wiki/images/Floating_Free.ogg' },
        { name: 'Flute Salad', url: 'https://oldschool.runescape.wiki/images/Flute_Salad.ogg' },
        { name: 'Food for Thought', url: 'https://oldschool.runescape.wiki/images/Food_for_Thought.ogg' },
        { name: 'Forbidden', url: 'https://oldschool.runescape.wiki/images/Forbidden.ogg' },
        { name: 'Forest', url: 'https://oldschool.runescape.wiki/images/Forest.ogg' },
        { name: 'The Forests of Shayzien', url: 'https://oldschool.runescape.wiki/images/The_Forests_of_Shayzien.ogg' },
        { name: 'Forever', url: 'https://oldschool.runescape.wiki/images/Forever.ogg' },
        { name: 'Forgettable Melody', url: 'https://oldschool.runescape.wiki/images/Forgettable_Melody.ogg' },
        { name: 'Forgotten', url: 'https://oldschool.runescape.wiki/images/Forgotten.ogg' },
        { name: 'A Forgotten Religion', url: 'https://oldschool.runescape.wiki/images/A_Forgotten_Religion.ogg' },
        { name: 'The Forgotten Tomb', url: 'https://oldschool.runescape.wiki/images/The_Forgotten_Tomb.ogg' },
        { name: 'The Forlorn Homestead', url: 'https://oldschool.runescape.wiki/images/The_Forlorn_Homestead.ogg' },
        { name: 'The Forsaken Tower', url: 'https://oldschool.runescape.wiki/images/The_Forsaken_Tower.ogg' },
        { name: 'The Forsaken', url: 'https://oldschool.runescape.wiki/images/The_Forsaken.ogg' },
        { name: 'Fossilised', url: 'https://oldschool.runescape.wiki/images/Fossilised.ogg' },
        { name: 'The Foundry', url: 'https://oldschool.runescape.wiki/images/The_Foundry.ogg' },
        { name: 'The Fragment', url: 'https://oldschool.runescape.wiki/images/The_Fragment.ogg' },
        { name: 'The Fremennik Kings', url: 'https://oldschool.runescape.wiki/images/The_Fremennik_Kings.ogg' },
        { name: 'Frogland', url: 'https://oldschool.runescape.wiki/images/Frogland.ogg' },
        { name: 'Frostbite', url: 'https://oldschool.runescape.wiki/images/Frostbite.ogg' },
        { name: 'Fruits de Mer', url: 'https://oldschool.runescape.wiki/images/Fruits_de_Mer.ogg' },
        { name: 'Ful to the Brim', url: 'https://oldschool.runescape.wiki/images/Ful_to_the_Brim.ogg' },
        { name: 'Funny Bunnies', url: 'https://oldschool.runescape.wiki/images/Funny_Bunnies.ogg' },
        { name: 'The Galleon', url: 'https://oldschool.runescape.wiki/images/The_Galleon.ogg' },
        { name: 'Gaol', url: 'https://oldschool.runescape.wiki/images/Gaol.ogg' },
        { name: 'Garden', url: 'https://oldschool.runescape.wiki/images/Garden.ogg' },
        { name: 'Garden of Autumn', url: 'https://oldschool.runescape.wiki/images/Garden_of_Autumn.ogg' },
        { name: 'Garden of Spring', url: 'https://oldschool.runescape.wiki/images/Garden_of_Spring.ogg' },
        { name: 'Garden of Summer', url: 'https://oldschool.runescape.wiki/images/Garden_of_Summer.ogg' },
        { name: 'Garden of Winter', url: 'https://oldschool.runescape.wiki/images/Garden_of_Winter.ogg' },
        { name: 'The Gates of Menaphos', url: 'https://oldschool.runescape.wiki/images/The_Gates_of_Menaphos.ogg' },
        { name: 'The Gauntlet', url: 'https://oldschool.runescape.wiki/images/The_Gauntlet.ogg' },
        { name: 'The Genie', url: 'https://oldschool.runescape.wiki/images/The_Genie.ogg' },
        { name: 'Getting Down to Business', url: 'https://oldschool.runescape.wiki/images/Getting_Down_to_Business.ogg' },
        { name: 'Gill Bill', url: 'https://oldschool.runescape.wiki/images/Gill_Bill.ogg' },
        { name: 'Gnome King', url: 'https://oldschool.runescape.wiki/images/Gnome_King.ogg' },
        { name: 'Gnome Village', url: 'https://oldschool.runescape.wiki/images/Gnome_Village.ogg' },
        { name: 'Gnome Village 2', url: 'https://oldschool.runescape.wiki/images/Gnome_Village_2.ogg' },
        { name: 'Gnome Village Party', url: 'https://oldschool.runescape.wiki/images/Gnome_Village_Party.ogg' },
        { name: 'Gnomeball', url: 'https://oldschool.runescape.wiki/images/Gnomeball.ogg' },
        { name: 'Goblin Game', url: 'https://oldschool.runescape.wiki/images/Goblin_Game.ogg' },
        { name: 'Goblin Village', url: 'https://oldschool.runescape.wiki/images/Goblin_Village.ogg' },
        { name: 'Golden Touch', url: 'https://oldschool.runescape.wiki/images/Golden_Touch.ogg' },
        { name: 'The Golem', url: 'https://oldschool.runescape.wiki/images/The_Golem.ogg' },
        { name: 'The Great North', url: 'https://oldschool.runescape.wiki/images/The_Great_North.ogg' },
        { name: 'Greatness', url: 'https://oldschool.runescape.wiki/images/Greatness.ogg' },
        { name: 'Grimly Fiendish', url: 'https://oldschool.runescape.wiki/images/Grimly_Fiendish.ogg' },
        { name: 'Grip of the Talon', url: 'https://oldschool.runescape.wiki/images/Grip_of_the_Talon.ogg' },
        { name: 'Grotto', url: 'https://oldschool.runescape.wiki/images/Grotto.ogg' },
        { name: 'Grow Grow Grow', url: 'https://oldschool.runescape.wiki/images/Grow_Grow_Grow.ogg' },
        { name: 'Grumpy', url: 'https://oldschool.runescape.wiki/images/Grumpy.ogg' },
        { name: 'The Guardian of Tapoyauik', url: 'https://oldschool.runescape.wiki/images/The_Guardian_of_Tapoyauik.ogg' },
        { name: 'Guardians of the Rift', url: 'https://oldschool.runescape.wiki/images/Guardians_of_the_Rift.ogg' },
        { name: 'The Guardians Prepare', url: 'https://oldschool.runescape.wiki/images/The_Guardians_Prepare.ogg' },
        { name: 'The Guidance of Ralos', url: 'https://oldschool.runescape.wiki/images/The_Guidance_of_Ralos.ogg' },
        { name: 'H.A.M. and Seek', url: 'https://oldschool.runescape.wiki/images/H.A.M._and_Seek.ogg' },
        { name: 'H.A.M. Attack', url: 'https://oldschool.runescape.wiki/images/H.A.M._Attack.ogg' },
        { name: 'H.A.M. Fisted', url: 'https://oldschool.runescape.wiki/images/H.A.M._Fisted.ogg' },
        { name: 'Harmony', url: 'https://oldschool.runescape.wiki/images/Harmony.ogg' },
        { name: 'Harmony 2', url: 'https://oldschool.runescape.wiki/images/Harmony_2.ogg' },
        { name: 'Haunted Mine', url: 'https://oldschool.runescape.wiki/images/Haunted_Mine.ogg' },
        { name: 'Have a Blast', url: 'https://oldschool.runescape.wiki/images/Have_a_Blast.ogg' },
        { name: 'Have an Ice Day', url: 'https://oldschool.runescape.wiki/images/Have_an_Ice_Day.ogg' },
        { name: 'Head to Head', url: 'https://oldschool.runescape.wiki/images/Head_to_Head.ogg' },
        { name: 'Healin\' Feelin\'', url: 'https://oldschool.runescape.wiki/images/Healin%27_Feelin%27.ogg' },
        { name: 'Heart and Mind', url: 'https://oldschool.runescape.wiki/images/Heart_and_Mind.ogg' },
        { name: 'Heavy Security', url: 'https://oldschool.runescape.wiki/images/Heavy_Security.ogg' },
        { name: 'The Heist', url: 'https://oldschool.runescape.wiki/images/The_Heist.ogg' },
        { name: 'Hells Bells', url: 'https://oldschool.runescape.wiki/images/Hells_Bells.ogg' },
        { name: 'Hermit', url: 'https://oldschool.runescape.wiki/images/Hermit.ogg' },
        { name: 'High Seas', url: 'https://oldschool.runescape.wiki/images/High_Seas.ogg' },
        { name: 'High Spirits', url: 'https://oldschool.runescape.wiki/images/High_Spirits.ogg' },
        { name: 'His Faithful Servants', url: 'https://oldschool.runescape.wiki/images/His_Faithful_Servants.ogg' },
        { name: 'Hoe Down', url: 'https://oldschool.runescape.wiki/images/Hoe_Down.ogg' },
        { name: 'Home Sweet Home', url: 'https://oldschool.runescape.wiki/images/Home_Sweet_Home.ogg' },
        { name: 'Honkytonky Sea Shanty 2', url: 'https://oldschool.runescape.wiki/images/Honkytonky_Sea_Shanty_2.ogg' },
        { name: 'Horizon', url: 'https://oldschool.runescape.wiki/images/Horizon.ogg' },
        { name: 'The Houses of Kourend', url: 'https://oldschool.runescape.wiki/images/The_Houses_of_Kourend.ogg' },
        { name: 'Hypnotised', url: 'https://oldschool.runescape.wiki/images/Hypnotised.ogg' },
        { name: 'Iban', url: 'https://oldschool.runescape.wiki/images/Iban.ogg' },
        { name: 'Ice and Fire', url: 'https://oldschool.runescape.wiki/images/Ice_and_Fire.ogg' },
        { name: 'Ice Melody', url: 'https://oldschool.runescape.wiki/images/Ice_Melody.ogg' },
        { name: 'Illusive', url: 'https://oldschool.runescape.wiki/images/Illusive.ogg' },
        { name: 'Impetuous', url: 'https://oldschool.runescape.wiki/images/Impetuous.ogg' },
        { name: 'Impulses', url: 'https://oldschool.runescape.wiki/images/Impulses.ogg' },
        { name: 'In Between', url: 'https://oldschool.runescape.wiki/images/In_Between.ogg' },
        { name: 'In the Brine', url: 'https://oldschool.runescape.wiki/images/In_the_Brine.ogg' },
        { name: 'In the Clink', url: 'https://oldschool.runescape.wiki/images/In_the_Clink.ogg' },
        { name: 'In the Manor', url: 'https://oldschool.runescape.wiki/images/In_the_Manor.ogg' },
        { name: 'In the Pits', url: 'https://oldschool.runescape.wiki/images/In_the_Pits.ogg' },
        { name: 'In the Shadows', url: 'https://oldschool.runescape.wiki/images/In_the_Shadows.ogg' },
        { name: 'Inadequacy', url: 'https://oldschool.runescape.wiki/images/Inadequacy.ogg' },
        { name: 'Incantation', url: 'https://oldschool.runescape.wiki/images/Incantation.ogg' },
        { name: 'Incarceration', url: 'https://oldschool.runescape.wiki/images/Incarceration.ogg' },
        { name: 'Inferno', url: 'https://oldschool.runescape.wiki/images/Inferno.ogg' },
        { name: 'Insect Queen', url: 'https://oldschool.runescape.wiki/images/Insect_Queen.ogg' },
        { name: 'Inspiration', url: 'https://oldschool.runescape.wiki/images/Inspiration.ogg' },
        { name: 'Into the Abyss', url: 'https://oldschool.runescape.wiki/images/Into_the_Abyss.ogg' },
        { name: 'Into the Blue', url: 'https://oldschool.runescape.wiki/images/Into_the_Blue.ogg' },
        { name: 'Into the Tombs', url: 'https://oldschool.runescape.wiki/images/Into_the_Tombs.ogg' },
        { name: 'Intrepid', url: 'https://oldschool.runescape.wiki/images/Intrepid.ogg' },
        { name: 'Invader', url: 'https://oldschool.runescape.wiki/images/Invader.ogg' },
        { name: 'Iorwerth\'s Lament', url: 'https://oldschool.runescape.wiki/images/Iorwerth%27s_Lament.ogg' },
        { name: 'Island Life', url: 'https://oldschool.runescape.wiki/images/Island_Life.ogg' },
        { name: 'Island of the Trolls', url: 'https://oldschool.runescape.wiki/images/Island_of_the_Trolls.ogg' },
        { name: 'Isle of Everywhere', url: 'https://oldschool.runescape.wiki/images/Isle_of_Everywhere.ogg' },
        { name: 'Isle of Serenity', url: 'https://oldschool.runescape.wiki/images/Isle_of_Serenity.ogg' },
        { name: 'It\'s not over \'til...', url: 'https://oldschool.runescape.wiki/images/It%27s_not_over_%27til....ogg' },
        { name: 'Itsy Bitsy...', url: 'https://oldschool.runescape.wiki/images/Itsy_Bitsy....ogg' },
        { name: 'Jaws of the Basilisk', url: 'https://oldschool.runescape.wiki/images/Jaws_of_the_Basilisk.ogg' },
        { name: 'Jaws of Gluttony', url: 'https://oldschool.runescape.wiki/images/Jaws_of_Gluttony.ogg' },
        { name: 'Jester Minute', url: 'https://oldschool.runescape.wiki/images/Jester_Minute.ogg' },
        { name: 'Jolly R', url: 'https://oldschool.runescape.wiki/images/Jolly_R.ogg' },
        { name: 'Joy of the Hunt', url: 'https://oldschool.runescape.wiki/images/Joy_of_the_Hunt.ogg' },
        { name: 'Judgement of the Depths', url: 'https://oldschool.runescape.wiki/images/Judgement_of_the_Depths.ogg' },
        { name: 'Jungle Bells', url: 'https://oldschool.runescape.wiki/images/Jungle_Bells.ogg' },
        { name: 'Jungle Hunt', url: 'https://oldschool.runescape.wiki/images/Jungle_Hunt.ogg' },
        { name: 'Jungle Island', url: 'https://oldschool.runescape.wiki/images/Jungle_Island.ogg' },
        { name: 'Jungle Island Xmas', url: 'https://oldschool.runescape.wiki/images/Jungle_Island_Xmas.ogg' },
        { name: 'Jungle Troubles', url: 'https://oldschool.runescape.wiki/images/Jungle_Troubles.ogg' },
        { name: 'Jungly 1', url: 'https://oldschool.runescape.wiki/images/Jungly_1.ogg' },
        { name: 'Jungly 2', url: 'https://oldschool.runescape.wiki/images/Jungly_2.ogg' },
        { name: 'Jungly 3', url: 'https://oldschool.runescape.wiki/images/Jungly_3.ogg' },
        { name: 'Kanon of Kahlith', url: 'https://oldschool.runescape.wiki/images/Kanon_of_Kahlith.ogg' },
        { name: 'Karamja Jam', url: 'https://oldschool.runescape.wiki/images/Karamja_Jam.ogg' },
        { name: 'The Kin', url: 'https://oldschool.runescape.wiki/images/The_Kin.ogg' },
        { name: 'King of the Trolls', url: 'https://oldschool.runescape.wiki/images/King_of_the_Trolls.ogg' },
        { name: 'Kingdom', url: 'https://oldschool.runescape.wiki/images/Kingdom.ogg' },
        { name: 'Knightly', url: 'https://oldschool.runescape.wiki/images/Knightly.ogg' },
        { name: 'Knightmare', url: 'https://oldschool.runescape.wiki/images/Knightmare.ogg' },
        { name: 'Kourend the Magnificent', url: 'https://oldschool.runescape.wiki/images/Kourend_the_Magnificent.ogg' },
        { name: 'La Mort', url: 'https://oldschool.runescape.wiki/images/La_Mort.ogg' },
        { name: 'Labyrinth', url: 'https://oldschool.runescape.wiki/images/Labyrinth.ogg' },
        { name: 'Lagoon', url: 'https://oldschool.runescape.wiki/images/Lagoon.ogg' },
        { name: 'Laid to Rest', url: 'https://oldschool.runescape.wiki/images/Laid_to_Rest.ogg' },
        { name: 'Lair', url: 'https://oldschool.runescape.wiki/images/Lair.ogg' },
        { name: 'Lair of the Basilisk', url: 'https://oldschool.runescape.wiki/images/Lair_of_the_Basilisk.ogg' },
        { name: 'Lament', url: 'https://oldschool.runescape.wiki/images/Lament.ogg' },
        { name: 'Lament for the Hallowed', url: 'https://oldschool.runescape.wiki/images/Lament_for_the_Hallowed.ogg' },
        { name: 'Lament of Meiyerditch', url: 'https://oldschool.runescape.wiki/images/Lament_of_Meiyerditch.ogg' },
        { name: 'Lamistard\'s Labyrinth', url: 'https://oldschool.runescape.wiki/images/Lamistard%27s_Labyrinth.ogg' },
        { name: 'Land Down Under', url: 'https://oldschool.runescape.wiki/images/Land_Down_Under.ogg' },
        { name: 'Land of Snow', url: 'https://oldschool.runescape.wiki/images/Land_of_Snow.ogg' },
        { name: 'Land of the Dwarves', url: 'https://oldschool.runescape.wiki/images/Land_of_the_Dwarves.ogg' },
        { name: 'Landlubber', url: 'https://oldschool.runescape.wiki/images/Landlubber.ogg' },
        { name: 'Last King of the Yarasa', url: 'https://oldschool.runescape.wiki/images/Last_King_of_the_Yarasa.ogg' },
        { name: 'Last Man Standing', url: 'https://oldschool.runescape.wiki/images/Last_Man_Standing.ogg' },
        { name: 'The Last Shanty', url: 'https://oldschool.runescape.wiki/images/The_Last_Shanty.ogg' },
        { name: 'Last Stand', url: 'https://oldschool.runescape.wiki/images/Last_Stand.ogg' },
        { name: 'Lasting', url: 'https://oldschool.runescape.wiki/images/Lasting.ogg' },
        { name: 'Lava is Mine', url: 'https://oldschool.runescape.wiki/images/Lava_is_Mine.ogg' },
        { name: 'Legend', url: 'https://oldschool.runescape.wiki/images/Legend.ogg' },
        { name: 'Legion', url: 'https://oldschool.runescape.wiki/images/Legion.ogg' },
        { name: 'Life at Sea', url: 'https://oldschool.runescape.wiki/images/Life_at_Sea.ogg' },
        { name: 'Life\'s a Beach!', url: 'https://oldschool.runescape.wiki/images/Life%27s_a_Beach!.ogg' },
        { name: 'Lighthouse', url: 'https://oldschool.runescape.wiki/images/Lighthouse.ogg' },
        { name: 'Lightness', url: 'https://oldschool.runescape.wiki/images/Lightness.ogg' },
        { name: 'Lightwalk', url: 'https://oldschool.runescape.wiki/images/Lightwalk.ogg' },
        { name: 'Little Cave of Horrors', url: 'https://oldschool.runescape.wiki/images/Little_Cave_of_Horrors.ogg' },
        { name: 'Lonesome', url: 'https://oldschool.runescape.wiki/images/Lonesome.ogg' },
        { name: 'Long Ago', url: 'https://oldschool.runescape.wiki/images/Long_Ago.ogg' },
        { name: 'Long Way Home', url: 'https://oldschool.runescape.wiki/images/Long_Way_Home.ogg' },
        { name: 'The Longramble Scramble', url: 'https://oldschool.runescape.wiki/images/The_Longramble_Scramble.ogg' },
        { name: 'Look to the Stars', url: 'https://oldschool.runescape.wiki/images/Look_to_the_Stars.ogg' },
        { name: 'Looking Back', url: 'https://oldschool.runescape.wiki/images/Looking_Back.ogg' },
        { name: 'Lore and Order', url: 'https://oldschool.runescape.wiki/images/Lore_and_Order.ogg' },
        { name: 'The Lost Melody', url: 'https://oldschool.runescape.wiki/images/The_Lost_Melody.ogg' },
        { name: 'Lost Soul', url: 'https://oldschool.runescape.wiki/images/Lost_Soul.ogg' },
        { name: 'Lost to Time', url: 'https://oldschool.runescape.wiki/images/Lost_to_Time.ogg' },
        { name: 'The Lost Tribe', url: 'https://oldschool.runescape.wiki/images/The_Lost_Tribe.ogg' },
        { name: 'Lower Depths', url: 'https://oldschool.runescape.wiki/images/Lower_Depths.ogg' },
        { name: 'Lucid Dream', url: 'https://oldschool.runescape.wiki/images/Lucid_Dream.ogg' },
        { name: 'Lucid Nightmare', url: 'https://oldschool.runescape.wiki/images/Lucid_Nightmare.ogg' },
        { name: 'Lullaby', url: 'https://oldschool.runescape.wiki/images/Lullaby.ogg' },
        { name: 'Lumbering', url: 'https://oldschool.runescape.wiki/images/Lumbering.ogg' },
        { name: 'The Lunar Isle', url: 'https://oldschool.runescape.wiki/images/The_Lunar_Isle.ogg' },
        { name: 'Lurking Threats', url: 'https://oldschool.runescape.wiki/images/Lurking_Threats.ogg' },
        { name: 'Mad Eadgar', url: 'https://oldschool.runescape.wiki/images/Mad_Eadgar.ogg' },
        { name: 'The Mad Mole', url: 'https://oldschool.runescape.wiki/images/The_Mad_Mole.ogg' },
        { name: 'Mage Arena', url: 'https://oldschool.runescape.wiki/images/Mage_Arena.ogg' },
        { name: 'Magic Dance', url: 'https://oldschool.runescape.wiki/images/Magic_Dance.ogg' },
        { name: 'Magic Magic Magic', url: 'https://oldschool.runescape.wiki/images/Magic_Magic_Magic.ogg' },
        { name: 'Magical Journey', url: 'https://oldschool.runescape.wiki/images/Magical_Journey.ogg' },
        { name: 'The Maiden\'s Anger', url: 'https://oldschool.runescape.wiki/images/The_Maiden%27s_Anger.ogg' },
        { name: 'The Maiden\'s Sorrow', url: 'https://oldschool.runescape.wiki/images/The_Maiden%27s_Sorrow.ogg' },
        { name: 'Major Miner', url: 'https://oldschool.runescape.wiki/images/Major_Miner.ogg' },
        { name: 'Making Waves', url: 'https://oldschool.runescape.wiki/images/Making_Waves.ogg' },
        { name: 'Malady', url: 'https://oldschool.runescape.wiki/images/Malady.ogg' },
        { name: 'March', url: 'https://oldschool.runescape.wiki/images/March.ogg' },
        { name: 'March of the Shayzien', url: 'https://oldschool.runescape.wiki/images/March_of_the_Shayzien.ogg' },
        { name: 'Marooned', url: 'https://oldschool.runescape.wiki/images/Marooned.ogg' },
        { name: 'Marzipan', url: 'https://oldschool.runescape.wiki/images/Marzipan.ogg' },
        { name: 'Masquerade', url: 'https://oldschool.runescape.wiki/images/Masquerade.ogg' },
        { name: 'Master of Puppets', url: 'https://oldschool.runescape.wiki/images/Master_of_Puppets.ogg' },
        { name: 'Mastermindless', url: 'https://oldschool.runescape.wiki/images/Mastermindless.ogg' },
        { name: 'A Matter of Intrigue', url: 'https://oldschool.runescape.wiki/images/A_Matter_of_Intrigue.ogg' },
        { name: 'Mausoleum', url: 'https://oldschool.runescape.wiki/images/Mausoleum.ogg' },
        { name: 'Maws Jaws & Claws', url: 'https://oldschool.runescape.wiki/images/Maws_Jaws_%26_Claws.ogg' },
        { name: 'The Maze', url: 'https://oldschool.runescape.wiki/images/The_Maze.ogg' },
        { name: 'Meddling Kids', url: 'https://oldschool.runescape.wiki/images/Meddling_Kids.ogg' },
        { name: 'Medieval', url: 'https://oldschool.runescape.wiki/images/Medieval.ogg' },
        { name: 'Mellow', url: 'https://oldschool.runescape.wiki/images/Mellow.ogg' },
        { name: 'Melodrama', url: 'https://oldschool.runescape.wiki/images/Melodrama.ogg' },
        { name: 'Meridian', url: 'https://oldschool.runescape.wiki/images/Meridian.ogg' },
        { name: 'Method of Madness', url: 'https://oldschool.runescape.wiki/images/Method_of_Madness.ogg' },
        { name: 'Miles Away', url: 'https://oldschool.runescape.wiki/images/Miles_Away.ogg' },
        { name: 'Military Life', url: 'https://oldschool.runescape.wiki/images/Military_Life.ogg' },
        { name: 'The Militia', url: 'https://oldschool.runescape.wiki/images/The_Militia.ogg' },
        { name: 'Mind over Matter', url: 'https://oldschool.runescape.wiki/images/Mind_over_Matter.ogg' },
        { name: 'Miracle Dance', url: 'https://oldschool.runescape.wiki/images/Miracle_Dance.ogg' },
        { name: 'Mirage', url: 'https://oldschool.runescape.wiki/images/Mirage.ogg' },
        { name: 'Miscellania', url: 'https://oldschool.runescape.wiki/images/Miscellania.ogg' },
        { name: 'Mistrock', url: 'https://oldschool.runescape.wiki/images/Mistrock.ogg' },
        { name: 'The Mollusc Menace', url: 'https://oldschool.runescape.wiki/images/The_Mollusc_Menace.ogg' },
        { name: 'Monarch Waltz', url: 'https://oldschool.runescape.wiki/images/Monarch_Waltz.ogg' },
        { name: 'Monkey Badness', url: 'https://oldschool.runescape.wiki/images/Monkey_Badness.ogg' },
        { name: 'Monkey Business', url: 'https://oldschool.runescape.wiki/images/Monkey_Business.ogg' },
        { name: 'Monkey Madness', url: 'https://oldschool.runescape.wiki/images/Monkey_Madness.ogg' },
        { name: 'Monkey Sadness', url: 'https://oldschool.runescape.wiki/images/Monkey_Sadness.ogg' },
        { name: 'Monkey Trouble', url: 'https://oldschool.runescape.wiki/images/Monkey_Trouble.ogg' },
        { name: 'Monster Melee', url: 'https://oldschool.runescape.wiki/images/Monster_Melee.ogg' },
        { name: 'The Monsters Below', url: 'https://oldschool.runescape.wiki/images/The_Monsters_Below.ogg' },
        { name: 'The Moons of Ruin', url: 'https://oldschool.runescape.wiki/images/The_Moons_of_Ruin.ogg' },
        { name: 'Moody', url: 'https://oldschool.runescape.wiki/images/Moody.ogg' },
        { name: 'Mor Ul Rek', url: 'https://oldschool.runescape.wiki/images/Mor_Ul_Rek.ogg' },
        { name: 'More Than Meets the Eye', url: 'https://oldschool.runescape.wiki/images/More_Than_Meets_the_Eye.ogg' },
        { name: 'Morytania', url: 'https://oldschool.runescape.wiki/images/Morytania.ogg' },
        { name: 'Morytanian Mystery', url: 'https://oldschool.runescape.wiki/images/Morytanian_Mystery.ogg' },
        { name: 'A Mother\'s Curse', url: 'https://oldschool.runescape.wiki/images/A_Mother%27s_Curse.ogg' },
        { name: 'Mother Ruckus', url: 'https://oldschool.runescape.wiki/images/Mother_Ruckus.ogg' },
        { name: 'Mouse Trap', url: 'https://oldschool.runescape.wiki/images/Mouse_Trap.ogg' },
        { name: 'Mudskipper Melody', url: 'https://oldschool.runescape.wiki/images/Mudskipper_Melody.ogg' },
        { name: 'Museum Medley', url: 'https://oldschool.runescape.wiki/images/Museum_Medley.ogg' },
        { name: 'Mutant Medley', url: 'https://oldschool.runescape.wiki/images/Mutant_Medley.ogg' },
        { name: 'My Arm\'s Journey', url: 'https://oldschool.runescape.wiki/images/My_Arm%27s_Journey.ogg' },
        { name: 'Mysterious Lands', url: 'https://oldschool.runescape.wiki/images/Mysterious_Lands.ogg' },
        { name: 'Mystics of Nature', url: 'https://oldschool.runescape.wiki/images/Mystics_of_Nature.ogg' },
        { name: 'Mythical', url: 'https://oldschool.runescape.wiki/images/Mythical.ogg' },
        { name: 'Narnode\'s Theme', url: 'https://oldschool.runescape.wiki/images/Narnode%27s_Theme.ogg' },
        { name: 'Natural', url: 'https://oldschool.runescape.wiki/images/Natural.ogg' },
        { name: 'The Navigator', url: 'https://oldschool.runescape.wiki/images/The_Navigator.ogg' },
        { name: 'Nether Realm', url: 'https://oldschool.runescape.wiki/images/Nether_Realm.ogg' },
        { name: 'Neverland', url: 'https://oldschool.runescape.wiki/images/Neverland.ogg' },
        { name: 'Newbie Farming', url: 'https://oldschool.runescape.wiki/images/Newbie_Farming.ogg' },
        { name: 'Newbie Melody', url: 'https://oldschool.runescape.wiki/images/Newbie_Melody.ogg' },
        { name: 'Night of the Vampyre', url: 'https://oldschool.runescape.wiki/images/Night_of_the_Vampyre.ogg' },
        { name: 'Nightfall', url: 'https://oldschool.runescape.wiki/images/Nightfall.ogg' },
        { name: 'The Nightmare Continues', url: 'https://oldschool.runescape.wiki/images/The_Nightmare_Continues.ogg' },
        { name: 'No Pasaran', url: 'https://oldschool.runescape.wiki/images/No_Pasaran.ogg' },
        { name: 'No Way Out', url: 'https://oldschool.runescape.wiki/images/No_Way_Out.ogg' },
        { name: 'The Noble Rodent', url: 'https://oldschool.runescape.wiki/images/The_Noble_Rodent.ogg' },
        { name: 'Nomad', url: 'https://oldschool.runescape.wiki/images/Nomad.ogg' },
        { name: 'Norse Code', url: 'https://oldschool.runescape.wiki/images/Norse_Code.ogg' },
        { name: 'The North', url: 'https://oldschool.runescape.wiki/images/The_North.ogg' },
        { name: 'Not a Moment of Relief', url: 'https://oldschool.runescape.wiki/images/Not_a_Moment_of_Relief.ogg' },
        { name: 'Nox Irae', url: 'https://oldschool.runescape.wiki/images/Nox_Irae.ogg' },
        { name: 'Noxious Awakening', url: 'https://oldschool.runescape.wiki/images/Noxious_Awakening.ogg' },
        { name: 'Null and Void', url: 'https://oldschool.runescape.wiki/images/Null_and_Void.ogg' },
        { name: 'Ogre the Top', url: 'https://oldschool.runescape.wiki/images/Ogre_the_Top.ogg' },
        { name: 'Oh Rats!', url: 'https://oldschool.runescape.wiki/images/Oh_Rats!.ogg' },
        { name: 'The Old Ones', url: 'https://oldschool.runescape.wiki/images/The_Old_Ones.ogg' },
        { name: 'On the Frontline', url: 'https://oldschool.runescape.wiki/images/On_the_Frontline.ogg' },
        { name: 'On the Shore', url: 'https://oldschool.runescape.wiki/images/On_the_Shore.ogg' },
        { name: 'On the Up', url: 'https://oldschool.runescape.wiki/images/On_the_Up.ogg' },
        { name: 'On the Wing', url: 'https://oldschool.runescape.wiki/images/On_the_Wing.ogg' },
        { name: 'On Thin Ice', url: 'https://oldschool.runescape.wiki/images/On_Thin_Ice.ogg' },
        { name: 'Oncoming Foe', url: 'https://oldschool.runescape.wiki/images/Oncoming_Foe.ogg' },
        { name: 'Organ Music 1', url: 'https://oldschool.runescape.wiki/images/Organ_Music_1.ogg' },
        { name: 'Organ Music 2', url: 'https://oldschool.runescape.wiki/images/Organ_Music_2.ogg' },
        { name: 'Oriental', url: 'https://oldschool.runescape.wiki/images/Oriental.ogg' },
        { name: 'The Other Side', url: 'https://oldschool.runescape.wiki/images/The_Other_Side.ogg' },
        { name: 'Out at the Mines', url: 'https://oldschool.runescape.wiki/images/Out_at_the_Mines.ogg' },
        { name: 'Out of the Deep', url: 'https://oldschool.runescape.wiki/images/Out_of_the_Deep.ogg' },
        { name: 'Over the Horizon', url: 'https://oldschool.runescape.wiki/images/Over_the_Horizon.ogg' },
        { name: 'Over the Mountains', url: 'https://oldschool.runescape.wiki/images/Over_the_Mountains.ogg' },
        { name: 'Over to Nardah', url: 'https://oldschool.runescape.wiki/images/Over_to_Nardah.ogg' },
        { name: 'Overpass', url: 'https://oldschool.runescape.wiki/images/Overpass.ogg' },
        { name: 'Overture', url: 'https://oldschool.runescape.wiki/images/Overture.ogg' },
        { name: 'Parade', url: 'https://oldschool.runescape.wiki/images/Parade.ogg' },
        { name: 'The Part Where You Die', url: 'https://oldschool.runescape.wiki/images/The_Part_Where_You_Die.ogg' },
        { name: 'Path of Peril', url: 'https://oldschool.runescape.wiki/images/Path_of_Peril.ogg' },
        { name: 'The Penguin Bards', url: 'https://oldschool.runescape.wiki/images/The_Penguin_Bards.ogg' },
        { name: 'Penguin Plots', url: 'https://oldschool.runescape.wiki/images/Penguin_Plots.ogg' },
        { name: 'Pathways', url: 'https://oldschool.runescape.wiki/images/Pathways.ogg' },
        { name: 'Peace and Prosperity', url: 'https://oldschool.runescape.wiki/images/Peace_and_Prosperity.ogg' },
        { name: 'Pest Control', url: 'https://oldschool.runescape.wiki/images/Pest_Control.ogg' },
        { name: 'Pharaoh\'s Tomb', url: 'https://oldschool.runescape.wiki/images/Pharaoh%27s_Tomb.ogg' },
        { name: 'The Pharaoh', url: 'https://oldschool.runescape.wiki/images/The_Pharaoh.ogg' },
        { name: 'Phasmatys', url: 'https://oldschool.runescape.wiki/images/Phasmatys.ogg' },
        { name: 'Pheasant Peasant', url: 'https://oldschool.runescape.wiki/images/Pheasant_Peasant.ogg' },
        { name: 'Pick & Shovel', url: 'https://oldschool.runescape.wiki/images/Pick_%26_Shovel.ogg' },
        { name: 'Pinball Wizard', url: 'https://oldschool.runescape.wiki/images/Pinball_Wizard.ogg' },
        { name: 'Pirates of Penance', url: 'https://oldschool.runescape.wiki/images/Pirates_of_Penance.ogg' },
        { name: 'Pirates of Peril', url: 'https://oldschool.runescape.wiki/images/Pirates_of_Peril.ogg' },
        { name: 'Plots and Plans', url: 'https://oldschool.runescape.wiki/images/Plots_and_Plans.ogg' },
        { name: 'The Plundered Tomb', url: 'https://oldschool.runescape.wiki/images/The_Plundered_Tomb.ogg' },
        { name: 'Poles Apart', url: 'https://oldschool.runescape.wiki/images/Poles_Apart.ogg' },
        { name: 'The Power of Tears', url: 'https://oldschool.runescape.wiki/images/The_Power_of_Tears.ogg' },
        { name: 'Power of the Shadow Realm', url: 'https://oldschool.runescape.wiki/images/Power_of_the_Shadow_Realm.ogg' },
        { name: 'Predator Xarpus', url: 'https://oldschool.runescape.wiki/images/Predator_Xarpus.ogg' },
        { name: 'Preservation', url: 'https://oldschool.runescape.wiki/images/Preservation.ogg' },
        { name: 'Preserved', url: 'https://oldschool.runescape.wiki/images/Preserved.ogg' },
        { name: 'Prime Time', url: 'https://oldschool.runescape.wiki/images/Prime_Time.ogg' },
        { name: 'Principality', url: 'https://oldschool.runescape.wiki/images/Principality.ogg' },
        { name: 'Prison Break', url: 'https://oldschool.runescape.wiki/images/Prison_Break.ogg' },
        { name: 'Prospering Fortune', url: 'https://oldschool.runescape.wiki/images/Prospering_Fortune.ogg' },
        { name: 'Quest', url: 'https://oldschool.runescape.wiki/images/Quest.ogg' },
        { name: 'The Quizmaster', url: 'https://oldschool.runescape.wiki/images/The_Quizmaster.ogg' },
        { name: 'Race Against the Clock', url: 'https://oldschool.runescape.wiki/images/Race_Against_the_Clock.ogg' },
        { name: 'Rat a Tat Tat', url: 'https://oldschool.runescape.wiki/images/Rat_a_Tat_Tat.ogg' },
        { name: 'Rat Hunt', url: 'https://oldschool.runescape.wiki/images/Rat_Hunt.ogg' },
        { name: 'Ready for Battle', url: 'https://oldschool.runescape.wiki/images/Ready_for_Battle.ogg' },
        { name: 'Ready for the Hunt', url: 'https://oldschool.runescape.wiki/images/Ready_for_the_Hunt.ogg' },
        { name: 'Regal', url: 'https://oldschool.runescape.wiki/images/Regal.ogg' },
        { name: 'Regal Pomp', url: 'https://oldschool.runescape.wiki/images/Regal_Pomp.ogg' },
        { name: 'Reggae', url: 'https://oldschool.runescape.wiki/images/Reggae.ogg' },
        { name: 'Reggae 2', url: 'https://oldschool.runescape.wiki/images/Reggae_2.ogg' },
        { name: 'Reign of the Basilisk', url: 'https://oldschool.runescape.wiki/images/Reign_of_the_Basilisk.ogg' },
        { name: 'Relics', url: 'https://oldschool.runescape.wiki/images/Relics.ogg' },
        { name: 'Rellekka', url: 'https://oldschool.runescape.wiki/images/Rellekka.ogg' },
        { name: 'Remote Waters', url: 'https://oldschool.runescape.wiki/images/Remote_Waters.ogg' },
        { name: 'Rest in Peace', url: 'https://oldschool.runescape.wiki/images/Rest_in_Peace.ogg' },
        { name: 'Revenants', url: 'https://oldschool.runescape.wiki/images/Revenants.ogg' },
        { name: 'Rhapsody', url: 'https://oldschool.runescape.wiki/images/Rhapsody.ogg' },
        { name: 'Right on Track', url: 'https://oldschool.runescape.wiki/images/Right_on_Track.ogg' },
        { name: 'Righteousness', url: 'https://oldschool.runescape.wiki/images/Righteousness.ogg' },
        { name: 'Rising Damp', url: 'https://oldschool.runescape.wiki/images/Rising_Damp.ogg' },
        { name: 'The Rising Sun', url: 'https://oldschool.runescape.wiki/images/The_Rising_Sun.ogg' },
        { name: 'Riverside', url: 'https://oldschool.runescape.wiki/images/Riverside.ogg' },
        { name: 'Roc and Roll', url: 'https://oldschool.runescape.wiki/images/Roc_and_Roll.ogg' },
        { name: 'The Rogues\' Den', url: 'https://oldschool.runescape.wiki/images/The_Rogues%27_Den.ogg' },
        { name: 'Roll the Bones', url: 'https://oldschool.runescape.wiki/images/Roll_the_Bones.ogg' },
        { name: 'Romancing the Crone', url: 'https://oldschool.runescape.wiki/images/Romancing_the_Crone.ogg' },
        { name: 'Romper Chomper', url: 'https://oldschool.runescape.wiki/images/Romper_Chomper.ogg' },
        { name: 'Roots and Flutes', url: 'https://oldschool.runescape.wiki/images/Roots_and_Flutes.ogg' },
        { name: 'Rose', url: 'https://oldschool.runescape.wiki/images/Rose.ogg' },
        { name: 'Royale', url: 'https://oldschool.runescape.wiki/images/Royale.ogg' },
        { name: 'Rugged Terrain', url: 'https://oldschool.runescape.wiki/images/Rugged_Terrain.ogg' },
        { name: 'The Route of All Evil', url: 'https://oldschool.runescape.wiki/images/The_Route_of_All_Evil.ogg' },
        { name: 'The Route of the Problem', url: 'https://oldschool.runescape.wiki/images/The_Route_of_the_Problem.ogg' },
        { name: 'The Ruins of Camdozaal', url: 'https://oldschool.runescape.wiki/images/The_Ruins_of_Camdozaal.ogg' },
        { name: 'Ruins of Isolation', url: 'https://oldschool.runescape.wiki/images/Ruins_of_Isolation.ogg' },
        { name: 'Rune Essence', url: 'https://oldschool.runescape.wiki/images/Rune_Essence.ogg' },
        { name: 'Sad Meadow', url: 'https://oldschool.runescape.wiki/images/Sad_Meadow.ogg' },
        { name: 'Safety in Numbers', url: 'https://oldschool.runescape.wiki/images/Safety_in_Numbers.ogg' },
        { name: 'Saga', url: 'https://oldschool.runescape.wiki/images/Saga.ogg' },
        { name: 'A Sailor\'s Dream', url: 'https://oldschool.runescape.wiki/images/A_Sailor%27s_Dream.ogg' },
        { name: 'Sands of Time', url: 'https://oldschool.runescape.wiki/images/Sands_of_Time.ogg' },
        { name: 'Sarachnis', url: 'https://oldschool.runescape.wiki/images/Sarachnis.ogg' },
        { name: 'Sarcophagus', url: 'https://oldschool.runescape.wiki/images/Sarcophagus.ogg' },
        { name: 'Sarim\'s Vermin', url: 'https://oldschool.runescape.wiki/images/Sarim%27s_Vermin.ogg' },
        { name: 'Scape Ape', url: 'https://oldschool.runescape.wiki/images/Scape_Ape.ogg' },
        { name: 'Scape Cave', url: 'https://oldschool.runescape.wiki/images/Scape_Cave.ogg' },
        { name: 'Scape Crystal', url: 'https://oldschool.runescape.wiki/images/Scape_Crystal.ogg' },
        { name: 'Scape Five', url: 'https://oldschool.runescape.wiki/images/Scape_Five.ogg' },
        { name: 'Scape Ground', url: 'https://oldschool.runescape.wiki/images/Scape_Ground.ogg' },
        { name: 'Scape Home', url: 'https://oldschool.runescape.wiki/images/Scape_Home.ogg' },
        { name: 'Scape Hunter', url: 'https://oldschool.runescape.wiki/images/Scape_Hunter.ogg' },
        { name: 'Scape Main', url: 'https://oldschool.runescape.wiki/images/Scape_Main.ogg' },
        { name: 'Scape Original', url: 'https://oldschool.runescape.wiki/images/Scape_Original.ogg' },
        { name: 'Scape Sad', url: 'https://oldschool.runescape.wiki/images/Scape_Sad.ogg' },
        { name: 'Scape Sail', url: 'https://oldschool.runescape.wiki/images/Scape_Sail.ogg' },
        { name: 'Scape Santa', url: 'https://oldschool.runescape.wiki/images/Scape_Santa.ogg' },
        { name: 'Scape Scared', url: 'https://oldschool.runescape.wiki/images/Scape_Scared.ogg' },
        { name: 'Scape Soft', url: 'https://oldschool.runescape.wiki/images/Scape_Soft.ogg' },
        { name: 'Scape Wild', url: 'https://oldschool.runescape.wiki/images/Scape_Wild.ogg' },
        { name: 'Scar Tissue', url: 'https://oldschool.runescape.wiki/images/Scar_Tissue.ogg' },
        { name: 'Scarab', url: 'https://oldschool.runescape.wiki/images/Scarab.ogg' },
        { name: 'Scorching Horizon', url: 'https://oldschool.runescape.wiki/images/Scorching_Horizon.ogg' },
        { name: 'School\'s Out', url: 'https://oldschool.runescape.wiki/images/School%27s_Out.ogg' },
        { name: 'Scorpia Dances', url: 'https://oldschool.runescape.wiki/images/Scorpia_Dances.ogg' },
        { name: 'Scrubfoot\'s Descent', url: 'https://oldschool.runescape.wiki/images/Scrubfoot%27s_Descent.ogg' },
        { name: 'Sea Minor Shanty', url: 'https://oldschool.runescape.wiki/images/Sea_Minor_Shanty.ogg' },
        { name: 'Sea Shanty', url: 'https://oldschool.runescape.wiki/images/Sea_Shanty.ogg' },
        { name: 'Sea Shanty 2', url: 'https://oldschool.runescape.wiki/images/Sea_Shanty_2.ogg' },
        { name: 'Sea Shanty Xmas', url: 'https://oldschool.runescape.wiki/images/Sea_Shanty_Xmas.ogg' },
        { name: 'Secrets of the North', url: 'https://oldschool.runescape.wiki/images/Secrets_of_the_North.ogg' },
        { name: 'The Seed of Crwys', url: 'https://oldschool.runescape.wiki/images/The_Seed_of_Crwys.ogg' },
        { name: 'Serenade', url: 'https://oldschool.runescape.wiki/images/Serenade.ogg' },
        { name: 'Serene', url: 'https://oldschool.runescape.wiki/images/Serene.ogg' },
        { name: 'Servants of Strife', url: 'https://oldschool.runescape.wiki/images/Servants_of_Strife.ogg' },
        { name: 'Set Sail', url: 'https://oldschool.runescape.wiki/images/Set_Sail.ogg' },
        { name: 'The Setting Sun', url: 'https://oldschool.runescape.wiki/images/The_Setting_Sun.ogg' },
        { name: 'Settlement', url: 'https://oldschool.runescape.wiki/images/Settlement.ogg' },
        { name: 'The Shadow', url: 'https://oldschool.runescape.wiki/images/The_Shadow.ogg' },
        { name: 'Shadow of the Ocean', url: 'https://oldschool.runescape.wiki/images/Shadow_of_the_Ocean.ogg' },
        { name: 'Shadowland', url: 'https://oldschool.runescape.wiki/images/Shadowland.ogg' },
        { name: 'Sharp End of the Crystal', url: 'https://oldschool.runescape.wiki/images/Sharp_End_of_the_Crystal.ogg' },
        { name: 'Shattered Relics', url: 'https://oldschool.runescape.wiki/images/Shattered_Relics.ogg' },
        { name: 'Shine', url: 'https://oldschool.runescape.wiki/images/Shine.ogg' },
        { name: 'Shining', url: 'https://oldschool.runescape.wiki/images/Shining.ogg' },
        { name: 'Shining Spirit', url: 'https://oldschool.runescape.wiki/images/Shining_Spirit.ogg' },
        { name: 'Shipwrecked', url: 'https://oldschool.runescape.wiki/images/Shipwrecked.ogg' },
        { name: 'Showdown', url: 'https://oldschool.runescape.wiki/images/Showdown.ogg' },
        { name: 'Sigmund\'s Showdown', url: 'https://oldschool.runescape.wiki/images/Sigmund%27s_Showdown.ogg' },
        { name: 'Sign Here', url: 'https://oldschool.runescape.wiki/images/Sign_Here.ogg' },
        { name: 'The Sinclairs', url: 'https://oldschool.runescape.wiki/images/The_Sinclairs.ogg' },
        { name: 'The Slayer', url: 'https://oldschool.runescape.wiki/images/The_Slayer.ogg' },
        { name: 'The Sound of Guthix', url: 'https://oldschool.runescape.wiki/images/The_Sound_of_Guthix.ogg' },
        { name: 'Slice of Silent Movie', url: 'https://oldschool.runescape.wiki/images/Slice_of_Silent_Movie.ogg' },
        { name: 'Slice of Station', url: 'https://oldschool.runescape.wiki/images/Slice_of_Station.ogg' },
        { name: 'Slither and Thither', url: 'https://oldschool.runescape.wiki/images/Slither_and_Thither.ogg' },
        { name: 'Slug a Bug Ball', url: 'https://oldschool.runescape.wiki/images/Slug_a_Bug_Ball.ogg' },
        { name: 'Snowflake & My Arm', url: 'https://oldschool.runescape.wiki/images/Snowflake_%26_My_Arm.ogg' },
        { name: 'Sojourn', url: 'https://oldschool.runescape.wiki/images/Sojourn.ogg' },
        { name: 'Song of the Elves', url: 'https://oldschool.runescape.wiki/images/Song_of_the_Elves.ogg' },
        { name: 'Song of the Silent Choir', url: 'https://oldschool.runescape.wiki/images/Song_of_the_Silent_Choir.ogg' },
        { name: 'Sorceress\'s Garden', url: 'https://oldschool.runescape.wiki/images/Sorceress%27s_Garden.ogg' },
        { name: 'Soul Fall', url: 'https://oldschool.runescape.wiki/images/Soul_Fall.ogg' },
        { name: 'Soul Wars', url: 'https://oldschool.runescape.wiki/images/Soul_Wars.ogg' },
        { name: 'Soundscape', url: 'https://oldschool.runescape.wiki/images/Soundscape.ogg' },
        { name: 'Sphinx', url: 'https://oldschool.runescape.wiki/images/Sphinx.ogg' },
        { name: 'Spirit', url: 'https://oldschool.runescape.wiki/images/Spirit.ogg' },
        { name: 'Spirit of the Forest', url: 'https://oldschool.runescape.wiki/images/Spirit_of_the_Forest.ogg' },
        { name: 'Spirits of the Elid', url: 'https://oldschool.runescape.wiki/images/Spirits_of_the_Elid.ogg' },
        { name: 'Spiritbloom', url: 'https://oldschool.runescape.wiki/images/Spiritbloom.ogg' },
        { name: 'Splendour', url: 'https://oldschool.runescape.wiki/images/Splendour.ogg' },
        { name: 'Spooky', url: 'https://oldschool.runescape.wiki/images/Spooky.ogg' },
        { name: 'Spooky 2', url: 'https://oldschool.runescape.wiki/images/Spooky_2.ogg' },
        { name: 'Spooky Jungle', url: 'https://oldschool.runescape.wiki/images/Spooky_Jungle.ogg' },
        { name: 'The Spurned Demon', url: 'https://oldschool.runescape.wiki/images/The_Spurned_Demon.ogg' },
        { name: 'The Spymaster', url: 'https://oldschool.runescape.wiki/images/The_Spymaster.ogg' },
        { name: 'Stalkers', url: 'https://oldschool.runescape.wiki/images/Stalkers.ogg' },
        { name: 'Stagnant', url: 'https://oldschool.runescape.wiki/images/Stagnant.ogg' },
        { name: 'Stand Up and Be Counted', url: 'https://oldschool.runescape.wiki/images/Stand_Up_and_Be_Counted.ogg' },
        { name: 'Starlight', url: 'https://oldschool.runescape.wiki/images/Starlight.ogg' },
        { name: 'Start', url: 'https://oldschool.runescape.wiki/images/Start.ogg' },
        { name: 'Still Night', url: 'https://oldschool.runescape.wiki/images/Still_Night.ogg' },
        { name: 'Stillness', url: 'https://oldschool.runescape.wiki/images/Stillness.ogg' },
        { name: 'Stones of Old', url: 'https://oldschool.runescape.wiki/images/Stones_of_Old.ogg' },
        { name: 'Storeroom Shuffle', url: 'https://oldschool.runescape.wiki/images/Storeroom_Shuffle.ogg' },
        { name: 'Storm Brew', url: 'https://oldschool.runescape.wiki/images/Storm_Brew.ogg' },
        { name: 'Stranded', url: 'https://oldschool.runescape.wiki/images/Stranded.ogg' },
        { name: 'Strange Place', url: 'https://oldschool.runescape.wiki/images/Strange_Place.ogg' },
        { name: 'Strangled', url: 'https://oldschool.runescape.wiki/images/Strangled.ogg' },
        { name: 'Stratosphere', url: 'https://oldschool.runescape.wiki/images/Stratosphere.ogg' },
        { name: 'Strength of Saradomin', url: 'https://oldschool.runescape.wiki/images/Strength_of_Saradomin.ogg' },
        { name: 'Stuck in the Mire', url: 'https://oldschool.runescape.wiki/images/Stuck_in_the_Mire.ogg' },
        { name: 'Subterranea', url: 'https://oldschool.runescape.wiki/images/Subterranea.ogg' },
        { name: 'Sunburn', url: 'https://oldschool.runescape.wiki/images/Sunburn.ogg' },
        { name: 'Sunny Side Up', url: 'https://oldschool.runescape.wiki/images/Sunny_Side_Up.ogg' },
        { name: 'Superstition', url: 'https://oldschool.runescape.wiki/images/Superstition.ogg' },
        { name: 'Surok\'s Theme', url: 'https://oldschool.runescape.wiki/images/Surok%27s_Theme.ogg' },
        { name: 'Suspicious', url: 'https://oldschool.runescape.wiki/images/Suspicious.ogg' },
        { name: 'Tale of Keldagrim', url: 'https://oldschool.runescape.wiki/images/Tale_of_Keldagrim.ogg' },
        { name: 'The Talkasti People', url: 'https://oldschool.runescape.wiki/images/The_Talkasti_People.ogg' },
        { name: 'Talking Forest', url: 'https://oldschool.runescape.wiki/images/Talking_Forest.ogg' },
        { name: 'Tarn Razorlor', url: 'https://oldschool.runescape.wiki/images/Tarn_Razorlor.ogg' },
        { name: 'A Taste of Hope', url: 'https://oldschool.runescape.wiki/images/A_Taste_of_Hope.ogg' },
        { name: 'Tears of Guthix', url: 'https://oldschool.runescape.wiki/images/Tears_of_Guthix.ogg' },
        { name: 'Technology', url: 'https://oldschool.runescape.wiki/images/Technology.ogg' },
        { name: 'Teklan', url: 'https://oldschool.runescape.wiki/images/Teklan.ogg' },
        { name: 'Tempest', url: 'https://oldschool.runescape.wiki/images/Tempest.ogg' },
        { name: 'Temple', url: 'https://oldschool.runescape.wiki/images/Temple.ogg' },
        { name: 'Temple Desecrated', url: 'https://oldschool.runescape.wiki/images/Temple_Desecrated.ogg' },
        { name: 'Temple of Light', url: 'https://oldschool.runescape.wiki/images/Temple_of_Light.ogg' },
        { name: 'Temple of the Eye', url: 'https://oldschool.runescape.wiki/images/Temple_of_the_Eye.ogg' },
        { name: 'Temple of Tribes', url: 'https://oldschool.runescape.wiki/images/Temple_of_Tribes.ogg' },
        { name: 'Tempor of the Storm', url: 'https://oldschool.runescape.wiki/images/Tempor_of_the_Storm.ogg' },
        { name: 'The Terrible Caverns', url: 'https://oldschool.runescape.wiki/images/The_Terrible_Caverns.ogg' },
        { name: 'The Terrible Tower', url: 'https://oldschool.runescape.wiki/images/The_Terrible_Tower.ogg' },
        { name: 'The Terrible Tunnels', url: 'https://oldschool.runescape.wiki/images/The_Terrible_Tunnels.ogg' },
        { name: 'Terrorbird Tussle', url: 'https://oldschool.runescape.wiki/images/Terrorbird_Tussle.ogg' },
        { name: 'Test of Companionship', url: 'https://oldschool.runescape.wiki/images/Test_of_Companionship.ogg' },
        { name: 'Test of Isolation', url: 'https://oldschool.runescape.wiki/images/Test_of_Isolation.ogg' },
        { name: 'Test of Resourcefulness', url: 'https://oldschool.runescape.wiki/images/Test_of_Resourcefulness.ogg' },
        { name: 'Test of Strength', url: 'https://oldschool.runescape.wiki/images/Test_of_Strength.ogg' },
        { name: 'Test Your Sails', url: 'https://oldschool.runescape.wiki/images/Test_Your_Sails.ogg' },
        { name: 'That Sullen Hall', url: 'https://oldschool.runescape.wiki/images/That_Sullen_Hall.ogg' },
        { name: 'Theme', url: 'https://oldschool.runescape.wiki/images/Theme.ogg' },
        { name: 'A Thorn in My Side', url: 'https://oldschool.runescape.wiki/images/A_Thorn_in_My_Side.ogg' },
        { name: 'Thrall of the Devourer', url: 'https://oldschool.runescape.wiki/images/Thrall_of_the_Devourer.ogg' },
        { name: 'Thrall of the Serpent', url: 'https://oldschool.runescape.wiki/images/Thrall_of_the_Serpent.ogg' },
        { name: 'Throne of the Demon', url: 'https://oldschool.runescape.wiki/images/Throne_of_the_Demon.ogg' },
        { name: 'Tick Tock', url: 'https://oldschool.runescape.wiki/images/Tick_Tock.ogg' },
        { name: 'Time Out', url: 'https://oldschool.runescape.wiki/images/Time_Out.ogg' },
        { name: 'Time to Mine', url: 'https://oldschool.runescape.wiki/images/Time_to_Mine.ogg' },
        { name: 'Tiptoe', url: 'https://oldschool.runescape.wiki/images/Tiptoe.ogg' },
        { name: 'Title Fight', url: 'https://oldschool.runescape.wiki/images/Title_Fight.ogg' },
        { name: 'Tomb Raider', url: 'https://oldschool.runescape.wiki/images/Tomb_Raider.ogg' },
        { name: 'Tomorrow', url: 'https://oldschool.runescape.wiki/images/Tomorrow.ogg' },
        { name: 'Too Many Cooks...', url: 'https://oldschool.runescape.wiki/images/Too_Many_Cooks....ogg' },
        { name: 'The Tortugan Way', url: 'https://oldschool.runescape.wiki/images/The_Tortugan_Way.ogg' },
        { name: 'The Tower of Voices', url: 'https://oldschool.runescape.wiki/images/The_Tower_of_Voices.ogg' },
        { name: 'The Tower', url: 'https://oldschool.runescape.wiki/images/The_Tower.ogg' },
        { name: 'The Trade Parade', url: 'https://oldschool.runescape.wiki/images/The_Trade_Parade.ogg' },
        { name: 'Trahaearn Toil', url: 'https://oldschool.runescape.wiki/images/Trahaearn_Toil.ogg' },
        { name: 'Tranquillity', url: 'https://oldschool.runescape.wiki/images/Tranquillity.ogg' },
        { name: 'Trawler', url: 'https://oldschool.runescape.wiki/images/Trawler.ogg' },
        { name: 'Trawler Minor', url: 'https://oldschool.runescape.wiki/images/Trawler_Minor.ogg' },
        { name: 'Tree Spirits', url: 'https://oldschool.runescape.wiki/images/Tree_Spirits.ogg' },
        { name: 'Tremble', url: 'https://oldschool.runescape.wiki/images/Tremble.ogg' },
        { name: 'Tribal', url: 'https://oldschool.runescape.wiki/images/Tribal.ogg' },
        { name: 'Tribal 2', url: 'https://oldschool.runescape.wiki/images/Tribal_2.ogg' },
        { name: 'Tribal Background', url: 'https://oldschool.runescape.wiki/images/Tribal_Background.ogg' },
        { name: 'Trinity', url: 'https://oldschool.runescape.wiki/images/Trinity.ogg' },
        { name: 'Troll Shuffle', url: 'https://oldschool.runescape.wiki/images/Troll_Shuffle.ogg' },
        { name: 'Trouble Brewing', url: 'https://oldschool.runescape.wiki/images/Trouble_Brewing.ogg' },
        { name: 'Troubled', url: 'https://oldschool.runescape.wiki/images/Troubled.ogg' },
        { name: 'Troubled Waters', url: 'https://oldschool.runescape.wiki/images/Troubled_Waters.ogg' },
        { name: 'Truth', url: 'https://oldschool.runescape.wiki/images/Truth.ogg' },
        { name: 'Twilight', url: 'https://oldschool.runescape.wiki/images/Twilight.ogg' },
        { name: 'TzHaar!', url: 'https://oldschool.runescape.wiki/images/TzHaar!.ogg' },
        { name: 'Undead Army', url: 'https://oldschool.runescape.wiki/images/Undead_Army.ogg' },
        { name: 'Undead Dungeon', url: 'https://oldschool.runescape.wiki/images/Undead_Dungeon.ogg' },
        { name: 'Under the Mountain', url: 'https://oldschool.runescape.wiki/images/Under_the_Mountain.ogg' },
        { name: 'Undercurrent', url: 'https://oldschool.runescape.wiki/images/Undercurrent.ogg' },
        { name: 'Underground', url: 'https://oldschool.runescape.wiki/images/Underground.ogg' },
        { name: 'Underground Pass', url: 'https://oldschool.runescape.wiki/images/Underground_Pass.ogg' },
        { name: 'Understanding', url: 'https://oldschool.runescape.wiki/images/Understanding.ogg' },
        { name: 'The Undying Light', url: 'https://oldschool.runescape.wiki/images/The_Undying_Light.ogg' },
        { name: 'Unknown Land', url: 'https://oldschool.runescape.wiki/images/Unknown_Land.ogg' },
        { name: 'Untouchable', url: 'https://oldschool.runescape.wiki/images/Untouchable.ogg' },
        { name: 'Unturned Stones', url: 'https://oldschool.runescape.wiki/images/Unturned_Stones.ogg' },
        { name: 'Upcoming', url: 'https://oldschool.runescape.wiki/images/Upcoming.ogg' },
        { name: 'Upir Likhyi', url: 'https://oldschool.runescape.wiki/images/Upir_Likhyi.ogg' },
        { name: 'Upper Depths', url: 'https://oldschool.runescape.wiki/images/Upper_Depths.ogg' },
        { name: 'Vampyre Assault', url: 'https://oldschool.runescape.wiki/images/Vampyre_Assault.ogg' },
        { name: 'Vanescula', url: 'https://oldschool.runescape.wiki/images/Vanescula.ogg' },
        { name: 'Varlamore\'s Sunset', url: 'https://oldschool.runescape.wiki/images/Varlamore%27s_Sunset.ogg' },
        { name: 'The Vault', url: 'https://oldschool.runescape.wiki/images/The_Vault.ogg' },
        { name: 'Venomous', url: 'https://oldschool.runescape.wiki/images/Venomous.ogg' },
        { name: 'Venture', url: 'https://oldschool.runescape.wiki/images/Venture.ogg' },
        { name: 'Venture 2', url: 'https://oldschool.runescape.wiki/images/Venture_2.ogg' },
        { name: 'Victory is Mine', url: 'https://oldschool.runescape.wiki/images/Victory_is_Mine.ogg' },
        { name: 'Village', url: 'https://oldschool.runescape.wiki/images/Village.ogg' },
        { name: 'Vision', url: 'https://oldschool.runescape.wiki/images/Vision.ogg' },
        { name: 'Volcanic Vikings', url: 'https://oldschool.runescape.wiki/images/Volcanic_Vikings.ogg' },
        { name: 'Voodoo Cult', url: 'https://oldschool.runescape.wiki/images/Voodoo_Cult.ogg' },
        { name: 'Voyage', url: 'https://oldschool.runescape.wiki/images/Voyage.ogg' },
        { name: 'The Waiting Game', url: 'https://oldschool.runescape.wiki/images/The_Waiting_Game.ogg' },
        { name: 'Waking Dream', url: 'https://oldschool.runescape.wiki/images/Waking_Dream.ogg' },
        { name: 'Waste Defaced', url: 'https://oldschool.runescape.wiki/images/Waste_Defaced.ogg' },
        { name: 'A Walk in the Woods', url: 'https://oldschool.runescape.wiki/images/A_Walk_in_the_Woods.ogg' },
        { name: 'The Walking Dead', url: 'https://oldschool.runescape.wiki/images/The_Walking_Dead.ogg' },
        { name: 'Wally the Hero', url: 'https://oldschool.runescape.wiki/images/Wally_the_Hero.ogg' },
        { name: 'Wander', url: 'https://oldschool.runescape.wiki/images/Wander.ogg' },
        { name: 'Warpath', url: 'https://oldschool.runescape.wiki/images/Warpath.ogg' },
        { name: 'Warrior', url: 'https://oldschool.runescape.wiki/images/Warrior.ogg' },
        { name: 'Warriors\' Guild', url: 'https://oldschool.runescape.wiki/images/Warriors%27_Guild.ogg' },
        { name: 'Watch Your Step', url: 'https://oldschool.runescape.wiki/images/Watch_Your_Step.ogg' },
        { name: 'Waterfall', url: 'https://oldschool.runescape.wiki/images/Waterfall.ogg' },
        { name: 'Waterlogged', url: 'https://oldschool.runescape.wiki/images/Waterlogged.ogg' },
        { name: 'Way of the Enchanter', url: 'https://oldschool.runescape.wiki/images/Way_of_the_Enchanter.ogg' },
        { name: 'Way of the Wyrm', url: 'https://oldschool.runescape.wiki/images/Way_of_the_Wyrm.ogg' },
        { name: 'Wayward', url: 'https://oldschool.runescape.wiki/images/Wayward.ogg' },
        { name: 'We are the Fairies', url: 'https://oldschool.runescape.wiki/images/We_are_the_Fairies.ogg' },
        { name: 'Welcome to my Nightmare', url: 'https://oldschool.runescape.wiki/images/Welcome_to_my_Nightmare.ogg' },
        { name: 'Welcome to the Theatre', url: 'https://oldschool.runescape.wiki/images/Welcome_to_the_Theatre.ogg' },
        { name: 'Well Hallowed Air', url: 'https://oldschool.runescape.wiki/images/Well_Hallowed_Air.ogg' },
        { name: 'Well of Voyage', url: 'https://oldschool.runescape.wiki/images/Well_of_Voyage.ogg' },
        { name: 'The Western Seas', url: 'https://oldschool.runescape.wiki/images/The_Western_Seas.ogg' },
        { name: 'What Happens Below...', url: 'https://oldschool.runescape.wiki/images/What_Happens_Below....ogg' },
        { name: 'What the Shell!', url: 'https://oldschool.runescape.wiki/images/What_the_Shell!.ogg' },
        { name: 'Where Eagles Lair', url: 'https://oldschool.runescape.wiki/images/Where_Eagles_Lair.ogg' },
        { name: 'Whispering Wind', url: 'https://oldschool.runescape.wiki/images/Whispering_Wind.ogg' },
        { name: 'Wild Isle', url: 'https://oldschool.runescape.wiki/images/Wild_Isle.ogg' },
        { name: 'Wild Side', url: 'https://oldschool.runescape.wiki/images/Wild_Side.ogg' },
        { name: 'Wilderness', url: 'https://oldschool.runescape.wiki/images/Wilderness.ogg' },
        { name: 'Wilderness 2', url: 'https://oldschool.runescape.wiki/images/Wilderness_2.ogg' },
        { name: 'Wilderness 3', url: 'https://oldschool.runescape.wiki/images/Wilderness_3.ogg' },
        { name: 'Wildwood', url: 'https://oldschool.runescape.wiki/images/Wildwood.ogg' },
        { name: 'Winter Funfair', url: 'https://oldschool.runescape.wiki/images/Winter_Funfair.ogg' },
        { name: 'Witching', url: 'https://oldschool.runescape.wiki/images/Witching.ogg' },
        { name: 'Woe of the Wyvern', url: 'https://oldschool.runescape.wiki/images/Woe_of_the_Wyvern.ogg' },
        { name: 'Wonder', url: 'https://oldschool.runescape.wiki/images/Wonder.ogg' },
        { name: 'Wonderous', url: 'https://oldschool.runescape.wiki/images/Wonderous.ogg' },
        { name: 'Woodland', url: 'https://oldschool.runescape.wiki/images/Woodland.ogg' },
        { name: 'Work Work Work', url: 'https://oldschool.runescape.wiki/images/Work_Work_Work.ogg' },
        { name: 'Workshop', url: 'https://oldschool.runescape.wiki/images/Workshop.ogg' },
        { name: 'A Worthy Foe', url: 'https://oldschool.runescape.wiki/images/A_Worthy_Foe.ogg' },
        { name: 'Wrath and Ruin', url: 'https://oldschool.runescape.wiki/images/Wrath_and_Ruin.ogg' },
        { name: 'Xenophobe', url: 'https://oldschool.runescape.wiki/images/Xenophobe.ogg' },
        { name: 'Yesteryear', url: 'https://oldschool.runescape.wiki/images/Yesteryear.ogg' },
        { name: 'Yo Ho Ho!', url: 'https://oldschool.runescape.wiki/images/Yo_Ho_Ho!.ogg' },
        { name: 'You Have My Attention', url: 'https://oldschool.runescape.wiki/images/You_Have_My_Attention.ogg' },
        { name: 'Zamorak Zoo', url: 'https://oldschool.runescape.wiki/images/Zamorak_Zoo.ogg' },
        { name: 'Zanik\'s Theme', url: 'https://oldschool.runescape.wiki/images/Zanik%27s_Theme.ogg' },
        { name: 'Zaros Zeitgeist', url: 'https://oldschool.runescape.wiki/images/Zaros_Zeitgeist.ogg' },
        { name: 'Zealot', url: 'https://oldschool.runescape.wiki/images/Zealot.ogg' },
        { name: 'Zogre Dance', url: 'https://oldschool.runescape.wiki/images/Zogre_Dance.ogg' },
        { name: 'Zombie Invasion', url: 'https://oldschool.runescape.wiki/images/Zombie_Invasion.ogg' },
        { name: 'Zombiism', url: 'https://oldschool.runescape.wiki/images/Zombiism.ogg' },
    ];

    function initGERadio() {
        const toggle = document.getElementById('geRadioToggle');
        const dropdown = document.getElementById('geRadioDropdown');
        const playBtn = document.getElementById('geRadioPlay');
        const prevBtn = document.getElementById('geRadioPrev');
        const nextBtn = document.getElementById('geRadioNext');
        const volumeSlider = document.getElementById('geRadioVolume');
        const shuffleCheck = document.getElementById('geRadioShuffle');
        const nowPlayingEl = document.getElementById('geRadioNowPlaying');
        const labelEl = document.getElementById('geRadioLabel');
        const trackSelect = document.getElementById('geRadioTrackSelect');
        const playIcon = playBtn.querySelector('.ge-radio-play-icon');
        const pauseIcon = playBtn.querySelector('.ge-radio-pause-icon');

        let audio = null;
        let trackIndex = -1;
        let isPlaying = false;
        let shufflePlaylist = [];

        // Populate track dropdown
        GE_RADIO_TRACKS.forEach((track, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = track.name;
            trackSelect.appendChild(opt);
        });

        function buildShufflePlaylist() {
            shufflePlaylist = GE_RADIO_TRACKS.map((_, i) => i);
            for (let i = shufflePlaylist.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shufflePlaylist[i], shufflePlaylist[j]] = [shufflePlaylist[j], shufflePlaylist[i]];
            }
        }
        buildShufflePlaylist();

        function getNextIndex(direction) {
            if (shuffleCheck.checked) {
                const pos = shufflePlaylist.indexOf(trackIndex);
                let next = pos + direction;
                if (next >= shufflePlaylist.length) { buildShufflePlaylist(); next = 0; }
                if (next < 0) next = shufflePlaylist.length - 1;
                return shufflePlaylist[next];
            }
            let next = trackIndex + direction;
            if (next >= GE_RADIO_TRACKS.length) next = 0;
            if (next < 0) next = GE_RADIO_TRACKS.length - 1;
            return next;
        }

        function ensureAudio() {
            if (!audio) {
                audio = new Audio();
                audio.crossOrigin = 'anonymous';
                audio.addEventListener('ended', () => playTrack(getNextIndex(1)));
                audio.addEventListener('error', () => {
                    nowPlayingEl.textContent = 'Skipping...';
                    setTimeout(() => playTrack(getNextIndex(1)), 800);
                });
            }
        }

        function loadTrack(index) {
            trackIndex = index;
            const track = GE_RADIO_TRACKS[trackIndex];
            ensureAudio();
            audio.src = track.url;
            audio.volume = volumeSlider.value / 100;
            nowPlayingEl.textContent = '♫ ' + track.name;
            labelEl.textContent = track.name;
            trackSelect.value = index;
        }

        function playTrack(index) {
            loadTrack(index);
            const p = audio.play();
            if (p && p.then) {
                p.then(() => {
                    isPlaying = true;
                    updatePlayState();
                }).catch(() => {
                    isPlaying = false;
                    updatePlayState();
                });
            }
        }

        function updatePlayState() {
            playIcon.style.display = isPlaying ? 'none' : '';
            pauseIcon.style.display = isPlaying ? '' : 'none';
            toggle.classList.toggle('playing', isPlaying);
            dropdown.classList.toggle('playing', isPlaying);
            if (!isPlaying && trackIndex === -1) {
                labelEl.textContent = 'GE Radio';
                nowPlayingEl.textContent = 'Not playing';
            }
        }

        // Toggle dropdown
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('open');
        });

        // Close dropdown on outside click
        document.addEventListener('click', (e) => {
            if (!document.getElementById('geRadio').contains(e.target)) {
                dropdown.classList.remove('open');
            }
        });

        // Play / Pause
        playBtn.addEventListener('click', () => {
            if (!audio || trackIndex === -1) {
                const start = shuffleCheck.checked ? shufflePlaylist[0] : Math.floor(Math.random() * GE_RADIO_TRACKS.length);
                playTrack(start);
                return;
            }
            if (isPlaying) {
                audio.pause();
                isPlaying = false;
            } else {
                const p = audio.play();
                if (p && p.then) p.then(() => { isPlaying = true; updatePlayState(); }).catch(() => {});
                isPlaying = true;
            }
            updatePlayState();
        });

        // Prev / Next
        prevBtn.addEventListener('click', () => {
            if (trackIndex === -1) return;
            playTrack(getNextIndex(-1));
        });
        nextBtn.addEventListener('click', () => {
            if (trackIndex === -1) {
                playTrack(shuffleCheck.checked ? shufflePlaylist[0] : 0);
                return;
            }
            playTrack(getNextIndex(1));
        });

        // Volume
        volumeSlider.addEventListener('input', () => {
            if (audio) audio.volume = volumeSlider.value / 100;
        });

        // Shuffle
        shuffleCheck.addEventListener('change', () => {
            if (shuffleCheck.checked) buildShufflePlaylist();
        });

        // Track select dropdown — pick a specific song
        trackSelect.addEventListener('change', () => {
            const idx = parseInt(trackSelect.value, 10);
            if (idx >= 0 && idx < GE_RADIO_TRACKS.length) {
                playTrack(idx);
            }
        });
    }

    // ========================================
    // Feedback Form + Admin Panel
    // ========================================

    const FEEDBACK_SERVER = 'https://osrs-ge-counter.onrender.com';

    function initFeedback() {
        const form = document.getElementById('feedbackForm');
        const msgInput = document.getElementById('feedbackMessage');
        const charCount = document.getElementById('feedbackCharCount');
        const statusEl = document.getElementById('feedbackStatus');
        const submitBtn = document.getElementById('feedbackSubmitBtn');

        if (!form || !msgInput) return;

        msgInput.addEventListener('input', () => {
            charCount.textContent = `${msgInput.value.length} / 2000`;
        });

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const type = form.querySelector('input[name="feedbackType"]:checked')?.value || 'suggestion';
            const name = document.getElementById('feedbackName')?.value.trim() || 'Anonymous';
            const message = msgInput.value.trim();
            if (!message) return;

            submitBtn.disabled = true;
            statusEl.className = 'feedback-status';
            statusEl.textContent = 'Sending...';

            try {
                const res = await fetch(`${FEEDBACK_SERVER}/feedback`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type, name, message }),
                });
                if (res.ok) {
                    statusEl.className = 'feedback-status success';
                    statusEl.textContent = 'Thanks for your feedback!';
                    form.reset();
                    charCount.textContent = '0 / 2000';
                    setTimeout(() => { statusEl.textContent = ''; }, 4000);
                } else {
                    throw new Error();
                }
            } catch (e) {
                statusEl.className = 'feedback-status error';
                statusEl.textContent = 'Failed to send. Try again later.';
            }
            submitBtn.disabled = false;
        });
    }

    // ========================================
    // Admin Panel
    // ========================================

    let adminToken = null;

    function initAdmin() {
        const manageBtn = document.getElementById('footerManage');
        const overlay = document.getElementById('adminOverlay');
        const closeBtn = document.getElementById('adminClose');
        const loginBtn = document.getElementById('adminLoginBtn');
        const logoutBtn = document.getElementById('adminLogout');
        const loginSection = document.getElementById('adminLogin');
        const panelSection = document.getElementById('adminPanel');
        const errorEl = document.getElementById('adminError');

        if (!manageBtn || !overlay) return;

        manageBtn.addEventListener('click', () => {
            overlay.classList.add('active');
            // If already logged in, show panel
            if (adminToken) {
                loginSection.style.display = 'none';
                panelSection.style.display = 'block';
                loadAdminFeedback();
            } else {
                loginSection.style.display = 'block';
                panelSection.style.display = 'none';
            }
        });

        closeBtn.addEventListener('click', () => {
            overlay.classList.remove('active');
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.classList.remove('active');
        });

        loginBtn.addEventListener('click', async () => {
            const username = document.getElementById('adminUser').value.trim();
            const password = document.getElementById('adminPass').value;
            errorEl.textContent = '';

            try {
                const res = await fetch(`${FEEDBACK_SERVER}/admin/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password }),
                });
                const data = await res.json();
                if (res.ok && data.token) {
                    adminToken = data.token;
                    loginSection.style.display = 'none';
                    panelSection.style.display = 'block';
                    loadAdminFeedback();
                } else {
                    errorEl.textContent = 'Invalid credentials';
                }
            } catch (e) {
                errorEl.textContent = 'Connection failed';
            }
        });

        // Enter key to login
        document.getElementById('adminPass')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') loginBtn.click();
        });

        logoutBtn.addEventListener('click', () => {
            adminToken = null;
            loginSection.style.display = 'block';
            panelSection.style.display = 'none';
            document.getElementById('adminUser').value = '';
            document.getElementById('adminPass').value = '';
            errorEl.textContent = '';
        });
    }

    async function loadAdminFeedback() {
        const list = document.getElementById('adminFeedbackList');
        if (!list || !adminToken) return;

        list.innerHTML = '<p class="admin-loading">Loading feedback...</p>';

        try {
            const res = await fetch(`${FEEDBACK_SERVER}/admin/feedback`, {
                headers: { 'Authorization': `Bearer ${adminToken}` },
            });
            if (!res.ok) throw new Error();
            const feedback = await res.json();

            if (!feedback.length) {
                list.innerHTML = '<p class="admin-loading">No feedback yet.</p>';
                return;
            }

            list.innerHTML = feedback.map(fb => {
                const d = new Date(fb.date);
                const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                const escapedMsg = fb.message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const escapedName = (fb.name || 'Anonymous').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                return `<div class="admin-fb-card">
                    <div class="admin-fb-header">
                        <span class="admin-fb-type ${fb.type}">${fb.type === 'bug' ? '\ud83d\udc1b Bug' : '\ud83d\udca1 Suggestion'}</span>
                        <span class="admin-fb-name">${escapedName}</span>
                        <span class="admin-fb-date">${dateStr}</span>
                        <button class="admin-fb-delete" data-id="${fb.id}" title="Delete">Delete</button>
                    </div>
                    <p class="admin-fb-msg">${escapedMsg}</p>
                </div>`;
            }).join('');

            // Delete buttons
            list.querySelectorAll('.admin-fb-delete').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const id = btn.getAttribute('data-id');
                    try {
                        await fetch(`${FEEDBACK_SERVER}/admin/feedback/${id}`, {
                            method: 'DELETE',
                            headers: { 'Authorization': `Bearer ${adminToken}` },
                        });
                        loadAdminFeedback();
                    } catch (e) {}
                });
            });
        } catch (e) {
            list.innerHTML = '<p class="admin-loading">Failed to load feedback.</p>';
        }
    }

    // ========================================
    // Collapsible Sidebars
    // ========================================

    function initCollapsibleSidebars() {
        document.querySelectorAll('.sidebar-header[data-collapse-toggle]').forEach(header => {
            const targetId = header.getAttribute('data-collapse-toggle');
            const target = document.getElementById(targetId);
            if (!target) return;

            target.classList.add('sidebar-collapsible');
            const hint = header.querySelector('.sidebar-header-hint');

            header.addEventListener('click', (e) => {
                // Don't collapse when clicking the refresh button
                if (e.target.closest('.news-refresh-btn')) return;

                const isCollapsed = target.classList.toggle('collapsed');
                header.classList.toggle('collapsed', isCollapsed);
                if (hint) hint.textContent = isCollapsed ? 'click to expand' : 'click to collapse';
            });
        });
    }

    // ========================================
    // Spin the Wheel
    // ========================================

    function initSpinWheel() {
        const btn = document.getElementById('spinWheelBtn');
        const overlay = document.getElementById('spinOverlay');
        const closeBtn = document.getElementById('spinClose');
        const goBtn = document.getElementById('spinGoBtn');
        const reel = document.getElementById('spinReel');
        const resultEl = document.getElementById('spinResult');
        if (!btn || !overlay) return;

        const soundToggle = document.getElementById('spinSoundToggle');
        let spinSoundEnabled = localStorage.getItem('spin_sound') !== 'off';
        if (soundToggle) {
            soundToggle.checked = spinSoundEnabled;
            soundToggle.addEventListener('change', () => {
                spinSoundEnabled = soundToggle.checked;
                localStorage.setItem('spin_sound', spinSoundEnabled ? 'on' : 'off');
            });
        }

        let spinning = false;
        let wheelItems = [];

        function getTop20() {
            return allItems
                .filter(it => it.margin != null && it.margin > 0 && (it.volume || 0) >= 200)
                .sort((a, b) => b.margin - a.margin)
                .slice(0, 20);
        }

        function buildReelHTML(items, repeats) {
            let html = '';
            for (let r = 0; r < repeats; r++) {
                for (const it of items) {
                    const icon = getIconUrl(it.icon);
                    html += `<div class="spin-reel-item">`
                        + `<img src="${icon}" alt="" onerror="this.style.display='none'">`
                        + `<span class="spin-item-name">${it.name}</span>`
                        + `<span class="spin-item-margin">${formatGp(it.margin, true)}</span>`
                        + `</div>`;
                }
            }
            return html;
        }

        function openSpinWheel() {
            wheelItems = getTop20();
            if (wheelItems.length === 0) {
                resultEl.innerHTML = '<p style="color:var(--text-muted)">No qualifying items found yet. Wait for data to load.</p>';
                reel.innerHTML = '';
                overlay.classList.add('active');
                goBtn.disabled = true;
                return;
            }
            // Shuffle for randomness
            const shuffled = [...wheelItems].sort(() => Math.random() - 0.5);
            wheelItems = shuffled;

            const repeats = 8; // repeat the list many times for scrolling
            reel.innerHTML = buildReelHTML(shuffled, repeats);
            reel.style.transition = 'none';
            reel.style.transform = 'translateY(0)';
            resultEl.innerHTML = '';
            goBtn.disabled = false;
            spinning = false;
            overlay.classList.add('active');
        }

        function closeSpinWheel() {
            overlay.classList.remove('active');
            spinning = false;
        }

        // Sample the cubic-bezier(0.15, 0.8, 0.3, 1) curve into a lookup table
        // for accurate and glitch-free time->progress mapping
        const BEZIER_SAMPLES = 200;
        const bezierLUT = [];
        (function buildBezierLUT() {
            // cubic-bezier(0.15, 0.8, 0.3, 1) means:
            // P1 = (0.15, 0.8), P2 = (0.3, 1.0)
            for (let i = 0; i <= BEZIER_SAMPLES; i++) {
                const t = i / BEZIER_SAMPLES;
                const mt = 1 - t;
                const xVal = 3 * mt * mt * t * 0.15 + 3 * mt * t * t * 0.3 + t * t * t;
                const yVal = 3 * mt * mt * t * 0.8 + 3 * mt * t * t * 1.0 + t * t * t;
                bezierLUT.push({ x: xVal, y: yVal });
            }
        })();

        // Get eased progress (y) for a given time fraction (x) via LUT interpolation
        function getEasedProgress(timeFraction) {
            if (timeFraction <= 0) return 0;
            if (timeFraction >= 1) return 1;
            // Find the two surrounding samples
            for (let i = 1; i < bezierLUT.length; i++) {
                if (bezierLUT[i].x >= timeFraction) {
                    const prev = bezierLUT[i - 1];
                    const curr = bezierLUT[i];
                    const ratio = (timeFraction - prev.x) / (curr.x - prev.x);
                    return prev.y + ratio * (curr.y - prev.y);
                }
            }
            return 1;
        }

        // Play a short click sound for each reel tick, scheduled to follow the easing curve
        function getTimeFractionForProgress(progressFraction) {
            if (progressFraction <= 0) return 0;
            if (progressFraction >= 1) return 1;
            for (let i = 1; i < bezierLUT.length; i++) {
                const prev = bezierLUT[i - 1];
                const curr = bezierLUT[i];
                if (prev.y <= progressFraction && curr.y >= progressFraction) {
                    const ratio = (progressFraction - prev.y) / (curr.y - prev.y || 1);
                    return prev.x + ratio * (curr.x - prev.x);
                }
            }
            return 1;
        }

        function playClickSequence(ticks, duration) {
            if (!spinSoundEnabled) return;
            try {
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const now = audioContext.currentTime + 0.03; // small scheduling offset

                // Build a short click buffer (noise with exponential decay)
                const sr = audioContext.sampleRate;
                const clickLen = Math.max(256, Math.floor(sr * 0.02));
                const buffer = audioContext.createBuffer(1, clickLen, sr);
                const data = buffer.getChannelData(0);
                for (let i = 0; i < clickLen; i++) {
                    const env = Math.exp(-8 * i / clickLen);
                    data[i] = (Math.random() * 2 - 1) * env * 0.9;
                }

                for (let k = 0; k < ticks; k++) {
                    const targetProgress = k / ticks;
                    const timeFrac = getTimeFractionForProgress(targetProgress);
                    const t = now + timeFrac * duration;

                    const src = audioContext.createBufferSource();
                    src.buffer = buffer;
                    const g = audioContext.createGain();
                    src.connect(g);
                    g.connect(audioContext.destination);

                    // Very short envelope for a crisp click
                    g.gain.setValueAtTime(0.0001, t);
                    g.gain.exponentialRampToValueAtTime(0.1, t + 0.001);
                    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);

                    src.start(t);
                    src.stop(t + 0.04);
                }
            } catch (e) {
                // ignore audio errors silently
            }
        }

        function spin() {
            if (spinning || wheelItems.length === 0) return;
            spinning = true;
            goBtn.disabled = true;
            resultEl.innerHTML = '';

            // Re-shuffle and rebuild the reel for a fresh spin each time
            const shuffled = [...wheelItems].sort(() => Math.random() - 0.5);
            wheelItems = shuffled;
            const repeats = 8;
            reel.innerHTML = buildReelHTML(shuffled, repeats);

            // Reset position instantly (no transition)
            reel.style.transition = 'none';
            reel.style.transform = 'translateY(0)';
            // Force reflow so the reset takes effect before animating
            void reel.offsetHeight;

            const itemHeight = 50;
            const totalPerSet = wheelItems.length;
            // Pick a random winner index
            const winnerIdx = Math.floor(Math.random() * totalPerSet);
            // We want to scroll through several full sets then land on the winner
            const fullSets = 5; // scroll past 5 full sets
            const targetItem = fullSets * totalPerSet + winnerIdx;
            // Center the winner in the viewport (viewport is 100px = 2 items)
            const offset = targetItem * itemHeight - (50 - itemHeight / 2);

            // Play click sound synced to each item passing the pointer
            const spinDuration = 4.0;
            playClickSequence(targetItem, spinDuration);

            // Apply cubic-bezier for realistic slow-down
            reel.style.transition = `transform ${spinDuration}s cubic-bezier(0.15, 0.8, 0.3, 1)`;
            reel.style.transform = `translateY(-${offset}px)`;

            setTimeout(() => {
                spinning = false;
                goBtn.disabled = false;
                const winner = wheelItems[winnerIdx];
                showSpinResult(winner);
            }, 4200);
        }

        function showSpinResult(item) {
            const icon = getIconUrl(item.icon);
            resultEl.innerHTML = `
                <div class="spin-result-card" data-item-id="${item.id}" title="Click to view details">
                    <img src="${icon}" alt="">
                    <div class="spin-result-info">
                        <div class="spin-result-name">${item.name}</div>
                        <div class="spin-result-details">Margin: <span>${formatGp(item.margin, true)}</span> &bull; Volume: ${(item.volume || 0).toLocaleString()}</div>
                    </div>
                </div>`;
            const card = resultEl.querySelector('.spin-result-card');
            if (card) {
                card.addEventListener('click', () => {
                    closeSpinWheel();
                    const full = allItems.find(i => i.id === item.id);
                    if (full) openModal(full);
                });
            }
        }

        btn.addEventListener('click', openSpinWheel);
        closeBtn.addEventListener('click', closeSpinWheel);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeSpinWheel();
        });
        goBtn.addEventListener('click', spin);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('active')) closeSpinWheel();
        });
    }

    // ========================================
    // Init
    // ========================================

    // ========================================
    // VISITOR COUNTER (WebSocket → Render)
    // ========================================
    function initVisitorCounter() {
        // ── REPLACE with your Render service URL ──
        const SERVER_URL = 'https://osrs-ge-counter.onrender.com/';
        const WS_URL = SERVER_URL.replace('https://', 'wss://').replace('http://', 'ws://');

        const onlineCountEl = document.getElementById('onlineCount');
        const totalVisitorsEl = document.getElementById('totalVisitors');

        // Base offset (0 = show real count)
        const ONLINE_BASE = 0;
        const TOTAL_BASE = 0;

        // Check if this is a brand-new visitor (never visited before)
        const VISITED_KEY = 'ge_has_visited';
        const isNewVisitor = !localStorage.getItem(VISITED_KEY);
        if (isNewVisitor) localStorage.setItem(VISITED_KEY, '1');

        function updateStats(data) {
            if (data.online != null && onlineCountEl)
                onlineCountEl.textContent = (Number(data.online) + ONLINE_BASE).toLocaleString();
            if (data.total != null && totalVisitorsEl)
                totalVisitorsEl.textContent = (Number(data.total) + TOTAL_BASE).toLocaleString();
        }

        // 1) HTTP fetch first — works reliably & wakes a sleeping Render instance
        async function fetchStats() {
            try {
                const res = await fetch(SERVER_URL);
                if (res.ok) updateStats(await res.json());
            } catch (e) {}
        }
        fetchStats();

        // 2) Also poll via HTTP every 30s as a reliable fallback
        setInterval(fetchStats, 30000);

        // 3) WebSocket for real-time updates (may fail while Render is waking)
        let ws;
        let reconnectTimer;
        let sentNewVisitor = false;

        function connect() {
            try { ws = new WebSocket(WS_URL); } catch (e) { return; }

            ws.onopen = () => {
                // Tell the server this is a new visitor (only once per session)
                if (isNewVisitor && !sentNewVisitor) {
                    ws.send(JSON.stringify({ type: 'new_visitor' }));
                    sentNewVisitor = true;
                }
            };

            ws.onmessage = (event) => {
                try { updateStats(JSON.parse(event.data)); } catch (e) {}
            };

            ws.onclose = () => {
                clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout(connect, 5000);
            };

            ws.onerror = () => { ws.close(); };
        }

        // Delay WebSocket slightly so the HTTP fetch wakes the server first
        setTimeout(connect, 2000);
    }

    function init() {
        initEvents();
        initTheme();
        initEffects();
        initCursorSelector();
        initPetCompanion();
        initSeasonalTheme();
        initGERadio();
        initCollapsibleSidebars();
        initSpinWheel();
        initVisitorCounter();
        loadData();
        loadNewsFeed();
        initFeedback();
        initAdmin();

        // Handle URL routing for item pages
        handleUrlRouting();

        // Listen for back/forward button
        window.addEventListener('popstate', handleUrlRouting);

        // News refresh button
        const newsRefreshBtn = document.getElementById('newsRefreshBtn');
        if (newsRefreshBtn) {
            newsRefreshBtn.addEventListener('click', () => {
                newsRefreshBtn.classList.add('spinning');
                loadNewsFeed().finally(() => {
                    setTimeout(() => newsRefreshBtn.classList.remove('spinning'), 600);
                });
            });
        }

        // Auto-refresh prices every 1 minute
        setInterval(() => {
            refreshPrices();
        }, 60000);
    }

    // Handle URL-based routing
    function handleUrlRouting() {
        const pathname = window.location.pathname;
        
        // If we're at the root, close any open modal
        if (pathname === '/' || pathname === '') {
            dom.modalOverlay.classList.remove('active');
            document.body.style.overflow = '';
            return;
        }

        // Extract item slug from URL (remove leading slash)
        const slug = pathname.replace(/^\//, '').split('/')[0];

        if (!slug) return;

        // Try to find the item by slug (wait for data if needed)
        const findAndOpenItem = () => {
            const item = findItemBySlug(slug);
            if (item) {
                openModal(item);
            } else if (!allItems || allItems.length === 0) {
                // Data not loaded yet, try again after a short delay
                setTimeout(findAndOpenItem, 100);
            }
        };

        findAndOpenItem();
    }

    // ========================================
    // Theme Selector (Dropdown)
    // ========================================

    const THEME_NAMES = {
        'dark': 'Dark',
        'light': 'Light',
        'blood-moon': 'Blood Moon',
        'dark-green': 'Dark Forest',
        'ocean': 'Ocean Depths',
        'royal-purple': 'Royal Purple',
        'sunset': 'Sunset',
    };

    function initTheme() {
        const saved = localStorage.getItem('ge_theme') || 'dark';
        applyTheme(saved);

        const selector = document.getElementById('themeSelector');
        const toggle = document.getElementById('themeToggle');
        const dropdown = document.getElementById('themeDropdown');

        // Toggle dropdown on button click
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            // Close effects dropdown
            var es = document.getElementById('effectsSelector');
            if (es) es.classList.remove('open');
            selector.classList.toggle('open');
        });

        // Handle theme option clicks
        dropdown.addEventListener('click', (e) => {
            const option = e.target.closest('.theme-option');
            if (!option) return;
            const theme = option.getAttribute('data-theme');
            if (theme) {
                document.body.classList.add('theme-transitioning');
                applyTheme(theme);
                localStorage.setItem('ge_theme', theme);
                setTimeout(() => document.body.classList.remove('theme-transitioning'), 500);
                selector.classList.remove('open');
            }
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!selector.contains(e.target)) {
                selector.classList.remove('open');
            }
        });

        // Close dropdown on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                selector.classList.remove('open');
            }
        });
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        // Update label
        const label = document.getElementById('themeLabel');
        if (label) label.textContent = THEME_NAMES[theme] || theme;
        // Update active state on options
        const options = document.querySelectorAll('.theme-option');
        options.forEach(opt => {
            opt.classList.toggle('active', opt.getAttribute('data-theme') === theme);
        });
    }

    // ========================================
    // Custom Cursors — OSRS themed
    // ========================================

    const CURSOR_LIST = [
        { id: 'default', name: 'Default', svg: null },
        {
            id: 'osrs-sword',
            name: 'Bronze Sword',
            png: 'https://oldschool.runescape.wiki/images/Bronze_sword.png',
            hotspot: [3, 29]
        },
        {
            id: 'osrs-rune-sword',
            name: 'Rune Sword',
            png: 'https://oldschool.runescape.wiki/images/Rune_sword.png',
            hotspot: [3, 29]
        },
        {
            id: 'osrs-dragon-scim',
            name: 'Dragon Scimitar',
            png: 'https://oldschool.runescape.wiki/images/Dragon_scimitar.png',
            hotspot: [3, 29]
        },
        {
            id: 'osrs-crosshair',
            name: 'Attack Crosshair',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
                <circle cx="16" cy="16" r="10" fill="none" stroke="%23E74C3C" stroke-width="2"/>
                <circle cx="16" cy="16" r="4" fill="none" stroke="%23E74C3C" stroke-width="1.5"/>
                <line x1="16" y1="2" x2="16" y2="8" stroke="%23E74C3C" stroke-width="2" stroke-linecap="round"/>
                <line x1="16" y1="24" x2="16" y2="30" stroke="%23E74C3C" stroke-width="2" stroke-linecap="round"/>
                <line x1="2" y1="16" x2="8" y2="16" stroke="%23E74C3C" stroke-width="2" stroke-linecap="round"/>
                <line x1="24" y1="16" x2="30" y2="16" stroke="%23E74C3C" stroke-width="2" stroke-linecap="round"/>
            </svg>`,
            hotspot: [16, 16]
        },
        {
            id: 'osrs-gold-pointer',
            name: 'Gold Pointer',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
                <path d="M5 2 L5 22 L10 17 L15 26 L19 24 L14 15 L20 15 Z" fill="%23C8AA6E" stroke="%23704214" stroke-width="1.5" stroke-linejoin="round"/>
            </svg>`,
            hotspot: [5, 2]
        },
        {
            id: 'osrs-green-pointer',
            name: 'Guthix Pointer',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
                <path d="M5 2 L5 22 L10 17 L15 26 L19 24 L14 15 L20 15 Z" fill="%232ECC71" stroke="%23196F3D" stroke-width="1.5" stroke-linejoin="round"/>
            </svg>`,
            hotspot: [5, 2]
        },
        {
            id: 'osrs-red-pointer',
            name: 'Zamorak Pointer',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
                <path d="M5 2 L5 22 L10 17 L15 26 L19 24 L14 15 L20 15 Z" fill="%23E74C3C" stroke="%23922B21" stroke-width="1.5" stroke-linejoin="round"/>
            </svg>`,
            hotspot: [5, 2]
        },
        {
            id: 'osrs-blue-pointer',
            name: 'Saradomin Pointer',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
                <path d="M5 2 L5 22 L10 17 L15 26 L19 24 L14 15 L20 15 Z" fill="%233B82F6" stroke="%231A5276" stroke-width="1.5" stroke-linejoin="round"/>
            </svg>`,
            hotspot: [5, 2]
        },
        {
            id: 'osrs-purple-pointer',
            name: 'Ancient Pointer',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
                <path d="M5 2 L5 22 L10 17 L15 26 L19 24 L14 15 L20 15 Z" fill="%239B59B6" stroke="%236C3483" stroke-width="1.5" stroke-linejoin="round"/>
            </svg>`,
            hotspot: [5, 2]
        },
    ];

    let currentCursor = localStorage.getItem('ge_cursor') || 'default';

    function initCursorSelector() {
        const cursorList = document.getElementById('cursorList');
        if (!cursorList) return;

        CURSOR_LIST.forEach(function(cur) {
            var btn = document.createElement('button');
            btn.className = 'cursor-option' + (currentCursor === cur.id ? ' active' : '');
            btn.setAttribute('data-cursor', cur.id);

            if (cur.png) {
                // Create a tiny preview using the PNG image
                var preview = document.createElement('div');
                preview.className = 'cursor-option-preview';
                var img = document.createElement('img');
                img.src = cur.png;
                img.alt = cur.name;
                img.style.width = '24px';
                img.style.height = '24px';
                img.style.objectFit = 'contain';
                img.style.imageRendering = 'pixelated';
                preview.appendChild(img);
                btn.appendChild(preview);
            } else if (cur.svg) {
                // Create a tiny preview of the cursor
                var preview = document.createElement('div');
                preview.className = 'cursor-option-preview';
                preview.innerHTML = cur.svg.replace(/%23/g, '#');
                btn.appendChild(preview);
            } else {
                var icon = document.createElement('div');
                icon.className = 'cursor-option-preview cursor-default-icon';
                icon.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M7 2l12 11.2-5.8.5 3.3 7.3-2.2 1-3.2-7.4L7 18.5V2z"/></svg>';
                btn.appendChild(icon);
            }

            var nameSpan = document.createElement('span');
            nameSpan.className = 'cursor-option-name';
            nameSpan.textContent = cur.name;
            btn.appendChild(nameSpan);

            cursorList.appendChild(btn);
        });

        // Handle clicks
        cursorList.addEventListener('click', function(e) {
            var option = e.target.closest('.cursor-option');
            if (!option) return;
            var cursorId = option.getAttribute('data-cursor');
            if (cursorId === null) return;
            selectCursor(cursorId);
            var all = cursorList.querySelectorAll('.cursor-option');
            for (var i = 0; i < all.length; i++) {
                all[i].classList.toggle('active', all[i].getAttribute('data-cursor') === cursorId);
            }
        });

        // Apply saved cursor on load
        if (currentCursor !== 'default') {
            applyCursorStyle(currentCursor);
        }
    }

    function selectCursor(cursorId) {
        currentCursor = cursorId;
        localStorage.setItem('ge_cursor', cursorId);
        applyCursorStyle(cursorId);
    }

    function applyCursorStyle(cursorId) {
        // Remove any existing custom cursor style
        let styleEl = document.getElementById('ge-custom-cursor-style');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'ge-custom-cursor-style';
            document.head.appendChild(styleEl);
        }

        if (cursorId === 'default') {
            styleEl.textContent = '';
            return;
        }

        const cur = CURSOR_LIST.find(c => c.id === cursorId);
        if (!cur || (!cur.svg && !cur.png)) {
            styleEl.textContent = '';
            return;
        }

        let dataUri;
        if (cur.png) {
            // Use the PNG image directly from the OSRS wiki
            dataUri = `url("${cur.png}") ${cur.hotspot[0]} ${cur.hotspot[1]}, auto`;
        } else {
            // Build a clean data URI — encode the SVG properly for use in CSS url()
            const svgClean = cur.svg
                .replace(/\n/g, '')
                .replace(/\s{2,}/g, ' ')
                .replace(/%23/g, '#')
                .trim();
            // Percent-encode the SVG for safe embedding in a CSS url()
            const encoded = encodeURIComponent(svgClean)
                .replace(/'/g, '%27')
                .replace(/\(/g, '%28')
                .replace(/\)/g, '%29');
            dataUri = `url("data:image/svg+xml,${encoded}") ${cur.hotspot[0]} ${cur.hotspot[1]}, auto`;
        }

        styleEl.textContent =
            `html, body, *, *::before, *::after { cursor: ${dataUri} !important; }\n` +
            `a, button, [role="button"], select, label, ` +
            `input[type="submit"], input[type="button"], ` +
            `.item-card, .cursor-pointer { cursor: ${dataUri} !important; }`;
    }

    // ========================================
    // Effects & Pet Combined Dropdown
    // ========================================

    function initEffects() {
        const selector = document.getElementById('effectsSelector');
        const toggle = document.getElementById('effectsToggle');
        const dropdown = document.getElementById('effectsDropdown');
        const onOffBtn = document.getElementById('effectsOnOffBtn');
        const onOffLabel = document.getElementById('effectsOnOffLabel');
        const statusDot = document.getElementById('effectsStatusDot');

        if (!selector || !toggle || !dropdown || !onOffBtn) return;

        // Init state
        if (!effectsEnabled) {
            document.body.classList.add('effects-off');
            onOffLabel.textContent = 'Effects Off';
            onOffBtn.classList.remove('active');
            statusDot.classList.add('off');
        } else {
            onOffBtn.classList.add('active');
        }

        // Toggle dropdown
        toggle.addEventListener('click', function(e) {
            e.stopPropagation();
            // Close theme dropdown
            var ts = document.getElementById('themeSelector');
            if (ts) ts.classList.remove('open');
            selector.classList.toggle('open');
        });

        // Prevent clicks inside dropdown from closing it
        dropdown.addEventListener('click', function(e) {
            e.stopPropagation();
        });

        // Effects on/off toggle
        onOffBtn.addEventListener('click', function() {
            effectsEnabled = !effectsEnabled;
            localStorage.setItem('ge_effects', effectsEnabled ? 'on' : 'off');
            document.body.classList.toggle('effects-off', !effectsEnabled);
            onOffLabel.textContent = effectsEnabled ? 'Effects On' : 'Effects Off';
            onOffBtn.classList.toggle('active', effectsEnabled);
            statusDot.classList.toggle('off', !effectsEnabled);
            // Hide/show pet when effects toggled
            if (petEl) petEl.style.display = effectsEnabled && currentPet !== 'none' ? '' : 'none';
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', function(e) {
            if (!selector.contains(e.target)) selector.classList.remove('open');
        });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') selector.classList.remove('open');
        });

        // Collapsible sub-sections (Cursor Style & Pet Companion)
        setupCollapsibleSection('cursorSectionToggle', 'cursorSectionBody');
        setupCollapsibleSection('petSectionToggle', 'petSectionBody');
    }

    function setupCollapsibleSection(toggleId, bodyId) {
        const toggle = document.getElementById(toggleId);
        const body = document.getElementById(bodyId);
        if (!toggle || !body) return;

        toggle.addEventListener('click', function() {
            const isCollapsed = body.classList.contains('collapsed');
            body.classList.toggle('collapsed', !isCollapsed);
            toggle.classList.toggle('expanded', isCollapsed);
        });
    }

    // ========================================
    // Pet Companion
    // ========================================

    const PET_LIST = [
        { id: 'chaos-elemental', name: 'Pet chaos elemental', icon: 'Pet_chaos_elemental.png' },
        { id: 'dagannoth-supreme', name: 'Pet dagannoth supreme', icon: 'Pet_dagannoth_supreme.png' },
        { id: 'dagannoth-prime', name: 'Pet dagannoth prime', icon: 'Pet_dagannoth_prime.png' },
        { id: 'dagannoth-rex', name: 'Pet dagannoth rex', icon: 'Pet_dagannoth_rex.png' },
        { id: 'penance-queen', name: 'Pet penance queen', icon: 'Pet_penance_queen.png' },
        { id: 'kreearra', name: "Pet kree'arra", icon: 'Pet_kree%27arra.png' },
        { id: 'general-graardor', name: 'Pet general graardor', icon: 'Pet_general_graardor.png' },
        { id: 'zilyana', name: 'Pet zilyana', icon: 'Pet_zilyana.png' },
        { id: 'kril-tsutsaroth', name: "Pet k'ril tsutsaroth", icon: 'Pet_k%27ril_tsutsaroth.png' },
        { id: 'baby-mole', name: 'Baby mole', icon: 'Baby_mole.png' },
        { id: 'prince-black-dragon', name: 'Prince black dragon', icon: 'Prince_black_dragon.png' },
        { id: 'kalphite-princess', name: 'Kalphite princess', icon: 'Kalphite_princess.png' },
        { id: 'smoke-devil', name: 'Pet smoke devil', icon: 'Pet_smoke_devil.png' },
        { id: 'kraken', name: 'Pet kraken', icon: 'Pet_kraken.png' },
        { id: 'dark-core', name: 'Pet dark core', icon: 'Pet_dark_core.png' },
        { id: 'snakeling', name: 'Pet snakeling', icon: 'Pet_snakeling.png' },
        { id: 'chompy-chick', name: 'Chompy chick', icon: 'Chompy_chick.png' },
        { id: 'venenatis-spiderling', name: 'Venenatis spiderling', icon: 'Venenatis_spiderling.png' },
        { id: 'callisto-cub', name: 'Callisto cub', icon: 'Callisto_cub.png' },
        { id: 'vetion-jr', name: "Vet'ion jr.", icon: 'Vet%27ion_jr..png' },
        { id: 'scorpia-offspring', name: "Scorpia's offspring", icon: 'Scorpia%27s_offspring.png' },
        { id: 'tzrek-jad', name: 'Tzrek-jad', icon: 'Tzrek-jad.png' },
        { id: 'hellpuppy', name: 'Hellpuppy', icon: 'Hellpuppy.png' },
        { id: 'abyssal-orphan', name: 'Abyssal orphan', icon: 'Abyssal_orphan.png' },
        { id: 'heron', name: 'Heron', icon: 'Heron.png' },
        { id: 'rock-golem', name: 'Rock golem', icon: 'Rock_golem.png' },
        { id: 'beaver', name: 'Beaver', icon: 'Beaver.png' },
        { id: 'baby-chinchompa', name: 'Baby chinchompa', icon: 'Baby_chinchompa_%28gold%29.png' },
        { id: 'bloodhound', name: 'Bloodhound', icon: 'Bloodhound.png' },
        { id: 'giant-squirrel', name: 'Giant squirrel', icon: 'Giant_squirrel.png' },
        { id: 'tangleroot', name: 'Tangleroot', icon: 'Tangleroot.png' },
        { id: 'rift-guardian', name: 'Rift guardian', icon: 'Rift_guardian_(fire).png' },
        { id: 'rocky', name: 'Rocky', icon: 'Rocky.png' },
        { id: 'phoenix', name: 'Phoenix', icon: 'Phoenix.png' },
        { id: 'olmlet', name: 'Olmlet', icon: 'Olmlet.png' },
        { id: 'skotos', name: 'Skotos', icon: 'Skotos.png' },
        { id: 'jal-nib-rek', name: 'Jal-nib-rek', icon: 'Jal-nib-rek.png' },
        { id: 'herbi', name: 'Herbi', icon: 'Herbi.png' },
        { id: 'noon', name: 'Noon', icon: 'Noon.png' },
        { id: 'vorki', name: 'Vorki', icon: 'Vorki.png' },
        { id: 'lil-zik', name: "Lil' zik", icon: 'Lil%27_zik.png' },
        { id: 'ikkle-hydra', name: 'Ikkle hydra', icon: 'Ikkle_hydra_(electric).png' },
        { id: 'sraracha', name: 'Sraracha', icon: 'Sraracha.png' },
        { id: 'youngllef', name: 'Youngllef', icon: 'Youngllef.png' },
        { id: 'smolcano', name: 'Smolcano', icon: 'Smolcano.png' },
        { id: 'little-nightmare', name: 'Little nightmare', icon: 'Little_nightmare.png' },
        { id: 'lil-creator', name: "Lil' creator", icon: 'Lil%27_creator.png' },
        { id: 'tiny-tempor', name: 'Tiny tempor', icon: 'Tiny_tempor.png' },
        { id: 'nexling', name: 'Nexling', icon: 'Nexling.png' },
        { id: 'abyssal-protector', name: 'Abyssal protector', icon: 'Abyssal_protector.png' },
        { id: 'tumekens-guardian', name: "Tumeken's guardian", icon: 'Tumeken%27s_guardian.png' },
        { id: 'muphin', name: 'Muphin', icon: 'Muphin_(shielded).png' },
        { id: 'wisp', name: 'Wisp', icon: 'Wisp.png' },
        { id: 'butch', name: 'Butch', icon: 'Butch.png' },
        { id: 'lilviathan', name: "Lil'viathan", icon: 'Lil%27viathan.png' },
        { id: 'baron', name: 'Baron', icon: 'Baron.png' },
        { id: 'scurry', name: 'Scurry', icon: 'Scurry.png' },
        { id: 'smol-heredit', name: 'Smol heredit', icon: 'Smol_heredit.png' },
        { id: 'quetzin', name: 'Quetzin', icon: 'Quetzin.png' },
        { id: 'nid', name: 'Nid', icon: 'Nid.png' },
        { id: 'huberte', name: 'Huberte', icon: 'Huberte.png' },
        { id: 'moxi', name: 'Moxi', icon: 'Moxi.png' },
        { id: 'bran', name: 'Bran', icon: 'Bran.png' },
        { id: 'yami', name: 'Yami', icon: 'Yami.png' },
        { id: 'dom', name: 'Dom', icon: 'Dom.png' },
        { id: 'soup', name: 'Soup', icon: 'Soup.png' },
        { id: 'beef', name: 'Beef', icon: 'Beef.png' },
        { id: 'gull', name: 'Gull', icon: 'Gull_(follower).png' },
        { id: 'gulliver', name: 'Gulliver', icon: 'Gulliver_(follower).png' }
    ];

    let petEl = null;
    let currentPet = localStorage.getItem('ge_pet') || 'none';
    let petX = 0, petY = 0;
    let targetX = 0, targetY = 0;
    let petAnimFrame = null;
    let petBouncing = localStorage.getItem('ge_pet_bouncing') !== 'false'; // Default to true
    let petVelX = (Math.random() - 0.5) * 7;  // Velocity X with random initial direction
    let petVelY = (Math.random() - 0.5) * 7;  // Velocity Y with random initial direction

    function initPetCompanion() {
        const selector = document.getElementById('effectsSelector');
        const petList = document.getElementById('petList');

        if (!selector || !petList) return;

        // Build "None" option
        const noneBtn = document.createElement('button');
        noneBtn.className = 'pet-option' + (currentPet === 'none' ? ' active' : '');
        noneBtn.setAttribute('data-pet', 'none');
        noneBtn.innerHTML = '<span class="pet-option-name">None</span>';
        petList.appendChild(noneBtn);

        // Build options from PET_LIST
        PET_LIST.forEach(function(pet) {
            var btn = document.createElement('button');
            btn.className = 'pet-option' + (currentPet === pet.id ? ' active' : '');
            btn.setAttribute('data-pet', pet.id);
            var img = document.createElement('img');
            img.className = 'pet-option-icon';
            img.src = 'https://oldschool.runescape.wiki/images/' + pet.icon;
            img.alt = '';
            img.loading = 'lazy';
            img.onerror = function() { this.style.display = 'none'; };
            var span = document.createElement('span');
            span.className = 'pet-option-name';
            span.textContent = pet.name;
            btn.appendChild(img);
            btn.appendChild(span);
            petList.appendChild(btn);
        });

        // Handle pet option clicks (delegation on petList)
        petList.addEventListener('click', function(e) {
            var option = e.target.closest('.pet-option');
            if (!option) return;
            var petId = option.getAttribute('data-pet');
            if (petId === null) return;
            selectPet(petId);
            // Update active state
            var all = petList.querySelectorAll('.pet-option');
            for (var i = 0; i < all.length; i++) {
                all[i].classList.toggle('active', all[i].getAttribute('data-pet') === petId);
            }
        });

        // Prevent scroll-through on pet list
        petList.addEventListener('wheel', function(e) {
            var atTop = petList.scrollTop <= 0 && e.deltaY < 0;
            var atBottom = petList.scrollTop + petList.clientHeight >= petList.scrollHeight - 1 && e.deltaY > 0;
            if (atTop || atBottom) e.preventDefault();
        }, { passive: false });

        // Create pet element
        petEl = document.createElement('div');
        petEl.className = 'pet-companion' + (petBouncing ? ' walking' : '');
        var petImg = document.createElement('img');
        petImg.src = '';
        petImg.alt = '';
        petEl.appendChild(petImg);
        petEl.style.display = 'none';
        document.body.appendChild(petEl);

        // Click pet to toggle bouncing mode
        petEl.addEventListener('click', function(e) {
            e.stopPropagation();
            petBouncing = !petBouncing;
            localStorage.setItem('ge_pet_bouncing', petBouncing);
            petEl.classList.toggle('walking', petBouncing);
            if (!petBouncing) {
                // Reset to follow mode
                petX = window.innerWidth / 2;
                petY = window.innerHeight / 2;
            } else {
                // Initialize random position and velocity for bouncing
                petX = Math.random() * (window.innerWidth - 50);
                petY = Math.random() * (window.innerHeight - 50);
                petVelX = (Math.random() - 0.5) * 7;
                petVelY = (Math.random() - 0.5) * 7;
            }
        });

        // Mouse tracking (only for follow mode)
        document.addEventListener('mousemove', function(e) {
            if (!petBouncing) {
                targetX = e.clientX + 20;
                targetY = e.clientY + 10;
            }
        });

        // Pet animation - handles both bouncing (DVD logo style) and following
        // Throttled to ~30fps to reduce GPU usage
        let petLastFrame = 0;
        const PET_FRAME_INTERVAL = 33; // ~30fps
        function animatePet(timestamp) {
            if (timestamp - petLastFrame >= PET_FRAME_INTERVAL) {
                petLastFrame = timestamp;
                if (petEl && petEl.style.display !== 'none') {
                    if (petBouncing) {
                        // Bouncing mode: DVD logo style - move in random direction and bounce off edges
                        petX += petVelX;
                        petY += petVelY;
                        
                        const petSize = 50;
                        const maxX = window.innerWidth - petSize;
                        const maxY = window.innerHeight - petSize;
                        
                        // Bounce off edges
                        if (petX <= 0 || petX >= maxX) {
                            petVelX *= -1;
                            petX = Math.max(0, Math.min(maxX, petX));
                        }
                        if (petY <= 0 || petY >= maxY) {
                            petVelY *= -1;
                            petY = Math.max(0, Math.min(maxY, petY));
                        }
                        
                        petEl.style.left = petX + 'px';
                        petEl.style.top = petY + 'px';
                        petEl.style.transform = petVelX < 0 ? 'scaleX(-1)' : '';
                    } else {
                        // Follow mouse mode
                        var ease = 0.08;
                        petX += (targetX - petX) * ease;
                        petY += (targetY - petY) * ease;
                        petEl.style.left = petX + 'px';
                        petEl.style.top = petY + 'px';
                        var dx = targetX - petX;
                        petEl.style.transform = dx < -1 ? 'scaleX(-1)' : '';
                    }
                }
            }
            petAnimFrame = requestAnimationFrame(animatePet);
        }
        petAnimFrame = requestAnimationFrame(animatePet);

        // Restore saved pet
        if (currentPet !== 'none') {
            selectPet(currentPet);
        }
    }

    function selectPet(petId, silent) {
        currentPet = petId;
        localStorage.setItem('ge_pet', petId);

        if (petId === 'none') {
            petEl.style.display = 'none';
            return;
        }

        const pet = PET_LIST.find(p => p.id === petId);
        if (!pet) return;

        const img = petEl.querySelector('img');
        img.src = 'https://oldschool.runescape.wiki/images/' + pet.icon;
        img.alt = pet.name;
        
        // Ensure bouncing class is applied if bouncing mode is on
        petEl.classList.toggle('walking', petBouncing);
        
        // Initialize bouncing position and velocity
        if (petBouncing) {
            petX = Math.random() * (window.innerWidth - 50);
            petY = Math.random() * (window.innerHeight - 50);
            petVelX = (Math.random() - 0.5) * 7;
            petVelY = (Math.random() - 0.5) * 7;
        }

        if (effectsEnabled) {
            petEl.style.display = '';
        }
    }

    // ========================================
    // Confetti on Favorite
    // ========================================

    function spawnConfetti(x, y) {
        if (!effectsEnabled) return;
        const colors = ['#c8aa6e', '#e74c3c', '#2ecc71', '#3b82f6', '#f1c40f', '#e67e22', '#9b59b6'];
        const count = 8; // reduced from 14 for lower GPU usage
        for (let i = 0; i < count; i++) {
            const el = document.createElement('div');
            const isSquare = Math.random() > 0.5;
            el.className = 'confetti-particle' + (isSquare ? ' square' : '');
            el.style.left = x + 'px';
            el.style.top = y + 'px';
            el.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
            const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
            const dist = 30 + Math.random() * 60;
            el.style.setProperty('--cx', Math.cos(angle) * dist + 'px');
            el.style.setProperty('--cy', Math.sin(angle) * dist - 20 + 'px');
            el.style.setProperty('--cr', (Math.random() * 720 - 360) + 'deg');
            document.body.appendChild(el);
            el.addEventListener('animationend', () => el.remove());
        }
    }

    // ========================================
    // Auto-refresh prices (silent)
    // ========================================

    async function refreshPrices() {
        try {
            const latestData = await fetchWithRetry(`${API_BASE}/latest`);
            let volumeData = {};
            try {
                const vol = await fetchWithRetry(`${API_BASE}/volumes`);
                volumeData = vol.data || vol;
            } catch (e) {}

            // Snapshot old prices for pulse detection
            const oldPrices = {};
            allItems.forEach(item => {
                oldPrices[item.id] = { buy: item.buyPrice, sell: item.sellPrice };
            });

            const prices = latestData.data || {};
            allItems.forEach(item => {
                const price = prices[item.id] || {};
                const prevBuy = item.buyPrice;
                const prevSell = item.sellPrice;
                if (price.high != null) item.buyPrice = price.high;
                if (price.low != null) item.sellPrice = price.low;
                item.tax = item.buyPrice ? Math.min(Math.floor(item.buyPrice * 0.02), 5000000) : 0;
                if (item.buyPrice && item.sellPrice) item.margin = item.buyPrice - item.sellPrice - item.tax;
                if (price.highTime) item.buyTime = new Date(price.highTime * 1000);
                if (price.lowTime) item.sellTime = new Date(price.lowTime * 1000);
                if (volumeData[item.id] != null) {
                    item.volume = volumeData[item.id];
                }
                // Track price change direction
                if (prevBuy != null && item.buyPrice != null) {
                    if (item.buyPrice > prevBuy) item.buyChange = 'up';
                    else if (item.buyPrice < prevBuy) item.buyChange = 'down';
                }
                if (prevSell != null && item.sellPrice != null) {
                    if (item.sellPrice > prevSell) item.sellChange = 'up';
                    else if (item.sellPrice < prevSell) item.sellChange = 'down';
                }
            });

            dataLoadedAt = Date.now();
            dom.lastUpdated.textContent = 'Just now';
            updateCardValues(oldPrices);
            updatePortfolioValue();
        } catch (e) {
            // Silent fail — next refresh will try again
        }
    }

    // ========================================
    // OSRS News Feed
    // ========================================

    async function loadNewsFeed() {
        const feedEl = document.getElementById('newsFeed');
        if (!feedEl) return;

        try {
            // Use allorigins.win as CORS proxy to fetch the RSS XML
            const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent('https://secure.runescape.com/m=news/latest_news.rss?oldschool=true');
            const resp = await fetch(proxyUrl);
            if (!resp.ok) throw new Error('Fetch failed');
            const xmlText = await resp.text();

            // Parse the RSS XML
            const parser = new DOMParser();
            const xml = parser.parseFromString(xmlText, 'text/xml');
            const items = xml.querySelectorAll('item');

            if (!items || items.length === 0) throw new Error('No news items');

            let html = '';
            items.forEach((item, i) => {
                if (i >= 20) return;
                const title = item.querySelector('title')?.textContent || 'Untitled';
                const link = item.querySelector('link')?.textContent || '#';
                const pubDate = item.querySelector('pubDate')?.textContent || '';
                const desc = (item.querySelector('description')?.textContent || '').replace(/<[^>]*>/g, '').trim();
                const shortDesc = desc.substring(0, 120);

                let dateStr = '';
                if (pubDate) {
                    try {
                        const d = new Date(pubDate);
                        dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    } catch (e) {}
                }

                // Try to extract image from description
                const rawDesc = item.querySelector('description')?.textContent || '';
                const imgMatch = rawDesc.match(/<img[^>]+src=["']([^"']+)["']/);
                const thumbnail = imgMatch ? imgMatch[1] : '';

                html += `<a href="${link}" target="_blank" rel="noopener" class="news-card">
                    ${thumbnail ? `<div class="news-thumb" style="background-image:url('${thumbnail}')"></div>` : ''}
                    <div class="news-card-body">
                        ${dateStr ? `<span class="news-date">${dateStr}</span>` : ''}
                        <h4 class="news-title">${title}</h4>
                        ${shortDesc ? `<p class="news-desc">${shortDesc}${desc.length > 120 ? '...' : ''}</p>` : ''}
                    </div>
                </a>`;
            });

            feedEl.innerHTML = html;
        } catch (err) {
            feedEl.innerHTML = `
                <div class="news-error">
                    <p>Could not load news feed.</p>
                    <a href="https://oldschool.runescape.com" target="_blank" rel="noopener" class="news-error-link">Visit oldschool.runescape.com \u2192</a>
                </div>`;
        }
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();