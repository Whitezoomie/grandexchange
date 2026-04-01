// ============================================================
// OSRS GE Price Predictor
// Polls the OSRS Wiki /5m endpoint every 5 minutes, stores
// snapshots in Supabase, and serves a /predict endpoint that
// returns trend-scored flip suggestions.
//
// Wire up in server.js:
//   const predictor = require('./predictor');
//   predictor.init(pool);           // start polling
//   predictor.handleRequest(req, res, headers); // in the route handler
// ============================================================

'use strict';

const WIKI_5M_URL   = 'https://prices.runescape.wiki/api/v1/osrs/5m';
const USER_AGENT    = 'therealge.com prediction service - contact@therealge.com';

// How many 5-minute periods to look back for trend analysis (default 36 = 3 hours)
const DEFAULT_LOOKBACK = 36;
// Minimum samples before we include an item in predictions
const MIN_SAMPLES = 4;
// Max items returned by /predict
const DEFAULT_LIMIT = 100;
// Keep data for this many days before pruning (1 day is 8x more than the 3hr lookback needs)
const RETENTION_DAYS = 1;
// Polling interval in ms
const POLL_INTERVAL_MS = 5 * 60 * 1000;

let pool = null;
let pollTimer = null;
let lastPollAt = null;
let lastPollCount = 0;
let dbReady = false;

// ─────────────────────────────────────────────────────────────
// Initialise: ensure table exists, start background polling
// ─────────────────────────────────────────────────────────────
async function init(dbPool) {
    pool = dbPool;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS price_snapshots (
                id          BIGSERIAL PRIMARY KEY,
                item_id     INTEGER   NOT NULL,
                avg_high    BIGINT    NOT NULL,
                high_volume BIGINT    NOT NULL DEFAULT 0,
                avg_low     BIGINT    NOT NULL,
                low_volume  BIGINT    NOT NULL DEFAULT 0,
                ts          TIMESTAMP WITH TIME ZONE NOT NULL
            )
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS price_snapshots_item_ts
                ON price_snapshots (item_id, ts DESC)
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS price_snapshots_ts
                ON price_snapshots (ts DESC)
        `);
        dbReady = true;
        console.log('[predictor] table ready');
    } catch (e) {
        console.error('[predictor] failed to create table:', e.message);
        return;
    }

    // Run immediately, then on an interval
    poll();
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

// ─────────────────────────────────────────────────────────────
// Polling: fetch /5m, bulk-insert into Supabase
// ─────────────────────────────────────────────────────────────
async function poll() {
    if (!dbReady || !pool) return;
    try {
        const res = await fetch(WIKI_5M_URL, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
            console.warn('[predictor] /5m HTTP', res.status);
            return;
        }
        const json = await res.json();
        const snapshotTs = json.timestamp ? new Date(json.timestamp * 1000) : new Date();
        const data = json.data || {};

        // Build parallel arrays for bulk unnest insert
        const ids = [], highs = [], hvols = [], lows = [], lvols = [], tss = [];
        for (const [key, p] of Object.entries(data)) {
            const id = parseInt(key, 10);
            if (isNaN(id)) continue;
            if (!p.avgHighPrice || !p.avgLowPrice) continue;
            if (p.avgHighPrice <= p.avgLowPrice) continue; // no positive margin
            ids.push(id);
            highs.push(BigInt(p.avgHighPrice));
            hvols.push(BigInt(p.highPriceVolume || 0));
            lows.push(BigInt(p.avgLowPrice));
            lvols.push(BigInt(p.lowPriceVolume || 0));
            tss.push(snapshotTs);
        }

        if (ids.length === 0) {
            console.warn('[predictor] no usable data from /5m');
            return;
        }

        await pool.query(
            `INSERT INTO price_snapshots
                 (item_id, avg_high, high_volume, avg_low, low_volume, ts)
             SELECT * FROM unnest(
                 $1::int[],
                 $2::bigint[],
                 $3::bigint[],
                 $4::bigint[],
                 $5::bigint[],
                 $6::timestamptz[]
             )`,
            [ids, highs, hvols, lows, lvols, tss]
        );

        lastPollAt    = Date.now();
        lastPollCount = ids.length;
        console.log(`[predictor] stored ${ids.length} items @ ${snapshotTs.toISOString()}`);

        // Prune old data — keeps Supabase free tier under limits
        await pool.query(
            `DELETE FROM price_snapshots WHERE ts < now() - ($1 * interval '1 day')`,
            [RETENTION_DAYS]
        );
    } catch (e) {
        console.error('[predictor] poll error:', e.message);
    }
}

// ─────────────────────────────────────────────────────────────
// Prediction query: linear regression slope per item
//
// Returns rows ordered by score descending.  Score =
//   avg_margin * avg_throughput * (1 + clamped_trend_factor)
//
// margin_slope is from REGR_SLOPE(margin, -rn):
//   rn=1 (newest) → x=-1 (highest X)
//   rn=N (oldest) → x=-N (lowest X)
// So a positive slope means margin is going UP over time. ✓
// ─────────────────────────────────────────────────────────────
async function runPredictionQuery(lookback, limit) {
    const result = await pool.query(`
        WITH samples AS (
            SELECT
                item_id,
                GREATEST(0,
                    avg_high - avg_low
                    - LEAST(FLOOR(avg_high * 0.02)::bigint, 5000000)
                ) AS margin,
                LEAST(high_volume, low_volume) AS throughput,
                ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY ts DESC) AS rn
            FROM price_snapshots
            WHERE ts > now() - ($1 * interval '5 minutes')
        ),
        per_item AS (
            SELECT
                item_id,
                MAX(CASE WHEN rn = 1 THEN margin END)     AS latest_margin,
                AVG(margin)::bigint                       AS avg_margin,
                AVG(throughput)::bigint                   AS avg_throughput,
                COUNT(*)                                  AS sample_count,
                REGR_SLOPE(margin::float, (-rn)::float)  AS margin_slope
            FROM samples
            WHERE rn <= $1
            GROUP BY item_id
            HAVING COUNT(*) >= $2
        )
        SELECT
            item_id,
            latest_margin,
            avg_margin,
            avg_throughput,
            sample_count,
            COALESCE(margin_slope, 0)     AS margin_slope,
            CASE WHEN avg_margin > 0
                 THEN (COALESCE(margin_slope, 0) / avg_margin) * 100.0
                 ELSE 0
            END                           AS trend_pct,
            CASE WHEN avg_margin > 0 AND avg_throughput > 0
                 THEN GREATEST(0,
                          avg_margin::float
                          * avg_throughput::float
                          * (1.0 + LEAST(GREATEST(
                              CASE WHEN avg_margin > 0
                                   THEN COALESCE(margin_slope, 0) / avg_margin
                                   ELSE 0 END,
                              -0.5), 0.5)))
                 ELSE 0
            END                           AS raw_score
        FROM per_item
        WHERE latest_margin > 0
          AND avg_throughput > 0
        ORDER BY raw_score DESC
        LIMIT $3
    `, [lookback, MIN_SAMPLES, limit]);

    return result.rows.map(r => ({
        item_id:       r.item_id,
        latest_margin: Number(r.latest_margin),
        avg_margin:    Number(r.avg_margin),
        avg_throughput: Number(r.avg_throughput),
        sample_count:  Number(r.sample_count),
        trend_pct:     parseFloat(Number(r.trend_pct).toFixed(2)),
        raw_score:     Math.round(Number(r.raw_score)),
        signal:        trendSignal(Number(r.trend_pct)),
    }));
}

function trendSignal(trendPct) {
    if (trendPct >  5.0) return 'RISING';
    if (trendPct >  1.0) return 'STABLE_UP';
    if (trendPct < -5.0) return 'FALLING';
    if (trendPct < -1.0) return 'STABLE_DOWN';
    return 'STABLE';
}

// ─────────────────────────────────────────────────────────────
// HTTP request handler — call from server.js route
// ─────────────────────────────────────────────────────────────
async function handleRequest(req, res, headers) {
    if (!dbReady) {
        res.writeHead(503, headers);
        return res.end(JSON.stringify({ error: 'predictor not ready', items: [] }));
    }

    const url   = new URL(req.url, `http://${req.headers.host}`);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || DEFAULT_LIMIT, 10), 500);
    const lookback = Math.min(
        parseInt(url.searchParams.get('lookback') || DEFAULT_LOOKBACK, 10),
        288 // max 24 hours
    );

    try {
        const items = await runPredictionQuery(lookback, limit);
        // Count how many snapshots exist in the DB so the client knows if data is fresh
        const countRes = await pool.query(
            `SELECT COUNT(DISTINCT item_id) AS items,
                    COUNT(*) AS snapshots,
                    MAX(ts)  AS latest_ts
             FROM price_snapshots`
        );
        const meta = countRes.rows[0];

        res.writeHead(200, headers);
        return res.end(JSON.stringify({
            items,
            meta: {
                distinct_items: Number(meta.items),
                total_snapshots: Number(meta.snapshots),
                latest_snapshot: meta.latest_ts,
                lookback_periods: lookback,
                generated_at: new Date().toISOString(),
                last_poll_at: lastPollAt ? new Date(lastPollAt).toISOString() : null,
                last_poll_count: lastPollCount,
            }
        }));
    } catch (e) {
        console.error('[predictor] handleRequest error:', e.message);
        res.writeHead(500, headers);
        return res.end(JSON.stringify({ error: 'internal error', items: [] }));
    }
}

module.exports = { init, handleRequest };
