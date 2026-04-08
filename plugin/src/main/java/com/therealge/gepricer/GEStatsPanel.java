package com.therealge.gepricer;

import net.runelite.client.config.ConfigManager;
import net.runelite.client.ui.ColorScheme;
import net.runelite.client.ui.FontManager;

import javax.swing.*;
import javax.swing.border.CompoundBorder;
import javax.swing.border.EmptyBorder;
import javax.swing.border.MatteBorder;
import java.awt.*;
import java.awt.event.FocusAdapter;
import java.awt.event.FocusEvent;
import java.text.NumberFormat;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** "Stats" tab panel - Flipping Copilot style. */
public class GEStatsPanel extends JPanel {
    // Palette
    private static final Color BG           = ColorScheme.DARK_GRAY_COLOR;
    private static final Color BG_CARD      = new Color(30, 30, 30);
    private static final Color BG_ROW       = ColorScheme.DARKER_GRAY_COLOR;
    private static final Color TEXT_WHITE   = Color.WHITE;
    private static final Color TEXT_MUTED   = new Color(160, 160, 160);
    private static final Color COLOR_PROFIT = new Color(0, 200, 83);
    private static final Color COLOR_LOSS   = new Color(255, 95, 95);
    private static final Color COLOR_ZERO   = new Color(200, 200, 200);
    private static final Color BORDER_COLOR = new Color(60, 60, 60);

    private static final Font FONT_PROFIT_BIG = FontManager.getRunescapeBoldFont();
    private static final Font FONT_LABEL_BIG  = FontManager.getRunescapeBoldFont();
    private static final Font FONT_STAT       = FontManager.getRunescapeSmallFont();
    private static final Font FONT_STAT_BOLD  = FontManager.getRunescapeFont();
    private static final Font FONT_ROW        = FontManager.getRunescapeSmallFont();
    private static final Font FONT_ROW_VAL    = FontManager.getRunescapeFont();

    private static final NumberFormat NF = NumberFormat.getNumberInstance(Locale.US);

    // Summary labels (updated in refresh / tickUpdate)
    private final JLabel totalProfitLabel;
    private final JLabel roiLabel;
    private final JLabel flipCountLabel;
    private final JLabel taxLabel;
    private final JLabel hourlyProfitLabel;
    private final JLabel sessionTimeLabel;
    private final JLabel streakLabel;
    private JPanel       streakRow;

    // Flip-list container
    private final JPanel flipListPanel;

    private final GETradeSession    session;
    private final ConfigManager     configManager;
    private final javax.swing.Timer ticker;
    private Runnable onReset;
    /** Live price data keyed by item ID — used to estimate profit for unmatched flips. */
    private Map<Integer, GEPricerItem> priceData = new HashMap<>();

    // Goal tracking
    private long   goalGp         = 0;   // 0 = no goal set
    private JProgressBar goalBar;
    private JLabel       goalLabel;
    private JPanel       goalSection;

    public void setOnReset(Runnable r) { this.onReset = r; }

    /** Called when the price list refreshes so unmatched flips can show estimated P&L. */
    public void updatePriceData(List<GEPricerItem> items) {
        priceData = new HashMap<>();
        if (items != null) for (GEPricerItem i : items) priceData.put(i.getId(), i);
        // No need to rebuild the full flip list here — next refresh() call will include it.
    }

    public GEStatsPanel(GETradeSession session, ConfigManager configManager) {
        this.session       = session;
        this.configManager = configManager;
        loadGoal();

        setLayout(new BorderLayout(0, 0));
        setBackground(BG);

        // ---- Prominent profit header ----
        totalProfitLabel = new JLabel("0 gp");
        totalProfitLabel.setForeground(COLOR_PROFIT);
        totalProfitLabel.setFont(FONT_PROFIT_BIG);

        JLabel profitCaption = new JLabel("Profit:");
        profitCaption.setForeground(TEXT_WHITE);
        profitCaption.setFont(FONT_LABEL_BIG);

        JPanel profitRow = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 0));
        profitRow.setOpaque(false);
        profitRow.add(profitCaption);
        profitRow.add(totalProfitLabel);

        // ---- Compact stat rows ----
        roiLabel          = statValueLabel("0.000%");
        flipCountLabel    = statValueLabel("0");
        taxLabel          = statValueLabel("0 gp");
        hourlyProfitLabel = statValueLabel("0 gp/hr");
        sessionTimeLabel  = statValueLabel("00:00:00");
        streakLabel       = new JLabel("");
        streakLabel.setFont(FONT_STAT_BOLD);
        streakLabel.setHorizontalAlignment(SwingConstants.RIGHT);

        JPanel summaryCard = new JPanel();
        summaryCard.setLayout(new BoxLayout(summaryCard, BoxLayout.Y_AXIS));
        summaryCard.setBackground(BG_CARD);
        summaryCard.setBorder(new EmptyBorder(10, 12, 10, 12));
        summaryCard.add(profitRow);
        summaryCard.add(Box.createVerticalStrut(8));
        summaryCard.add(buildStatRow("ROI:",          roiLabel));
        summaryCard.add(Box.createVerticalStrut(4));
        summaryCard.add(buildStatRow("Flips made:",   flipCountLabel));
        summaryCard.add(Box.createVerticalStrut(4));
        summaryCard.add(buildStatRow("Tax paid:",     taxLabel));
        summaryCard.add(Box.createVerticalStrut(4));
        summaryCard.add(buildStatRow("GP/hr:",        hourlyProfitLabel));
        summaryCard.add(Box.createVerticalStrut(4));
        summaryCard.add(buildStatRow("Session time:", sessionTimeLabel));
        summaryCard.add(Box.createVerticalStrut(4));
        streakRow = buildStatRow("Streak:", streakLabel);
        streakRow.setVisible(false);
        summaryCard.add(streakRow);
        summaryCard.add(Box.createVerticalStrut(8));
        summaryCard.add(buildGoalSection());

        // ---- History section header ----
        JPanel sectionHeader = new JPanel(new BorderLayout(4, 0));
        sectionHeader.setBackground(BG_ROW);
        sectionHeader.setBorder(new EmptyBorder(6, 10, 6, 10));

        JLabel historyTitle = new JLabel("Trade History");
        historyTitle.setForeground(TEXT_MUTED);
        historyTitle.setFont(FONT_STAT_BOLD);

        JButton resetBtn = new JButton("Reset session");
        resetBtn.setFont(FONT_STAT);
        resetBtn.setForeground(TEXT_MUTED);
        resetBtn.setBackground(ColorScheme.MEDIUM_GRAY_COLOR);
        resetBtn.setBorderPainted(false);
        resetBtn.setFocusPainted(false);
        resetBtn.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        resetBtn.setToolTipText("Clear all session stats");
        resetBtn.addActionListener(e -> {
            session.reset();
            if (onReset != null) onReset.run();
            refresh();
        });

        sectionHeader.add(historyTitle, BorderLayout.CENTER);
        sectionHeader.add(resetBtn,     BorderLayout.EAST);

        // ---- Scrollable flip list ----
        // ScrollablePanel implements Scrollable.getScrollableTracksViewportWidth() = true
        // so JScrollPane constrains the panel's width to the viewport; otherwise the panel
        // expands to its preferred width (longest item name) and rows overflow the visible area.
        flipListPanel = new ScrollablePanel();
        flipListPanel.setBackground(BG);

        JScrollPane scroll = new JScrollPane(flipListPanel);
        scroll.setBorder(null);
        scroll.setHorizontalScrollBarPolicy(ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER);
        scroll.getVerticalScrollBar().setUnitIncrement(16);
        scroll.setBackground(BG);

        JPanel northPart = new JPanel();
        northPart.setLayout(new BoxLayout(northPart, BoxLayout.Y_AXIS));
        northPart.setBackground(BG);
        northPart.add(summaryCard);
        northPart.add(sectionHeader);

        add(northPart, BorderLayout.NORTH);
        add(scroll,    BorderLayout.CENTER);

        ticker = new javax.swing.Timer(1000, e -> tickUpdate());
        ticker.setRepeats(true);
        ticker.start();
    }

    // Public API

    /** Refresh all labels and rebuild the flip list. Call on the EDT. */
    public void refresh() {
        List<GEFlipRecord> flips = session.getFlips();
        long profit       = session.getTotalProfit();
        long totalTax     = flips.stream().filter(GEFlipRecord::isMatched).mapToLong(f -> f.tax).sum();
        long totalSpent   = flips.stream().filter(GEFlipRecord::isMatched).mapToLong(f -> f.buySpent).sum();
        int  matchedFlips = session.getMatchedFlipCount();
        int  totalFlips   = session.getTotalFlipCount();

        // Total profit
        String sign = profit > 0 ? "+" : "";
        totalProfitLabel.setText(sign + formatGpCompact(profit) + " gp");
        totalProfitLabel.setForeground(colorFor(profit));

        // ROI
        double roi = totalSpent > 0 ? (profit * 100.0) / totalSpent : 0.0;
        roiLabel.setText(String.format("%.3f%%", roi));
        roiLabel.setForeground(colorFor(profit));

        // Flips
        int unmatched = totalFlips - matchedFlips;
        flipCountLabel.setText(unmatched > 0
            ? matchedFlips + "  (" + unmatched + " unmatched)"
            : String.valueOf(matchedFlips));
        flipCountLabel.setForeground(TEXT_MUTED);

        // Tax
        taxLabel.setText(formatGpCompact(totalTax) + " gp");
        taxLabel.setForeground(TEXT_MUTED);

        // Flip streak — count consecutive profitable matched flips from most recent
        int streak = 0;
        for (int i = flips.size() - 1; i >= 0; i--) {
            GEFlipRecord f = flips.get(i);
            if (f.isMatched() && f.getProfit() > 0) streak++;
            else break;
        }
        if (streak >= 2) {
            streakLabel.setText("\uD83D\uDD25 " + streak + " in a row");
            streakLabel.setForeground(new Color(255, 160, 0));
            streakRow.setVisible(true);
        } else {
            streakRow.setVisible(false);
        }

        tickUpdate();
        buildFlipList();
    }

    public void stopTicker() { ticker.stop(); }

    private void loadGoal() {
        try {
            String raw = configManager.getConfiguration("gepricer", "sessionGoalGp");
            if (raw != null && !raw.isBlank()) goalGp = Long.parseLong(raw.trim());
        } catch (Exception ignored) {}
    }

    private void saveGoal() {
        configManager.setConfiguration("gepricer", "sessionGoalGp", String.valueOf(goalGp));
    }

    private JPanel buildGoalSection() {
        goalSection = new JPanel();
        goalSection.setLayout(new BoxLayout(goalSection, BoxLayout.Y_AXIS));
        goalSection.setOpaque(false);

        // Input row: label + field + "gp" suffix
        JPanel inputRow = new JPanel(new FlowLayout(FlowLayout.LEFT, 4, 0));
        inputRow.setOpaque(false);

        JLabel lbl = new JLabel("Session goal:");
        lbl.setForeground(TEXT_MUTED);
        lbl.setFont(FONT_STAT);

        JTextField goalField = new JTextField(goalGp > 0 ? formatGpCompact(goalGp) : "", 6);
        goalField.setFont(FONT_STAT);
        goalField.setForeground(Color.WHITE);
        goalField.setBackground(new Color(50, 50, 50));
        goalField.setCaretColor(Color.WHITE);
        goalField.setBorder(BorderFactory.createCompoundBorder(
            BorderFactory.createLineBorder(new Color(80, 80, 80)),
            BorderFactory.createEmptyBorder(1, 4, 1, 4)));
        goalField.setToolTipText("Enter goal in gp, e.g. 10000000 or 10M");
        goalField.addActionListener(e -> applyGoalInput(goalField));
        goalField.addFocusListener(new FocusAdapter() {
            @Override public void focusLost(FocusEvent e) { applyGoalInput(goalField); }
        });

        JLabel gpSuffix = new JLabel("gp");
        gpSuffix.setForeground(TEXT_MUTED);
        gpSuffix.setFont(FONT_STAT);

        inputRow.add(lbl);
        inputRow.add(goalField);
        inputRow.add(gpSuffix);

        // Progress bar
        goalBar = new JProgressBar(0, 100);
        goalBar.setValue(0);
        goalBar.setStringPainted(false);
        goalBar.setForeground(COLOR_PROFIT);
        goalBar.setBackground(new Color(40, 40, 40));
        goalBar.setBorder(BorderFactory.createLineBorder(new Color(70, 70, 70)));
        goalBar.setPreferredSize(new Dimension(Integer.MAX_VALUE, 6));
        goalBar.setMaximumSize(new Dimension(Integer.MAX_VALUE, 6));
        goalBar.setAlignmentX(Component.LEFT_ALIGNMENT);

        // Progress label: e.g. "4.2M / 10M (42%)" or hidden when no goal
        goalLabel = new JLabel("");
        goalLabel.setForeground(TEXT_MUTED);
        goalLabel.setFont(FONT_STAT);
        goalLabel.setAlignmentX(Component.LEFT_ALIGNMENT);

        JPanel barWrapper = new JPanel(new BorderLayout());
        barWrapper.setOpaque(false);
        barWrapper.setBorder(new EmptyBorder(3, 0, 0, 0));
        barWrapper.add(goalBar, BorderLayout.CENTER);
        barWrapper.setAlignmentX(Component.LEFT_ALIGNMENT);
        barWrapper.setMaximumSize(new Dimension(Integer.MAX_VALUE, 12));

        goalSection.add(inputRow);
        goalSection.add(Box.createVerticalStrut(4));
        goalSection.add(barWrapper);
        goalSection.add(Box.createVerticalStrut(2));
        goalSection.add(goalLabel);

        refreshGoalBar(session.getTotalProfit());
        return goalSection;
    }

    private void applyGoalInput(JTextField field) {
        String raw = field.getText().trim().toLowerCase(Locale.ROOT);
        try {
            long parsed;
            if (raw.endsWith("b"))      parsed = (long)(Double.parseDouble(raw.replace("b","")) * 1_000_000_000L);
            else if (raw.endsWith("m")) parsed = (long)(Double.parseDouble(raw.replace("m","")) * 1_000_000L);
            else if (raw.endsWith("k")) parsed = (long)(Double.parseDouble(raw.replace("k","")) * 1_000L);
            else                        parsed = Long.parseLong(raw.replaceAll("[^0-9]", ""));
            goalGp = Math.max(0, parsed);
        } catch (Exception ignored) {
            goalGp = 0;
        }
        field.setText(goalGp > 0 ? formatGpCompact(goalGp) : "");
        saveGoal();
        refreshGoalBar(session.getTotalProfit());
    }

    private void refreshGoalBar(long profit) {
        if (goalBar == null) return;
        if (goalGp <= 0) {
            goalBar.setValue(0);
            goalLabel.setText("");
            goalLabel.setVisible(false);
            goalBar.setVisible(false);
            return;
        }
        goalBar.setVisible(true);
        goalLabel.setVisible(true);
        int pct = (int) Math.min(100, Math.max(0, profit * 100L / goalGp));
        goalBar.setValue(pct);
        goalBar.setForeground(pct >= 100 ? new Color(255, 215, 0) : COLOR_PROFIT);
        goalLabel.setText(formatGpCompact(Math.max(0, profit)) + " / " + formatGpCompact(goalGp) + "  (" + pct + "%)");
        goalLabel.setForeground(pct >= 100 ? new Color(255, 215, 0) : TEXT_MUTED);
    }

    // Private helpers

    private void tickUpdate() {
        long elapsedMs = System.currentTimeMillis() - session.getStartMs();
        long secs      = elapsedMs / 1000L;
        sessionTimeLabel.setText(String.format("%02d:%02d:%02d",
            secs / 3600, (secs % 3600) / 60, secs % 60));
        sessionTimeLabel.setForeground(TEXT_MUTED);

        if (elapsedMs > 0) {
            long profit = session.getTotalProfit();
            long hrly   = (long) (profit * 3_600_000.0 / elapsedMs);
            hourlyProfitLabel.setText((hrly > 0 ? "+" : "") + formatGpCompact(hrly) + " gp/hr");
            hourlyProfitLabel.setForeground(colorFor(hrly));
            refreshGoalBar(profit);
        }
    }

    private void buildFlipList() {
        flipListPanel.removeAll();

        List<GETradeSession.PendingBuy> pending = session.getPendingBuys();
        List<GEFlipRecord>              flips   = session.getFlips();

        if (pending.isEmpty() && flips.isEmpty()) {
            JLabel empty = new JLabel("No trades recorded this session.");
            empty.setForeground(TEXT_MUTED);
            empty.setFont(FONT_STAT);
            empty.setBorder(new EmptyBorder(16, 10, 16, 10));
            empty.setAlignmentX(Component.CENTER_ALIGNMENT);
            flipListPanel.add(empty);
        } else {
            for (GETradeSession.PendingBuy buy : pending)
                flipListPanel.add(buildPendingRow(buy));
            for (GEFlipRecord flip : flips)
                    flipListPanel.add(buildFlipRow(flip));
        }

        flipListPanel.revalidate();
        flipListPanel.repaint();
    }

    /** Single-line row for a pending (unsold) buy. */
    private JPanel buildPendingRow(GETradeSession.PendingBuy buy) {
        JPanel row = new JPanel(new BorderLayout(8, 0)) {
            @Override public Dimension getMaximumSize()
            { return new Dimension(Integer.MAX_VALUE, getPreferredSize().height); }
        };
        row.setBackground(BG_ROW);
        row.setBorder(new CompoundBorder(
            new MatteBorder(0, 0, 1, 0, BORDER_COLOR),
            new EmptyBorder(6, 10, 6, 10)));
        row.setAlignmentX(Component.LEFT_ALIGNMENT);

        JLabel nameLabel = new JLabel("\u00d7" + NF.format(buy.quantity) + "  " + buy.itemName);
        nameLabel.setForeground(TEXT_WHITE);
        nameLabel.setFont(FONT_ROW);
        nameLabel.setToolTipText(buy.itemName);

        JLabel statusLabel = new JLabel("pending");
        statusLabel.setForeground(new Color(180, 140, 0));
        statusLabel.setFont(FONT_ROW_VAL);

        row.add(nameLabel,   BorderLayout.CENTER);
        row.add(statusLabel, BorderLayout.EAST);
        return row;
    }

    /** Single-line row showing item name on left and profit/loss on right. */
    private JPanel buildFlipRow(GEFlipRecord flip) {
        JPanel row = new JPanel(new BorderLayout(8, 0)) {
            @Override public Dimension getMaximumSize()
            { return new Dimension(Integer.MAX_VALUE, getPreferredSize().height); }
        };
        row.setBackground(BG_ROW);
        row.setBorder(new CompoundBorder(
            new MatteBorder(0, 0, 1, 0, BORDER_COLOR),
            new EmptyBorder(6, 10, 6, 10)));
        row.setAlignmentX(Component.LEFT_ALIGNMENT);

        JLabel nameLabel = new JLabel("\u00d7" + NF.format(flip.quantity) + "  " + flip.itemName);
        nameLabel.setForeground(TEXT_WHITE);
        nameLabel.setFont(FONT_ROW);
        nameLabel.setToolTipText(flip.itemName);

        JLabel profitLabel = new JLabel();
        profitLabel.setFont(FONT_ROW_VAL);
        profitLabel.setHorizontalAlignment(SwingConstants.RIGHT);
        if (flip.isMatched()) {
            long p = flip.getProfit();
            profitLabel.setText((p >= 0 ? "+" : "") + formatGp(p) + " gp");
            profitLabel.setForeground(colorFor(p));
        } else {
            // No matching buy recorded — estimate using current instaSell price if available
            GEPricerItem priceItem = priceData.get(flip.itemId);
            if (priceItem != null && priceItem.getInstaSell() > 0) {
                long estBuyCost = priceItem.getInstaSell() * flip.quantity;
                long estProfit  = flip.sellReceived - estBuyCost;
                profitLabel.setText((estProfit >= 0 ? "~+" : "~") + formatGp(estProfit) + " gp (est.)");
                profitLabel.setForeground(new Color(200, 160, 50)); // amber = estimated
            } else {
                profitLabel.setText("?");
                profitLabel.setForeground(TEXT_MUTED);
            }
        }

        // Duration label (how long from buy placed to sell completed)
        JLabel durationLabel = new JLabel();
        durationLabel.setFont(FONT_STAT);
        durationLabel.setHorizontalAlignment(SwingConstants.RIGHT);
        long durMs = flip.getSellDurationMs();
        if (durMs >= 0) {
            durationLabel.setText(formatDuration(durMs));
            durationLabel.setForeground(TEXT_MUTED);
        } else {
            durationLabel.setVisible(false);
        }

        JPanel rightPanel = new JPanel();
        rightPanel.setLayout(new BoxLayout(rightPanel, BoxLayout.Y_AXIS));
        rightPanel.setOpaque(false);
        profitLabel.setAlignmentX(Component.RIGHT_ALIGNMENT);
        durationLabel.setAlignmentX(Component.RIGHT_ALIGNMENT);
        rightPanel.add(profitLabel);
        rightPanel.add(durationLabel);

        row.add(nameLabel,  BorderLayout.CENTER);
        row.add(rightPanel, BorderLayout.EAST);
        return row;
    }

    // Label / row factories

    private static JPanel buildStatRow(String key, JLabel valueLabel) {
        JPanel row = new JPanel(new BorderLayout(8, 0));
        row.setBackground(BG_CARD);
        row.setMaximumSize(new Dimension(Integer.MAX_VALUE, 22));

        JLabel keyLabel = new JLabel(key);
        keyLabel.setForeground(TEXT_MUTED);
        keyLabel.setFont(FONT_STAT);

        row.add(keyLabel,   BorderLayout.WEST);
        row.add(valueLabel, BorderLayout.EAST);
        return row;
    }

    private static JLabel statValueLabel(String text) {
        JLabel l = new JLabel(text);
        l.setForeground(TEXT_MUTED);
        l.setFont(FONT_STAT_BOLD);
        l.setHorizontalAlignment(SwingConstants.RIGHT);
        return l;
    }

    // Format helpers

    private static String formatGp(long val) {
        return NF.format(val);
    }

    /** "42s", "5m 12s", "1h 3m" */
    private static String formatDuration(long ms) {
        long secs = ms / 1000L;
        if (secs < 60)   return secs + "s";
        long mins = secs / 60, remSecs = secs % 60;
        if (mins < 60)   return mins + "m" + (remSecs > 0 ? " " + remSecs + "s" : "");
        long hrs = mins / 60, remMins = mins % 60;
        return hrs + "h" + (remMins > 0 ? " " + remMins + "m" : "");
    }

    private static String formatGpCompact(long val) {
        long abs = Math.abs(val);
        String prefix = val < 0 ? "-" : "";
        if (abs >= 1_000_000_000L) return prefix + String.format("%.2fB", abs / 1_000_000_000.0);
        if (abs >= 1_000_000L)     return prefix + String.format("%.2fM", abs / 1_000_000.0);
        if (abs >= 1_000L)         return prefix + String.format("%.1fK", abs / 1_000.0);
        return NF.format(val);
    }

    private static Color colorFor(long val) {
        if (val > 0) return COLOR_PROFIT;
        if (val < 0) return COLOR_LOSS;
        return COLOR_ZERO;
    }

    /**
     * A JPanel that tells JScrollPane to size its width to the viewport width.
     * Without this, JScrollPane sizes the panel to its preferred width (the
     * widest row), causing rows to overflow the visible plugin panel area.
     */
    private static class ScrollablePanel extends JPanel implements javax.swing.Scrollable {
        ScrollablePanel() {
            setLayout(new BoxLayout(this, BoxLayout.Y_AXIS));
        }

        @Override public Dimension getPreferredScrollableViewportSize()            { return getPreferredSize(); }
        @Override public int getScrollableUnitIncrement(Rectangle r, int o, int d) { return 16; }
        @Override public int getScrollableBlockIncrement(Rectangle r, int o, int d) { return 100; }
        @Override public boolean getScrollableTracksViewportWidth()                 { return true; }
        @Override public boolean getScrollableTracksViewportHeight()                { return false; }
    }
}
