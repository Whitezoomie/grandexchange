package com.therealge.gepricer;

import net.runelite.client.config.ConfigManager;
import net.runelite.client.game.ItemManager;
import net.runelite.client.ui.ColorScheme;
import net.runelite.client.ui.FontManager;
import net.runelite.client.util.AsyncBufferedImage;
import okhttp3.OkHttpClient;

import javax.swing.*;
import javax.swing.border.EmptyBorder;
import javax.swing.border.MatteBorder;
import java.awt.*;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.text.NumberFormat;
import java.util.*;
import java.util.List;
import java.util.Locale;
import java.util.function.Consumer;
import java.util.stream.Collectors;

/**
 * "Flip Pick" tab â€” suggests the best current flipping opportunity.
 *
 * Algorithm (mirrors therealge.com):
 *   1. Filter items: volume â‰¥ 150/day, margin > 0, both prices known,
 *      not in block list, not in session skip set.
 *   2. Sort by net margin descending.
 *   3. Show the #1 candidate with full stats.
 *
 * Actions:
 *   View  â†’ switches to Prices tab and fills in the search bar.
 *   Next  â†’ skips this item for the session (reset when all items skipped).
 *   Block â†’ permanently blocks this item (persisted via ConfigManager).
 */
public class GEFlipPickPanel extends JPanel {
    // Palette
    private static final Color BG           = ColorScheme.DARK_GRAY_COLOR;
    private static final Color BG_CARD      = new Color(30, 30, 30);
    private static final Color TEXT_WHITE   = Color.WHITE;
    private static final Color TEXT_MUTED   = new Color(160, 160, 160);
    private static final Color COLOR_PROFIT = new Color(0, 200, 83);
    private static final Color COLOR_GOLD   = new Color(255, 215, 0);
    private static final Color COLOR_LOSS   = new Color(255, 95, 95);
    private static final Color BORDER_COLOR = new Color(60, 60, 60);

    private static final NumberFormat NF = NumberFormat.getNumberInstance(Locale.US);

    private long minVolume = 150; // Minimum daily volume for an item to be a Flip Pick candidate (user-adjustable).
    private long overcutGp = 0; // Amount to add to buy price when buying (buy overcut).
    private long sellUndercutGp = 0; // Amount to subtract from sell price when selling (sell undercut).

    // Dependencies
    private final ItemManager      itemManager;
    private final ConfigManager    configManager;
    private final OkHttpClient    httpClient;
    private final Runnable         onSwitchToPrices; // Called when user clicks "View" â€” switches the outer panel to Prices.
    private final Consumer<String> onSearch; // Called with item name when user clicks "View" â€” fills the search bar.
    private Runnable               onItemChanged; // Called when the displayed item changes (Next/Block clicked).

    // State
    private List<GEPricerItem>  allItems    = new ArrayList<>();
    private final Set<Integer>  skipSet          = new HashSet<>(); // Session-only: resets when all candidates are skipped.
    private final Set<Integer>  blockSet         = new HashSet<>(); // Persisted via ConfigManager key "gepricer" / "flipBlocklist".
    /** Items the player currently has a SELLING or SOLD offer for â€” excluded from buy suggestions. */
    private final Set<Integer>  sellingItemIds   = new HashSet<>();
    private GEPricerItem        currentItem      = null;
    private boolean             blockListOpen    = false; // Whether the block-list section is currently expanded.
    private Consumer<StagnantBuyAlert> onModifyOffer    = null; // Called when user clicks "Modify" on a stagnant buy banner.
    private Consumer<StagnantBuyAlert> onCancelNewOffer  = null; // Called when user clicks "New item" on a stagnant buy banner.
    private Consumer<StagnantSellAlert> onModifySellOffer = null; // Called when user clicks "Lower it" on a stagnant sell banner.

    /** Stagnant sell-offer alerts (no fills in â‰¥60 min) â€” suggest lowering price if safe. */
    private final List<StagnantSellAlert> stagnantSellAlerts    = new ArrayList<>();
    private final Set<Integer>            dismissedSellAlerts   = new HashSet<>();

    /** Active price alerts from the plugin â€” rendered as banners above the flip card. */
    private final List<PriceAlert> priceAlerts  = new ArrayList<>();
    /** Stagnant buy-offer alerts (no fills in â‰¥10 min) â€” ask the user what to do. */
    private final List<StagnantBuyAlert> stagnantBuyAlerts = new ArrayList<>();
    /** Set of stagnant buy item IDs that the user has chosen to keep for now. */
    private final Set<Integer> keptStagnantBuys = new HashSet<>();
    /** Inventory sell suggestions â€” items the user already holds that can be sold. */
    private final List<InventorySellSuggestion> inventorySuggestions = new ArrayList<>();
    private long perSlotBudget = 0; // Per-slot GP budget (0 = no limit). Flip Pick candidates are filtered to this price.
    private long totalInventoryGp = 0; // Total GP the player has in inventory (displayed in header).

    // Data models

    /**
     * A sell offer that has been open for â‰¥60 minutes with no fills.
     * {@code canLower} = true when lowering to {@code suggestedPrice} won't exceed a 100k loss.
     * When {@code canLower} is false, only a "Keep it" dismiss is offered.
     */
    public static class StagnantSellAlert {
        public final int    itemId;
        public final String itemName;
        public final long   minutesOpen;
        public final long   currentPrice; // Price the offer is currently listed at.
        public final long   suggestedPrice; // Insta-buy (current market bid) to suggest as the new sell price.
        public final boolean canLower; // True if lowering to suggestedPrice keeps the loss within the 100k tolerance.

        public StagnantSellAlert(int itemId, String itemName, long minutesOpen,
                                 long currentPrice, long suggestedPrice, boolean canLower) {
            this.itemId        = itemId;
            this.itemName      = itemName;
            this.minutesOpen   = minutesOpen;
            this.currentPrice  = currentPrice;
            this.suggestedPrice = suggestedPrice;
            this.canLower      = canLower;
        }
    }

    /**
     * Represents a buy offer that has been open for â‰¥10 minutes without filling.
     * The user is asked whether to keep it, modify the price, or buy a different item.
     */
    public static class StagnantBuyAlert {
        public final int    itemId;
        public final String itemName;
        public final long   minutesOpen; // How many minutes the offer has been open without a fill.
        public final long   currentPrice; // Price the offer is currently listed at.

        public StagnantBuyAlert(int itemId, String itemName, long minutesOpen, long currentPrice) {
            this.itemId       = itemId;
            this.itemName     = itemName;
            this.minutesOpen  = minutesOpen;
            this.currentPrice = currentPrice;
        }
    }

    /**
     * Represents a single stale GE offer that should be modified.
     * {@code isBuy} = true for a buy offer, false for a sell offer.
     */
    public static class PriceAlert {
        public final int    itemId;
        public final String itemName;
        public final boolean isBuy;
        public final long   currentPrice; // Price currently set in the GE offer.
        public final long   recommendedPrice; // Recommended price to modify the offer to.

        public PriceAlert(int itemId, String itemName, boolean isBuy,
                          long currentPrice, long recommendedPrice) {
            this.itemId           = itemId;
            this.itemName         = itemName;
            this.isBuy            = isBuy;
            this.currentPrice     = currentPrice;
            this.recommendedPrice = recommendedPrice;
        }
    }
    /** An item currently sitting in the player's inventory that can be sold for profit. */
    public static class InventorySellSuggestion {
        public final int    itemId;
        public final String itemName;
        public final int    qty;
        public final long   recommendedSellPrice;

        public InventorySellSuggestion(int itemId, String itemName, int qty, long recommendedSellPrice) {
            this.itemId               = itemId;
            this.itemName             = itemName;
            this.qty                  = qty;
            this.recommendedSellPrice = recommendedSellPrice;
        }
    }

    // UI
    private final JPanel contentArea;

    public GEFlipPickPanel(ItemManager itemManager,
                           ConfigManager configManager,
                           OkHttpClient httpClient,
                           Runnable onSwitchToPrices,
                           Consumer<String> onSearch) {
        this.itemManager      = itemManager;
        this.configManager    = configManager;
        this.httpClient       = httpClient;
        this.onSwitchToPrices = onSwitchToPrices;
        this.onSearch         = onSearch;

        loadBlockList();
        loadMinVolume();
        loadOvercut();
        loadSellUndercut();

        setLayout(new BorderLayout(0, 0));
        setBackground(BG);

        // ---- Title bar ----
        JPanel titleBar = new JPanel();
        titleBar.setLayout(new BoxLayout(titleBar, BoxLayout.Y_AXIS));
        titleBar.setBackground(ColorScheme.DARKER_GRAY_COLOR);
        titleBar.setBorder(new EmptyBorder(8, 10, 8, 10));

        JLabel title = new JLabel("Flip Pick");
        title.setForeground(TEXT_WHITE);
        title.setFont(FontManager.getRunescapeBoldFont());
        title.setAlignmentX(Component.LEFT_ALIGNMENT);

        // ---- Buy Overcut row ----
        JPanel overcutRow = new JPanel(new FlowLayout(FlowLayout.LEFT, 4, 0));
        overcutRow.setOpaque(false);
        overcutRow.setAlignmentX(Component.LEFT_ALIGNMENT);

        JLabel overcutLabel = new JLabel("Overcut");
        overcutLabel.setForeground(TEXT_MUTED);
        overcutLabel.setFont(FontManager.getRunescapeSmallFont());

        JTextField overcutField = buildGpTextField(overcutGp, () -> overcutGp, v -> overcutGp = v, this::saveOvercut);

        JLabel overcutSuffix = new JLabel("gp");
        overcutSuffix.setForeground(TEXT_MUTED);
        overcutSuffix.setFont(FontManager.getRunescapeSmallFont());

        JButton overcutDown = buildStepButton("-");
        JButton overcutUp   = buildStepButton("+");
        JButton overcutReset = buildResetButton();
        overcutDown.addActionListener(e -> {
            overcutGp = Math.max(0, overcutGp - 100);
            overcutField.setText(String.valueOf(overcutGp));
            saveOvercut();
            showBestFlip();
        });
        overcutUp.addActionListener(e -> {
            overcutGp += 100;
            overcutField.setText(String.valueOf(overcutGp));
            saveOvercut();
            showBestFlip();
        });
        overcutReset.addActionListener(e -> {
            overcutGp = 0;
            overcutField.setText("0");
            saveOvercut();
            showBestFlip();
        });

        overcutRow.add(overcutLabel);
        overcutRow.add(overcutDown);
        overcutRow.add(overcutField);
        overcutRow.add(overcutUp);
        overcutRow.add(overcutReset);
        overcutRow.add(overcutSuffix);

        // ---- Sell Undercut row ----
        JPanel sellUndercutRow = new JPanel(new FlowLayout(FlowLayout.LEFT, 4, 0));
        sellUndercutRow.setOpaque(false);
        sellUndercutRow.setAlignmentX(Component.LEFT_ALIGNMENT);

        JLabel sellUndercutLabel = new JLabel("Undercut");
        sellUndercutLabel.setForeground(TEXT_MUTED);
        sellUndercutLabel.setFont(FontManager.getRunescapeSmallFont());

        JTextField sellUndercutField = buildGpTextField(sellUndercutGp, () -> sellUndercutGp, v -> sellUndercutGp = v, this::saveSellUndercut);

        JLabel sellUndercutSuffix = new JLabel("gp");
        sellUndercutSuffix.setForeground(TEXT_MUTED);
        sellUndercutSuffix.setFont(FontManager.getRunescapeSmallFont());

        JButton sellUndercutDown = buildStepButton("-");
        JButton sellUndercutUp   = buildStepButton("+");
        JButton sellUndercutReset = buildResetButton();
        sellUndercutDown.addActionListener(e -> {
            sellUndercutGp = Math.max(0, sellUndercutGp - 100);
            sellUndercutField.setText(String.valueOf(sellUndercutGp));
            saveSellUndercut();
            showBestFlip();
        });
        sellUndercutUp.addActionListener(e -> {
            sellUndercutGp += 100;
            sellUndercutField.setText(String.valueOf(sellUndercutGp));
            saveSellUndercut();
            showBestFlip();
        });
        sellUndercutReset.addActionListener(e -> {
            sellUndercutGp = 0;
            sellUndercutField.setText("0");
            saveSellUndercut();
            showBestFlip();
        });

        sellUndercutRow.add(sellUndercutLabel);
        sellUndercutRow.add(sellUndercutDown);
        sellUndercutRow.add(sellUndercutField);
        sellUndercutRow.add(sellUndercutUp);
        sellUndercutRow.add(sellUndercutReset);
        sellUndercutRow.add(sellUndercutSuffix);

        // ---- Vol/day row ----
        JPanel volRow = new JPanel(new FlowLayout(FlowLayout.LEFT, 4, 0));
        volRow.setOpaque(false);
        volRow.setAlignmentX(Component.LEFT_ALIGNMENT);

        JLabel volPrefix = new JLabel("Min vol/day  \u2265");
        volPrefix.setForeground(TEXT_MUTED);
        volPrefix.setFont(FontManager.getRunescapeSmallFont());

        JLabel volLabel = new JLabel(String.valueOf(minVolume));
        volLabel.setForeground(Color.WHITE);
        volLabel.setFont(FontManager.getRunescapeSmallFont());

        JLabel volSuffix = new JLabel(" vol/day");
        volSuffix.setForeground(TEXT_MUTED);
        volSuffix.setFont(FontManager.getRunescapeSmallFont());

        JButton volDown = new JButton("-");
        JButton volUp   = new JButton("+");
        for (JButton btn : new JButton[]{ volDown, volUp }) {
            btn.setFont(FontManager.getRunescapeSmallFont());
            btn.setForeground(Color.WHITE);
            btn.setBackground(new Color(60, 60, 60));
            btn.setBorderPainted(false);
            btn.setFocusPainted(false);
            btn.setPreferredSize(new Dimension(16, 14));
            btn.setMinimumSize(new Dimension(16, 14));
            btn.setMaximumSize(new Dimension(16, 14));
        }
        volDown.addActionListener(e -> {
            if (minVolume > 0) minVolume = Math.max(0, minVolume - 25);
            volLabel.setText(String.valueOf(minVolume));
            saveMinVolume();
            showBestFlip();
        });
        volUp.addActionListener(e -> {
            minVolume += 25;
            volLabel.setText(String.valueOf(minVolume));
            saveMinVolume();
            showBestFlip();
        });

        volRow.add(volPrefix);
        volRow.add(volDown);
        volRow.add(volLabel);
        volRow.add(volUp);
        volRow.add(volSuffix);

        titleBar.add(title);
        titleBar.add(Box.createVerticalStrut(4));
        titleBar.add(overcutRow);
        titleBar.add(Box.createVerticalStrut(2));
        titleBar.add(sellUndercutRow);
        titleBar.add(Box.createVerticalStrut(2));
        titleBar.add(volRow);

        // ---- Scrollable body ----
        contentArea = new ScrollablePanel();
        contentArea.setLayout(new BoxLayout(contentArea, BoxLayout.Y_AXIS));
        contentArea.setBackground(BG);
        contentArea.setBorder(new EmptyBorder(8, 8, 8, 8));

        JScrollPane scroll = new JScrollPane(contentArea);
        scroll.setBorder(null);
        scroll.setHorizontalScrollBarPolicy(ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER);
        scroll.getVerticalScrollBar().setUnitIncrement(16);
        scroll.setBackground(BG);

        add(titleBar, BorderLayout.NORTH);
        add(scroll,   BorderLayout.CENTER);

        showLoading();
    }

    // Public API

    /** Called (on EDT) whenever the price list refreshes. */
    public void updateItems(List<GEPricerItem> items) {
        this.allItems = items;
        showBestFlip();
    }

    /**
     * Called from the plugin (via EDT) when stagnant buy offers are detected.
     * Replaces the current stagnant-buy alert list and refreshes the panel.
     * Alerts the user has dismissed with "Keep" are suppressed until the item
     * is no longer in the stagnant list (i.e. it filled or was cancelled).
     */
    public void updateStagnantBuyAlerts(List<StagnantBuyAlert> alerts) {
        if (!SwingUtilities.isEventDispatchThread()) { SwingUtilities.invokeLater(() -> updateStagnantBuyAlerts(alerts)); return; }
        // Remove kept-dismissals for items that are no longer stagnant
        Set<Integer> incomingIds = new HashSet<>();
        for (StagnantBuyAlert a : alerts) incomingIds.add(a.itemId);
        keptStagnantBuys.retainAll(incomingIds);

        stagnantBuyAlerts.clear();
        stagnantBuyAlerts.addAll(alerts);
        showBestFlip();
    }

    /** Returns the currently displayed Flip Pick item, or null. */
    public GEPricerItem getCurrentItem() {
        return currentItem;
    }

    /** Returns the current buy overcut amount in GP (0 = none). */
    public long getOvercutGp() {
        return overcutGp;
    }

    /** Returns the current sell undercut amount in GP (0 = none). */
    public long getSellUndercutGp() {
        return sellUndercutGp;
    }

    /** Register a callback to be notified when the displayed item changes (Next/Block). */
    public void setOnItemChanged(Runnable callback) {
        this.onItemChanged = callback;
    }

    public void setOnModifyOffer(Consumer<StagnantBuyAlert> cb)   { this.onModifyOffer   = cb; }
    public void setOnCancelNewOffer(Consumer<StagnantBuyAlert> cb){ this.onCancelNewOffer = cb; }
    public void setOnModifySellOffer(Consumer<StagnantSellAlert> cb){ this.onModifySellOffer = cb; }

    /**
     * Called (on EDT) when stagnant sell offers are detected.
     * Retains dismissals for alerts still in the incoming list.
     */
    public void updateStagnantSellAlerts(List<StagnantSellAlert> alerts) {
        if (!SwingUtilities.isEventDispatchThread()) { SwingUtilities.invokeLater(() -> updateStagnantSellAlerts(alerts)); return; }
        Set<Integer> incomingIds = new HashSet<>();
        for (StagnantSellAlert a : alerts) incomingIds.add(a.itemId);
        dismissedSellAlerts.retainAll(incomingIds);
        stagnantSellAlerts.clear();
        stagnantSellAlerts.addAll(alerts);
        showBestFlip();
    }

    /**
     * Called from the plugin (via EDT) whenever active GE offer prices are checked.
     * Replaces the current alert list and refreshes the flip card area.
     */
    public void updatePriceAlerts(List<PriceAlert> alerts) {
        if (!SwingUtilities.isEventDispatchThread()) { SwingUtilities.invokeLater(() -> updatePriceAlerts(alerts)); return; }
        priceAlerts.clear();
        priceAlerts.addAll(alerts);
        showBestFlip();
    }

    /**
     * Updates the inventory sell suggestions shown at the top of the panel.
     * Also updates the GP budget used to filter Flip Pick candidates.
     * Safe to call from any thread.
     */
    public void updateInventoryContext(List<InventorySellSuggestion> suggestions,
                                       long totalGp, long perSlotBudgetGp) {
        if (!SwingUtilities.isEventDispatchThread()) { SwingUtilities.invokeLater(() -> updateInventoryContext(suggestions, totalGp, perSlotBudgetGp)); return; }
        inventorySuggestions.clear();
        if (suggestions != null) inventorySuggestions.addAll(suggestions);
        totalInventoryGp = totalGp;
        perSlotBudget    = perSlotBudgetGp;
        showBestFlip();
    }

    /** Removes an item from the session skip set so it can be suggested again. Safe to call from any thread. */
    public void unskipItem(int itemId) {
        if (!SwingUtilities.isEventDispatchThread()) { SwingUtilities.invokeLater(() -> unskipItem(itemId)); return; }
        skipSet.remove(itemId);
    }

    /**
     * Replaces the set of item IDs that the player currently has SELLING/SOLD offers for.
     * Those items are excluded from buy suggestions until the offer completes and is collected.
     * Safe to call from any thread.
     */
    public void setSellingItemIds(java.util.Collection<Integer> ids) {
        if (!SwingUtilities.isEventDispatchThread()) { SwingUtilities.invokeLater(() -> setSellingItemIds(ids)); return; }
        sellingItemIds.clear();
        if (ids != null) sellingItemIds.addAll(ids);
        // Refresh the displayed item in case the current pick is now excluded.
        showBestFlip();
    }

    /** Programmatically skips the current item â€” same as clicking the Next button. Safe to call from any thread. */
    public void skipCurrentItem() {
        if (!SwingUtilities.isEventDispatchThread()) { SwingUtilities.invokeLater(this::skipCurrentItem); return; }
        if (currentItem != null) {
            skipSet.add(currentItem.getId());
            showBestFlip();
        }
    }

    // Core logic

    /** Estimated hours to sell one full buy limit at current volume. */
    private double sellTimeHours(GEPricerItem i) {
        if (i.getVolume() <= 0 || i.getBuyLimit() <= 0) return 0.0;
        return i.getBuyLimit() / (i.getVolume() / 48.0);
    }

    private List<GEPricerItem> getCandidates() {
        return allItems.stream()
            .filter(i -> i.getVolume() >= minVolume)
            .filter(i -> i.getMargin() > 0)
            .filter(i -> i.getInstaBuy() > 0 && i.getInstaSell() > 0)
            .filter(i -> !blockSet.contains(i.getId()))
            .filter(i -> !skipSet.contains(i.getId()))
            .filter(i -> !sellingItemIds.contains(i.getId()))
            .filter(i -> perSlotBudget <= 0 || (i.getInstaSell() + overcutGp) <= perSlotBudget)
            .filter(i -> i.getBuyLimit() <= 0 || i.getVolume() <= 0 || sellTimeHours(i) <= 2.0)
            .filter(this::hasPositiveAdjustedMargin)
            // Skip items whose prices haven't been updated in over an hour — stale margin is fictional
            .filter(i -> {
                long newestTs = Math.max(i.getInstaBuyTime(), i.getInstaSellTime());
                return newestTs <= 0 || (System.currentTimeMillis() / 1000L) - newestTs < 3600;
            })
            // Skip items the server flags as declining (FALLING or STABLE_DOWN)
            .filter(i -> {
                String sig = i.getServerSignal();
                return sig == null || (!sig.equals("FALLING") && !sig.equals("STABLE_DOWN"));
            })
            .sorted(Comparator.comparingLong((GEPricerItem i) -> {
                long score = i.getEffectiveScore();
                return score > 0 ? score : i.getMargin();
            }).reversed())
            .collect(Collectors.toList());
    }

    /**
     * Returns true if the margin is still positive after applying the user's overcut/undercut offsets.
     * Prevents suggesting items where the adjusted buy price has eaten into the profit.
     */
    private boolean hasPositiveAdjustedMargin(GEPricerItem i) {
        long adjBuy    = i.getInstaSell() + overcutGp;
        long adjSell   = Math.max(1, i.getInstaBuy() - sellUndercutGp);
        long adjTax    = Math.min((long) Math.floor(adjSell * 0.02), 5_000_000L);
        return (adjSell - adjBuy - adjTax) > 0;
    }

    /**
     * Re-evaluates the best candidate and updates only the item card + action bar,
     * leaving the block-list section (index 4+) untouched so it stays open.
     */
    private void refreshItemCardOnly() {
        // If there are banners (price alerts or inventory suggestions) the component indices
        // shift, so fall back to a full rebuild.
        if (!priceAlerts.isEmpty() || !inventorySuggestions.isEmpty()) { showBestFlip(); return; }

        List<GEPricerItem> candidates = getCandidates();
        if (candidates.isEmpty() && !skipSet.isEmpty()) {
            skipSet.clear();
            candidates = getCandidates();
        }

        if (candidates.isEmpty()) {
            currentItem = null;
            // Full rebuild is fine here â€” no candidates means block list is irrelevant
            showBestFlip();
            return;
        }

        currentItem = candidates.get(0);

        // Replace components 0-3: card, strut, actionBar, strut
        // Keep component 4+ (block list section) intact.
        if (contentArea.getComponentCount() >= 4) {
            contentArea.remove(3); // strut before block list
            contentArea.remove(2); // action bar
            contentArea.remove(1); // strut after card
            contentArea.remove(0); // item card

            contentArea.add(buildItemCard(currentItem), 0);
            contentArea.add(Box.createVerticalStrut(8),  1);
            contentArea.add(buildActionBar(),            2);
            contentArea.add(Box.createVerticalStrut(14), 3);
        } else {
            // Fallback: full rebuild
            showBestFlip();
            return;
        }

        contentArea.revalidate();
        contentArea.repaint();
    }

    /** Shows a paused placeholder in the content area. */
    private void showLoading() {
        contentArea.removeAll();
        JLabel lbl = new JLabel("Loading items\u2026");
        lbl.setForeground(TEXT_MUTED);
        lbl.setFont(FontManager.getRunescapeSmallFont());
        lbl.setAlignmentX(Component.CENTER_ALIGNMENT);
        lbl.setBorder(new EmptyBorder(20, 0, 0, 0));
        contentArea.add(lbl);
        contentArea.revalidate();
        contentArea.repaint();
    }

    /** Builds a red warning banner for a buy offer that hasn't filled in â‰¥10 minutes. */
    private JPanel buildStagnantBuyBanner(StagnantBuyAlert alert) {
        JPanel banner = new JPanel() {
            @Override public Dimension getMaximumSize()
            { return new Dimension(Integer.MAX_VALUE, getPreferredSize().height); }
        };
        banner.setLayout(new BoxLayout(banner, BoxLayout.Y_AXIS));
        Color RED = new Color(220, 60, 60);
        banner.setBackground(new Color(45, 10, 10));
        banner.setBorder(BorderFactory.createCompoundBorder(
            new MatteBorder(1, 1, 1, 1, RED),
            new EmptyBorder(7, 8, 7, 8)
        ));
        banner.setAlignmentX(Component.LEFT_ALIGNMENT);

        // Question line
        JLabel questionLbl = new JLabel(String.format(
            "<html><body>"
            + "<b style='color:#EF5350'>Buy offer stagnant (%d min):</b> %s<br>"
            + "No fills at <b>%,d gp</b> \u2014 keep it?</body></html>",
            alert.minutesOpen, alert.itemName, alert.currentPrice));
        questionLbl.setForeground(Color.WHITE);
        questionLbl.setFont(FontManager.getRunescapeSmallFont());
        questionLbl.setAlignmentX(Component.LEFT_ALIGNMENT);
        banner.add(questionLbl);
        banner.add(Box.createVerticalStrut(6));

        // Button row
        JPanel btnRow = new JPanel();
        btnRow.setLayout(new BoxLayout(btnRow, BoxLayout.X_AXIS));
        btnRow.setOpaque(false);
        btnRow.setAlignmentX(Component.LEFT_ALIGNMENT);

        JButton keepBtn   = stagnantButton("Keep it",    new Color(70, 70, 70),  Color.WHITE);
        JButton modifyBtn = stagnantButton("Modify",     new Color(230, 120, 0), Color.BLACK);
        JButton newItemBtn= stagnantButton("New item",   new Color(0, 160, 80),  Color.BLACK);

        // Keep: dismiss this banner until the next check cycle
        keepBtn.addActionListener(e -> {
            keptStagnantBuys.add(alert.itemId);
            showBestFlip();
        });

        // Modify: show an inline tip explaining how to raise the buy price in the GE
        modifyBtn.addActionListener(e -> {
            // Replace button row with a tip label
            btnRow.removeAll();
            JLabel tip = new JLabel(
                "<html><body><b style='color:#FF9800'>To modify:</b><br>"
                + "1. Open GE \u2192 click the buy offer<br>"
                + "2. Click the price and raise it by 1\u20135%<br>"
                + "3. Confirm to re-enter the queue at a higher priority</body></html>");
            tip.setForeground(Color.WHITE);
            tip.setFont(FontManager.getRunescapeSmallFont());
            btnRow.add(tip);
            btnRow.add(Box.createHorizontalStrut(4));
            JButton doneBtn = stagnantButton("Got it", new Color(70, 70, 70), Color.WHITE);
            doneBtn.addActionListener(ev -> {
                keptStagnantBuys.add(alert.itemId);
                showBestFlip();
            });
            btnRow.add(doneBtn);
            btnRow.revalidate();
            btnRow.repaint();
        });

        // New item: dismiss banner and call plugin callback to highlight the slot and guide cancel
        newItemBtn.addActionListener(e -> {
            keptStagnantBuys.add(alert.itemId);
            showBestFlip();
            if (onCancelNewOffer != null) onCancelNewOffer.accept(alert);
        });

        keepBtn.setMaximumSize(keepBtn.getPreferredSize());
        modifyBtn.setMaximumSize(modifyBtn.getPreferredSize());
        newItemBtn.setMaximumSize(newItemBtn.getPreferredSize());
        btnRow.add(keepBtn);
        btnRow.add(Box.createHorizontalStrut(4));
        btnRow.add(modifyBtn);
        btnRow.add(Box.createHorizontalStrut(4));
        btnRow.add(newItemBtn);
        btnRow.add(Box.createHorizontalGlue());
        banner.add(btnRow);
        return banner;
    }

    /** Small styled button used inside stagnant-buy banners. */
    private static JButton stagnantButton(String text, Color bg, Color fg) {
        JButton btn = new JButton(text);
        btn.setFont(FontManager.getRunescapeSmallFont());
        btn.setForeground(fg);
        btn.setBackground(bg);
        btn.setOpaque(true);
        btn.setBorderPainted(false);
        btn.setFocusPainted(false);
        btn.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        return btn;
    }

    /** Builds a yellow banner for a stagnant sell offer. */
    private JPanel buildStagnantSellBanner(StagnantSellAlert alert) {
        JPanel banner = new JPanel() {
            @Override public Dimension getMaximumSize()
            { return new Dimension(Integer.MAX_VALUE, getPreferredSize().height); }
        };
        banner.setLayout(new BoxLayout(banner, BoxLayout.Y_AXIS));
        Color YELLOW = new Color(210, 180, 0);
        banner.setBackground(new Color(35, 30, 5));
        banner.setBorder(BorderFactory.createCompoundBorder(
            new MatteBorder(1, 1, 1, 1, YELLOW),
            new EmptyBorder(7, 8, 7, 8)
        ));
        banner.setAlignmentX(Component.LEFT_ALIGNMENT);

        String bodyText;
        if (alert.canLower)
            bodyText = String.format(
                "<html><body><b style='color:#FFD700'>Sell stagnant (%d min):</b> %s<br>"
                + "Lower to <b>%,d gp</b>?</body></html>",
                alert.minutesOpen, alert.itemName, alert.suggestedPrice);
        else
            bodyText = String.format(
                "<html><body><b style='color:#FFD700'>Sell stagnant (%d min):</b> %s<br>"
                + "Keep at <b>%,d gp</b> (lowering risks a loss)</body></html>",
                alert.minutesOpen, alert.itemName, alert.currentPrice);

        JLabel lbl = new JLabel(bodyText);
        lbl.setForeground(Color.WHITE);
        lbl.setFont(FontManager.getRunescapeSmallFont());
        lbl.setAlignmentX(Component.LEFT_ALIGNMENT);
        banner.add(lbl);
        banner.add(Box.createVerticalStrut(6));

        JPanel btnRow = new JPanel();
        btnRow.setLayout(new BoxLayout(btnRow, BoxLayout.X_AXIS));
        btnRow.setOpaque(false);
        btnRow.setAlignmentX(Component.LEFT_ALIGNMENT);

        if (alert.canLower) {
            JButton lowerBtn = stagnantButton("Lower it", new Color(200, 160, 0), Color.BLACK);
            JButton keepBtn  = stagnantButton("Keep it",  new Color(70, 70, 70),  Color.WHITE);
            lowerBtn.setMaximumSize(lowerBtn.getPreferredSize());
            keepBtn.setMaximumSize(keepBtn.getPreferredSize());

            lowerBtn.addActionListener(e -> {
                dismissedSellAlerts.add(alert.itemId);
                showBestFlip();
                // Guidance: tell the assist panel to show the new sell target
                if (onModifySellOffer != null) onModifySellOffer.accept(alert);
            });
            keepBtn.addActionListener(e -> {
                dismissedSellAlerts.add(alert.itemId);
                showBestFlip();
            });

            btnRow.add(lowerBtn);
            btnRow.add(Box.createHorizontalStrut(4));
            btnRow.add(keepBtn);
        } else {
            JButton keepBtn = stagnantButton("Got it", new Color(70, 70, 70), Color.WHITE);
            keepBtn.setMaximumSize(keepBtn.getPreferredSize());
            keepBtn.addActionListener(e -> {
                dismissedSellAlerts.add(alert.itemId);
                showBestFlip();
            });
            btnRow.add(keepBtn);
        }

        btnRow.add(Box.createHorizontalGlue());
        banner.add(btnRow);
        return banner;
    }

    /** Builds an orange warning banner instructing the user to update a stale GE offer price. */
    private JPanel buildPriceAlertBanner(PriceAlert alert) {
        JPanel banner = new JPanel(new BorderLayout()) {
            @Override public Dimension getMaximumSize() {
                return new Dimension(Integer.MAX_VALUE, getPreferredSize().height);
            }
        };
        Color ORANGE = new Color(255, 152, 0);
        banner.setBackground(new Color(50, 35, 10));
        banner.setBorder(BorderFactory.createCompoundBorder(
            new MatteBorder(1, 1, 1, 1, ORANGE),
            new EmptyBorder(6, 8, 6, 8)
        ));
        banner.setAlignmentX(Component.LEFT_ALIGNMENT);

        String type = alert.isBuy ? "BUY" : "SELL";
        String verb = alert.isBuy ? "buying" : "selling";
        String text = String.format(
            "<html><body><b style='color:#FF9800'>Modify %s offer:</b> %s<br>"
            + "Currently %s at <b>%,d gp</b><br>"
            + "Recommended price: <b style='color:#00C853'>%,d gp</b></body></html>",
            type, alert.itemName, verb, alert.currentPrice, alert.recommendedPrice);

        JLabel lbl = new JLabel(text);
        lbl.setForeground(Color.WHITE);
        lbl.setFont(FontManager.getRunescapeSmallFont());
        banner.add(lbl, BorderLayout.CENTER);
        return banner;
    }

    /** Builds a teal banner showing an item the player already has in inventory and its sell price. */
    private JPanel buildInventorySuggestionBanner(InventorySellSuggestion s) {
        JPanel banner = new JPanel(new BorderLayout()) {
            @Override public Dimension getMaximumSize() {
                return new Dimension(Integer.MAX_VALUE, getPreferredSize().height);
            }
        };
        Color TEAL = new Color(0, 188, 212);
        banner.setBackground(new Color(5, 40, 50));
        banner.setBorder(BorderFactory.createCompoundBorder(
            new MatteBorder(1, 1, 1, 1, TEAL),
            new EmptyBorder(6, 8, 6, 8)
        ));
        banner.setAlignmentX(Component.LEFT_ALIGNMENT);

        String text = String.format(
            "<html><body><b style='color:#00BCD4'>Sell from inventory:</b> %s x%,d<br>"
            + "List at <b style='color:#00C853'>%,d gp</b> each</body></html>",
            s.itemName, s.qty, s.recommendedSellPrice);

        JLabel lbl = new JLabel(text);
        lbl.setForeground(Color.WHITE);
        lbl.setFont(FontManager.getRunescapeSmallFont());
        banner.add(lbl, BorderLayout.CENTER);
        return banner;
    }

    private void showBestFlip() {
        GEPricerItem previousItem = currentItem;

        List<GEPricerItem> candidates = getCandidates();

        // If every item has been skipped, silently reset the skip set and retry
        if (candidates.isEmpty() && !skipSet.isEmpty()) {
            skipSet.clear();
            candidates = getCandidates();
        }

        contentArea.removeAll();

        // ---- Inventory sell suggestions (teal banners) ----
        for (InventorySellSuggestion s : inventorySuggestions) {
            contentArea.add(buildInventorySuggestionBanner(s));
            contentArea.add(Box.createVerticalStrut(4));
        }

        // ---- Stagnant buy-offer banners ----
        for (StagnantBuyAlert alert : stagnantBuyAlerts) {
            if (!keptStagnantBuys.contains(alert.itemId)) {
                contentArea.add(buildStagnantBuyBanner(alert));
                contentArea.add(Box.createVerticalStrut(4));
            }
        }

        // ---- Stagnant sell-offer banners ----
        for (StagnantSellAlert alert : stagnantSellAlerts) {
            if (!dismissedSellAlerts.contains(alert.itemId)) {
                contentArea.add(buildStagnantSellBanner(alert));
                contentArea.add(Box.createVerticalStrut(4));
            }
        }

        // ---- Active-offer price-change banners (orange banners) ----
        for (PriceAlert alert : priceAlerts) {
            contentArea.add(buildPriceAlertBanner(alert));
            contentArea.add(Box.createVerticalStrut(4));
        }

        if (candidates.isEmpty()) {
            currentItem = null;
            JLabel lbl = new JLabel(
                "<html><center>No items with \u2265150 daily volume<br>and a positive margin found.</center></html>");
            lbl.setForeground(TEXT_MUTED);
            lbl.setFont(FontManager.getRunescapeSmallFont());
            lbl.setAlignmentX(Component.CENTER_ALIGNMENT);
            lbl.setBorder(new EmptyBorder(20, 0, 0, 0));
            contentArea.add(lbl);
        } else {
            currentItem = candidates.get(0);
            contentArea.add(buildItemCard(currentItem));
            contentArea.add(Box.createVerticalStrut(8));
            contentArea.add(buildActionBar());
            contentArea.add(Box.createVerticalStrut(14));
            contentArea.add(buildBlockListSection(blockListOpen));
        }

        contentArea.revalidate();
        contentArea.repaint();

        // Notify the assist panel whenever the displayed item changes so it stays in sync.
        if (currentItem != previousItem && onItemChanged != null) { onItemChanged.run(); }
    }

    // Item card

    private JPanel buildItemCard(GEPricerItem item) {
        // Override getMaximumSize so BoxLayout Y_AXIS uses preferred height
        // instead of stretching the card to fill all available space.
        JPanel card = new JPanel(new BorderLayout(0, 8)) {
            @Override public Dimension getMaximumSize() {
                return new Dimension(Integer.MAX_VALUE, getPreferredSize().height);
            }
        };
        card.setBackground(BG_CARD);
        String trendSig = item.getServerSignal();
        Color cardBorderColor = BORDER_COLOR;
        if (trendSig != null && !trendSig.isBlank()) {
            if      (trendSig.equals("RISING"))      cardBorderColor = new Color(0, 160, 60);
            else if (trendSig.equals("STABLE_UP"))   cardBorderColor = new Color(0, 100, 40);
            else if (trendSig.equals("STABLE_DOWN")) cardBorderColor = new Color(180, 100, 0);
            else if (trendSig.equals("FALLING"))     cardBorderColor = new Color(180, 40, 40);
        }
        card.setBorder(BorderFactory.createCompoundBorder(
            new MatteBorder(1, 1, 1, 1, cardBorderColor),
            new EmptyBorder(10, 10, 10, 12)
        ));
        card.setAlignmentX(Component.LEFT_ALIGNMENT);

        // ---- Header: icon (WEST) + name (CENTER, wraps) ----
        JLabel iconLabel = new JLabel();
        iconLabel.setPreferredSize(new Dimension(36, 32));
        iconLabel.setVerticalAlignment(SwingConstants.TOP);
        if (itemManager != null) {
            try {
                AsyncBufferedImage img = itemManager.getImage(item.getId());
                iconLabel.setIcon(new ImageIcon(img));
                img.onLoaded(() -> SwingUtilities.invokeLater(() -> {
                    iconLabel.setIcon(new ImageIcon(img));
                    iconLabel.repaint();
                }));
            } catch (Exception ignored) {}
        }

        // Wrap long names at word boundaries. Using an HTML pixel width forces Swing to
        // word-wrap rather than extending the card beyond the panel edge.
        String displayName = "<html><body style='width:110px'>" + item.getName() + "</body></html>";
        JLabel nameLabel = new JLabel(displayName);
        nameLabel.setForeground(TEXT_WHITE);
        nameLabel.setFont(FontManager.getRunescapeFont());
        nameLabel.setVerticalAlignment(SwingConstants.CENTER);

        JLabel stalenessLabel = new JLabel(item.getLastUpdatedText());
        stalenessLabel.setForeground(TEXT_MUTED);
        stalenessLabel.setFont(FontManager.getRunescapeSmallFont());

        JPanel namePanel = new JPanel();
        namePanel.setLayout(new BoxLayout(namePanel, BoxLayout.Y_AXIS));
        namePanel.setBackground(BG_CARD);
        namePanel.add(nameLabel);
        namePanel.add(stalenessLabel);

        JPanel header = new JPanel(new BorderLayout(6, 0));
        header.setBackground(BG_CARD);
        header.setBorder(BorderFactory.createEmptyBorder(0, 0, 8, 0));
        header.add(iconLabel, BorderLayout.WEST);
        header.add(namePanel, BorderLayout.CENTER);
        card.add(header, BorderLayout.NORTH);

        // ---- Stats: 2-column GridBagLayout so values never overflow ----
        JPanel stats = new JPanel(new GridBagLayout());
        stats.setBackground(BG_CARD);

        // remove stale roiPct / limitProfit locals â€” now computed inside buildItemCard with overcut
        int r = 0;
        boolean hasSell   = item.getInstaSell() > 0;
        boolean hasBuy    = item.getInstaBuy()  > 0;
        long adjBuy    = hasSell ? item.getInstaSell() + overcutGp : 0;
        long adjSell   = hasBuy  ? Math.max(1, item.getInstaBuy() - sellUndercutGp) : 0;
        long adjTax    = Math.min((long) Math.floor(adjSell * 0.02), 5_000_000L);
        long adjMargin = (hasSell && hasBuy) ? adjSell - adjBuy - adjTax : 0;
        double roiPctAdj = adjBuy > 0 ? (adjMargin * 100.0) / adjBuy : 0.0;
        Color  roiColor   = roiPctAdj >= 5.0 ? COLOR_PROFIT : roiPctAdj >= 2.0 ? COLOR_GOLD : TEXT_MUTED;
        long   limitProfit = item.getBuyLimit() > 0 && adjMargin > 0
            ? adjMargin * item.getBuyLimit() : -1;

        addStatRow(stats, r++, "Margin",      (hasSell && hasBuy) ? NF.format(adjMargin) + " gp" : "N/A",
            (hasSell && hasBuy) ? (adjMargin > 0 ? COLOR_PROFIT : COLOR_LOSS) : TEXT_MUTED);
        addStatRow(stats, r++, "ROI",          (hasSell && hasBuy) ? String.format("%.2f%%", roiPctAdj) : "N/A", roiColor);
        // Predicted GP/hour: shown when 1h data is available â€” the key sorting signal
        long predGphr = item.getPredictedGPHour();
        if (predGphr > 0)
            addStatRow(stats, r++, "GP/hr",      formatGpCompact(predGphr) + " gp",  COLOR_PROFIT);
        // Server trend signal: shown when prediction server data is available
        String sig = item.getServerSignal();
        if (sig != null && !sig.isBlank()) {
            String arrow = "\u2192"; // â†’
            Color trendColor = TEXT_MUTED;
            double tp = item.getTrendPct();
            if      (tp >  5) { arrow = "\u2191"; trendColor = COLOR_PROFIT; }           // â†‘
            else if (tp >  1) { arrow = "\u2197"; trendColor = new Color(100, 220, 100); } // â†—
            else if (tp < -5) { arrow = "\u2193"; trendColor = COLOR_LOSS; }              // â†“
            else if (tp < -1) { arrow = "\u2198"; trendColor = new Color(255, 150, 50); } // â†˜
            addStatRow(stats, r++, "Trend",    arrow + " " + String.format("%+.1f%%", tp), trendColor);
        }
        // 1h average margin â€” more reliable than spot, shown when 1h data available
        long pred1hMargin = item.getPredictedMargin1h();
        boolean has1hData = item.getAvgHighPrice1h() > 0 && item.getAvgLowPrice1h() > 0;
        addStatRow(stats, r++, "1h Avg",
            has1hData ? NF.format(pred1hMargin) + " gp" : "\u2014",
            has1hData ? (pred1hMargin > 0 ? COLOR_PROFIT : COLOR_LOSS) : TEXT_MUTED);
        addStatRow(stats, r++, "Buy @",  hasSell ? NF.format(adjBuy)  + " gp" : "N/A", TEXT_WHITE);
        addStatRow(stats, r++, "Sell @", hasBuy  ? NF.format(adjSell) + " gp" : "N/A", TEXT_WHITE);
        addStatRow(stats, r++, "Volume",       NF.format(item.getVolume()) + "/day",   TEXT_MUTED);
        addStatRow(stats, r++, "Buy Limit",
            item.getBuyLimit() > 0 ? NF.format(item.getBuyLimit()) : "\u2014",      TEXT_MUTED);
        if (limitProfit >= 0)
            addStatRow(stats, r++, "Max Profit",  NF.format(limitProfit) + " gp",   COLOR_PROFIT);

        // ---- Estimated sell time ----
        // Approximation: if the daily volume is spread evenly, how long to sell one full limit?
        if (item.getVolume() > 0 && item.getBuyLimit() > 0) {
            double itemsPerHour   = item.getVolume() / 24.0;
            double fillMinutes    = (item.getBuyLimit() / itemsPerHour) * 60.0;
            String fillText;
            Color  fillColor;
            if (fillMinutes < 30) {
                fillText  = String.format("~%d min", Math.max(1, (int) fillMinutes));
                fillColor = COLOR_PROFIT;
            } else if (fillMinutes < 90) {
                fillText  = String.format("~%d min", (int) fillMinutes);
                fillColor = COLOR_GOLD;
            } else {
                int hrs  = (int) (fillMinutes / 60);
                int mins = (int) (fillMinutes % 60);
                fillText  = hrs > 0 ? String.format("~%dh %dm", hrs, mins) : String.format("~%d min", (int) fillMinutes);
                fillColor = COLOR_LOSS;
            }
            addStatRow(stats, r, "Est. sell", fillText, fillColor);
        }

        card.add(stats, BorderLayout.CENTER);

        // ---- View graph link ----
        JLabel graphLink = new JLabel("<html><u>View graph on therealge.com \u2197</u></html>");
        graphLink.setForeground(new Color(100, 180, 255));
        graphLink.setFont(FontManager.getRunescapeSmallFont());
        graphLink.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        graphLink.setBorder(BorderFactory.createEmptyBorder(8, 0, 4, 0));
        graphLink.addMouseListener(new MouseAdapter() {
            @Override
            public void mousePressed(MouseEvent e) {
                try {
                    String slug = item.getName().toLowerCase(java.util.Locale.ROOT)
                        .replaceAll("[^a-z0-9 ]", " ").trim().replaceAll("\\s+", "-");
                    java.awt.Desktop.getDesktop().browse(new java.net.URI("https://therealge.com/" + slug + ".html"));
                } catch (Exception ignored) {}
            }
        });
        card.add(graphLink, BorderLayout.SOUTH);

        return card;
    }

    private static String formatGpCompact(long gp) {
        if (gp >= 1_000_000_000) return String.format("%.1fB", gp / 1_000_000_000.0);
        if (gp >= 1_000_000)     return String.format("%.1fM", gp / 1_000_000.0);
        if (gp >= 1_000)         return String.format("%.0fK", gp / 1_000.0);
        return String.valueOf(gp);
    }

    private void addStatRow(JPanel parent, int row,
                            String labelText, String valueText, Color valueColor) {
        GridBagConstraints c = new GridBagConstraints();
        c.gridy  = row;
        c.insets = new Insets(3, 0, 3, 4);

        c.gridx   = 0;
        c.anchor  = GridBagConstraints.WEST;
        c.weightx = 0;
        c.fill    = GridBagConstraints.NONE;
        JLabel lbl = new JLabel(labelText);
        lbl.setForeground(TEXT_MUTED);
        lbl.setFont(FontManager.getRunescapeSmallFont());
        parent.add(lbl, c);

        c.gridx   = 1;
        c.anchor  = GridBagConstraints.EAST;
        c.weightx = 1.0;
        c.fill    = GridBagConstraints.HORIZONTAL;
        c.insets  = new Insets(3, 8, 3, 0);
        JLabel val = new JLabel(valueText);
        val.setForeground(valueColor);
        val.setFont(FontManager.getRunescapeFont());
        val.setHorizontalAlignment(SwingConstants.RIGHT);
        parent.add(val, c);
    }

    // Action bar  (View | Next | Block)

    private JPanel buildActionBar() {
        JPanel bar = new JPanel(new GridLayout(1, 3, 4, 0));
        bar.setBackground(BG);
        bar.setMaximumSize(new Dimension(Integer.MAX_VALUE, 28));
        bar.setAlignmentX(Component.LEFT_ALIGNMENT);

        JButton viewBtn  = makeActionBtn("View",  new Color(40, 80, 40));
        JButton nextBtn  = makeActionBtn("Next",  new Color(40, 50, 80));
        JButton blockBtn = makeActionBtn("Block", new Color(80, 35, 35));

        viewBtn.addActionListener(e -> {
            if (currentItem != null) {
                if (onSearch         != null) onSearch.accept(currentItem.getName());
                if (onSwitchToPrices != null) onSwitchToPrices.run();
            }
        });

        nextBtn.addActionListener(e -> {
            if (currentItem != null) {
                skipSet.add(currentItem.getId());
                showBestFlip();
                if (onItemChanged != null) onItemChanged.run();
            }
        });

        blockBtn.addActionListener(e -> {
            if (currentItem != null) {
                blockSet.add(currentItem.getId());
                saveBlockList();
                showBestFlip();
                if (onItemChanged != null) onItemChanged.run();
            }
        });

        bar.add(viewBtn);
        bar.add(nextBtn);
        bar.add(blockBtn);
        return bar;
    }

    private JButton makeActionBtn(String text, Color bg) {
        JButton btn = new JButton(text);
        btn.setFont(FontManager.getRunescapeSmallFont());
        btn.setForeground(TEXT_WHITE);
        btn.setBackground(bg);
        btn.setBorderPainted(false);
        btn.setFocusPainted(false);
        btn.setOpaque(true);
        btn.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        return btn;
    }

    /** Small +/- stepper button used next to the Overcut and Undercut fields. */
    private static JButton buildStepButton(String text) {
        JButton btn = new JButton(text);
        btn.setFont(FontManager.getRunescapeSmallFont());
        btn.setForeground(Color.WHITE);
        btn.setBackground(new Color(60, 60, 60));
        btn.setBorderPainted(false);
        btn.setFocusPainted(false);
        btn.setPreferredSize(new Dimension(16, 14));
        btn.setMinimumSize(new Dimension(16, 14));
        btn.setMaximumSize(new Dimension(16, 14));
        btn.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        return btn;
    }

    /** Small reset (×) button that zeros the adjacent overcut/undercut field. */
    private static JButton buildResetButton() {
        JButton btn = new JButton("\u00d7");
        btn.setFont(FontManager.getRunescapeSmallFont());
        btn.setForeground(new Color(180, 80, 80));
        btn.setBackground(new Color(55, 55, 55));
        btn.setBorderPainted(false);
        btn.setFocusPainted(false);
        btn.setPreferredSize(new Dimension(14, 14));
        btn.setMinimumSize(new Dimension(14, 14));
        btn.setMaximumSize(new Dimension(14, 14));
        btn.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        btn.setToolTipText("Reset to 0");
        return btn;
    }

    // Block list section (collapsible)

    private JPanel buildBlockListSection(boolean startOpen) {
        JPanel section = new JPanel();
        section.setLayout(new BoxLayout(section, BoxLayout.Y_AXIS));
        section.setBackground(BG);
        section.setAlignmentX(Component.LEFT_ALIGNMENT);
        section.setMaximumSize(new Dimension(Integer.MAX_VALUE, Integer.MAX_VALUE));

        JLabel header = new JLabel("Blocked items (" + blockSet.size() + ")  " + (startOpen ? "\u25b4" : "\u25be"));
        header.setForeground(TEXT_MUTED);
        header.setFont(FontManager.getRunescapeSmallFont());
        header.setAlignmentX(Component.LEFT_ALIGNMENT);
        header.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));

        JPanel blockItems = new JPanel();
        blockItems.setLayout(new BoxLayout(blockItems, BoxLayout.Y_AXIS));
        blockItems.setBackground(BG);
        blockItems.setAlignmentX(Component.LEFT_ALIGNMENT);
        blockItems.setVisible(startOpen);
        if (startOpen) rebuildBlockItems(blockItems, header);

        header.addMouseListener(new MouseAdapter() {
            @Override
            public void mousePressed(MouseEvent e) {
                blockListOpen = !blockItems.isVisible();
                blockItems.setVisible(blockListOpen);
                header.setText("Blocked items (" + blockSet.size() + ")  " + (blockListOpen ? "\u25b4" : "\u25be"));
                if (blockListOpen) rebuildBlockItems(blockItems, header);
                contentArea.revalidate();
                contentArea.repaint();
            }
        });

        section.add(header);
        section.add(blockItems);
        return section;
    }

    private void rebuildBlockItems(JPanel container, JLabel headerLabel) {
        container.removeAll();

        if (blockSet.isEmpty()) {
            JLabel empty = new JLabel("No items blocked.");
            empty.setForeground(TEXT_MUTED);
            empty.setFont(FontManager.getRunescapeSmallFont());
            empty.setAlignmentX(Component.LEFT_ALIGNMENT);
            container.add(empty);
        } else {
            for (int itemId : new ArrayList<>(blockSet)) {
                GEPricerItem item = allItems.stream()
                    .filter(i -> i.getId() == itemId)
                    .findFirst().orElse(null);
                String name = item != null ? item.getName() : "Item #" + itemId;

                JPanel row = new JPanel(new BorderLayout(4, 0));
                row.setBackground(new Color(35, 35, 35));
                row.setBorder(new EmptyBorder(3, 6, 3, 6));
                row.setMaximumSize(new Dimension(Integer.MAX_VALUE, 26));
                row.setAlignmentX(Component.LEFT_ALIGNMENT);

                JLabel nameLbl = new JLabel(name);
                nameLbl.setForeground(TEXT_MUTED);
                nameLbl.setFont(FontManager.getRunescapeSmallFont());

                JButton removeBtn = new JButton("\u2715");
                removeBtn.setFont(FontManager.getRunescapeSmallFont());
                removeBtn.setForeground(COLOR_LOSS);
                removeBtn.setBackground(new Color(35, 35, 35));
                removeBtn.setBorderPainted(false);
                removeBtn.setFocusPainted(false);
                removeBtn.setMargin(new Insets(0, 4, 0, 0));
                removeBtn.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));

                final int fId = itemId;
                removeBtn.addActionListener(ev -> {
                    blockSet.remove(fId);
                    saveBlockList();
                    headerLabel.setText("Blocked items (" + blockSet.size() + ")  \u25b4");
                    rebuildBlockItems(container, headerLabel);
                    // Refresh the item card only (re-evaluate candidates without rebuilding
                    // the whole panel, so the block list stays open)
                    refreshItemCardOnly();
                });

                row.add(nameLbl,   BorderLayout.CENTER);
                row.add(removeBtn, BorderLayout.EAST);
                container.add(row);
                container.add(Box.createVerticalStrut(2));
            }
        }

        container.revalidate();
        container.repaint();
    }

    // Persistence

    private void loadBlockList() {
        String raw = configManager.getConfiguration("gepricer", "flipBlocklist");
        if (raw == null || raw.isBlank()) return;
        for (String part : raw.split(",")) {
            try { blockSet.add(Integer.parseInt(part.trim())); } catch (NumberFormatException ignored) {}
        }
    }

    private void saveBlockList() {
        String s = blockSet.stream()
            .map(String::valueOf)
            .collect(Collectors.joining(","));
        configManager.setConfiguration("gepricer", "flipBlocklist", s);
    }

    private void loadMinVolume()    { minVolume      = loadCfgLong("flipMinVolume",    150); }
    private void loadOvercut()      { overcutGp      = loadCfgLong("flipOvercut",        0); }
    private void loadSellUndercut() { sellUndercutGp = loadCfgLong("flipSellUndercut",   0); }
    private void saveMinVolume()    { saveCfgLong("flipMinVolume",    minVolume); }
    private void saveOvercut()      { saveCfgLong("flipOvercut",      overcutGp); }
    private void saveSellUndercut() { saveCfgLong("flipSellUndercut", sellUndercutGp); }

    private long loadCfgLong(String key, long defaultVal) {
        String raw = configManager.getConfiguration("gepricer", key);
        if (raw == null || raw.isBlank()) return defaultVal;
        try { return Math.max(0, Long.parseLong(raw.trim())); } catch (NumberFormatException ignored) { return defaultVal; }
    }

    private void saveCfgLong(String key, long value) {
        configManager.setConfiguration("gepricer", key, String.valueOf(value));
    }

    // Scrollable content panel

    private static class ScrollablePanel extends JPanel implements javax.swing.Scrollable {
        @Override public Dimension getPreferredScrollableViewportSize() { return getPreferredSize(); }
        @Override public int getScrollableUnitIncrement(Rectangle vr, int o, int d) { return 20; }
        @Override public int getScrollableBlockIncrement(Rectangle vr, int o, int d) { return 60; }
        @Override public boolean getScrollableTracksViewportWidth()  { return true; }
        @Override public boolean getScrollableTracksViewportHeight() { return false; }
    }

    private JTextField buildGpTextField(long initialValue,
                                         java.util.function.LongSupplier getter,
                                         java.util.function.LongConsumer setter,
                                         Runnable saver) {
        JTextField tf = new JTextField(String.valueOf(initialValue), 7);
        tf.setFont(FontManager.getRunescapeSmallFont());
        tf.setForeground(Color.WHITE);
        tf.setBackground(new Color(50, 50, 50));
        tf.setCaretColor(Color.WHITE);
        tf.setBorder(BorderFactory.createCompoundBorder(
            BorderFactory.createLineBorder(new Color(80, 80, 80)),
            BorderFactory.createEmptyBorder(1, 4, 1, 4)));
        tf.setMaximumSize(new Dimension(70, 18));
        Runnable apply = () -> {
            try {
                long val = Math.max(0, Long.parseLong(tf.getText().trim().replaceAll(",", "")));
                setter.accept(val);
                tf.setText(String.valueOf(getter.getAsLong()));
                saver.run();
                showBestFlip();
            } catch (NumberFormatException ignored) {
                tf.setText(String.valueOf(getter.getAsLong()));
            }
        };
        tf.addActionListener(e -> apply.run());
        tf.addFocusListener(new java.awt.event.FocusAdapter() {
            @Override public void focusLost(java.awt.event.FocusEvent e) { apply.run(); }
        });
        return tf;
    }

    // Formatting helpers

    private static String formatGp(long amount) {
        if (amount >= 1_000_000_000)
            return String.format("%.2fB gp", amount / 1_000_000_000.0);
        if (amount >= 1_000_000)
            return String.format("%.2fM gp", amount / 1_000_000.0);
        if (amount >= 1_000)
            return String.format("%.1fK gp", amount / 1_000.0);
        return NF.format(amount) + " gp";
    }
}
