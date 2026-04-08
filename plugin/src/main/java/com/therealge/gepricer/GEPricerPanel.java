package com.therealge.gepricer;

import net.runelite.client.config.ConfigManager;
import net.runelite.client.game.ItemManager;
import net.runelite.client.ui.ColorScheme;
import net.runelite.client.ui.FontManager;
import net.runelite.client.ui.PluginPanel;
import okhttp3.OkHttpClient;

import javax.swing.*;
import javax.swing.border.EmptyBorder;
import javax.swing.border.MatteBorder;
import java.awt.*;
import java.awt.event.*;
import java.text.NumberFormat;
import java.util.*;
import java.util.List;
import java.util.stream.Collectors;

/**
 * Main sidebar panel for the GE Price Tracker plugin.
 *
 * Layout (top â†’ bottom):
 *   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
 *   â”‚  GE Price Tracker         [↻] â”‚  â† header
 *   â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
 *   â”‚  [ðŸ” Search …           ] [★] â”‚  â† search bar + favorites toggle
 *   â”‚  Sort: [Margin ↓         ▼]   â”‚  â† sort selector
 *   â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
 *   â”‚  ▲ Buy    ▼ Sell    Δ Margin  â”‚  â† column headings
 *   â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
 *   â”‚  <scrollable item list>       â”‚
 *   â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
 *   â”‚  4,312 items Â· updated 3m ago â”‚  â† status bar
 *   â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
 */
public class GEPricerPanel extends PluginPanel {
    // UI palette
    private static final Color BG          = ColorScheme.DARK_GRAY_COLOR;
    private static final Color BG_HEADER   = ColorScheme.DARKER_GRAY_COLOR;
    private static final Color BG_SEARCH   = new Color(40, 40, 40);
    private static final Color TEXT_WHITE  = Color.WHITE;
    private static final Color TEXT_MUTED  = new Color(160, 160, 160);
    private static final Color COLOR_STAR_ON  = new Color(255, 200, 0);
    private static final Color COLOR_STAR_OFF = new Color(100, 100, 100);

    private static final int MAX_UNFILTERED_ROWS = 10; // Maximum item rows to render on the default (no-search) landing view.
    private static final long MIN_DEFAULT_VOLUME = 150; // Minimum daily volume required to appear on the default landing view.

    private static final NumberFormat NF = NumberFormat.getNumberInstance(Locale.US);

    // Injected references
    private final GEPricerPlugin   plugin;
    private final GEPricerConfig   config;
    private final ConfigManager    configManager;
    private final ItemManager      itemManager;
    private final OkHttpClient     httpClient;
    private final GETradeSession   session;

    // Favorites (persisted via ConfigManager)
    private final Set<Integer> favorites = new HashSet<>();

    // UI components
    private final JTextField          searchField;
    private final JToggleButton       favButton;
    private final JComboBox<GEPricerConfig.SortType> sortBox;
    private final JPanel              itemListPanel;
    private final JScrollPane         scrollPane;
    private final JLabel              statusLabel;
    // Stats tab
    private       GEStatsPanel        statsPanel;
    // Flip Pick tab
    private       GEFlipPickPanel     flipPickPanel;
    // Guided flip assist panel (always visible, above tabs)
    private       GEFlipAssistPanel   flipAssistPanel;
    private       JPanel              cardPanel;
    private       JButton             pricesTabBtn;
    private       JButton             flipPickTabBtn;
    private       JButton             statsTabBtn;

    // State
    private List<GEPricerItem>                   allItems     = new ArrayList<>();
    /** Keeps one GEPricerItemPanel per item ID so we can refresh in-place. */
    private final Map<Integer, GEPricerItemPanel> rowCache     = new HashMap<>();
    private boolean                              favOnly      = false;
    private long                                 lastRefresh  = 0;
    /** Debounce timer so search only rebuilds 150 ms after the user stops typing. */
    private final javax.swing.Timer              searchDebounce;
    private final javax.swing.Timer              tickTimer; // 1-second tick timer that keeps the "updated Xs ago" label live.

    public GEPricerPanel(GEPricerPlugin plugin,
                         GEPricerConfig config,
                         ConfigManager configManager,
                         ItemManager itemManager,
                         OkHttpClient httpClient,
                         GETradeSession session) {
        // false = we manage our own scroll pane
        super(false);
        this.plugin        = plugin;
        this.config        = config;
        this.configManager = configManager;
        this.itemManager   = itemManager;
        this.httpClient    = httpClient;
        this.session       = session;

        // Fire 150 ms after the last keystroke; setRepeats(false) so it only fires once.
        searchDebounce = new javax.swing.Timer(150, e -> rebuildList());
        searchDebounce.setRepeats(false);

        // Tick every second to keep the status bar time fresh.
        tickTimer = new javax.swing.Timer(1000, e -> tickStatusBar());
        tickTimer.setRepeats(true);
        tickTimer.start();

        loadFavorites();

        setBackground(BG);
        setLayout(new BorderLayout(0, 0));

        // ---- Header bar ----
        JPanel header = buildHeader();

        // ---- Tab bar (Prices | Stats) ----
        JPanel tabBar = buildTabBar();

        // ---- Search + sort bar ----
        searchField = buildSearchField();
        favButton   = buildFavButton();
        sortBox     = buildSortBox();
        JPanel controls = buildControlsBar(searchField, favButton, sortBox);

        // ---- Column headings ----
        JPanel columnHeadings = buildColumnHeadings();

        // ---- Scrollable item list ----
        itemListPanel = new JPanel();
        itemListPanel.setLayout(new BoxLayout(itemListPanel, BoxLayout.Y_AXIS));
        itemListPanel.setBackground(ColorScheme.DARK_GRAY_COLOR);

        scrollPane = new JScrollPane(itemListPanel);
        scrollPane.setBorder(null);
        scrollPane.setHorizontalScrollBarPolicy(ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER);
        scrollPane.getVerticalScrollBar().setUnitIncrement(16);
        scrollPane.setBackground(BG);

        // ---- Status bar ----
        statusLabel = new JLabel("Loading…");
        statusLabel.setForeground(TEXT_MUTED);
        statusLabel.setFont(FontManager.getRunescapeSmallFont());
        statusLabel.setBorder(new EmptyBorder(4, 8, 4, 8));
        statusLabel.setHorizontalAlignment(SwingConstants.CENTER);

        // ---- Prices card: controls + item list + status ----
        JPanel controlStack = new JPanel();
        controlStack.setLayout(new BoxLayout(controlStack, BoxLayout.Y_AXIS));
        controlStack.setBackground(BG);
        controlStack.add(controls);
        controlStack.add(columnHeadings);

        JPanel pricesCard = new JPanel(new BorderLayout(0, 0));
        pricesCard.setBackground(BG);
        pricesCard.add(controlStack, BorderLayout.NORTH);
        pricesCard.add(scrollPane,   BorderLayout.CENTER);
        pricesCard.add(statusLabel,  BorderLayout.SOUTH);

        // ---- Stats card ----
        statsPanel = new GEStatsPanel(session, configManager);
        statsPanel.setOnReset(() -> plugin.clearSavedSession());

        // ---- Flip Pick card ----
        flipPickPanel = new GEFlipPickPanel(
            itemManager,
            configManager,
            httpClient,
            () -> switchToTab("PRICES"),
            name -> {
                searchField.setText(name);
                searchField.setForeground(TEXT_WHITE);
                searchDebounce.restart();
            }
        );
        flipPickPanel.setOnItemChanged(() -> plugin.onFlipPickItemChanged());

        // ---- Card switcher ----
        cardPanel = new JPanel(new CardLayout());
        cardPanel.add(pricesCard,    "PRICES");
        cardPanel.add(flipPickPanel, "FLIP_PICK");
        cardPanel.add(statsPanel,    "STATS");

        // ---- Guided flip assist panel (always visible) ----
        flipAssistPanel = new GEFlipAssistPanel(itemManager);

        // ---- Fixed north: header + flip assist + tab bar ----
        JPanel fixedNorth = new JPanel();
        fixedNorth.setLayout(new BoxLayout(fixedNorth, BoxLayout.Y_AXIS));
        fixedNorth.setBackground(BG);
        fixedNorth.add(header);
        fixedNorth.add(flipAssistPanel);
        fixedNorth.add(tabBar);

        add(fixedNorth, BorderLayout.NORTH);
        add(cardPanel,  BorderLayout.CENTER);
    }

    // Called by plugin on background thread result (already on EDT)

    public void updateItems(List<GEPricerItem> items) {
        this.allItems   = items;
        this.lastRefresh = System.currentTimeMillis();
        rebuildList();
        updateStatusBar();
        if (flipPickPanel != null)
            flipPickPanel.updateItems(items);
        if (statsPanel != null)
            statsPanel.updatePriceData(items);
    }

    public void setStatus(String msg) {
        statusLabel.setText(msg);
    }

    public void showError(String msg) {
        statusLabel.setForeground(new Color(255, 80, 80));
        statusLabel.setText("Error: " + msg);
    }

    // List rendering

    private void rebuildList() {
        String raw     = searchField.getText().trim();
        boolean noQuery = raw.isEmpty() || raw.equals("Search items\u2026");
        String query   = noQuery ? "" : raw.toLowerCase();
        GEPricerConfig.SortType sort = (GEPricerConfig.SortType) sortBox.getSelectedItem();

        // 1. Filter
        boolean volumesLoaded = allItems.stream().anyMatch(i -> i.getVolume() > 0);
        List<GEPricerItem> visible = allItems.stream()
            .filter(i -> !favOnly || favorites.contains(i.getId()))
            .filter(i -> !config.hideNoPrices() || i.hasPrices())
            .filter(i -> noQuery || i.getName().toLowerCase().contains(query))
            .filter(i -> !noQuery || favOnly || !volumesLoaded || i.getVolume() >= MIN_DEFAULT_VOLUME)
            .collect(Collectors.toList());

        // 2. Sort
        if (sort != null) switch (sort) {
            case MARGIN_DESC:    visible.sort(Comparator.comparingLong(GEPricerItem::getMargin).reversed());    break;
            case INSTABUY_DESC:  visible.sort(Comparator.comparingLong(GEPricerItem::getInstaBuy).reversed());  break;
            case INSTASELL_DESC: visible.sort(Comparator.comparingLong(GEPricerItem::getInstaSell).reversed()); break;
            case VOLUME_DESC:    visible.sort(Comparator.comparingLong(GEPricerItem::getVolume).reversed());    break;
            case NAME_ASC:       visible.sort(Comparator.comparing(i -> i.getName().toLowerCase()));            break;
        }

        // 3. Cap default view to top 10
        if (noQuery && !favOnly && visible.size() > MAX_UNFILTERED_ROWS) { visible = visible.subList(0, MAX_UNFILTERED_ROWS); }

        // 4. Build / reuse panels
        itemListPanel.removeAll();

        for (GEPricerItem item : visible) {
            GEPricerItemPanel row = rowCache.computeIfAbsent(item.getId(),
                id -> new GEPricerItemPanel(item, favorites.contains(id),
                    this::handleFavToggle, itemManager));
            row.refresh();
            itemListPanel.add(row);
        }

        itemListPanel.revalidate();
        itemListPanel.repaint();
    }

    private JLabel buildMoreLabel(int hidden) {
        JLabel lbl = new JLabel(hidden + " more items - use search to narrow results");
        lbl.setForeground(TEXT_MUTED);
        lbl.setFont(FontManager.getRunescapeSmallFont());
        lbl.setBorder(new EmptyBorder(6, 8, 6, 8));
        lbl.setHorizontalAlignment(SwingConstants.CENTER);
        return lbl;
    }

    // Favorites

    private void handleFavToggle(GEPricerItem item) {
        if (favorites.contains(item.getId()))
            favorites.remove(item.getId());
        else
            favorites.add(item.getId());

        saveFavorites();

        GEPricerItemPanel row = rowCache.get(item.getId());
        if (row != null) row.setFavorite(favorites.contains(item.getId()));

        if (favOnly) rebuildList(); // remove from list if we're in fav-only mode
    }

    private void loadFavorites() {
        String raw = configManager.getConfiguration("gepricer", "favorites");
        if (raw == null || raw.isBlank()) return;
        for (String part : raw.split(",")) {
            try { favorites.add(Integer.parseInt(part.trim())); } catch (NumberFormatException ignored) {}
        }
    }

    private void saveFavorites() {
        String serialized = favorites.stream()
            .map(String::valueOf)
            .collect(Collectors.joining(","));
        configManager.setConfiguration("gepricer", "favorites", serialized);
    }

    // Status bar

    private void updateStatusBar() {
        long withPrices = allItems.stream().filter(GEPricerItem::hasPrices).count();
        itemCount = withPrices;
        tickStatusBar();
    }

    private long itemCount = 0;

    private void tickStatusBar() {
        if (lastRefresh == 0) return;
        long elapsed = (System.currentTimeMillis() - lastRefresh) / 1000L;
        String ago;
        if (elapsed < 5)        ago = "just now";
        else if (elapsed < 60)  ago = elapsed + "s ago";
        else                    ago = (elapsed / 60) + "m ago";
        statusLabel.setForeground(TEXT_MUTED);
        statusLabel.setText(NF.format(itemCount) + " items \u00b7 updated " + ago);
    }

    // Stats integration

    /** Called (on EDT) whenever a GE offer completes so the stats tab updates. */
    public void refreshStats() {
        if (statsPanel != null)
            statsPanel.refresh();
    }

    /**
     * Update the guided flip assist panel with the current workflow step.
     * This is called from the plugin on the EDT.
     */
    public void updateFlipAssist(int step, GEPricerItem pick,
                                  String boughtItemName, int boughtItemId,
                                  int boughtQty, int totalQty, long sellPrice,
                                  long overcutGp, long sellUndercutGp) {
        if (flipAssistPanel != null) {
            flipAssistPanel.update(step, pick,
                boughtItemName, boughtItemId, boughtQty, totalQty, sellPrice, overcutGp, sellUndercutGp);
        }
    }

    /** Returns the current Flip Pick item from the Flip Pick tab, or null. */
    public GEPricerItem getFlipPickItem() {
        if (flipPickPanel == null) return null;
        return flipPickPanel.getCurrentItem();
    }

    /** Returns the current overcut GP value from the Flip Pick panel (0 if unavailable). */
    public long getFlipPickOvercutGp() {
        if (flipPickPanel == null) return 0;
        return flipPickPanel.getOvercutGp();
    }

    /** Returns the current sell undercut GP value from the Flip Pick panel (0 if unavailable). */
    public long getFlipPickSellUndercutGp() {
        if (flipPickPanel == null) return 0;
        return flipPickPanel.getSellUndercutGp();
    }

    /** Wire a callback that fires when the paused state changes from any source. */
    public void setFlipAssistOnPauseStateChanged(Runnable r) {
        if (flipAssistPanel != null) flipAssistPanel.setOnPauseStateChanged(r);
    }

    /** Toggles the GE guidance pause state (safe to call from any thread). */
    public void toggleFlipAssistPaused() {
        if (flipAssistPanel != null) flipAssistPanel.togglePaused();
    }

    /** Wire a callback that fires immediately when the user clicks Resume in the assist panel. */
    public void setFlipAssistOnResume(Runnable r) {
        if (flipAssistPanel != null) flipAssistPanel.setOnResume(r);
    }

    /** Returns true if the user has paused GE guidance (from the assist panel). */
    public boolean isFlipPickPaused() {
        return flipAssistPanel != null && flipAssistPanel.isPaused();
    }

    /** Returns true if Sell Only mode is active (buy guidance skipped). */
    public boolean isSellOnlyMode() {
        return flipAssistPanel != null && flipAssistPanel.isSellOnlyMode();
    }

    /** Skips the current Flip Pick item so the next best candidate is shown. */
    public void skipFlipPickItem() {
        if (flipPickPanel != null)
            flipPickPanel.skipCurrentItem();
    }

    /** Removes an item from the session skip set so it can be suggested again after a completed sell. */
    public void unskipFlipPickItem(int itemId) {
        if (flipPickPanel != null)
            flipPickPanel.unskipItem(itemId);
    }

    /**
     * Updates the set of item IDs the player currently has SELLING/SOLD offers for,
     * so those items are excluded from buy suggestions in the Flip Pick.
     */
    public void setFlipPickSellingItemIds(java.util.Collection<Integer> ids) {
        if (flipPickPanel != null)
            flipPickPanel.setSellingItemIds(ids);
    }

    /** Updates the price-change alert banners shown at the top of the Flip Pick panel. */
    public void setFlipPickPriceAlerts(java.util.List<GEFlipPickPanel.PriceAlert> alerts) {
        if (flipPickPanel != null)
            flipPickPanel.updatePriceAlerts(alerts != null ? alerts : java.util.Collections.emptyList());
    }

    /** Updates the stagnant buy-offer banners shown at the top of the Flip Pick panel. */
    public void setFlipPickStagnantBuyAlerts(java.util.List<GEFlipPickPanel.StagnantBuyAlert> alerts) {
        if (flipPickPanel != null)
            flipPickPanel.updateStagnantBuyAlerts(alerts != null ? alerts : java.util.Collections.emptyList());
    }

    public void setFlipPickOnModifyOffer(java.util.function.Consumer<GEFlipPickPanel.StagnantBuyAlert> cb) {
        if (flipPickPanel != null) flipPickPanel.setOnModifyOffer(cb);
    }

    public void setFlipPickOnCancelNewOffer(java.util.function.Consumer<GEFlipPickPanel.StagnantBuyAlert> cb) {
        if (flipPickPanel != null) flipPickPanel.setOnCancelNewOffer(cb);
    }

    public void setFlipPickOnModifySellOffer(java.util.function.Consumer<GEFlipPickPanel.StagnantSellAlert> cb) {
        if (flipPickPanel != null) flipPickPanel.setOnModifySellOffer(cb);
    }

    public void setFlipPickStagnantSellAlerts(java.util.List<GEFlipPickPanel.StagnantSellAlert> alerts) {
        if (flipPickPanel != null)
            flipPickPanel.updateStagnantSellAlerts(alerts != null ? alerts : java.util.Collections.emptyList());
    }

    /**
     * Updates the inventory sell suggestions and GP budget shown in the Flip Pick panel.
     * @param suggestions  Items found in the player's inventory that have sell pricing.
     * @param totalGp      Total coins in the player's inventory.
     * @param perSlotBudget Per-slot buy budget (totalGp / targetSlots), 0 = no limit.
     */
    public void setFlipPickInventoryContext(
            java.util.List<GEFlipPickPanel.InventorySellSuggestion> suggestions,
            long totalGp, long perSlotBudget) {
        if (flipPickPanel != null)
            flipPickPanel.updateInventoryContext(
                suggestions != null ? suggestions : java.util.Collections.emptyList(),
                totalGp, perSlotBudget);
    }

    /** Stop background timers â€“ called by the plugin on shutdown. */
    public void shutdown() {
        searchDebounce.stop();
        tickTimer.stop();
        if (statsPanel != null)
            statsPanel.stopTicker();
    }

    // Tab bar

    private JPanel buildTabBar() {
        pricesTabBtn   = makeTabButton("Prices");
        flipPickTabBtn = makeTabButton("Flip Pick");
        statsTabBtn    = makeTabButton("Stats");

        // Prices tab is active by default
        pricesTabBtn.setForeground(TEXT_WHITE);
        pricesTabBtn.setBackground(new Color(45, 45, 45));

        flipPickTabBtn.setForeground(TEXT_MUTED);
        flipPickTabBtn.setBackground(new Color(28, 28, 28));

        statsTabBtn.setForeground(TEXT_MUTED);
        statsTabBtn.setBackground(new Color(28, 28, 28));

        pricesTabBtn.addActionListener(e -> switchToTab("PRICES"));
        flipPickTabBtn.addActionListener(e -> switchToTab("FLIP_PICK"));
        statsTabBtn.addActionListener(e -> switchToTab("STATS"));

        JPanel bar = new JPanel(new GridLayout(1, 3, 1, 0));
        bar.setBackground(new Color(10, 10, 10)); // 1px gap colour
        bar.setBorder(new MatteBorder(0, 0, 1, 0, new Color(70, 70, 70)));
        bar.add(pricesTabBtn);
        bar.add(flipPickTabBtn);
        bar.add(statsTabBtn);
        return bar;
    }

    private JButton makeTabButton(String label) {
        JButton btn = new JButton(label);
        btn.setFont(FontManager.getRunescapeSmallFont());
        btn.setBorderPainted(false);
        btn.setFocusPainted(false);
        btn.setOpaque(true);
        btn.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        btn.setBorder(new EmptyBorder(6, 0, 6, 0));
        return btn;
    }

    private void switchToTab(String tab) {
        ((CardLayout) cardPanel.getLayout()).show(cardPanel, tab);
        pricesTabBtn  .setForeground("PRICES"   .equals(tab) ? TEXT_WHITE : TEXT_MUTED);
        flipPickTabBtn.setForeground("FLIP_PICK".equals(tab) ? TEXT_WHITE : TEXT_MUTED);
        statsTabBtn   .setForeground("STATS"    .equals(tab) ? TEXT_WHITE : TEXT_MUTED);
        pricesTabBtn  .setBackground("PRICES"   .equals(tab) ? new Color(45, 45, 45) : new Color(28, 28, 28));
        flipPickTabBtn.setBackground("FLIP_PICK".equals(tab) ? new Color(45, 45, 45) : new Color(28, 28, 28));
        statsTabBtn   .setBackground("STATS"    .equals(tab) ? new Color(45, 45, 45) : new Color(28, 28, 28));
        if ("STATS".equals(tab) && statsPanel != null)
            statsPanel.refresh();
    }

    // UI builders

    private JPanel buildHeader() {
        JPanel p = new JPanel(new BorderLayout(4, 0));
        p.setBackground(BG_HEADER);
        p.setBorder(new EmptyBorder(8, 8, 8, 8));

        JLabel title = new JLabel("Zoom Flips");
        title.setForeground(TEXT_WHITE);
        title.setFont(FontManager.getRunescapeBoldFont());

        JLabel subtitle = new JLabel("powered by therealge.com");
        subtitle.setForeground(new Color(120, 120, 120));
        subtitle.setFont(FontManager.getRunescapeSmallFont());

        JPanel titleArea = new JPanel(new BorderLayout(0, 1));
        titleArea.setBackground(BG_HEADER);
        titleArea.add(title,    BorderLayout.NORTH);
        titleArea.add(subtitle, BorderLayout.SOUTH);

        JButton refresh = new JButton("↻");
        refresh.setToolTipText("Refresh prices now");
        refresh.setForeground(TEXT_WHITE);
        refresh.setBackground(ColorScheme.MEDIUM_GRAY_COLOR);
        refresh.setBorderPainted(false);
        refresh.setFocusPainted(false);
        refresh.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        refresh.setFont(new Font("SansSerif", Font.PLAIN, 14));
        refresh.addActionListener(e -> {
            setStatus("Refreshing…");
            plugin.triggerRefresh();
        });

        p.add(titleArea, BorderLayout.CENTER);
        p.add(refresh,   BorderLayout.EAST);
        return p;
    }

    private JTextField buildSearchField() {
        JTextField tf = new JTextField();
        tf.setBackground(BG_SEARCH);
        tf.setForeground(TEXT_WHITE);
        tf.setCaretColor(TEXT_WHITE);
        tf.setBorder(new EmptyBorder(4, 6, 4, 6));
        tf.setFont(FontManager.getRunescapeSmallFont());

        // Placeholder
        tf.setText("Search items…");
        tf.setForeground(TEXT_MUTED);
        tf.addFocusListener(new FocusAdapter() {
            @Override public void focusGained(FocusEvent e) {
                if (tf.getText().equals("Search items…")) {
                    tf.setText("");
                    tf.setForeground(TEXT_WHITE);
                }
            }
            @Override public void focusLost(FocusEvent e) {
                if (tf.getText().isBlank()) {
                    tf.setText("Search items…");
                    tf.setForeground(TEXT_MUTED);
                }
            }
        });
        tf.addKeyListener(new KeyAdapter() {
            @Override public void keyReleased(KeyEvent e) {
                if (!tf.getText().equals("Search items…")) { searchDebounce.restart(); }
            }
        });
        return tf;
    }

    private JToggleButton buildFavButton() {
        JToggleButton btn = new JToggleButton("★");
        btn.setToolTipText("Show favorites only");
        btn.setSelected(false);
        btn.setForeground(COLOR_STAR_OFF);
        btn.setBackground(BG_SEARCH);
        btn.setBorderPainted(false);
        btn.setFocusPainted(false);
        btn.setFont(new Font("SansSerif", Font.PLAIN, 14));
        btn.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        btn.addActionListener(e -> {
            favOnly = btn.isSelected();
            btn.setForeground(favOnly ? COLOR_STAR_ON : COLOR_STAR_OFF);
            rebuildList();
        });
        return btn;
    }

    private JComboBox<GEPricerConfig.SortType> buildSortBox() {
        JComboBox<GEPricerConfig.SortType> cb =
            new JComboBox<>(GEPricerConfig.SortType.values());
        cb.setSelectedItem(config.defaultSort());
        cb.setBackground(BG_SEARCH);
        cb.setForeground(TEXT_WHITE);
        cb.setFont(FontManager.getRunescapeSmallFont());
        cb.setFocusable(false);
        cb.setBorder(null);
        cb.addActionListener(e -> rebuildList());
        return cb;
    }

    private JPanel buildControlsBar(JTextField search, JToggleButton fav,
                                     JComboBox<GEPricerConfig.SortType> sort) {
        // Row 1: search + clear button + star
        JButton clearBtn = new JButton("×");
        clearBtn.setToolTipText("Clear search");
        clearBtn.setForeground(TEXT_MUTED);
        clearBtn.setBackground(BG_SEARCH);
        clearBtn.setBorderPainted(false);
        clearBtn.setFocusPainted(false);
        clearBtn.setFont(new Font("SansSerif", Font.PLAIN, 14));
        clearBtn.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        clearBtn.setMargin(new Insets(0, 4, 0, 4));
        clearBtn.addActionListener(e -> {
            search.setText("Search items\u2026");
            search.setForeground(TEXT_MUTED);
            rebuildList();
        });

        JPanel searchRow = new JPanel(new BorderLayout(3, 0));
        searchRow.setBackground(BG);
        searchRow.add(search,   BorderLayout.CENTER);
        searchRow.add(clearBtn, BorderLayout.EAST);

        JPanel searchAndFav = new JPanel(new BorderLayout(3, 0));
        searchAndFav.setBackground(BG);
        searchAndFav.add(searchRow, BorderLayout.CENTER);
        searchAndFav.add(fav,       BorderLayout.EAST);

        // Row 2: sort label + combo
        JLabel sortLabel = new JLabel("Sort:");
        sortLabel.setForeground(TEXT_MUTED);
        sortLabel.setFont(FontManager.getRunescapeSmallFont());

        JPanel sortRow = new JPanel(new BorderLayout(4, 0));
        sortRow.setBackground(BG);
        sortRow.add(sortLabel, BorderLayout.WEST);
        sortRow.add(sort,      BorderLayout.CENTER);

        JPanel bar = new JPanel();
        bar.setLayout(new BoxLayout(bar, BoxLayout.Y_AXIS));
        bar.setBackground(BG);
        bar.setBorder(new EmptyBorder(4, 8, 4, 8));
        bar.add(searchAndFav);
        bar.add(Box.createVerticalStrut(4));
        bar.add(sortRow);
        return bar;
    }

    private JPanel buildColumnHeadings() {
        JPanel buyRow = new JPanel(new GridLayout(1, 2, 0, 0));
        buyRow.setBackground(new Color(30, 30, 30));
        buyRow.setBorder(new EmptyBorder(3, 8, 0, 8));

        JLabel buyH  = new JLabel("▲ Insta-Buy");
        JLabel sellH = new JLabel("▼ Insta-Sell");
        for (JLabel l : new JLabel[]{buyH, sellH}) {
            l.setForeground(TEXT_MUTED);
            l.setFont(FontManager.getRunescapeSmallFont());
            l.setHorizontalAlignment(SwingConstants.LEFT);
            buyRow.add(l);
        }

        JPanel marginRow = new JPanel(new BorderLayout());
        marginRow.setBackground(new Color(30, 30, 30));
        marginRow.setBorder(new EmptyBorder(1, 8, 3, 8));

        JLabel marginH = new JLabel("Δ Margin");
        marginH.setForeground(TEXT_MUTED);
        marginH.setFont(FontManager.getRunescapeSmallFont());
        marginRow.add(marginH, BorderLayout.WEST);

        JPanel p = new JPanel();
        p.setLayout(new BoxLayout(p, BoxLayout.Y_AXIS));
        p.setBackground(new Color(30, 30, 30));
        p.add(buyRow);
        p.add(marginRow);
        return p;
    }
}
