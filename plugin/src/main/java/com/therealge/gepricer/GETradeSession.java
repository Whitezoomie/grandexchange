package com.therealge.gepricer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.*;

/**
 * Tracks Grand Exchange buy/sell completions within a single plugin session.
 *
 * <p>When a BUY offer completes, the item + cost are queued.
 * When a SELL offer completes, we try to pop the oldest matching buy (FIFO per item)
 * and record the full flip P/L. Sells with no matching buy are still recorded but
 * marked as unmatched (profit unknown).
 *
 * <p>Thread-safe â€“ all public methods are synchronized.
 */
public class GETradeSession {
    // Internal pending-buy queue entry (also exposed to the UI)
    public static class PendingBuy {
        public final int    itemId;
        public final String itemName;
        public final int    quantity;
        public final long   spent;
        public final long   timestampMs;

        PendingBuy(int id, String name, int qty, long spent) {
            this(id, name, qty, spent, System.currentTimeMillis());
        }

        /** Deserialisation constructor â€” preserves the original timestamp. */
        PendingBuy(int id, String name, int qty, long spent, long timestampMs) {
            this.itemId      = id;
            this.itemName    = name;
            this.quantity    = qty;
            this.spent       = spent;
            this.timestampMs = timestampMs;
        }
    }

    // State

    /** Unmatched buy offers queued per item, oldest first. */
    private final Map<Integer, Deque<PendingBuy>> pendingBuys = new LinkedHashMap<>();

    private final List<GEFlipRecord> flips = new ArrayList<>(); // All completed sell events, most-recent first.

    private final long startMs = System.currentTimeMillis(); // When this session was created.

    // Mutation

    /**
     * Record a fully completed buy offer (state == BOUGHT).
     *
     * @param itemId   OSRS item ID
     * @param name     item name (for display)
     * @param quantity total quantity bought
     * @param spent    total gold spent (from GrandExchangeOffer.getSpent())
     */
    public synchronized void onBought(int itemId, String name, int quantity, long spent) {
        pendingBuys
            .computeIfAbsent(itemId, k -> new ArrayDeque<>())
            .addLast(new PendingBuy(itemId, name, quantity, spent));
    }

    /**
     * Record a fully completed sell offer (state == SOLD).
     * Attempts a FIFO match against the oldest pending buy for this item.
     *
     * @param itemId   OSRS item ID
     * @param name     item name (used only when no matching buy exists)
     * @param quantity total quantity sold
     * @param received total gold received (from GrandExchangeOffer.getSpent(), post-tax)
     */
    public synchronized void onSold(int itemId, String name, int quantity, long received, long tax) {
        Deque<PendingBuy> queue = pendingBuys.get(itemId);
        long   buySpent         = -1L;
        String resolvedName     = name;

        long buyTs = -1L;
        if (queue != null && !queue.isEmpty()) {
            PendingBuy buy = queue.pollFirst();
            buySpent       = buy.spent;
            resolvedName   = buy.itemName;
            buyTs          = buy.timestampMs;
        }

        flips.add(0, new GEFlipRecord(itemId, resolvedName, quantity,
                                      buySpent, received, tax, buyTs, System.currentTimeMillis()));
    }

    // Accessors

    /** Returns true if there is at least one pending (unmatched) buy recorded for the given item. */
    public synchronized boolean hasPendingBuy(int itemId) {
        Deque<PendingBuy> queue = pendingBuys.get(itemId);
        return queue != null && !queue.isEmpty();
    }

    /**
     * Returns the oldest pending buy cost for an item without removing it,
     * or -1 if no pending buy exists. Used to preview P/L before the sell is recorded.
     */
    public synchronized long peekBuySpent(int itemId) {
        Deque<PendingBuy> queue = pendingBuys.get(itemId);
        if (queue == null || queue.isEmpty()) return -1L;
        return queue.peekFirst().spent;
    }

    /** Snapshot of all flip records, most-recent first. */
    public synchronized List<GEFlipRecord> getFlips() {
        return Collections.unmodifiableList(new ArrayList<>(flips));
    }

    /** Sum of net profit over all matched flips. Negative means net loss. */
    public synchronized long getTotalProfit() {
        return flips.stream()
                    .filter(GEFlipRecord::isMatched)
                    .mapToLong(GEFlipRecord::getProfit)
                    .sum();
    }

    /** Number of sell events matched to a buy (full P/L known). */
    public synchronized int getMatchedFlipCount() {
        return (int) flips.stream().filter(GEFlipRecord::isMatched).count();
    }

    /** Total sell events recorded (matched + unmatched). */
    public synchronized int getTotalFlipCount() {
        return flips.size();
    }

    /** Session start epoch ms. */
    public long getStartMs() {
        return startMs;
    }

    /** Discard all history and pending buys (user-requested reset). */
    public synchronized void reset() {
        pendingBuys.clear();
        flips.clear();
    }

    // Persistence helpers

    /**
     * Serialises the current state (flips + pending buys) to a JSON string
     * suitable for storage in {@link net.runelite.client.config.ConfigManager}.
     */
    public synchronized String toJsonString() {
        JsonObject root = new JsonObject();

        JsonArray flipsArr = new JsonArray();
        for (GEFlipRecord r : flips) {
            JsonObject o = new JsonObject();
            o.addProperty("itemId",       r.itemId);
            o.addProperty("itemName",     r.itemName);
            o.addProperty("quantity",     r.quantity);
            o.addProperty("buySpent",     r.buySpent);
            o.addProperty("sellReceived", r.sellReceived);
            o.addProperty("tax",             r.tax);
            o.addProperty("buyTimestampMs", r.buyTimestampMs);
            o.addProperty("timestampMs",    r.timestampMs);
            flipsArr.add(o);
        }
        root.add("flips", flipsArr);

        JsonArray pendingArr = new JsonArray();
        for (Deque<PendingBuy> queue : pendingBuys.values()) {
            for (PendingBuy b : queue) {
                JsonObject o = new JsonObject();
                o.addProperty("itemId",      b.itemId);
                o.addProperty("itemName",    b.itemName);
                o.addProperty("quantity",    b.quantity);
                o.addProperty("spent",       b.spent);
                o.addProperty("timestampMs", b.timestampMs);
                pendingArr.add(o);
            }
        }
        root.add("pendingBuys", pendingArr);

        return root.toString();
    }

    /**
     * Deserialises and merges saved state into this session.
     * Existing in-memory records are replaced.
     * Safe to call with null or blank input (no-op).
     */
    public synchronized void loadFromJsonString(String json) {
        if (json == null || json.isBlank()) return;
        try {
            JsonObject root = new JsonParser().parse(json).getAsJsonObject();

            flips.clear();
            if (root.has("flips")) {
                for (var el : root.getAsJsonArray("flips")) {
                    JsonObject o    = el.getAsJsonObject();
                    int    itemId   = o.get("itemId").getAsInt();
                    String name     = o.get("itemName").getAsString();
                    int    qty      = o.get("quantity").getAsInt();
                    long   bought   = o.get("buySpent").getAsLong();
                    long   received = o.get("sellReceived").getAsLong();
                    long   tax      = o.get("tax").getAsLong();
                    long   buyTs    = o.has("buyTimestampMs") ? o.get("buyTimestampMs").getAsLong() : -1L;
                    long   ts       = o.get("timestampMs").getAsLong();
                    flips.add(new GEFlipRecord(itemId, name, qty, bought, received, tax, buyTs, ts));
                }
            }

            pendingBuys.clear();
            if (root.has("pendingBuys")) {
                for (var el : root.getAsJsonArray("pendingBuys")) {
                    JsonObject o = el.getAsJsonObject();
                    int    itemId = o.get("itemId").getAsInt();
                    String name   = o.get("itemName").getAsString();
                    int    qty    = o.get("quantity").getAsInt();
                    long   spent  = o.get("spent").getAsLong();
                    long   ts     = o.get("timestampMs").getAsLong();
                    pendingBuys
                        .computeIfAbsent(itemId, k -> new ArrayDeque<>())
                        .addLast(new PendingBuy(itemId, name, qty, spent, ts));
                }
            }
        } catch (Exception ignored) {
            // Corrupt / incompatible data â€” start fresh
            pendingBuys.clear();
            flips.clear();
        }
    }

    /** Flat snapshot of all pending (unmatched) buys, newest first. Each entry is still waiting for its sell. */
    public synchronized List<PendingBuy> getPendingBuys() {
        List<PendingBuy> result = new ArrayList<>();
        for (Deque<PendingBuy> q : pendingBuys.values())
            result.addAll(q);
        // Sort newest first
        result.sort(Comparator.comparingLong((PendingBuy b) -> b.timestampMs).reversed());
        return Collections.unmodifiableList(result);
    }
}
