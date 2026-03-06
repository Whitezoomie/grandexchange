// ============================================
// OSRS GE Tracker — Visitor Counter + Feedback Server
// Deploy on Render.com with Supabase PostgreSQL (direct connection)
// ============================================

const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { Pool } = require('pg');

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
        if (haRes) {
            highlightsData.approved = haRes.rows.map(h => ({
                id: h.id, playerName: h.player_name, caption: h.caption,
                image: h.image, date: h.created_at, approvedDate: h.approved_date,
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
            image: h.image, date: h.date, approvedDate: h.approvedDate
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
            highlightsData.approved.splice(ai, 1);
            await dbQuery('DELETE FROM highlights_approved WHERE id = $1', [id]);
        }
        res.writeHead(200, headers);
        return res.end(JSON.stringify({ success: true }));
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
});
