// ============================================
// OSRS GE Tracker — Visitor Counter + Feedback Server
// Deploy this on Render.com with Supabase (persistent database)
// ============================================

const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 10000;

// --- Supabase initialization ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_KEY environment variables are required');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- Admin credentials (hashed server-side — never sent to client) ---
const ADMIN_USER = 'Whitezoomie';
const ADMIN_PASS_HASH = crypto.createHash('sha256').update('Da2008Da!!@@##').digest('hex');

// --- Initialize data with Supabase ---
let totalVisitors = 0;
let feedbackList = [];
let votesData = {};
const ipVotes = {};
let highlightsData = { pending: [], approved: [] };

// Load data from Supabase on startup
async function initializeData() {
    try {
        // Load total visitors
        const { data: visitData } = await supabase.from('visitors').select('total').single();
        if (visitData) totalVisitors = visitData.total || 0;

        // Load feedback
        const { data: fData } = await supabase.from('feedback').select('*').order('created_at', { ascending: false });
        feedbackList = (fData || []).map(f => ({
            id: f.id,
            type: f.type,
            name: f.name,
            message: f.message,
            date: f.created_at,
        }));

        // Load votes
        const { data: vData } = await supabase.from('votes').select('*');
        votesData = {};
        (vData || []).forEach(v => {
            votesData[v.item_id] = { up: v.up_votes, down: v.down_votes };
        });

        // Load highlights
        const { data: hPending } = await supabase.from('highlights_pending').select('*').order('created_at', { ascending: false });
        const { data: hApproved } = await supabase.from('highlights_approved').select('*').order('approved_date', { ascending: false });
        
        highlightsData.pending = (hPending || []).map(h => ({
            id: h.id,
            playerName: h.player_name,
            caption: h.caption,
            image: h.image,
            date: h.created_at,
        }));

        highlightsData.approved = (hApproved || []).map(h => ({
            id: h.id,
            playerName: h.player_name,
            caption: h.caption,
            image: h.image,
            date: h.created_at,
            approvedDate: h.approved_date,
        }));

        console.log('Data loaded from Supabase');
    } catch (e) {
        console.error('Error initializing data:', e.message);
        // Continue with empty data — tables may not exist yet
    }
}

// --- Database saving functions (async) ---
async function saveTotal() {
    try {
        const { data } = await supabase.from('visitors').select('*').single();
        if (data) {
            await supabase.from('visitors').update({ total: totalVisitors }).eq('id', data.id);
        } else {
            await supabase.from('visitors').insert({ total: totalVisitors });
        }
    } catch (e) { console.error('Error saving total:', e.message); }
}

async function saveFeedback() {
    // Feedback is saved individually — this is a no-op
}

async function saveVotes() {
    // Votes are saved individually — this is a no-op
}

async function saveHighlights() {
    // Highlights are saved individually — this is a no-op
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
            try {
                const { data: existing } = await supabase.from('votes').select('*').eq('item_id', itemId).single();
                if (existing) {
                    await supabase.from('votes').update({ up_votes: entry.up, down_votes: entry.down }).eq('item_id', itemId);
                } else {
                    await supabase.from('votes').insert({ item_id: itemId, up_votes: entry.up, down_votes: entry.down });
                }
            } catch (e) { console.error('Error saving vote:', e.message); }

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
            
            // Save to Supabase
            try {
                await supabase.from('feedback').insert({
                    id: entry.id,
                    type: entry.type,
                    name: entry.name,
                    message: entry.message,
                    created_at: entry.date
                });
            } catch (e) { console.error('Error saving feedback:', e.message); }

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
            // Delete from Supabase
            try {
                await supabase.from('feedback').delete().eq('id', id);
            } catch (e) { console.error('Error deleting feedback:', e.message); }
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
        
        // Delete all votes from Supabase
        try {
            await supabase.from('votes').delete().gte('id', 0); // Delete all rows
        } catch (e) { console.error('Error resetting votes:', e.message); }

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
            const image      = String(data.image      || '').slice(0, 700000); // ~500KB max
            if (!playerName || !image) {
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
            
            // Save to Supabase
            try {
                await supabase.from('highlights_pending').insert({
                    id: entry.id,
                    player_name: entry.playerName,
                    caption: entry.caption,
                    image: entry.image,
                    created_at: entry.date
                });
            } catch (e) { console.error('Error saving highlight:', e.message); }

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
            
            // Move from pending to approved in Supabase
            try {
                await supabase.from('highlights_pending').delete().eq('id', id);
                await supabase.from('highlights_approved').insert({
                    id: entry.id,
                    player_name: entry.playerName,
                    caption: entry.caption,
                    image: entry.image,
                    created_at: entry.date,
                    approved_date: entry.approvedDate
                });
            } catch (e) { console.error('Error approving highlight:', e.message); }
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
            try { await supabase.from('highlights_pending').delete().eq('id', id); } catch (e) {}
        }
        const ai = (highlightsData.approved || []).findIndex(h => h.id === id);
        if (ai !== -1) { 
            highlightsData.approved.splice(ai, 1);
            try { await supabase.from('highlights_approved').delete().eq('id', id); } catch (e) {}
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
