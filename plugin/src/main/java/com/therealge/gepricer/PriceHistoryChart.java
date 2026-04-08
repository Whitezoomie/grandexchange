package com.therealge.gepricer;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.runelite.client.ui.FontManager;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

import javax.swing.*;
import java.awt.*;
import java.awt.geom.Path2D;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * Mini price-history chart panel mirroring therealge.com.
 *
 * Shows avgHighPrice (green / buy) and avgLowPrice (orange / sell) lines.
 *
 * Ranges → API timestep → cutoff window:
 *   24h → 5m  → last 24 hours
 *   7d  → 1h  → last 7 days
 *   30d → 6h  → last 30 days
 *   1y  → 24h → last 365 days
 */
class PriceHistoryChart extends JPanel {
    private static final String TIMESERIES_URL =
        GEPricerPlugin.API_BASE + "/timeseries?timestep=%s&id=%d";
    private static final String USER_AGENT =
        "RuneLite ZoomFlipsPlugin/1.0 - therealge.com community plugin";

    private static final Color BG_CHART   = new Color(20, 20, 20);
    private static final Color COLOR_BUY  = new Color(0, 200, 83);
    private static final Color COLOR_SELL = new Color(255, 140, 0);
    private static final Color COLOR_GRID = new Color(45, 45, 45);
    private static final Color TEXT_MUTED = new Color(120, 120, 120);
    private static final Color TEXT_WHITE = Color.WHITE;
    private static final Color BG_TAB_ACT = new Color(55, 55, 55);
    private static final Color BG_TAB     = new Color(30, 30, 30);

    private static final int CHART_H  = 110;
    private static final int PAD_LEFT = 48;
    private static final int PAD_RIGHT = 6;
    private static final int PAD_TOP  = 8;
    private static final int PAD_BOT  = 20;

    enum Range { H24, D7, D30, Y1 }
    private static final Range[]  RANGES     = {Range.H24, Range.D7, Range.D30, Range.Y1};
    private static final String[] TAB_LABELS = {"24h", "7d", "30d", "1y"};

    private static class PricePoint {
        final long timestamp, avgHigh, avgLow;
        PricePoint(long ts, long h, long l) { timestamp = ts; avgHigh = h; avgLow = l; }
    }

    private enum LoadState { IDLE, LOADING, LOADED, ERROR }

    private final OkHttpClient          httpClient;
    private final JButton[]             tabBtns = new JButton[4];
    private final JPanel                chartCanvas;

    private int                      itemId      = -1;
    private Range                    activeRange = Range.H24;
    private volatile LoadState       loadState   = LoadState.IDLE;
    private volatile List<PricePoint> data       = new ArrayList<>();
    private volatile String          errorMsg    = "";

    PriceHistoryChart(OkHttpClient httpClient) {
        this.httpClient = httpClient;

        setBackground(BG_CHART);
        setLayout(new BorderLayout(0, 0));
        setAlignmentX(Component.LEFT_ALIGNMENT);

        // ---- Tab bar ----
        JPanel tabBar = new JPanel(new GridLayout(1, 4, 2, 0));
        tabBar.setBackground(new Color(25, 25, 25));
        tabBar.setBorder(BorderFactory.createEmptyBorder(3, 3, 3, 3));

        for (int i = 0; i < 4; i++) {
            final Range r = RANGES[i];
            JButton btn = new JButton(TAB_LABELS[i]);
            btn.setFont(FontManager.getRunescapeSmallFont());
            btn.setFocusPainted(false);
            btn.setBorderPainted(false);
            btn.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
            btn.setOpaque(true);
            applyTabStyle(btn, r == activeRange);
            btn.addActionListener(e -> {
                if (activeRange == r) return;
                activeRange = r;
                for (int j = 0; j < 4; j++) applyTabStyle(tabBtns[j], RANGES[j] == r);
                if (itemId >= 0) loadAsync();
            });
            tabBtns[i] = btn;
            tabBar.add(btn);
        }

        // ---- Chart canvas ----
        chartCanvas = new JPanel() {
            @Override
            protected void paintComponent(Graphics g) {
                super.paintComponent(g);
                drawChart((Graphics2D) g, getWidth(), getHeight());
            }
        };
        chartCanvas.setBackground(BG_CHART);
        chartCanvas.setOpaque(true);
        chartCanvas.setPreferredSize(new Dimension(0, CHART_H));
        chartCanvas.setMinimumSize(new Dimension(0, CHART_H));

        add(tabBar,      BorderLayout.NORTH);
        add(chartCanvas, BorderLayout.CENTER);

        setPreferredSize(new Dimension(0, CHART_H + 26));
        setMaximumSize(new Dimension(Integer.MAX_VALUE, CHART_H + 26));
    }

    /** Trigger a data load for the given item (called from EDT). */
    void loadItem(int id) {
        this.itemId = id;
        loadAsync();
    }

    // ---------- async network ----------

    private void loadAsync() {
        loadState = LoadState.LOADING;
        data      = new ArrayList<>();
        chartCanvas.repaint();

        final Range range = activeRange;
        final int   id    = itemId;
        String url = String.format(TIMESERIES_URL, timestepFor(range), id);

        new Thread(() -> {
            Request req = new Request.Builder()
                .url(url)
                .header("User-Agent", USER_AGENT)
                .build();
            try (Response resp = httpClient.newCall(req).execute()) {
                if (!resp.isSuccessful() || resp.body() == null) {
                    loadState = LoadState.ERROR;
                    errorMsg  = "HTTP " + resp.code();
                } else {
                    List<PricePoint> pts = parseTimeseries(resp.body().string(), range);
                    if (pts.isEmpty()) { loadState = LoadState.ERROR; errorMsg = "No data"; } else { data = pts; loadState = LoadState.LOADED; }
                }
            } catch (Exception ex) {
                loadState = LoadState.ERROR;
                errorMsg  = "Load failed";
            }
            SwingUtilities.invokeLater(chartCanvas::repaint);
        }, "ge-chart-fetch").start();
    }

    // ---------- JSON parsing ----------

    private static List<PricePoint> parseTimeseries(String json, Range range) {
        List<PricePoint> out = new ArrayList<>();
        try {
            JsonArray arr = new JsonParser().parse(json)
                .getAsJsonObject().getAsJsonArray("data");
            long now    = System.currentTimeMillis() / 1000L;
            long cutoff = cutoffSec(range, now);

            for (JsonElement el : arr) {
                JsonObject p  = el.getAsJsonObject();
                long ts  = jsonLong(p, "timestamp");
                if (ts < cutoff) continue;
                long hi  = jsonLong(p, "avgHighPrice");
                long lo  = jsonLong(p, "avgLowPrice");
                if (hi > 0 || lo > 0)
                    out.add(new PricePoint(ts, hi, lo));
            }
            out.sort((a, b) -> Long.compare(a.timestamp, b.timestamp));

            // Forward-fill zeros so lines don't drop to the baseline
            for (int i = 1; i < out.size(); i++) {
                PricePoint prev = out.get(i - 1);
                PricePoint cur  = out.get(i);
                long h = cur.avgHigh > 0 ? cur.avgHigh : prev.avgHigh;
                long l = cur.avgLow  > 0 ? cur.avgLow  : prev.avgLow;
                out.set(i, new PricePoint(cur.timestamp, h, l));
            }
        } catch (Exception ignored) {}
        return out;
    }

    // ---------- drawing ----------

    private void drawChart(Graphics2D g, int w, int h) {
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setColor(BG_CHART);
        g.fillRect(0, 0, w, h);

        if (loadState == LoadState.LOADING) {
            drawCentred(g, "Loading\u2026", w, h);
            return;
        }
        if (loadState != LoadState.LOADED || data.isEmpty()) {
            drawCentred(g, loadState == LoadState.ERROR ? errorMsg : "No data", w, h);
            return;
        }

        int cw = w - PAD_LEFT - PAD_RIGHT;
        int ch = h - PAD_TOP  - PAD_BOT;
        if (cw <= 0 || ch <= 0) return;

        // Compute price range
        long minP = Long.MAX_VALUE, maxP = Long.MIN_VALUE;
        for (PricePoint p : data) {
            if (p.avgHigh > 0) { minP = Math.min(minP, p.avgHigh); maxP = Math.max(maxP, p.avgHigh); }
            if (p.avgLow  > 0) { minP = Math.min(minP, p.avgLow);  maxP = Math.max(maxP, p.avgLow);  }
        }
        if (minP == Long.MAX_VALUE) return;
        long spread  = maxP - minP;
        double yMin  = minP - Math.max(spread, 1) * 0.08;
        double yMax  = maxP + Math.max(spread, 1) * 0.08;
        double yRange = yMax - yMin;

        // Horizontal grid lines + Y labels (4 lines: 0..3)
        Font smallFont = new Font(
            FontManager.getRunescapeSmallFont().getName(), Font.PLAIN, 9);
        g.setFont(smallFont);
        for (int i = 0; i <= 3; i++) {
            int y = PAD_TOP + (int)(ch * i / 3.0);
            g.setColor(COLOR_GRID);
            g.setStroke(new BasicStroke(1f));
            g.drawLine(PAD_LEFT, y, PAD_LEFT + cw, y);

            double val = yMax - yRange * i / 3.0;
            g.setColor(TEXT_MUTED);
            String label = compactGp((long) val);
            FontMetrics fm = g.getFontMetrics();
            g.drawString(label, PAD_LEFT - fm.stringWidth(label) - 3,
                         y + fm.getAscent() / 2);
        }

        int n = data.size();

        // Buy line (green)
        g.setColor(COLOR_BUY);
        g.setStroke(new BasicStroke(1.5f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
        drawPolyline(g, data, true, cw, ch, yMin, yRange);

        // Sell line (orange)
        g.setColor(COLOR_SELL);
        g.setStroke(new BasicStroke(1.5f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
        drawPolyline(g, data, false, cw, ch, yMin, yRange);

        // X-axis tick labels (4 evenly spaced)
        g.setFont(smallFont);
        g.setColor(TEXT_MUTED);
        FontMetrics fm = g.getFontMetrics();
        for (int i = 0; i <= 3; i++) {
            int idx = (int)((n - 1) * i / 3.0);
            String label = formatTime(data.get(idx).timestamp, activeRange);
            int x = PAD_LEFT + (int)(cw * i / 3.0) - fm.stringWidth(label) / 2;
            x = Math.max(0, Math.min(x, w - fm.stringWidth(label)));
            g.drawString(label, x, h - 3);
        }

        // Mini legend (top-left of chart area)
        g.setFont(smallFont);
        int lx = PAD_LEFT + 4, ly = PAD_TOP + 10;
        g.setColor(COLOR_BUY);
        g.fillOval(lx, ly - 6, 6, 6);
        g.drawString("Buy", lx + 8, ly);
        g.setColor(COLOR_SELL);
        g.fillOval(lx + 30, ly - 6, 6, 6);
        g.drawString("Sell", lx + 38, ly);
    }

    private void drawPolyline(Graphics2D g, List<PricePoint> pts, boolean useHigh,
                               int cw, int ch, double yMin, double yRange) {
        Path2D.Float path = new Path2D.Float();
        boolean started = false;
        int n = pts.size();
        for (int i = 0; i < n; i++) {
            long val = useHigh ? pts.get(i).avgHigh : pts.get(i).avgLow;
            if (val <= 0) continue;
            float x = PAD_LEFT + (float) cw * i / Math.max(n - 1, 1);
            float y = PAD_TOP  + (float)(ch * (1.0 - (val - yMin) / yRange));
            y = Math.max(PAD_TOP, Math.min(PAD_TOP + ch, y)); // clamp
            if (!started) { path.moveTo(x, y); started = true; } else { path.lineTo(x, y); }
        }
        if (started) g.draw(path);
    }

    private static void drawCentred(Graphics2D g, String text, int w, int h) {
        g.setFont(FontManager.getRunescapeSmallFont());
        g.setColor(TEXT_MUTED);
        FontMetrics fm = g.getFontMetrics();
        g.drawString(text, (w - fm.stringWidth(text)) / 2, h / 2 + fm.getAscent() / 2);
    }

    // ---------- static helpers ----------

    private static void applyTabStyle(JButton btn, boolean active) {
        btn.setBackground(active ? BG_TAB_ACT : BG_TAB);
        btn.setForeground(active ? TEXT_WHITE : TEXT_MUTED);
    }

    private static String timestepFor(Range r) {
        switch (r) {
            case H24: return "5m";
            case D7:  return "1h";
            case D30: return "6h";
            case Y1:  return "24h";
            default:  return "5m";
        }
    }

    private static long cutoffSec(Range r, long now) {
        switch (r) {
            case H24: return now -        86_400L;
            case D7:  return now -  7L * 86_400L;
            case D30: return now - 30L * 86_400L;
            case Y1:  return now - 365L * 86_400L;
            default:  return now -        86_400L;
        }
    }

    private static String formatTime(long epochSec, Range r) {
        ZonedDateTime zdt = Instant.ofEpochSecond(epochSec)
            .atZone(ZoneId.systemDefault());
        switch (r) {
            case H24: return String.format("%02d:%02d", zdt.getHour(), zdt.getMinute());
            case D7:
            case D30: return String.format("%s %d",
                          shortMonth(zdt.getMonthValue()), zdt.getDayOfMonth());
            case Y1:  return String.format("%s '%02d",
                          shortMonth(zdt.getMonthValue()), zdt.getYear() % 100);
            default:  return "";
        }
    }

    private static String shortMonth(int m) {
        String[] names = {"Jan","Feb","Mar","Apr","May","Jun",
                          "Jul","Aug","Sep","Oct","Nov","Dec"};
        return (m >= 1 && m <= 12) ? names[m - 1] : "";
    }

    private static String compactGp(long val) {
        long abs = Math.abs(val);
        if (abs >= 1_000_000_000L) return String.format("%.1fB", val / 1_000_000_000.0);
        if (abs >= 1_000_000L)     return String.format("%.1fM", val / 1_000_000.0);
        if (abs >= 1_000L)         return String.format("%.0fK", val / 1_000.0);
        return String.valueOf(val);
    }

    private static long jsonLong(JsonObject obj, String key) {
        if (obj.has(key) && !obj.get(key).isJsonNull()) {
            try { return obj.get(key).getAsLong(); } catch (Exception e) { return 0L; }
        }
        return 0L;
    }
}
