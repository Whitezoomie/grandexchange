// ============================================
// OSRS GE Tracker — Visitor Counter + Feedback Server
// Deploy on Render.com with Supabase PostgreSQL (direct connection)
// ============================================

const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { Pool } = require('pg');
const predictor = require('./predictor');

const PORT = process.env.PORT || 10000;

// --- PostgreSQL connection (Supabase direct) ---
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
    console.error('Unexpected pool error:', err.message);
});

// --- DB helper: run a query with error handling ---
async function dbQuery(text, params) {
    try {
        const result = await pool.query(text, params);
        return result;
    } catch (e) {
        console.error('DB ERROR:', e.message, '| Query:', text.slice(0, 80));
        return null;
    }
}

// --- Admin credentials (hashed server-side — never sent to client) ---
const ADMIN_USER = 'Whitezoomie';
const ADMIN_PASS_HASH = crypto.createHash('sha256').update('Da2008Da!!@@##').digest('hex');

// --- Initialize data with PostgreSQL ---
let totalVisitors = 0;
let feedbackList = [];
let votesData = {};
const ipVotes = {};
let highlightsData = { pending: [], approved: [] };
// Server-side feedback cooldowns per IP (ms timestamp)
const feedbackCooldowns = new Map();
const FEEDBACK_COOLDOWN_MS = 60 * 1000; // 1 minute

// Load data from PostgreSQL on startup
async function initializeData() {
    try {
        // Test connection first
        const testRes = await dbQuery('SELECT NOW()');
        if (!testRes) {
            console.error('Cannot connect to PostgreSQL — running with in-memory data only');
            return;
        }
        console.log('PostgreSQL connected successfully');

        // Ensure the highlight_of_day table exists to avoid runtime errors
        await dbQuery(`CREATE TABLE IF NOT EXISTS highlight_of_day (
            id TEXT PRIMARY KEY,
            set_date TIMESTAMP WITH TIME ZONE DEFAULT now()
        )`);

        // Ensure player count history table exists
        await dbQuery(`CREATE TABLE IF NOT EXISTS player_count_history (
            id SERIAL PRIMARY KEY,
            count INTEGER NOT NULL,
            recorded_at TIMESTAMP WITH TIME ZONE DEFAULT now()
        )`);
        // Load last 1440 data points into memory (24h at 1-min resolution)
        const pcHist = await dbQuery(
            'SELECT count, recorded_at FROM player_count_history ORDER BY recorded_at DESC LIMIT 1440'
        );
        if (pcHist && pcHist.rows.length > 0) {
            _pc.history = pcHist.rows.reverse().map(r => ({
                count: r.count,
                ts: new Date(r.recorded_at).getTime()
            }));
            const latest = _pc.history[_pc.history.length - 1];
            _pc.count = latest.count;
            _pc.fetchedAt = latest.ts;
            _pc.lastHistoryTs = latest.ts;
            console.log(`[player-count] loaded ${_pc.history.length} history rows from DB, latest: ${_pc.count}`);
        }

        // Load per-day-of-week history: most recent occurrence of each weekday (UTC), last 8 days
        const pcDailyRes = await dbQuery(`
            WITH latest_dates AS (
                SELECT
                    EXTRACT(DOW FROM recorded_at AT TIME ZONE 'UTC')::int AS dow,
                    MAX(TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')) AS latest_date
                FROM player_count_history
                WHERE recorded_at >= NOW() - INTERVAL '8 days'
                GROUP BY dow
            )
            SELECT
                EXTRACT(DOW FROM h.recorded_at AT TIME ZONE 'UTC')::int AS dow,
                TO_CHAR(h.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date_str,
                h.count,
                EXTRACT(EPOCH FROM h.recorded_at)::bigint * 1000 AS ts_ms
            FROM player_count_history h
            JOIN latest_dates l
                ON EXTRACT(DOW FROM h.recorded_at AT TIME ZONE 'UTC')::int = l.dow
               AND TO_CHAR(h.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = l.latest_date
            ORDER BY h.recorded_at ASC
        `);
        if (pcDailyRes && pcDailyRes.rows.length > 0) {
            pcDailyRes.rows.forEach(r => {
                const dow = r.dow;
                if (!_pcDaily[dow]) _pcDaily[dow] = { date: r.date_str, points: [] };
                _pcDaily[dow].points.push({ count: r.count, ts: Number(r.ts_ms) });
            });
            console.log(`[player-daily] loaded daily history for days: ${Object.keys(_pcDaily).join(',')}`);
        }

        // Ensure tax history table exists
        await dbQuery(`CREATE TABLE IF NOT EXISTS tax_history (
            id SERIAL PRIMARY KEY,
            total_tax BIGINT NOT NULL,
            recorded_at TIMESTAMP WITH TIME ZONE DEFAULT now()
        )`);

        // Ensure trade volume history table exists
        await dbQuery(`CREATE TABLE IF NOT EXISTS volume_history (
            id SERIAL PRIMARY KEY,
            total_volume BIGINT NOT NULL,
            recorded_at TIMESTAMP WITH TIME ZONE DEFAULT now()
        )`);

        // Load total visitors
        const vRes = await dbQuery('SELECT total FROM visitors LIMIT 1');
        if (vRes && vRes.rows.length > 0) totalVisitors = vRes.rows[0].total || 0;

        // Load feedback
        const fRes = await dbQuery('SELECT * FROM feedback ORDER BY created_at DESC LIMIT 500');
        if (fRes) {
            feedbackList = fRes.rows.map(f => ({
                id: f.id, type: f.type, name: f.name,
                message: f.message, date: f.created_at,
            }));
        }

        // Load votes
        const voRes = await dbQuery('SELECT * FROM votes');
        if (voRes) {
            votesData = {};
            voRes.rows.forEach(v => {
                votesData[v.item_id] = { up: v.up_votes, down: v.down_votes };
            });
        }

        // Load highlights
        const hpRes = await dbQuery('SELECT * FROM highlights_pending ORDER BY created_at DESC');
        if (hpRes) {
            highlightsData.pending = hpRes.rows.map(h => ({
                id: h.id, playerName: h.player_name, caption: h.caption,
                image: h.image, date: h.created_at,
            }));
        }

        const haRes = await dbQuery('SELECT * FROM highlights_approved ORDER BY approved_date DESC');
        // Load the current Highlight of the Day (if any)
        const hodRes = await dbQuery('SELECT id FROM highlight_of_day LIMIT 1');
        const hodId = (hodRes && hodRes.rows && hodRes.rows.length) ? hodRes.rows[0].id : null;
        if (haRes) {
            highlightsData.approved = haRes.rows.map(h => ({
                id: h.id, playerName: h.player_name, caption: h.caption,
                image: h.image, date: h.created_at, approvedDate: h.approved_date,
                highlightOfDay: (h.id === hodId) || false,
            }));
        }

        console.log(`Data loaded: ${totalVisitors} visitors, ${feedbackList.length} feedback, ${Object.keys(votesData).length} votes, ${highlightsData.pending.length} pending / ${highlightsData.approved.length} approved highlights`);
    } catch (e) {
        console.error('Error initializing data:', e.message);
    }
}

// --- Database saving functions ---
async function saveTotal() {
    const exists = await dbQuery('SELECT id FROM visitors LIMIT 1');
    if (exists && exists.rows.length > 0) {
        await dbQuery('UPDATE visitors SET total = $1, updated_at = NOW() WHERE id = $2', [totalVisitors, exists.rows[0].id]);
    } else {
        await dbQuery('INSERT INTO visitors (total) VALUES ($1)', [totalVisitors]);
    }
}

// --- Simple session tokens for admin ---
const adminTokens = new Set();

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

// --- OSRS player count cache + history ---
const _pc = { count: null, fetchedAt: 0, history: [], lastHistoryTs: 0 };
// Per-day-of-week history (UTC): { 0: { date: 'YYYY-MM-DD', points: [{count,ts}] }, ... }
const _pcDaily = {};
const https = require('https');

// --- GE 24h tax estimate cache + history ---
const _tax = { value: null, fetchedAt: 0, history: [] };
// --- GE 24h trade volume cache + history ---
const _vol = { value: null, fetchedAt: 0, history: [] };
const WIKI_API = 'https://prices.runescape.wiki/api/v1/osrs';
const WIKI_UA  = { headers: { 'User-Agent': 'OSRS-GE-Tracker/1.0 +https://osrs-ge-tracker.com' } };

function httpsGet(url, opts, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req2 = https.get(url, opts || {}, (r) => {
            // Follow one redirect
            if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
                r.resume();
                return httpsGet(r.headers.location, opts, timeoutMs).then(resolve).catch(reject);
            }
            let body = '';
            r.on('data', d => { body += d; });
            r.on('end', () => resolve(body));
            r.on('error', reject);
        });
        req2.on('error', reject);
        req2.setTimeout(timeoutMs || 8000, () => { req2.destroy(); reject(new Error('timeout')); });
    });
}

async function tryPlayerCountJs() {
    try {
        const body = await httpsGet(
            'https://oldschool.runescape.com/player_count.js?varname=_c',
            { headers: { 'User-Agent': 'Mozilla/5.0 OSRS-GE-Tracker/1.0' } }
        );
        const m = body.match(/=\s*(\d+)/);
        if (m) return parseInt(m[1], 10);
        console.warn('[player-count] player_count.js unexpected:', body.slice(0, 80));
    } catch (e) {
        console.warn('[player-count] player_count.js failed:', e.message);
    }
    return null;
}

async function tryScrapePage() {
    try {
        const body = await httpsGet(
            'https://oldschool.runescape.com/',
            { headers: { 'User-Agent': 'Mozilla/5.0 OSRS-GE-Tracker/1.0', 'Accept': 'text/html' } }
        );
        // "There are currently 81,053 people playing!"
        const m = body.match(/there are currently ([\d,]+) people playing/i);
        if (m) return parseInt(m[1].replace(/,/g, ''), 10);
        console.warn('[player-count] homepage parse failed, snippet:', body.slice(0, 120));
    } catch (e) {
        console.warn('[player-count] homepage scrape failed:', e.message);
    }
    return null;
}

async function refreshPlayerCount() {
    let count = await tryPlayerCountJs();
    if (count === null) count = await tryScrapePage();
    if (count !== null && count > 0) {
        const now = Date.now();
        _pc.count = count;
        _pc.fetchedAt = now;
        // Only add a history point once per minute (1-min resolution = 720 pts = 12h)
        if (now - _pc.lastHistoryTs >= 60000) {
            _pc.lastHistoryTs = now;
            _pc.history.push({ count, ts: now });
            if (_pc.history.length > 1440) _pc.history.shift();
            console.log('[player-count] updated:', count);
            // Persist to DB (fire and forget)
            dbQuery(
                'INSERT INTO player_count_history (count, recorded_at) VALUES ($1, NOW())',
                [count]
            ).catch(e => console.warn('[player-count] db save:', e.message));
            // Prune rows older than 90 days
            dbQuery(
                "DELETE FROM player_count_history WHERE recorded_at < NOW() - INTERVAL '90 days'"
            ).catch(() => {});

            // Update per-day-of-week in-memory cache (UTC day)
            const d = new Date(now);
            const dow = d.getUTCDay();
            const dateStr = d.toISOString().slice(0, 10);
            if (!_pcDaily[dow] || _pcDaily[dow].date !== dateStr) {
                _pcDaily[dow] = { date: dateStr, points: [] };
            }
            _pcDaily[dow].points.push({ count, ts: now });
            if (_pcDaily[dow].points.length > 1440) _pcDaily[dow].points.shift();
        }
    }
}

// Kick off immediately and then every 5 s
refreshPlayerCount();
setInterval(refreshPlayerCount, 5000);

// --- GE tax estimate refresh (runs every 60 s — OSRS Wiki prices update ~1 min) ---
async function refreshTaxData() {
    try {
        const [latestRaw, volumesRaw] = await Promise.all([
            httpsGet(WIKI_API + '/latest',  WIKI_UA, 14000),
            httpsGet(WIKI_API + '/volumes', WIKI_UA, 14000),
        ]);
        const priceData  = (JSON.parse(latestRaw).data  || {});
        const volData    = (JSON.parse(volumesRaw).data  || {});
        let totalTax = 0;
        let totalVol = 0;
        for (const id of Object.keys(priceData)) {
            const p   = priceData[id];
            const vol = volData[id] || 0;
            if (!p || !p.high || vol <= 0) continue;
            totalTax += Math.min(Math.floor(p.high * 0.02), 5000000) * vol;
            totalVol += p.high * vol;
        }
        const now = Date.now();
        if (totalTax > 0) {
            const taxChanged = totalTax !== _tax.value;
            _tax.value     = totalTax;
            _tax.fetchedAt = now;
            if (taxChanged) {
                _tax.history.push({ value: totalTax, ts: now });
                if (_tax.history.length > 120) _tax.history.shift();
                console.log('[tax] updated:', totalTax.toLocaleString());
                dbQuery(
                    'INSERT INTO tax_history (total_tax, recorded_at) VALUES ($1, NOW())',
                    [totalTax]
                ).catch(e => console.warn('[tax] db save:', e.message));
                // Prune rows older than 90 days
                dbQuery(
                    "DELETE FROM tax_history WHERE recorded_at < NOW() - INTERVAL '90 days'"
                ).catch(() => {});
            }
        }
        if (totalVol > 0) {
            const volChanged = totalVol !== _vol.value;
            _vol.value     = totalVol;
            _vol.fetchedAt = now;
            if (volChanged) {
                _vol.history.push({ value: totalVol, ts: now });
                if (_vol.history.length > 120) _vol.history.shift();
                console.log('[volume] updated:', totalVol.toLocaleString());
                dbQuery(
                    'INSERT INTO volume_history (total_volume, recorded_at) VALUES ($1, NOW())',
                    [totalVol]
                ).catch(e => console.warn('[volume] db save:', e.message));
                // Prune rows older than 90 days
                dbQuery(
                    "DELETE FROM volume_history WHERE recorded_at < NOW() - INTERVAL '90 days'"
                ).catch(() => {});
            }
        }
    } catch (e) {
        console.warn('[tax/volume] refresh failed:', e.message);
    }
}

// Kick off immediately and then every 30 s
refreshTaxData();
setInterval(refreshTaxData, 30000);

// --- Parse JSON body helper ---
function parseBody(req, maxBytes) {
    maxBytes = maxBytes || 1e6;
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > maxBytes) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        req.on('error', reject);
    });
}

// --- HTTP server ---
const server = http.createServer(async (req, res) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, headers);
        return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    // --- Stats endpoint ---
    if (path === '/' && req.method === 'GET') {
        res.writeHead(200, headers);
        return res.end(JSON.stringify({ online: clients.size, total: totalVisitors }));
    }

    // --- OSRS player count (served from server-side cache, history from Supabase) ---
    if (path === '/player-count' && req.method === 'GET') {
        if (_pc.count !== null) {
            res.writeHead(200, headers);
            return res.end(JSON.stringify({
                count: _pc.count,
                age: Math.round((Date.now() - _pc.fetchedAt) / 1000),
                history: _pc.history.slice(-1440)
            }));
        }
        // Cache not ready yet — trigger a fetch now and wait for it
        try {
            await refreshPlayerCount();
        } catch (e) { /* ignore */ }
        if (_pc.count !== null) {
            res.writeHead(200, headers);
            return res.end(JSON.stringify({ count: _pc.count, age: 0, history: _pc.history.slice(-720) }));
        }
        res.writeHead(503, headers);
        return res.end(JSON.stringify({ error: 'player count not available yet, try again shortly' }));
    }

    // --- Per-day-of-week player history (shared, server-authoritative) ---
    if (path === '/player-daily-history' && req.method === 'GET') {
        res.writeHead(200, headers);
        return res.end(JSON.stringify(_pcDaily));
    }

    // --- GE 24h tax estimate (served from server-side cache, history from Supabase) ---
    if (path === '/tax-history' && req.method === 'GET') {
        if (_tax.value !== null) {
            res.writeHead(200, headers);
            return res.end(JSON.stringify({
                value: _tax.value,
                age: Math.round((Date.now() - _tax.fetchedAt) / 1000),
                history: _tax.history.slice(-60)
            }));
        }
        try { await refreshTaxData(); } catch(e) { /* ignore */ }
        if (_tax.value !== null) {
            res.writeHead(200, headers);
            return res.end(JSON.stringify({ value: _tax.value, age: 0, history: _tax.history.slice(-60) }));
        }
        res.writeHead(503, headers);
        return res.end(JSON.stringify({ error: 'tax data not available yet, try again shortly' }));
    }

    // --- GE 24h trade volume (served from server-side cache, history from Supabase) ---
    if (path === '/volume-history' && req.method === 'GET') {
        if (_vol.value !== null) {
            res.writeHead(200, headers);
            return res.end(JSON.stringify({
                value: _vol.value,
                age: Math.round((Date.now() - _vol.fetchedAt) / 1000),
                history: _vol.history.slice(-60)
            }));
        }
        try { await refreshTaxData(); } catch(e) { /* ignore */ }
        if (_vol.value !== null) {
            res.writeHead(200, headers);
            return res.end(JSON.stringify({ value: _vol.value, age: 0, history: _vol.history.slice(-60) }));
        }
        res.writeHead(503, headers);
        return res.end(JSON.stringify({ error: 'volume data not available yet, try again shortly' }));
    }

    // --- Get votes for an item ---
    if (path.startsWith('/votes/') && req.method === 'GET') {
        const itemId = path.split('/').pop();
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const entry = votesData[itemId] || { up: 0, down: 0 };
        const userVote = ipVotes[itemId + '_' + ip] || null;
        res.writeHead(200, headers);
        return res.end(JSON.stringify({ up: entry.up, down: entry.down, userVote }));
    }

    // --- Submit a vote ---
    if (path === '/votes' && req.method === 'POST') {
        try {
            const data = await parseBody(req);
            const itemId = String(data.itemId || '').slice(0, 20);
            const vote = data.vote === 'up' ? 'up' : data.vote === 'down' ? 'down' : null;
            if (!itemId || !vote) {
                res.writeHead(400, headers);
                return res.end(JSON.stringify({ error: 'Invalid request' }));
            }
            const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
            const key = itemId + '_' + ip;
            const prev = ipVotes[key] || null;

            if (!votesData[itemId]) votesData[itemId] = { up: 0, down: 0 };
            const entry = votesData[itemId];

            if (prev === vote) {
                // Toggle off (undo vote)
                entry[vote] = Math.max(0, entry[vote] - 1);
                delete ipVotes[key];
            } else {
                // Remove old vote if switching
                if (prev) entry[prev] = Math.max(0, entry[prev] - 1);
                entry[vote]++;
                ipVotes[key] = vote;
            }

            // Update database
            dbQuery(
                `INSERT INTO votes (item_id, up_votes, down_votes) VALUES ($1, $2, $3)
                 ON CONFLICT (item_id) DO UPDATE SET up_votes = $2, down_votes = $3, updated_at = NOW()`,
                [itemId, entry.up, entry.down]
            ).catch(e => console.error('Error saving vote:', e.message));

            res.writeHead(200, headers);
            return res.end(JSON.stringify({ up: entry.up, down: entry.down, userVote: ipVotes[key] || null }));
        } catch (e) {
            res.writeHead(400, headers);
            return res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    }

    // --- Submit feedback (public, no auth) ---
    if (path === '/feedback' && req.method === 'POST') {
        try {
            const data = await parseBody(req);
            const type = (data.type === 'bug') ? 'bug' : 'suggestion';
            const message = String(data.message || '').trim().slice(0, 2000);
            const name = String(data.name || 'Anonymous').trim().slice(0, 50);
            if (!message) {
                res.writeHead(400, headers);
                return res.end(JSON.stringify({ error: 'Message is required' }));
            }
            // Server-side rate-limit per IP
            const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
            const last = feedbackCooldowns.get(ip) || 0;
            const now = Date.now();
            if (now - last < FEEDBACK_COOLDOWN_MS) {
                const retryAfter = Math.ceil((FEEDBACK_COOLDOWN_MS - (now - last)) / 1000);
                res.writeHead(429, headers);
                return res.end(JSON.stringify({ error: 'Cooldown', retry_after: retryAfter }));
            }

            // record timestamp immediately to reduce race conditions
            feedbackCooldowns.set(ip, now);
            const entry = {
                id: crypto.randomBytes(8).toString('hex'),
                type,
                name,
                message,
                date: new Date().toISOString(),
            };
            feedbackList.unshift(entry);
            if (feedbackList.length > 500) feedbackList = feedbackList.slice(0, 500);
            
            // Save to database
            const result = await dbQuery(
                'INSERT INTO feedback (id, type, name, message, created_at) VALUES ($1, $2, $3, $4, $5)',
                [entry.id, entry.type, entry.name, entry.message, entry.date]
            );
            if (!result) console.error('FAILED to save feedback to DB');

            res.writeHead(201, headers);
            return res.end(JSON.stringify({ success: true }));
        } catch (e) {
            res.writeHead(400, headers);
            return res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    }

    // --- Admin login ---
    if (path === '/admin/login' && req.method === 'POST') {
        try {
            const data = await parseBody(req);
            const user = String(data.username || '');
            const passHash = crypto.createHash('sha256').update(String(data.password || '')).digest('hex');
            if (user === ADMIN_USER && passHash === ADMIN_PASS_HASH) {
                const token = generateToken();
                adminTokens.add(token);
                // Expire token after 2 hours
                setTimeout(() => adminTokens.delete(token), 2 * 60 * 60 * 1000);
                res.writeHead(200, headers);
                return res.end(JSON.stringify({ success: true, token }));
            } else {
                res.writeHead(401, headers);
                return res.end(JSON.stringify({ error: 'Invalid credentials' }));
            }
        } catch (e) {
            res.writeHead(400, headers);
            return res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    }

    // --- Admin: get all feedback ---
    if (path === '/admin/feedback' && req.method === 'GET') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (!adminTokens.has(token)) {
            res.writeHead(401, headers);
            return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        res.writeHead(200, headers);
        return res.end(JSON.stringify(feedbackList));
    }

    // --- Admin: delete feedback ---
    if (path.startsWith('/admin/feedback/') && req.method === 'DELETE') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (!adminTokens.has(token)) {
            res.writeHead(401, headers);
            return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        const id = path.split('/').pop();
        const idx = feedbackList.findIndex(f => f.id === id);
        if (idx !== -1) {
            feedbackList.splice(idx, 1);
            // Delete from database
            await dbQuery('DELETE FROM feedback WHERE id = $1', [id]);
        }
        res.writeHead(200, headers);
        return res.end(JSON.stringify({ success: true }));
    }

    // --- Admin: reset all votes ---
    if (path === '/admin/votes/reset' && req.method === 'POST') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (!adminTokens.has(token)) {
            res.writeHead(401, headers);
            return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        votesData = {};
        Object.keys(ipVotes).forEach(k => delete ipVotes[k]);
        
        // Delete all votes from database
        await dbQuery('DELETE FROM votes');

        res.writeHead(200, headers);
        return res.end(JSON.stringify({ success: true }));
    }

    // --- Get approved highlights (public) ---
    if (path === '/highlights' && req.method === 'GET') {
        const approved = (highlightsData.approved || []).map(h => ({
            id: h.id, playerName: h.playerName, caption: h.caption,
            image: h.image, date: h.date, approvedDate: h.approvedDate,
            highlightOfDay: !!h.highlightOfDay
        }));
        res.writeHead(200, headers);
        return res.end(JSON.stringify(approved));
    }

    // --- Submit a highlight (public) ---
    if (path === '/highlights/submit' && req.method === 'POST') {
        try {
            const data = await parseBody(req, 12e6); // 12 MB — base64 images can be large
            const playerName = String(data.playerName || '').trim().slice(0, 30);
            const caption    = String(data.caption    || '').trim().slice(0, 120);
            const imageRaw   = String(data.image || '');
            // Allow up to ~11 MB of base64 data (covers ~8 MB binary images).
            // Reject larger payloads to avoid excessive DB/storage use.
            if (!imageRaw) {
                res.writeHead(400, headers);
                return res.end(JSON.stringify({ error: 'Player name and image are required' }));
            }
            if (imageRaw.length > 11e6) {
                res.writeHead(413, headers);
                return res.end(JSON.stringify({ error: 'Image too large' }));
            }
            const image = imageRaw;
            if (!playerName) {
                res.writeHead(400, headers);
                return res.end(JSON.stringify({ error: 'Player name and image are required' }));
            }
            const entry = {
                id: crypto.randomBytes(8).toString('hex'),
                playerName, caption, image,
                date: new Date().toISOString(),
            };
            highlightsData.pending.unshift(entry);
            if (highlightsData.pending.length > 100) highlightsData.pending = highlightsData.pending.slice(0, 100);
            
            // Save to database
            const result = await dbQuery(
                'INSERT INTO highlights_pending (id, player_name, caption, image, created_at) VALUES ($1, $2, $3, $4, $5)',
                [entry.id, entry.playerName, entry.caption, entry.image, entry.date]
            );
            if (result) {
                console.log('Highlight saved to DB:', entry.id, entry.playerName);
            } else {
                console.error('FAILED to save highlight to DB');
            }

            res.writeHead(201, headers);
            return res.end(JSON.stringify({ success: true }));
        } catch (e) {
            res.writeHead(400, headers);
            return res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    }

    // --- Admin: get pending highlights ---
    if (path === '/admin/highlights/pending' && req.method === 'GET') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (!adminTokens.has(token)) { res.writeHead(401, headers); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
        res.writeHead(200, headers);
        return res.end(JSON.stringify(highlightsData.pending || []));
    }

    // --- Admin: approve a highlight ---
    if (path.match(/^\/admin\/highlights\/[a-f0-9]+\/approve$/) && req.method === 'POST') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (!adminTokens.has(token)) { res.writeHead(401, headers); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
        const id  = path.split('/')[3];
        const idx = (highlightsData.pending || []).findIndex(h => h.id === id);
        if (idx !== -1) {
            const [entry] = highlightsData.pending.splice(idx, 1);
            entry.approvedDate = new Date().toISOString();
            highlightsData.approved.unshift(entry);
            if (highlightsData.approved.length > 50) highlightsData.approved = highlightsData.approved.slice(0, 50);
            
            // Move from pending to approved in database
            await dbQuery('DELETE FROM highlights_pending WHERE id = $1', [id]);
            await dbQuery(
                'INSERT INTO highlights_approved (id, player_name, caption, image, created_at, approved_date) VALUES ($1, $2, $3, $4, $5, $6)',
                [entry.id, entry.playerName, entry.caption, entry.image, entry.date, entry.approvedDate]
            );
        }
        res.writeHead(200, headers);
        return res.end(JSON.stringify({ success: true }));
    }

    // --- Admin: deny / delete a highlight ---
    if (path.match(/^\/admin\/highlights\/[a-f0-9]+$/) && req.method === 'DELETE') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (!adminTokens.has(token)) { res.writeHead(401, headers); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
        const id = path.split('/').pop();
        const pi = (highlightsData.pending  || []).findIndex(h => h.id === id);
        if (pi !== -1) { 
            highlightsData.pending.splice(pi, 1);
            await dbQuery('DELETE FROM highlights_pending WHERE id = $1', [id]);
        }
        const ai = (highlightsData.approved || []).findIndex(h => h.id === id);
        if (ai !== -1) { 
            // If deleted highlight was highlightOfDay, clear the selection
            const wasHod = !!highlightsData.approved[ai].highlightOfDay;
            highlightsData.approved.splice(ai, 1);
            await dbQuery('DELETE FROM highlights_approved WHERE id = $1', [id]);
            if (wasHod) {
                await dbQuery('DELETE FROM highlight_of_day');
            }
        }
        res.writeHead(200, headers);
        return res.end(JSON.stringify({ success: true }));
    }

    // --- Admin: get/set Highlight of the Day ---
    if (path === '/admin/highlight-of-day' && req.method === 'GET') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (!adminTokens.has(token)) { res.writeHead(401, headers); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
        const hodRes2 = await dbQuery('SELECT id FROM highlight_of_day LIMIT 1');
        const hodId2 = (hodRes2 && hodRes2.rows && hodRes2.rows.length) ? hodRes2.rows[0].id : null;
        res.writeHead(200, headers);
        return res.end(JSON.stringify({ id: hodId2 }));
    }

    if (path === '/admin/highlight-of-day' && req.method === 'POST') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (!adminTokens.has(token)) { res.writeHead(401, headers); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
        try {
            const data = await parseBody(req);
            const id = data && data.id ? String(data.id) : null;

            // Clear existing selection first
            await dbQuery('DELETE FROM highlight_of_day');

            if (id) {
                // Ensure the id exists in approved list before setting
                const exists = (highlightsData.approved || []).some(h => h.id === id);
                if (!exists) {
                    res.writeHead(400, headers);
                    return res.end(JSON.stringify({ error: 'Invalid highlight id' }));
                }
                await dbQuery('INSERT INTO highlight_of_day (id, set_date) VALUES ($1, NOW())', [id]);
            }

            // Update in-memory flags
            (highlightsData.approved || []).forEach(h => { h.highlightOfDay = (id && h.id === id) || false; });

            res.writeHead(200, headers);
            return res.end(JSON.stringify({ success: true, id: id || null }));
        } catch (e) {
            res.writeHead(400, headers);
            return res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    }

    // --- Price Prediction endpoint ---
    if (path === '/predict' && req.method === 'GET') {
        return predictor.handleRequest(req, res, headers);
    }

    // Fallback
    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: 'Not found' }));
});

// --- WebSocket server ---
const wss = new WebSocketServer({ server });
const clients = new Set();

function broadcast() {
    const msg = JSON.stringify({ online: clients.size, total: totalVisitors });
    for (const ws of clients) {
        try { ws.send(msg); } catch (e) {}
    }
}

wss.on('connection', (ws) => {
    clients.add(ws);

    // Send current stats immediately (don't increment yet)
    broadcast();

    // Listen for a message from the client indicating a new visitor
    ws.once('message', async (raw) => {
        try {
            const msg = JSON.parse(raw);
            if (msg.type === 'new_visitor') {
                totalVisitors++;
                await saveTotal();
                broadcast();
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        clients.delete(ws);
        broadcast();
    });

    ws.on('error', () => {
        clients.delete(ws);
    });

    // Keep-alive ping every 30s (prevents Render from killing idle connections)
    const keepAlive = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
            ws.ping();
        } else {
            clearInterval(keepAlive);
        }
    }, 30000);

    ws.on('close', () => clearInterval(keepAlive));
});

server.listen(PORT, async () => {
    console.log(`Visitor counter server running on port ${PORT}`);
    await initializeData();
    predictor.init(pool);
});
