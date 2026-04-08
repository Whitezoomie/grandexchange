package com.therealge.gepricer;

/** Immutable record of a completed Grand Exchange sell, optionally matched to a recorded buy. */
public class GEFlipRecord {
    public final int    itemId;
    public final String itemName;
    public final int    quantity;

    /**
     * Total gold spent on the matching buy offer.
     * -1 means no buy was recorded for this item this session (profit cannot be determined).
     */
    public final long buySpent;

    /**
     * Total gold received from the sell offer as reported by the game client
     * (already net of GE tax – the game deducts tax before crediting the seller).
     */
    public final long sellReceived;

    public final long tax; // GE tax deducted from the sell (2 % of gross, capped at 5 M).

    public final long buyTimestampMs; // System.currentTimeMillis() from the matching PendingBuy. -1 if no buy matched.

    public final long timestampMs; // System.currentTimeMillis() when this record was created (sell completed).

    public GEFlipRecord(int itemId, String itemName, int quantity,
                        long buySpent, long sellReceived, long tax, long buyTimestampMs, long timestampMs) {
        this.itemId          = itemId;
        this.itemName        = itemName;
        this.quantity        = quantity;
        this.buySpent        = buySpent;
        this.sellReceived    = sellReceived;
        this.tax             = tax;
        this.buyTimestampMs  = buyTimestampMs;
        this.timestampMs     = timestampMs;
    }

    /** Elapsed ms from buy placement to sell completion. -1 if no matching buy was recorded. */
    public long getSellDurationMs() {
        return buyTimestampMs >= 0 ? timestampMs - buyTimestampMs : -1L;
    }

    /**
     * Net profit for this flip (sellReceived - buySpent).
     * Only meaningful when {@link #isMatched()} returns true.
     */
    public long getProfit() {
        return buySpent >= 0L ? sellReceived - buySpent : 0L;
    }

    /** True if a matching buy offer was recorded this session. */
    public boolean isMatched() {
        return buySpent >= 0L;
    }
}
