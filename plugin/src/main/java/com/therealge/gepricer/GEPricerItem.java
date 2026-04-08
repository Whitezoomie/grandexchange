package com.therealge.gepricer;

import lombok.Data;
import lombok.NonNull;

/**
 * Represents a single Grand Exchange item with live wiki price data.
 *
 * API field mapping:
 *   "high"     â†’ instaBuy  (the price you receive selling instantly = the highest buy offer)
 *   "low"      â†’ instaSell (the price you pay buying instantly     = the lowest sell offer)
 *   "highTime" â†’ instaBuyTime  (unix seconds of last high-price trade)
 *   "lowTime"  â†’ instaSellTime (unix seconds of last low-price trade)
 */
@Data
public class GEPricerItem {

    private final int    id;
    @NonNull private final String name;
    @NonNull private final String iconName; // e.g. "Dragon_hunter_crossbow.png"
    private final int    buyLimit;

    private long instaBuy; // Wiki insta-buy  â€“ the price a buyer is willing to pay (what you get when selling insta).

    private long instaSell; // Wiki insta-sell â€“ the price a seller is asking   (what you pay when buying insta).

    private long instaBuyTime; // Unix epoch seconds of the last observed instaBuy trade.

    private long instaSellTime; // Unix epoch seconds of the last observed instaSell trade.

    private long volume; // Daily trade volume (from /volumes endpoint). 0 if unavailable.

    /**
     * 1-hour average high (insta-buy) price from the /1h endpoint.
     * This is the average price at which items were bought (sellers received) in the last hour.
     * 0 if unavailable.
     */
    private long avgHighPrice1h;

    private long highPriceVolume1h; // Number of items traded at the high price in the last 1-hour window.

    /**
     * 1-hour average low (insta-sell) price from the /1h endpoint.
     * This is the average price at which items were sold (buyers paid) in the last hour.
     * 0 if unavailable.
     */
    private long avgLowPrice1h;

    private long lowPriceVolume1h; // Number of items traded at the low price in the last 1-hour window.

    // --- Server-side prediction data (from Render /predict endpoint) ---------
    private double trendPct; // Trend % per 5-min period from the prediction server (positive = rising margin).
    private long   serverScore; // Server-computed ranking score (higher = better flip opportunity). 0 = no server data yet.
    private String serverSignal; // Trend signal: RISING / STABLE_UP / STABLE / STABLE_DOWN / FALLING

    /** True when this item pays zero GE tax (e.g. Old School bonds). */
    private boolean taxExempt = false;

    // Derived helpers

    /**
     * GE tax = 2 % of insta-buy price, capped at 5 M gp.
     * Returns 0 for tax-exempt items.
     */
    public long getTax() {
        if (taxExempt || instaBuy <= 0) return 0L;
        return Math.min((long) Math.floor(instaBuy * 0.02), 5_000_000L);
    }

    /** Gross margin before GE tax. */
    public long getMarginRaw() {
        if (instaBuy <= 0 || instaSell <= 0) return 0L;
        return instaBuy - instaSell;
    }

    /** Net margin after GE tax. */
    public long getMargin() {
        long raw = getMarginRaw();
        if (raw <= 0) return 0L;
        return raw - getTax();
    }

    /** Margin as a percentage of the insta-buy price (after tax). */
    public double getMarginPercent() {
        if (instaBuy <= 0) return 0.0;
        return (getMargin() * 100.0) / instaBuy;
    }

    /** True if at least one of the prices is known. */
    public boolean hasPrices() {
        return instaBuy > 0 || instaSell > 0;
    }

    /** Human-readable "X min ago" for the most recent price update. */
    public String getLastUpdatedText() {
        long newest = Math.max(instaBuyTime, instaSellTime);
        return formatTimeAgo(newest);
    }

    /**
     * Predicted net margin per item using 1-hour average prices.
     * These average prices are far more reliable than spot prices because they smooth out
     * manipulation and single-trade outliers. Falls back to spot margin if 1h data is missing.
     */
    public long getPredictedMargin1h() {
        if (avgHighPrice1h <= 0 || avgLowPrice1h <= 0) return getMargin();
        long tax = Math.min((long) Math.floor(avgHighPrice1h * 0.02), 5_000_000L);
        return Math.max(0, avgHighPrice1h - avgLowPrice1h - tax);
    }

    /**
     * Predicted GP per hour for this flip based on 1h average prices and actual 1h trade volumes.
     *
     * Formula:
     *   gpPerCycle = predictedMargin1h Ã— buyLimit
     *   cycleHours = max(4, buyLimit/buyVol1h + buyLimit/sellVol1h)
     *   predictedGPHour = gpPerCycle / cycleHours
     *
     * The 4-hour floor reflects the GE buy-limit reset period. When markets are very liquid
     * the fill time is fast but the buy limit still caps how often you can flip.
     * Falls back to daily volume Ã· 24 when 1h volume data is absent.
     * Returns 0 when there is insufficient data to make a prediction.
     */
    public long getPredictedGPHour() {
        long margin = getPredictedMargin1h();
        if (margin <= 0) return 0;

        // Use buy limit; fall back to 500 if unknown (conservative guess)
        int limit = buyLimit > 0 ? buyLimit : 500;

        // 1h trade volumes: items exchanged at high/low price in the last hour
        // Fall back to daily volume Ã· 24 if the 1h endpoint had no data for this item
        long buyVol  = lowPriceVolume1h  > 0 ? lowPriceVolume1h  : (volume > 0 ? volume / 24 : 0);
        long sellVol = highPriceVolume1h > 0 ? highPriceVolume1h : (volume > 0 ? volume / 24 : 0);
        if (buyVol <= 0 || sellVol <= 0) return 0;

        // Time in hours to fill one buy order and one sell order at the buy limit quantity
        double buyHours   = (double) limit / buyVol;
        double sellHours  = (double) limit / sellVol;
        // Floor at 4 hours (GE buy-limit resets every 4 hours)
        double cycleHours = Math.max(4.0, buyHours + sellHours);

        return (long) (margin * limit / cycleHours);
    }

    /**
     * Best available ranking score. Uses the server's trend-adjusted score when available,
     * otherwise falls back to the local GP/hr prediction from 1h Wiki data.
     */
    public long getEffectiveScore() {
        return serverScore > 0 ? serverScore : getPredictedGPHour();
    }

    // Static utilities

    public static String formatTimeAgo(long unixSeconds) {
        if (unixSeconds <= 0) return "N/A";
        long diff = (System.currentTimeMillis() / 1000L) - unixSeconds;
        if (diff < 0)   return "just now";
        if (diff < 60)  return diff + "s ago";
        if (diff < 3600) return (diff / 60) + "m ago";
        if (diff < 86400) return (diff / 3600) + "h ago";
        return (diff / 86400) + "d ago";
    }
}
