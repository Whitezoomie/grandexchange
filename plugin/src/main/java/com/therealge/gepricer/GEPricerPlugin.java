package com.therealge.gepricer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.inject.Provides;
import lombok.extern.slf4j.Slf4j;
import net.runelite.api.Client;
import net.runelite.api.GrandExchangeOffer;
import net.runelite.api.GrandExchangeOfferState;
import net.runelite.api.InventoryID;
import net.runelite.api.Item;
import net.runelite.api.ItemContainer;
import net.runelite.api.GameState;
import net.runelite.api.events.GameStateChanged;
import net.runelite.api.events.GameTick;
import net.runelite.api.events.GrandExchangeOfferChanged;
import net.runelite.api.events.GrandExchangeSearched;
import net.runelite.api.events.ScriptPostFired;
import net.runelite.api.events.VarClientIntChanged;
import net.runelite.api.events.WidgetClosed;
import net.runelite.api.events.WidgetLoaded;
import net.runelite.api.ScriptID;
import net.runelite.api.FontID;
import net.runelite.api.widgets.JavaScriptCallback;
import net.runelite.api.VarClientInt;
import net.runelite.api.VarClientStr;
import net.runelite.api.VarPlayer;
import net.runelite.api.widgets.ComponentID;
import net.runelite.api.widgets.Widget;
import net.runelite.api.widgets.WidgetPositionMode;
import net.runelite.client.Notifier;
import net.runelite.api.widgets.WidgetSizeMode;
import net.runelite.api.widgets.WidgetTextAlignment;
import net.runelite.api.widgets.WidgetType;
import net.runelite.client.callback.ClientThread;
import net.runelite.client.config.ConfigManager;
import net.runelite.client.eventbus.Subscribe;
import net.runelite.client.game.ItemManager;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;
import net.runelite.client.ui.ClientToolbar;
import net.runelite.client.ui.NavigationButton;
import net.runelite.client.ui.overlay.OverlayManager;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

import javax.inject.Inject;
import javax.swing.*;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.util.ArrayList;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.time.Duration;
import java.time.Instant;

@Slf4j
@PluginDescriptor(
    name        = "Zoom Flips",
    description = "Live Grand Exchange prices powered by therealge.com â€“ shows insta-buy/sell prices and flip margins",
    tags        = {"grand exchange", "ge", "prices", "flipping", "trading", "market", "therealge"}
)
public class GEPricerPlugin extends Plugin
{
    // -----------------------------------------------------------------------
    // Wiki API endpoints  (same source as therealge.com)
    // -----------------------------------------------------------------------
    static final String API_BASE    = "https://prices.runescape.wiki/api/v1/osrs";
    private static final String MAPPING_URL   = API_BASE + "/mapping";
    private static final String PREDICT_URL   = "https://osrs-ge-server.onrender.com/predict?limit=200";
    private static final String LATEST_URL  = API_BASE + "/latest";
    private static final String VOLUMES_URL = API_BASE + "/volumes";
    /** 1-hour aggregated avg prices â€” used for predicted GP/hr scoring. */
    private static final String AVG_1H_URL  = API_BASE + "/1h";

    /** Identify ourselves to the wiki per their usage policy. */
    private static final String USER_AGENT =
        "RuneLite ZoomFlipsPlugin/1.0 - therealge.com community plugin";

    // -----------------------------------------------------------------------
    // Injected dependencies
    // -----------------------------------------------------------------------
    @Inject private Client           client;
    @Inject private ClientThread     clientThread;
    @Inject private ClientToolbar    clientToolbar;
    @Inject private OkHttpClient     httpClient;
    @Inject private GEPricerConfig   config;
    @Inject private ConfigManager    configManager;
    @Inject private ItemManager      itemManager;
    @Inject private OverlayManager   overlayManager;
    @Inject private Notifier          notifier;

    // -----------------------------------------------------------------------
    // Plugin state
    // -----------------------------------------------------------------------
    private GEPricerPanel             panel;
    private NavigationButton          navButton;
    private ScheduledExecutorService  executor;
    private ScheduledFuture<?>        scheduledRefresh;
    private GETradeSession            tradeSession;
    private GEFlipAssistOverlay       flipHighlightOverlay;

    // -----------------------------------------------------------------------
    // Guided flip assistant state (drives GEFlipAssistPanel in the side panel)
    // -----------------------------------------------------------------------
    /** Current step in the guided workflow (-1 = GE closed, 0-5 = active). */
    private int    step             = -1;
    /** Coins the player currently holds. */
    /** Item currently being actively flipped (buy placed/in-progress/just bought). */
    private int    activeFlipItemId = -1;
    /** Item ID being bought/just bought. */
    private int    boughtItemId     = -1;
    /** Display name of the item being bought. */
    private String boughtItemName   = null;
    /** Quantity filled so far. */
    private int    boughtQuantity   = 0;
    /** Total quantity ordered. */
    private int    totalQuantity    = 0;
    /** Sell target price after buy completes. */
    private long   sellTargetPrice  = 0;
    /** True while the price/quantity chatbox input is open. */
    private boolean priceDialogOpen = false;
    /** True if the last chatbox dialog that opened (inputType==7) was a PRICE dialog
     *  ("Set a price for each item:") rather than a quantity dialog ("How many"). */
    private boolean lastDialogWasPrice = true;
    /** False until the first post-login game tick reconciliation scan completes. */
    private boolean startupScanDone = false;
    /** Injected pause/resume button widget inside the GE interface. Null when GE is closed. */
    private Widget  gePauseWidget   = null;

    /** Master item map keyed by item ID â€“ populated by /mapping then enriched by /latest. */
    final Map<Integer, GEPricerItem> itemsById = new ConcurrentHashMap<>();

    /** Item IDs that pay zero GE tax in OSRS (e.g. Old School bonds). */
    private static final java.util.Set<Integer> TAX_EXEMPT_IDS =
        new java.util.HashSet<>(java.util.Arrays.asList(13190));

    /** Counts game ticks between active-offer price alert checks (fires every 10 ticks). */
    private int priceAlertTickCounter = 0;
    /** Counts game ticks between inventory/budget scans (fires every 5 ticks). */
    private int inventoryTickCounter  = 0;
    /**
     * Item IDs that currently have an active price-modify alert.
     * Written on the EDT (by checkActiveOfferPrices), read on the render thread.
     * Using a volatile reference to a snapshot list keeps it thread-safe without locks.
     */
    private volatile List<Integer> activeAlertItemIds = java.util.Collections.emptyList();

    // -----------------------------------------------------------------------
    // Slot activity timers (mirrors Flipping Utilities SlotActivityTimer)
    // -----------------------------------------------------------------------
    /** Widget child index within each GE slot that holds the "Buy"/"Sell"/"Empty" text. */
    private static final int    SLOT_STATE_CHILD_IDX  = 16;
    /** Smaller OSRS font used while the timer string is appended to the state label. */
    private static final int    SLOT_FONT_TIMER        = 495;
    /** Default OSRS font for the slot state label when no timer is shown. */
    private static final int    SLOT_FONT_DEFAULT      = 496;
    /** Seconds without a fill before the timer turns orange (stagnant). */
    private static final int    SLOT_STAGNATION_SECS   = 5 * 60;
    /** Spacer string between state label and timer (same width as Flipping Utilities). */
    private static final String SLOT_TIMER_SPACER      = "          ";
    /** When the offer in each slot was first placed (set on qty==0 BUYING/SELLING event). */
    private final Instant[] slotTradeStart   = new Instant[8];
    /** When the last offer event for each slot was received. */
    private final Instant[] slotLastUpdate   = new Instant[8];
    /** True if the offer was already active when the plugin started â€” start time is unknown. */
    private final boolean[] slotTimerUnknown = new boolean[8];
    /** True if the slot holds a buy-side offer (BUYING/BOUGHT/CANCELLED_BUY). */
    private final boolean[] slotIsBuy        = new boolean[8];
    /** True if the slot offer has fully completed or been cancelled. */
    private final boolean[] slotIsComplete   = new boolean[8];
    /**
     * Last known quantitySold for each slot.  -1 means "never seen an event for this slot
     * in this process lifetime".  Used to distinguish genuine new fills (qty increased)
     * from reconnect/duplicate login-time events (same qty) so we never overwrite persisted
     * timestamps with Instant.now() on reconnect.
     */
    private final int[]     slotLastQty      = new int[8];
    private final int[]     slotItemId       = new int[8];
    /** Scheduled task that updates GE slot timer widgets every second. */
    private ScheduledFuture<?> slotTimerTask;

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    @Override
    protected void startUp()
    {
        tradeSession = new GETradeSession();
        loadSession();
        panel = new GEPricerPanel(this, config, configManager, itemManager, httpClient, tradeSession);
        panel.setFlipAssistOnResume(this::updateAssistPanel);
        // When pause state changes from sidebar, refresh the in-GE widget on client thread
        panel.setFlipAssistOnPauseStateChanged(
            () -> clientThread.invokeLater(this::refreshGePauseWidget));

        // Stagnant buy banner â€” Modify: highlight slot and show raise-price guidance
        panel.setFlipPickOnModifyOffer(alert ->
        {
            boughtItemId    = alert.itemId;
            boughtItemName  = alert.itemName;
            sellTargetPrice = Math.round(alert.currentPrice * 1.03);
            step = 13;
            updateAssistPanel();
        });
        // Stagnant buy banner â€” New item: highlight slot and guide user to cancel it
        panel.setFlipPickOnCancelNewOffer(alert ->
        {
            boughtItemId   = alert.itemId;
            boughtItemName = alert.itemName;
            step = 14;
            updateAssistPanel();
        });

        // Stagnant sell banner â€” Lower it: guide user to lower price in the GE
        panel.setFlipPickOnModifySellOffer(alert ->
        {
            boughtItemId    = alert.itemId;
            boughtItemName  = alert.itemName;
            sellTargetPrice = alert.suggestedPrice;
            step = 6;   // reuse "Set sell offer qty & price" step
            updateAssistPanel();
        });

        navButton = NavigationButton.builder()
            .tooltip("Zoom Flips")
            .icon(buildIcon())
            .priority(6)
            .panel(panel)
            .build();

        clientToolbar.addNavigation(navButton);

        flipHighlightOverlay = new GEFlipAssistOverlay(client, this);
        overlayManager.add(flipHighlightOverlay);

        startupScanDone = false;
        loadAssistState();

        executor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "ge-price-tracker");
            t.setDaemon(true);
            return t;
        });

        // Load mapping first, then prices, then schedule auto-refresh
        executor.execute(this::initialLoad);

        // Start slot-timer task â€” updates GE slot widgets with elapsed offer time every second
        java.util.Arrays.fill(slotTimerUnknown, true);
        java.util.Arrays.fill(slotLastQty, -1);
        java.util.Arrays.fill(slotItemId, 0);
        // Load any persisted timer data now. If the plugin starts while the player is already
        // logged in, no LOGGED_IN GameStateChanged event will fire, so onGameStateChanged would
        // never call loadSlotTimers() â€” causing the startup fill(true) to be saved on next logout
        // and permanently wiping all persisted timer data.
        loadSlotTimers();
        slotTimerTask = executor.scheduleAtFixedRate(
            () -> clientThread.invokeLater(this::updateSlotTimerWidgets),
            1000, 1000, TimeUnit.MILLISECONDS);
    }

    @Override
    protected void shutDown()
    {
        saveSession();
        saveAssistState();
        saveSlotTimers();
        clientToolbar.removeNavigation(navButton);
        cancelScheduledRefresh();

        if (flipHighlightOverlay != null)
        {
            overlayManager.remove(flipHighlightOverlay);
            flipHighlightOverlay = null;
        }
        activeFlipItemId = -1;
        step = -1;

        if (panel != null)
        {
            panel.shutdown();
        }
        if (slotTimerTask != null)
        {
            slotTimerTask.cancel(false);
            slotTimerTask = null;
        }
        // Restore slot widgets to default "Buy"/"Sell"/"Empty" text before shutting down
        clientThread.invokeLater(this::resetSlotTimerWidgets);
        if (executor != null)
        {
            executor.shutdownNow();
            executor = null;
        }
        panel     = null;
        navButton = null;
        tradeSession = null;
        itemsById.clear();
    }

    // -----------------------------------------------------------------------
    // Called from panel "Refresh" button
    // -----------------------------------------------------------------------
    void triggerRefresh()
    {
        if (executor != null && !executor.isShutdown())
        {
            executor.execute(this::fetchLatestPrices);
        }
    }

    // -----------------------------------------------------------------------
    // Background data loading
    // -----------------------------------------------------------------------

    private void initialLoad()
    {
        try
        {
            SwingUtilities.invokeLater(() -> panel.setStatus("Fetching prices\u2026"));
            fetchMappingData();
            fetchPriceData();
            fetchVolumeData();
            fetchAvgPriceData1h();
            fetchPredictions();
            pushToPanel();
            scheduleAutoRefresh();
        }
        catch (Throwable t)
        {
            log.error("GEPricer: initialLoad failed", t);
            SwingUtilities.invokeLater(() -> panel.showError(t.getMessage()));
        }
    }

    private void scheduleAutoRefresh()
    {
        cancelScheduledRefresh();
        if (executor != null && !executor.isShutdown())
        {
            scheduledRefresh = executor.scheduleAtFixedRate(
                this::fetchLatestPrices, 30, 30, TimeUnit.SECONDS);
        }
    }

    private void cancelScheduledRefresh()
    {
        if (scheduledRefresh != null)
        {
            scheduledRefresh.cancel(false);
            scheduledRefresh = null;
        }
    }

    /** Fetch item metadata (name, icon, buy limit) from /mapping. */
    private void fetchMappingData()
    {
        log.info("GEPricer: fetching /mapping...");
        String body = doGet(MAPPING_URL);
        if (body == null) { log.warn("GEPricer: /mapping returned null body"); return; }

        try
        {
            var arr = new JsonParser().parse(body).getAsJsonArray();
            for (var el : arr)
            {
                JsonObject obj = el.getAsJsonObject();
                int    id    = obj.get("id").getAsInt();
                String name  = obj.has("name")  ? obj.get("name").getAsString()  : "Unknown";
                String icon  = obj.has("icon")  ? obj.get("icon").getAsString()  : "";
                int    limit = obj.has("limit") ? obj.get("limit").getAsInt()    : 0;

                GEPricerItem newItem = new GEPricerItem(id, name, icon, limit);
                if (TAX_EXEMPT_IDS.contains(id)) newItem.setTaxExempt(true);
                itemsById.put(id, newItem);
            }
            log.info("GEPricer: loaded {} item mappings", itemsById.size());
        }
        catch (Exception e)
        {
            log.error("GEPricer: failed to parse /mapping", e);
        }
    }

    /** Fetch latest insta-buy/sell prices from /latest. */
    private void fetchPriceData()
    {
        log.info("GEPricer: fetching /latest...");
        String body = doGet(LATEST_URL);
        if (body == null) { log.warn("GEPricer: /latest returned null body"); return; }

        try
        {
            JsonObject data = new JsonParser().parse(body)
                .getAsJsonObject().getAsJsonObject("data");

            int priced = 0;
            for (Map.Entry<String, com.google.gson.JsonElement> entry : data.entrySet())
            {
                int id;
                try { id = Integer.parseInt(entry.getKey()); }
                catch (NumberFormatException ex) { continue; }

                JsonObject p = entry.getValue().getAsJsonObject();
                long high     = getLong(p, "high");
                long low      = getLong(p, "low");
                long highTime = getLong(p, "highTime");
                long lowTime  = getLong(p, "lowTime");

                GEPricerItem item = itemsById.computeIfAbsent(id,
                    i -> new GEPricerItem(i, "Item " + i, "", 0));
                item.setInstaBuy(high);
                item.setInstaSell(low);
                item.setInstaBuyTime(highTime);
                item.setInstaSellTime(lowTime);
                if (high > 0 || low > 0) priced++;
            }
            log.info("GEPricer: loaded prices for {} items", priced);
        }
        catch (Exception e)
        {
            log.error("GEPricer: failed to parse /latest", e);
        }
    }

    /** Fetch 1-hour average buy/sell prices and volumes from /1h. */
    private void fetchAvgPriceData1h()
    {
        log.info("GEPricer: fetching /1h...");
        String body = doGet(AVG_1H_URL);
        if (body == null) { log.warn("GEPricer: /1h returned null body"); return; }

        try
        {
            JsonObject root = new JsonParser().parse(body).getAsJsonObject();
            JsonObject data = root.has("data") ? root.getAsJsonObject("data") : root;

            int count = 0;
            for (Map.Entry<String, com.google.gson.JsonElement> entry : data.entrySet())
            {
                int id;
                try { id = Integer.parseInt(entry.getKey()); }
                catch (NumberFormatException ex) { continue; }

                GEPricerItem item = itemsById.get(id);
                if (item == null || entry.getValue().isJsonNull()) continue;

                JsonObject p = entry.getValue().getAsJsonObject();
                long avgHigh = getLong(p, "avgHighPrice");
                long highVol = getLong(p, "highPriceVolume");
                long avgLow  = getLong(p, "avgLowPrice");
                long lowVol  = getLong(p, "lowPriceVolume");

                if (avgHigh > 0) item.setAvgHighPrice1h(avgHigh);
                if (highVol > 0) item.setHighPriceVolume1h(highVol);
                if (avgLow  > 0) item.setAvgLowPrice1h(avgLow);
                if (lowVol  > 0) item.setLowPriceVolume1h(lowVol);
                count++;
            }
            log.info("GEPricer: loaded 1h avg data for {} items", count);
        }
        catch (Exception e)
        {
            log.warn("GEPricer: could not parse /1h (non-fatal): {}", e.getMessage());
        }
    }

    /** Fetch trend predictions from the Render prediction server (/predict endpoint). */
    private void fetchPredictions()
    {
        log.info("GEPricer: fetching predictions...");
        String body = doGet(PREDICT_URL);
        if (body == null) { log.warn("GEPricer: prediction server returned null"); return; }

        try
        {
            JsonObject root = new JsonParser().parse(body).getAsJsonObject();
            var items = root.getAsJsonArray("items");
            int applied = 0;
            for (var el : items)
            {
                JsonObject obj = el.getAsJsonObject();
                int id = obj.get("item_id").getAsInt();
                GEPricerItem item = itemsById.get(id);
                if (item == null) continue;
                item.setServerScore(obj.get("raw_score").getAsLong());
                item.setTrendPct(obj.get("trend_pct").getAsDouble());
                item.setServerSignal(obj.get("signal").getAsString());
                applied++;
            }
            log.info("GEPricer: applied predictions to {} items", applied);
        }
        catch (Exception e)
        {
            log.warn("GEPricer: could not parse predictions (non-fatal): {}", e.getMessage());
        }
    }

    /** Fetch 24h trade volumes from /volumes. */
    private void fetchVolumeData()
    {
        log.info("GEPricer: fetching /volumes...");
        String body = doGet(VOLUMES_URL);
        if (body == null) { log.warn("GEPricer: /volumes returned null body"); return; }

        try
        {
            JsonObject data = new JsonParser().parse(body).getAsJsonObject();
            JsonObject volData = data.has("data") ? data.getAsJsonObject("data") : data;

            for (Map.Entry<String, com.google.gson.JsonElement> entry : volData.entrySet())
            {
                int id;
                try { id = Integer.parseInt(entry.getKey()); }
                catch (NumberFormatException ex) { continue; }

                GEPricerItem item = itemsById.get(id);
                if (item != null && !entry.getValue().isJsonNull())
                {
                    item.setVolume(entry.getValue().getAsLong());
                }
            }
        }
        catch (Exception e)
        {
            log.warn("GEPricer: could not parse /volumes (non-fatal): {}", e.getMessage());
        }
        log.info("GEPricer: volumes fetch complete");
    }

    /** Push current data snapshot to the panel on the EDT. */
    private void pushToPanel()
    {
        List<GEPricerItem> snapshot = new ArrayList<>(itemsById.values());
        log.info("GEPricer: pushing {} items to panel", snapshot.size());
        SwingUtilities.invokeLater(() -> {
            panel.updateItems(snapshot);
            updateAssistPanel();
        });
    }

    /** Called from panel Refresh button and auto-refresh timer. */
    void fetchLatestPrices()
    {
        if (executor == null || executor.isShutdown()) return;
        executor.execute(() -> {
            try
            {
                SwingUtilities.invokeLater(() -> panel.setStatus("Fetching prices\u2026"));
                fetchPriceData();
                fetchVolumeData();
                fetchAvgPriceData1h();
                fetchPredictions();
                pushToPanel();
            }
            catch (Throwable t)
            {
                log.error("GEPricer: refresh failed", t);
            }
        });
    }

    // -----------------------------------------------------------------------
    // HTTP helper
    // -----------------------------------------------------------------------

    private String doGet(String url)
    {
        Request request = new Request.Builder()
            .url(url)
            .header("User-Agent", USER_AGENT)
            .build();

        try (Response response = httpClient.newCall(request).execute())
        {
            if (!response.isSuccessful() || response.body() == null)
            {
                log.warn("GEPricer: HTTP {} for {}", response.code(), url);
                return null;
            }
            return response.body().string();
        }
        catch (Throwable e)
        {
            log.error("GEPricer: request failed for {}: {}", url, e.getMessage());
            return null;
        }
    }

    private static long getLong(JsonObject obj, String key)
    {
        if (obj.has(key) && !obj.get(key).isJsonNull())
        {
            return obj.get(key).getAsLong();
        }
        return 0L;
    }

    // -----------------------------------------------------------------------
    // Grand Exchange Assist â€“ search injection
    // -----------------------------------------------------------------------

    /**
     * Fires when the GE search chatbox opens (VarClientInt index 2 = MESLAYERMODE, value 14).
     * We defer with invokeLater so widget children are fully initialised before we inject â€”
     * same technique used by flipping-copilot.
     */
    @Subscribe
    public void onVarClientIntChanged(VarClientIntChanged event)
    {
        if (event.getIndex() != VarClientInt.INPUT_TYPE) return;
        if (panel != null && panel.isFlipPickPaused()) return;
        int inputType = client.getVarcIntValue(VarClientInt.INPUT_TYPE);

        // value 14 = GE item search chatbox opened (user clicked a buy slot)
        if (inputType == 14)
        {
            // In Sell Only mode, ignore buy-slot clicks entirely â€” don't start the buy flow.
            if (panel != null && panel.isSellOnlyMode()) return;
            if (step == 0 || step == -1) { step = 1; updateAssistPanel(); }
            // Always schedule â€” injectFlipPickSuggestion returns false (retry) when the
            // widget is not ready yet, so invokeLater(BooleanSupplier) keeps retrying
            // each tick until the widget is available.
            clientThread.invokeLater(this::injectFlipPickSuggestion);
        }

        // value 7 = price/quantity chatbox opened â€” detect which dialog and show the right suggestion
        if (inputType == 7)
        {
            priceDialogOpen = true;
            if (step == 2 || step == 6 || step == 11)
            {
                // showDialogClickWidget detects qty vs price by reading the chatbox message text,
                // saves lastDialogWasPrice, then injects the appropriate clickable suggestion.
                clientThread.invokeLater(this::showDialogClickWidget);
            }
        }

        // value 0 = chatbox closed â€” advance step only when the PRICE dialog was dismissed.
        // This lets the user set quantity (without using "...") before touching price,
        // and ensures the step only moves forward when price has actually been entered.
        if (inputType == 0 && priceDialogOpen)
        {
            priceDialogOpen = false;
            clientThread.invokeLater(() ->
            {
                // If re-opened immediately (user clicked "..."), priceDialogOpen is true again â€” skip
                if (priceDialogOpen) return;
                if      (step == 2  && lastDialogWasPrice)  { step = 3; updateAssistPanel(); }
                else if (step == 6  && lastDialogWasPrice)  { step = 7; updateAssistPanel(); }
                else if (step == 11) { step = 7; updateAssistPanel(); }
                else if (step == 13 && lastDialogWasPrice)  { step = 3; updateAssistPanel(); }
            });
        }
    }

    /** GE interface group ID (group 465). */
    private static final int GE_GROUP_ID = 465;

    /**
     * ScriptID.CHAT_TEXT_INPUT_REBUILD (222) fires when the GE search chatbox is
     * first fully built (both with and without a previous search). Using invokeLater
     * here ensures our injection runs AFTER all of the game's own init scripts for
     * that tick have completed, preventing them from overwriting our widgets.
     *
     * ScriptID.GE_ITEM_SEARCH (752) fires after each live search result set is
     * loaded (every keystroke). Re-inject via invokeLater so our row persists.
     */
    @Subscribe
    public void onScriptPostFired(ScriptPostFired event)
    {
        if (panel != null && panel.isFlipPickPaused()) return;
        int id = event.getScriptId();

        // Initial chatbox build â€” only needed when widget was null at VarClientIntChanged time
        if (id == ScriptID.CHAT_TEXT_INPUT_REBUILD
                && client.getVarcIntValue(VarClientInt.INPUT_TYPE) == 14
                && step == 1)
        {
            clientThread.invokeLater(this::injectFlipPickSuggestion);
        }

        // After each live search result set loads (every keypress) â†’ re-inject so our row stays.
        if (id == ScriptID.GE_ITEM_SEARCH && step == 1)
        {
            clientThread.invokeLater(this::injectFlipPickSuggestion);
        }

        // GE slot UI update scripts â€” recolor price text to indicate profitability
        if (id == 782 || id == 804)
        {
            colorizeSlotPrices();
            // Re-apply slot timer text after widget rebuild (GE open / switch world)
            updateSlotTimerWidgets();
        }

        // GE slot hover tooltip (script 526) â€” append profit line to SELLING tooltips
        if (id == 526)
        {
            injectSellTooltipProfit();
        }
    }

    /**
     * Colors the price text on each active GE slot widget to indicate profitability.
     * Green  = we have a recorded buy for this item (will make profit).
     * Orange = item is selling but no buy was recorded this session (unknown P/L).
     * Called on the client thread when scripts 782 or 804 fire (GE slot UI rebuild).
     */
    private void colorizeSlotPrices()
    {
        GrandExchangeOffer[] offers = client.getGrandExchangeOffers();
        if (offers == null) return;
        for (int i = 0; i < offers.length; i++)
        {
            GrandExchangeOffer o = offers[i];
            if (o == null) continue;
            GrandExchangeOfferState st = o.getState();
            if (st != GrandExchangeOfferState.SELLING && st != GrandExchangeOfferState.BUYING) continue;

            Widget slotWidget = client.getWidget(GE_GROUP_ID, 7 + i);
            if (slotWidget == null || slotWidget.isHidden()) continue;
            Widget priceWidget = slotWidget.getChild(25);
            if (priceWidget == null) continue;
            String text = priceWidget.getText();
            if (text == null || text.isEmpty()) continue;

            // Strip any existing <col> tags
            String plain = text.replaceAll("<col=[0-9a-fA-F]{6}>", "").replaceAll("</col>", "");

            String hex;
            if (st == GrandExchangeOfferState.SELLING)
            {
                boolean hasBuy = tradeSession != null && tradeSession.peekBuySpent(o.getItemId()) >= 0;
                hex = hasBuy ? "32c832" : "ff9800"; // green or orange
            }
            else
            {
                // BUYING â€” use the standard RuneLite buy color
                hex = "ff981f";
            }
            priceWidget.setText("<col=" + hex + ">" + plain + "</col>");
        }
    }

    /**
     * Intercepts the GE slot hover tooltip when it shows "Selling: ItemName X/Y"
     * and appends a profit line.  Script 526 fires immediately after the tooltip
     * widget is populated.
     * Called on the client thread.
     */
    private void injectSellTooltipProfit()
    {
        // Tooltip widget: group 523, child 2 contains the text lines
        Widget tooltip = client.getWidget(523, 2);
        if (tooltip == null || tooltip.isHidden()) return;
        String text = tooltip.getText();
        if (text == null || !text.contains("Selling:")) return;
        // Avoid re-injecting if we already processed this tooltip
        if (text.contains("Profit:") || text.contains("P/L:")) return;

        // Extract item name from "Selling: ItemName X/Y"
        // format: "Selling: <name><br>X / Y"
        String cleaned = text.replaceAll("<br>", " ").replaceAll("<[^>]+>", "").trim();
        // pattern: "Selling: <name> <qty>/<total>"
        java.util.regex.Matcher m = java.util.regex.Pattern
            .compile("Selling: (.+?) \\d[\\d,]* / [\\d,]+")
            .matcher(cleaned);
        if (!m.find()) return;
        String itemName = m.group(1).trim();

        // Look up item by name to get its ID
        GEPricerItem matched = null;
        for (GEPricerItem it : itemsById.values())
        {
            if (itemName.equalsIgnoreCase(it.getName()))
            {
                matched = it;
                break;
            }
        }
        if (matched == null) return;

        long buySpent = tradeSession != null ? tradeSession.peekBuySpent(matched.getId()) : -1L;
        if (buySpent < 0) return; // no buy recorded â€” can't show profit

        GrandExchangeOffer[] offers = client.getGrandExchangeOffers();
        if (offers == null) return;
        for (GrandExchangeOffer o : offers)
        {
            if (o == null || o.getItemId() != matched.getId()) continue;
            if (o.getState() != GrandExchangeOfferState.SELLING) continue;
            // Use current price Ã— qty sold so far as a preview of proceeds
            long sellPrice = o.getPrice();
            long qty       = o.getTotalQuantity();
            long tax       = Math.min((long) Math.floor(sellPrice * qty * 0.02), 5_000_000L);
            long profit    = sellPrice * qty - buySpent - tax;
            String sign    = profit >= 0 ? "+" : "";
            String profitStr = sign + java.text.NumberFormat.getNumberInstance(java.util.Locale.US).format(profit) + " gp";
            String color   = profit >= 0 ? "<col=32c832>" : "<col=e65a5a>";
            tooltip.setText(text + "<br>" + color + "Profit: " + profitStr + "</col>");
            // Resize tooltip height to fit the extra line
            Widget container = client.getWidget(523, 0);
            if (container != null) container.setOriginalHeight(container.getOriginalHeight() + 14);
            tooltip.revalidate();
            break;
        }
    }

    /**
     * Reset the startup-scan flag whenever the player returns to the login screen
     * (logout or start of a new login). The flag is cleared so that on the next
     * login the first game tick triggers a fresh offer-reconciliation scan, and
     * onGrandExchangeOfferChanged events that fire during that first tick are
     * suppressed until the scan has set correct state.
     */
    @Subscribe
    public void onGameStateChanged(GameStateChanged event)
    {
        GameState state = event.getGameState();
        if (state == GameState.LOGIN_SCREEN || state == GameState.HOPPING)
        {
            // Persist session and assist state so nothing is lost across logouts
            // (shutDown() only fires when the plugin/client fully closes)
            saveSession();
            saveAssistState();
            saveSlotTimers();
            startupScanDone = false;
        }
        else if (state == GameState.LOGGED_IN)
        {
            // Reload session in case another client instance saved newer data.
            // NOTE: do NOT call loadSlotTimers() here — a reconnect (DC recovery) fires
            // LOGGED_IN without a prior HOPPING/LOGIN_SCREEN save, which would overwrite
            // fresh in-memory timer state with stale config data and cause false stagnant alerts.
            loadSession();
        }
    }

    /**
     * Detect when the GE window loads (group 465) to set the initial step.
     * If a buy is already in progress (step 4) or just completed (step 5),
     * leave the step as-is so the guided overlay persists.
     */
    @Subscribe
    public void onWidgetLoaded(WidgetLoaded event)
    {
        if (event.getGroupId() != GE_GROUP_ID) return;
        injectGePauseButton();
        if (panel != null && panel.isFlipPickPaused()) return;

        // Don't reset step if we're waiting for a buy or in the sell guidance flow
        if (step >= 4) return;

        Widget offerSetup = client.getWidget(ComponentID.GRAND_EXCHANGE_OFFER_CONTAINER);
        if (offerSetup != null && !offerSetup.isHidden())
        {
            step = 1;
            updateAssistPanel();
        }
        else if (!checkAndRedirectToCollect())
        {
            step = 0;
            updateAssistPanel();
            // Immediately check whether the player already has an item in inventory
            // to sell â€” if so, prioritise that over the "click a buy slot" guidance.
            checkInventoryForFlipPickItem();
        }
    }

    /**
     * Detect when the GE window closes.
     * If a buy is in progress (step 4) or just completed (step 5), keep the step
     * so the guided overlay is shown when the GE re-opens.
     */
    @Subscribe
    public void onWidgetClosed(WidgetClosed event)
    {
        if (event.getGroupId() != GE_GROUP_ID) return;
        gePauseWidget = null;
        if (panel != null && panel.isFlipPickPaused()) return;

        if (step < 4)
        {
            step = -1;
        }
        updateAssistPanel();
    }

    /** Fires after a GE search completes â€” lock results to our suggested item at step 1. */
    @Subscribe
    public void onGrandExchangeSearched(GrandExchangeSearched event)
    {
        if (panel != null && panel.isFlipPickPaused()) return;
        // While guiding the user (step 1), lock search results to ONLY our recommended item.
        if (step == 1)
        {
            GEPricerItem pick = getFlipPickItem();
            if (pick != null)
            {
                client.setGeSearchResultIds(new short[]{(short) pick.getId()});
                client.setGeSearchResultCount(1);
                client.setGeSearchResultIndex(0);
                event.consume();
            }
        }
    }

    /**
     * Every game tick, while on the GE offer setup screen (steps 1-3), determine
     * the correct step based on what item/price the player has entered.
     */
    @Subscribe
    public void onGameTick(GameTick event)
    {
        if (panel != null && panel.isFlipPickPaused()) return;
        // On the first game tick after login, reconcile actual GE offer state with
        // the persisted state before letting normal tick logic run.
        if (!startupScanDone)
        {
            startupScanDone = true;
            clientThread.invokeLater(this::performStartupGeScan);
            return;
        }
        // Only poll during step 1 (waiting for buy item selection) and step 5/10/11 (waiting for sell item).
        if (step == 1) clientThread.invokeLater(this::checkGeAssistStep);
        if (step == 5 || step == 10 || step == 11) clientThread.invokeLater(this::checkSellAssistStep);

        // Check if the flip pick item is already in the player's inventory (idle/waiting steps).
        if (step == -1 || step == 0 || step == 8) clientThread.invokeLater(this::checkInventoryForFlipPickItem);

        // At idle/GE-open steps, detect any non-tracked SOLD offer and prompt the user to collect.
        if (step == -1 || step == 0 || step == 8) clientThread.invokeLater(this::checkForAnySoldOffer);

        // While showing inventory-item sell guidance (step 11), verify the item is still present.
        if (step == 11) clientThread.invokeLater(this::checkInventoryItemPresence);

        // At steps 0 and 8 (GE open, waiting to place a buy), check every tick whether the GE
        // is now full and redirect the user to collect/sell if so.
        if (step == 0 || step == 8) clientThread.invokeLater(this::checkFullGeRedirect);

        // At step 12 (sell completed, waiting for player to collect GP), detect collection.
        if (step == 12) clientThread.invokeLater(this::checkSoldOfferCollected);

        // At steps 2 and 3 (item selected, waiting for price / confirming), detect if the user
        // clicked the back button â€” CURRENT_GE_ITEM resets to -1/0 when they go back.
        if (step == 2 || step == 3)
        {
            clientThread.invokeLater(() ->
            {
                GEPricerItem pick = getFlipPickItem();
                if (pick == null) return;
                int currentItemId = client.getVarpValue(VarPlayer.CURRENT_GE_ITEM);
                if (currentItemId != pick.getId())
                {
                    step = 1;
                    updateAssistPanel();
                }
            });
        }

        // At steps 6, 7, and 11 (sell price / confirm / inventory sell), detect if the user left the sell screen.
        if (step == 6 || step == 7 || step == 11) clientThread.invokeLater(this::checkSellScreenBackOut);

        // Check active offer prices every 10 ticks (~6 s) and surface banners for stale prices.
        if (++priceAlertTickCounter >= 10)
        {
            priceAlertTickCounter = 0;
            clientThread.invokeLater(this::checkActiveOfferPrices);
        }

        // Scan inventory every 5 ticks (~3 s): detect sellable items and update GP budget.
        if (++inventoryTickCounter >= 5)
        {
            inventoryTickCounter = 0;
            clientThread.invokeLater(this::checkInventoryAndBudget);
        }
    }

    /**
     * Scans the player's inventory every few ticks to:
     *   1. Detect any tradeable items with pricing data and suggest sell prices.
     *   2. Count total GP (item 995) and compute per-slot buy budget (GP / empty GE slots, max 8).
     * Updates the Flip Pick panel with this context.
     * Must be called on the client thread.
     */
    private void checkInventoryAndBudget()
    {
        if (panel == null) return;

        ItemContainer inv = client.getItemContainer(InventoryID.INVENTORY);
        if (inv == null) return;

        // Count empty GE slots for budget calculation
        GrandExchangeOffer[] offers = client.getGrandExchangeOffers();
        int emptySlots = 8;
        if (offers != null)
        {
            emptySlots = 0;
            for (GrandExchangeOffer o : offers)
            {
                if (o == null || o.getState() == GrandExchangeOfferState.EMPTY) emptySlots++;
            }
        }
        int targetSlots = Math.max(1, Math.min(8, emptySlots));

        long totalGp = 0;
        // item 995 = coins
        Map<Integer, Integer> qtyByItem = new LinkedHashMap<>();
        for (Item it : inv.getItems())
        {
            if (it == null || it.getId() <= 0) continue;
            if (it.getId() == 995)
            {
                totalGp += it.getQuantity();
            }
            else
            {
                qtyByItem.merge(it.getId(), it.getQuantity(), Integer::sum);
            }
        }

        long perSlotBudget = totalGp > 0 ? totalGp / 8L : 0; // always distribute across 8 slots

        // Build sell suggestions for inventory items that have pricing data
        long sellUndercut = panel.getFlipPickSellUndercutGp();
        List<GEFlipPickPanel.InventorySellSuggestion> suggestions = new ArrayList<>();
        for (Map.Entry<Integer, Integer> entry : qtyByItem.entrySet())
        {
            GEPricerItem item = itemsById.get(entry.getKey());
            if (item == null || !item.hasPrices() || item.getInstaBuy() <= 0) continue;
            long instaBuy = item.getInstaBuy();
            long sellPrice = sellUndercut < instaBuy ? instaBuy - sellUndercut : instaBuy;
            suggestions.add(new GEFlipPickPanel.InventorySellSuggestion(
                item.getId(), item.getName(), entry.getValue(), sellPrice));
        }

        final long finalGp          = totalGp;
        final long finalBudget      = perSlotBudget;
        final List<GEFlipPickPanel.InventorySellSuggestion> finalSuggestions = suggestions;
        SwingUtilities.invokeLater(() ->
            panel.setFlipPickInventoryContext(finalSuggestions, finalGp, finalBudget));
    }

    private static final long STAGNANT_BUY_MINS = 10L;

    /**
     * Scans all active BUYING and SELLING GE offers against the current recommended prices
     * from the Flip Pick panel. Any offer whose price has drifted past the 1% (min 1000 gp)
     * threshold is surfaced as a banner at the top of the Flip Pick tab.
     * Also detects BUYING offers that haven't had a single fill in â‰¥10 minutes and surfaces
     * a stagnant-buy banner asking the player whether to keep, modify, or swap to a new item.
     * Must be called from the client thread.
     */
    private void checkActiveOfferPrices()
    {
        if (panel == null || itemsById.isEmpty()) return;
        GrandExchangeOffer[] offers = client.getGrandExchangeOffers();
        if (offers == null) return;

        long overcutGp   = panel.getFlipPickOvercutGp();
        long undercutGp  = panel.getFlipPickSellUndercutGp();

        List<GEFlipPickPanel.PriceAlert> alerts = new ArrayList<>();
        List<GEFlipPickPanel.StagnantBuyAlert> stagnantAlerts = new ArrayList<>();
        List<GEFlipPickPanel.StagnantSellAlert> stagnantSellAlerts = new ArrayList<>();
        for (int i = 0; i < offers.length && i < 8; i++)
        {
            GrandExchangeOffer offer = offers[i];
            if (offer == null) continue;
            GrandExchangeOfferState st = offer.getState();
            if (st != GrandExchangeOfferState.BUYING && st != GrandExchangeOfferState.SELLING) continue;

            GEPricerItem item = itemsById.get(offer.getItemId());

            // ---- Stagnant buy detection (BUYING only) ----
            if (st == GrandExchangeOfferState.BUYING
                && !slotTimerUnknown[i]
                && slotLastUpdate[i] != null)
            {
                long minsSinceLastFill = Duration.between(slotLastUpdate[i], Instant.now()).toMinutes();
                if (minsSinceLastFill >= STAGNANT_BUY_MINS)
                {
                    String name = item != null ? item.getName() : "Item " + offer.getItemId();
                    stagnantAlerts.add(new GEFlipPickPanel.StagnantBuyAlert(
                        offer.getItemId(), name, minsSinceLastFill, offer.getPrice()));
                }
            }

            if (item == null || !item.hasPrices()) continue;

            // Only alert on SELL offers â€” for BUY offers the stagnant banner above guides the user.
            if (st == GrandExchangeOfferState.BUYING) continue;

            // ---- Stagnant sell detection (SELLING only, â‰¥60 min) ----
            if (!slotTimerUnknown[i] && slotLastUpdate[i] != null)
            {
                long minsSinceLastFill = Duration.between(slotLastUpdate[i], Instant.now()).toMinutes();
                if (minsSinceLastFill >= 60L && item != null)
                {
                    long suggestedPrice = item.hasPrices() ? Math.max(1L, item.getInstaBuy() - undercutGp) : 0;
                    if (suggestedPrice > 0)
                    {
                        long floor   = breakEvenSellPrice(offer.getItemId(), offer.getTotalQuantity());
                        // canLower if suggested >= floor and loss per unit â‰¤ 100k total
                        long lossTotal = (offer.getPrice() - suggestedPrice) * (long) offer.getTotalQuantity();
                        boolean canLower = suggestedPrice >= floor && lossTotal <= 100_000L;
                        String name = item.getName();
                        stagnantSellAlerts.add(new GEFlipPickPanel.StagnantSellAlert(
                            offer.getItemId(), name, minsSinceLastFill,
                            offer.getPrice(), suggestedPrice, canLower));
                    }
                }
            }

            long offerPrice = offer.getPrice();
            long raw   = Math.max(1L, item.getInstaBuy() - undercutGp);
            long floor = breakEvenSellPrice(offer.getItemId(), offer.getTotalQuantity());
            long recommended = Math.max(raw, floor);

            if (recommended <= 0) continue;

            boolean profitableModification = recommended > floor;
            boolean currentBelowFloor      = floor > 0 && offerPrice < floor;
            if (!profitableModification && !currentBelowFloor) continue;

            long diff      = Math.abs(offerPrice - recommended);
            long threshold = Math.max(1000L, recommended / 100L);
            if (diff >= threshold)
            {
                alerts.add(new GEFlipPickPanel.PriceAlert(
                    item.getId(), item.getName(), false, offerPrice, recommended));
            }
        }

        List<GEFlipPickPanel.PriceAlert> finalAlerts = alerts;
        List<GEFlipPickPanel.StagnantBuyAlert> finalStagnant = stagnantAlerts;
        List<GEFlipPickPanel.StagnantSellAlert> finalStagnantSell = stagnantSellAlerts;
        // Collect IDs of all currently SELLING/SOLD offers to exclude from buy suggestions.
        Set<Integer> sellingIds = new java.util.HashSet<>();
        for (GrandExchangeOffer offer : offers)
        {
            if (offer == null) continue;
            GrandExchangeOfferState st2 = offer.getState();
            if (st2 == GrandExchangeOfferState.SELLING || st2 == GrandExchangeOfferState.SOLD)
                sellingIds.add(offer.getItemId());
        }
        SwingUtilities.invokeLater(() -> {
            activeAlertItemIds = finalAlerts.stream()
                .map(a -> a.itemId)
                .collect(java.util.stream.Collectors.toList());
            panel.setFlipPickPriceAlerts(finalAlerts);
            panel.setFlipPickStagnantBuyAlerts(finalStagnant);
            panel.setFlipPickStagnantSellAlerts(finalStagnantSell);
            panel.setFlipPickSellingItemIds(sellingIds);
        });
    }

    /**
     * Called each game tick at steps 6 and 7 to detect if the player has left the
     * sell offer setup screen (closed it or clicked back). Resets to step 5 so the
     * guidance shows the sell price again when they re-enter.
     */
    private void checkSellScreenBackOut()
    {
        if (step != 6 && step != 7 && step != 11) return;

        // At step 11 the sell screen hasn't necessarily been opened yet â€” the user
        // still needs to click the inventory item to enter the offer screen.
        // Only fire the back-out logic if the sell screen WAS previously open (i.e. step moved
        // past 11 to 6/7) but disappeared, or if the item has been loaded via checkSellAssistStep.
        // For step 11 specifically we skip the guard so the logic below can still reset to step 11.
        if (step == 11)
        {
            Widget offerContainer = client.getWidget(465, 26);
            boolean screenVisible = offerContainer != null && !offerContainer.isHidden();
            if (!screenVisible) return; // still waiting for user to open sell screen â€” no backout yet
        }

        Widget offerContainer = client.getWidget(465, 26);
        boolean screenGone = offerContainer == null || offerContainer.isHidden();
        if (!screenGone)
        {
            // Screen is visible â€” check if the item shown is no longer ours
            int currentItemId = client.getVarpValue(VarPlayer.CURRENT_GE_ITEM);
            if (currentItemId == boughtItemId) return; // still on the right screen
        }

        // Player backed out â€” return to the appropriate pre-screen step.
        // If the item is still in their inventory, show the inventory-detection guidance (step 11).
        // Otherwise fall back to step 5 (collect + sell from GE).
        ItemContainer inv = client.getItemContainer(InventoryID.INVENTORY);
        boolean itemInInventory = false;
        if (inv != null && boughtItemId > 0)
        {
            for (Item it : inv.getItems())
            {
                if (it != null && it.getId() == boughtItemId) { itemInInventory = true; break; }
            }
        }
        step = itemInInventory ? 11 : 5;
        updateAssistPanel();
    }

    /**
     * Called each game tick at step 5 to detect when the sell offer setup screen
     * has loaded with the bought item, advancing to step 6 (set sell price).
     */
    /**
     * Scans the entire inventory for any tradeable item with known pricing data.
     * Picks the highest-value sellable item (by instaBuy * qty) and jumps to
     * step 11 so the user is guided to sell it before buying anything new.
     * Runs at idle steps (-1, 0, 8) and immediately on GE open.
     * Must be called on the client thread.
     */
    private void checkInventoryForFlipPickItem()
    {
        if (step != -1 && step != 0 && step != 8) return;
        if (panel != null && panel.isFlipPickPaused()) return;

        GEPricerItem best = findBestSellableInventoryItem();
        if (best == null) return;

        ItemContainer inv = client.getItemContainer(InventoryID.INVENTORY);
        if (inv == null) return;
        int qty = 0;
        for (Item it : inv.getItems())
            if (it != null && it.getId() == best.getId()) qty += it.getQuantity();
        if (qty <= 0) return;

        long sellUndercut = panel != null ? panel.getFlipPickSellUndercutGp() : 0;
        boughtItemId     = best.getId();
        activeFlipItemId = best.getId();
        boughtItemName   = best.getName();
        boughtQuantity   = qty;
        totalQuantity    = qty;
        sellTargetPrice  = calcSellTarget(best.getId(), qty, sellUndercut);
        step = 11;
        updateAssistPanel();
    }

    /**
     * Returns the highest-value item in the player's inventory that has pricing data
     * and can be sold (instaBuy > 0), or null if none found.
     * "Highest value" = instaBuy * quantity (most GP at stake first).
     * Excludes coins (ID 995).
     */
    private GEPricerItem findBestSellableInventoryItem()
    {
        ItemContainer inv = client.getItemContainer(InventoryID.INVENTORY);
        if (inv == null || itemsById.isEmpty()) return null;

        // Aggregate quantities per item ID
        Map<Integer, Integer> qtyMap = new LinkedHashMap<>();
        for (Item it : inv.getItems())
        {
            if (it == null || it.getId() <= 0 || it.getId() == 995) continue;
            qtyMap.merge(it.getId(), it.getQuantity(), Integer::sum);
        }

        GEPricerItem best    = null;
        long         bestVal = 0;
        for (Map.Entry<Integer, Integer> e : qtyMap.entrySet())
        {
            GEPricerItem item = itemsById.get(e.getKey());
            if (item == null || !item.hasPrices() || item.getInstaBuy() <= 0) continue;
            long val = item.getInstaBuy() * (long) e.getValue();
            if (val > bestVal) { bestVal = val; best = item; }
        }
        return best;
    }

    /**
     * Called each game tick at step 11 to verify the detected inventory item is still
     * present. If it has been removed (sold, dropped, banked) the step resets to idle.
     * Must be called on the client thread.
     */
    private void checkInventoryItemPresence()
    {
        if (step != 11 || boughtItemId <= 0) return;

        ItemContainer inv = client.getItemContainer(InventoryID.INVENTORY);
        if (inv == null) return;

        for (Item it : inv.getItems())
        {
            if (it != null && it.getId() == boughtItemId) return; // still there
        }

        // Item no longer in inventory â€” check if there is another sellable item to handle next.
        boughtItemId     = -1;
        activeFlipItemId = -1;
        boughtItemName   = null;

        // Try to chain to the next highest-value sellable inventory item.
        GEPricerItem next = findBestSellableInventoryItem();
        if (next != null)
        {
            ItemContainer inv2 = client.getItemContainer(InventoryID.INVENTORY);
            int qty = 0;
            if (inv2 != null)
                for (Item it : inv2.getItems())
                    if (it != null && it.getId() == next.getId()) qty += it.getQuantity();
            if (qty > 0)
            {
                long sellUndercut = panel != null ? panel.getFlipPickSellUndercutGp() : 0;
                boughtItemId     = next.getId();
                activeFlipItemId = next.getId();
                boughtItemName   = next.getName();
                boughtQuantity   = qty;
                totalQuantity    = qty;
                sellTargetPrice  = calcSellTarget(next.getId(), qty, sellUndercut);
                step = 11;
                updateAssistPanel();
                return;
            }
        }

        // No more sellable items â€” fall back to buy guidance if GE is still open.
        Widget geMain = client.getWidget(GE_GROUP_ID, 0);
        step = (geMain != null && !geMain.isHidden()) ? 0 : -1;
        updateAssistPanel();
    }

    private void checkSellAssistStep()
    {
        if (step != 5 && step != 10 && step != 11) return;

        Widget offerContainer = client.getWidget(465, 26);
        if (offerContainer == null || offerContainer.isHidden()) return;

        if (step == 10)
        {
            // When modifying a cancelled sell, CURRENT_GE_ITEM is not updated by the game.
            // The offer screen being visible is sufficient to advance to the price-setting step.
            step = 6;
            updateAssistPanel();
            return;
        }

        int currentItemId = client.getVarpValue(VarPlayer.CURRENT_GE_ITEM);
        if (currentItemId == boughtItemId && boughtItemId > 0)
        {
            step = 6; // sell offer screen loaded with our item â€” now set quantity then price
            updateAssistPanel();
        }
    }

    /**
     * Called each game tick at steps -1, 0, and 8 (idle/waiting states) to detect
     * when any GE offer has completed (SOLD) that is not part of the tracked flip.
     * When found, advances to step 12 so the user is prompted to collect.
     */
    private void checkForAnySoldOffer()
    {
        if (step != -1 && step != 0 && step != 8) return;
        if (boughtItemId > 0) return; // tracked flip â€” handled by normal offer-changed flow
        GrandExchangeOffer[] offers = client.getGrandExchangeOffers();
        if (offers == null) return;
        for (GrandExchangeOffer o : offers)
        {
            if (o != null && o.getState() == GrandExchangeOfferState.SOLD)
            {
                step = 12;
                updateAssistPanel();
                return;
            }
        }
    }

    /**
     * Called each game tick at step 12 to detect when the player has collected
     * their GP from the completed sell offer. Once no SOLD offer remains, step
     * advances to 0 so the user can place a new buy.
     */
    private void checkSoldOfferCollected()
    {
        if (step != 12) return;
        GrandExchangeOffer[] offers = client.getGrandExchangeOffers();
        if (offers == null) return;
        for (GrandExchangeOffer o : offers)
        {
            if (o != null && o.getState() == GrandExchangeOfferState.SOLD) return; // still uncollected
        }
        // All SOLD offers collected â€” clear state and start fresh
        boughtItemId   = -1;
        boughtItemName = null;
        step = 0;
        updateAssistPanel();
    }

    /**
     * Called each game tick at step 0 or 8 to detect when the GE becomes full
     * and redirect the user to collect/sell bought items instead of buying more.
     */
    private void checkFullGeRedirect()
    {
        if (step != 0 && step != 8) return;
        if (panel != null && panel.isFlipPickPaused()) return;
        // If GE is not full, ensure we stay at step 0 (not 8)
        GrandExchangeOffer[] offers = client.getGrandExchangeOffers();
        if (offers == null) return;
        boolean anyEmpty = false;
        for (GrandExchangeOffer o : offers)
        {
            if (o.getState() == GrandExchangeOfferState.EMPTY) { anyEmpty = true; break; }
        }
        if (anyEmpty)
        {
            if (step == 8) { step = 0; updateAssistPanel(); }
            return;
        }
        // GE is full â€” run the full redirect logic
        checkAndRedirectToCollect();
    }

    /**
     * Called each game tick at step 1 to check whether the correct GE item
     * has been loaded into the offer slot. Uses VarPlayer.CURRENT_GE_ITEM
     * (the RuneLite-standard enum) rather than a hardcoded VarPlayer index.
     */
    private void checkGeAssistStep()
    {
        if (step != 1) return;

        // Verify the GE offer setup screen is visible
        Widget offerContainer = client.getWidget(465, 26);
        if (offerContainer == null || offerContainer.isHidden())
        {
            step = 0;
            updateAssistPanel();
            return;
        }

        GEPricerItem pick = getFlipPickItem();
        if (pick == null) return;

        // VarPlayer.CURRENT_GE_ITEM = the item currently loaded in the GE offer setup screen
        int currentItemId = client.getVarpValue(VarPlayer.CURRENT_GE_ITEM);
        if (currentItemId == pick.getId())
        {
            step = 2; // correct item â€” now set quantity then price
            updateAssistPanel();
        }
    }

    /** Exposes the current workflow step to the highlight overlay. */
    int getStep() { return step; }

    /** Exposes the paused state to the highlight overlay. */
    boolean isGuidancePaused() { return panel != null && panel.isFlipPickPaused(); }

    /** Exposes the sell-only mode state to the highlight overlay. */
    boolean isSellOnlyMode() { return panel != null && panel.isSellOnlyMode(); }

    /** Returns a snapshot of item IDs that currently have an active price-modify alert. */
    List<Integer> getActiveAlertItemIds() { return activeAlertItemIds; }

    /**
     * Called when the user clicks Next or Block on the Flip Pick panel while
     * the GE interface is open. Updates the assist guidance and, if the search
     * step is active, re-injects the new item into the search box.
     */
    void onFlipPickItemChanged()
    {
        updateAssistPanel();
        // If the GE search box is open (step 1), re-inject the new item suggestion.
        if (step == 1)
        {
            clientThread.invoke(this::injectFlipPickSuggestion);
        }
    }

    /** Exposes the bought item ID to the highlight overlay for inventory highlighting. */
    int getBoughtItemId() { return boughtItemId; }

    /** Pushes current assist state to the side panel. */
    private void updateAssistPanel()
    {
        if (panel == null) return;
        GEPricerItem pick = getFlipPickItem();
        long overcutGp = panel.getFlipPickOvercutGp();
        long sellUndercutGp = panel.getFlipPickSellUndercutGp();
        SwingUtilities.invokeLater(() ->
            panel.updateFlipAssist(step, pick,
                boughtItemName, boughtItemId, boughtQuantity, totalQuantity, sellTargetPrice,
                overcutGp, sellUndercutGp));
    }

    /** Injects (or re-injects) a pause/resume button directly onto the GE interface. */
    private void injectGePauseButton()
    {
        Widget root = client.getWidget(GE_GROUP_ID, 0);
        if (root == null) return;

        gePauseWidget = root.createChild(-1, WidgetType.TEXT);
        gePauseWidget.setFontId(FontID.VERDANA_11_BOLD);
        gePauseWidget.setYPositionMode(WidgetPositionMode.ABSOLUTE_TOP);
        gePauseWidget.setXPositionMode(WidgetPositionMode.ABSOLUTE_LEFT);
        gePauseWidget.setOriginalX(410);
        gePauseWidget.setOriginalY(23);
        gePauseWidget.setOriginalWidth(60);
        gePauseWidget.setOriginalHeight(14);
        gePauseWidget.setXTextAlignment(WidgetTextAlignment.LEFT);
        gePauseWidget.setHasListener(true);
        gePauseWidget.setAction(0, "Toggle guidance");
        gePauseWidget.setOnMouseRepeatListener((JavaScriptCallback) ev ->
            gePauseWidget.setTextColor(0xFFFFFF));
        gePauseWidget.setOnMouseLeaveListener((JavaScriptCallback) ev ->
            refreshGePauseWidget());
        gePauseWidget.setOnOpListener((JavaScriptCallback) ev ->
        {
            if (panel != null) panel.toggleFlipAssistPaused();
            refreshGePauseWidget();  // paused volatile already flipped synchronously
        });
        refreshGePauseWidget();
        gePauseWidget.revalidate();
    }

    /** Updates the GE pause widget text/colour to match current paused state. Must run on client thread. */
    void refreshGePauseWidget()
    {
        if (gePauseWidget == null) return;
        boolean paused = panel != null && panel.isFlipPickPaused();
        gePauseWidget.setText(paused ? "> Resume" : "|| Pause");
        gePauseWidget.setTextColor(paused ? 0x40DD40 : 0xFF8C00);
        gePauseWidget.setHidden(false);
        gePauseWidget.revalidate();
    }

    /**
     * Injects our flip pick suggestion into the GE search result widget, displayed
     * immediately when the search box opens â€” no text injection, no runScript.
     * Mimics the "previous search" approach used by flipping-copilot:
     *   child 0 = clickable background rectangle (RECTANGLE with op-listener)
     *   child 1 = "Zoom item:" label (TEXT)
     *   child 2 = item name text (TEXT)
     *   child 3 = item icon (GRAPHIC)
     *
     * Returns false to signal invokeLater to retry the next tick if the widget
     * is not ready yet.  Returns true when injection succeeds or is no longer needed.
     */
    private boolean injectFlipPickSuggestion()
    {
        // Stop retrying once the search box is closed or we move to a later step.
        if (client.getVarcIntValue(VarClientInt.INPUT_TYPE) != 14 || step != 1) return true;
        if (panel != null && panel.isFlipPickPaused()) return true;

        GEPricerItem pick = getFlipPickItem();
        if (pick == null) return true;

        Widget searchResults = client.getWidget(ComponentID.CHATBOX_GE_SEARCH_RESULTS);
        if (searchResults == null) return false; // widget not ready yet â€” retry

        int    itemId   = pick.getId();
        String itemName = pick.getName();

        // Check if previous search children already exist (game-created or previously injected).
        // The game creates static children for the "Previous search:" row when the player
        // has a stored last-search item.  We also detect our own previously-injected row.
        boolean previousSearchChildrenExist = hasPreviousSearchChildren(searchResults);

        if (previousSearchChildrenExist)
        {
            // Modify existing static children to show our suggested item.
            Widget clickRect = searchResults.getChild(0);
            if (clickRect != null)
            {
                clickRect.setHasListener(true);
                clickRect.setOnOpListener(754, itemId, 84);
                clickRect.setOnKeyListener(754, itemId, -2147483640);
                clickRect.setName("<col=ff9040>" + itemName + "</col>");
                clickRect.setAction(0, "Select");
                clickRect.revalidate();
            }

            Widget labelText = searchResults.getChild(1);
            if (labelText != null)
            {
                labelText.setText("Flip Pick:");
                labelText.setOriginalWidth(95);
                labelText.setXTextAlignment(WidgetTextAlignment.LEFT);
                labelText.revalidate();
            }

            Widget nameText = searchResults.getChild(2);
            if (nameText != null)
            {
                nameText.setText(itemName);
                nameText.revalidate();
            }

            Widget iconWidget = searchResults.getChild(3);
            if (iconWidget != null)
            {
                iconWidget.setItemId(itemId);
                iconWidget.revalidate();
            }
        }
        else
        {
            // No previous search children â€” create from scratch at specific indices.

            // child 0: clickable background rectangle
            Widget bg = searchResults.createChild(0, WidgetType.RECTANGLE);
            bg.setTextColor(0xFFFFFF);
            bg.setOpacity(255);
            bg.setName("<col=ff9040>" + itemName + "</col>");
            bg.setHasListener(true);
            bg.setFilled(true);
            bg.setOriginalX(114);
            bg.setOriginalY(0);
            bg.setOriginalWidth(256);
            bg.setOriginalHeight(32);
            bg.setOnOpListener(754, itemId, 84);
            bg.setOnKeyListener(754, itemId, -2147483640);
            bg.setHasListener(true);
            bg.setAction(0, "Select");
            bg.setOnMouseOverListener((JavaScriptCallback) ev -> bg.setOpacity(200));
            bg.setOnMouseLeaveListener((JavaScriptCallback) ev -> bg.setOpacity(255));
            bg.revalidate();

            // child 1: "Flip Pick:" label
            Widget label = searchResults.createChild(1, WidgetType.TEXT);
            label.setText("Flip Pick:");
            label.setFontId(495);
            label.setOriginalX(114);
            label.setOriginalY(0);
            label.setOriginalWidth(95);
            label.setOriginalHeight(32);
            label.setYTextAlignment(1);
            label.revalidate();

            // child 2: item name text
            Widget name = searchResults.createChild(2, WidgetType.TEXT);
            name.setText(itemName);
            name.setFontId(495);
            name.setOriginalX(254);
            name.setOriginalY(0);
            name.setOriginalWidth(116);
            name.setOriginalHeight(32);
            name.setYTextAlignment(1);
            name.revalidate();

            // child 3: item icon
            Widget icon = searchResults.createChild(3, WidgetType.GRAPHIC);
            icon.setItemId(itemId);
            icon.setItemQuantity(1);
            icon.setItemQuantityMode(0);
            icon.setRotationX(550);
            icon.setModelZoom(1031);
            icon.setBorderType(1);
            icon.setOriginalX(214);
            icon.setOriginalY(0);
            icon.setOriginalWidth(36);
            icon.setOriginalHeight(32);
            icon.revalidate();
        }
        return true;
    }

    /**
     * Checks whether static children already exist on the search results widget â€”
     * either the game's own "Previous search:" row or our previously-injected row.
     */
    private boolean hasPreviousSearchChildren(Widget searchResults)
    {
        Widget[] children = searchResults.getChildren();
        if (children == null || children.length < 2) return false;
        for (Widget child : children)
        {
            if (child == null) continue;
            String text = child.getText();
            if (text == null) continue;
            if (text.startsWith("Flip Pick:") || text.startsWith("Previous search:"))
            {
                return true;
            }
        }
        return false;
    }

    /**
     * Detects whether the currently-open chatbox input dialog (inputType==7) is a
     * PRICE dialog ("Set a price for each item:") or a QUANTITY dialog ("How many").
     * Reads the chatbox message widget text to distinguish them. Must run on client thread.
     * Saves the result in {@code lastDialogWasPrice} for use when the dialog closes.
     * Then delegates to {@link #showQuantityClickWidget()} or {@link #showPriceClickWidget()}.
     */
    private void showDialogClickWidget()
    {
        if (client.getVarcIntValue(VarClientInt.INPUT_TYPE) != 7) return;

        // Try to read the chatbox message text to determine which dialog is open.
        // widget 162:44 = MES_TEXT2 (message body); widget 162:41 = title area.
        // Price dialog shows "Set a price for each item:" / "Enter price".
        // Quantity dialog shows "How many do you wish to buy/sell?" / "Enter amount".
        boolean isPrice = true; // safe default
        int[] children = {44, 41, 43, 40, 38};
        outer:
        for (int childId : children)
        {
            Widget w = client.getWidget(162, childId);
            if (w == null) continue;
            String txt = w.getText();
            if (txt == null || txt.isEmpty()) continue;
            String lower = txt.toLowerCase();
            if (lower.contains("price"))                         { isPrice = true;  break outer; }
            if (lower.contains("how many") || lower.contains("amount")) { isPrice = false; break outer; }
        }

        lastDialogWasPrice = isPrice;
        if (isPrice)
            showPriceClickWidget();
        else
            showQuantityClickWidget();
    }

    /**
     * Adds a clickable text widget inside the chatbox quantity-entry dialog showing
     * the FlipPick suggested quantity (buy limit). Clicking it sets the quantity.
     */
    private void showQuantityClickWidget()
    {
        if (client.getVarcIntValue(VarClientInt.INPUT_TYPE) != 7) return;

        int    qty = -1;
        String label;
        if (step == 2)
        {
            GEPricerItem pick = getFlipPickItem();
            if (pick != null && pick.getBuyLimit() > 0)
            {
                qty = pick.getBuyLimit();
                // If instaSell is very high-value, suggest qty 1 instead
                long overcut = panel != null ? panel.getFlipPickOvercutGp() : 0;
                if (pick.getInstaSell() + overcut > 10_000_000L) qty = 1;
            }
            label = qty > 0
                ? "set qty to buy limit: " + String.format("%,d", qty)
                : "no buy limit available";
        }
        else if (step == 6)
        {
            qty = totalQuantity > 0 ? totalQuantity : -1;
            label = qty > 0
                ? "set qty to bought amount: " + String.format("%,d", qty)
                : "no quantity available";
        }
        else return;

        Widget parent = client.getWidget(10616871);
        if (parent == null) return;

        final int finalQty = qty;

        Widget text = parent.createChild(-1, WidgetType.TEXT);
        text.setFontId(FontID.VERDANA_11_BOLD);
        text.setTextColor(0x00A000);
        text.setYPositionMode(WidgetPositionMode.ABSOLUTE_TOP);
        text.setOriginalX(10);
        text.setOriginalY(35);
        text.setOriginalHeight(20);
        text.setXTextAlignment(WidgetTextAlignment.LEFT);
        text.setWidthMode(WidgetSizeMode.MINUS);
        text.setHasListener(true);
        text.setText(label);
        text.setOnMouseRepeatListener((JavaScriptCallback) ev -> text.setTextColor(0xFFFFFF));
        text.setOnMouseLeaveListener((JavaScriptCallback) ev -> text.setTextColor(0x00A000));
        text.revalidate();

        if (finalQty > 0)
        {
            text.setAction(0, "Set quantity");
            text.setOnOpListener((JavaScriptCallback) ev ->
            {
                Widget displayWidget = client.getWidget(10616876);
                if (displayWidget != null)
                    displayWidget.setText(finalQty + "*");
                client.setVarcStrValue(VarClientStr.INPUT_TEXT, String.valueOf(finalQty));
            });
        }
    }

    /**
     * Adds a clickable text widget inside the chatbox price-entry dialog showing
     * the FlipPick suggested price. Clicking it sets the price â€” exactly matching
     * the approach used by Flipping Utilities and Flipping Copilot.
     *
     * Key ordering: revalidate() FIRST, then set action + op-listener.
     * Both FU and copilot follow this pattern â€” revalidate after op-listener
     * appears to clear the listener in some client versions.
     */
    private void showPriceClickWidget()
    {
        if (client.getVarcIntValue(VarClientInt.INPUT_TYPE) != 7) return;

        int    price = -1;
        String label;
        if (step == 2)
        {
            GEPricerItem pick = getFlipPickItem();
            long overcut = panel != null ? panel.getFlipPickOvercutGp() : 0;
            if (pick != null && pick.getInstaSell() > 0) price = (int)(pick.getInstaSell() + overcut);
            label = price > 0
                ? "set to FlipPick buy price: " + String.format("%,d", price) + " gp"
                : "no FlipPick price available";
        }
        else if (step == 6 || step == 11)
        {
            if (sellTargetPrice > 0) price = (int) sellTargetPrice;
            label = price > 0
                ? "set to FlipPick sell price: " + String.format("%,d", price) + " gp"
                : "no sell price available";
        }
        else if (step == 9)
        {
            if (sellTargetPrice > 0) price = (int) sellTargetPrice;
            label = price > 0
                ? "re-buy at: " + String.format("%,d", price) + " gp"
                : "no re-buy price available";
        }
        else return;

        // MES_LAYER = interface 162, child 39 = 10616871 (gameval: InterfaceID.Chatbox.MES_LAYER)
        // This is where FU creates its price suggestion widgets â€” 2 children past CHATBOX_CONTAINER (37)
        Widget parent = client.getWidget(10616871);
        if (parent == null) return;

        final int finalPrice = price;

        // Step 1: create widget and set layout/appearance properties
        Widget text = parent.createChild(-1, WidgetType.TEXT);
        text.setFontId(FontID.VERDANA_11_BOLD);
        text.setTextColor(0x00A000);
        text.setYPositionMode(WidgetPositionMode.ABSOLUTE_TOP);
        text.setOriginalX(10);
        text.setOriginalY(35);
        text.setOriginalHeight(20);
        text.setXTextAlignment(WidgetTextAlignment.LEFT);
        text.setWidthMode(WidgetSizeMode.MINUS);
        text.setHasListener(true);
        text.setText(label);
        text.setOnMouseRepeatListener((JavaScriptCallback) ev -> text.setTextColor(0xFFFFFF));
        text.setOnMouseLeaveListener((JavaScriptCallback) ev -> text.setTextColor(0x00A000));

        // Step 2: revalidate to commit layout â€” BEFORE setting action/op-listener
        text.revalidate();

        // Step 3: set action and op-listener AFTER revalidate (matches FU pattern exactly)
        if (finalPrice > 0)
        {
            text.setAction(0, "Set price");
            text.setOnOpListener((JavaScriptCallback) ev ->
            {
                // MES_TEXT2 = interface 162, child 44 = 10616876 (gameval: InterfaceID.Chatbox.MES_TEXT2)
                // This is the ACTUAL display widget FU uses â€” NOT CHATBOX_FULL_INPUT (child 42)
                Widget displayWidget = client.getWidget(10616876);
                if (displayWidget != null)
                {
                    displayWidget.setText(finalPrice + "*");
                }
                client.setVarcStrValue(VarClientStr.INPUT_TEXT, String.valueOf(finalPrice));
            });
        }
    }

    /**
     * Track completed buys/sells for the stats tab, and drive the guided
     * overlay steps 4 (buying in progress) and 5 (bought â†’ show sell price).
     */
    @Subscribe
    public void onGrandExchangeOfferChanged(GrandExchangeOfferChanged event)
    {
        if (tradeSession == null) return;
        if (panel != null && panel.isFlipPickPaused()) return;
        // Suppress all offer events until the startup reconciliation scan has run on the
        // first game tick. This prevents login-time offer-state events (BUYING/SELLING for
        // pre-existing offers) from resetting the guided-workflow step to 0 before the
        // scan has had a chance to set the correct step from actual GE contents.
        if (!startupScanDone) return;

        GrandExchangeOffer      offer = event.getOffer();
        GrandExchangeOfferState state = offer.getState();
        int slot = event.getSlot();

        // Update slot activity timer state for this slot; persist immediately so that
        // a reconnect (DC) loads the correct fresh timestamp rather than stale config data.
        boolean prevUnknown = slotTimerUnknown[slot];
        Instant prevUpdate  = slotLastUpdate[slot];
        updateSlotTimerState(slot, offer);
        if (slotLastUpdate[slot] != prevUpdate || (prevUnknown && !slotTimerUnknown[slot]))
        {
            executor.execute(this::saveSlotTimers);
        }
        {
            GEPricerItem pick  = getFlipPickItem();
            boolean isOurFlip = (pick != null && offer.getItemId() == pick.getId())
                                 || offer.getItemId() == activeFlipItemId
                                 || offer.getItemId() == boughtItemId;

            if (isOurFlip)
            {
                GEPricerItem item = itemsById.get(offer.getItemId());

                if (state == GrandExchangeOfferState.BUYING)
                {
                    activeFlipItemId = offer.getItemId();
                    // Skip this item in the Flip Pick so the next best candidate is suggested
                    if (panel != null) SwingUtilities.invokeLater(() -> panel.skipFlipPickItem());
                    // If the GE is now full, guide to collect/sell instead of buying more
                    if (!checkAndRedirectToCollect())
                    {
                        step = 0;
                        updateAssistPanel();
                    }
                }
                else if (state == GrandExchangeOfferState.BOUGHT)
                {
                    activeFlipItemId = offer.getItemId();
                    boughtItemId     = offer.getItemId();
                    boughtItemName   = item != null ? item.getName() : "Item " + offer.getItemId();
                    boughtQuantity   = offer.getQuantitySold();
                    totalQuantity    = offer.getTotalQuantity();
                    long sellUndercut = panel != null ? panel.getFlipPickSellUndercutGp() : 0;
                    sellTargetPrice = calcSellTarget(offer.getItemId(), offer.getQuantitySold(), sellUndercut);
                    step = 5; // enter sell guidance flow
                    updateAssistPanel();
                }
                else if (state == GrandExchangeOfferState.SELLING)
                {
                    // Sell offer confirmed â€” clear tracked buy state immediately
                    activeFlipItemId = -1;
                    boughtItemId     = -1;
                    boughtItemName   = null;
                    if (!checkAndRedirectToCollect())
                    {
                        step = 0;
                        updateAssistPanel();
                    }
                }
                else if (state == GrandExchangeOfferState.SOLD)
                {
                    int completedId  = offer.getItemId();
                    GEPricerItem soldItem = itemsById.get(completedId);
                    // Keep boughtItemId/boughtItemName set so step 12 can display the item name.
                    boughtItemId     = completedId;
                    boughtItemName   = soldItem != null ? soldItem.getName() : boughtItemName;
                    activeFlipItemId = -1;
                    // Un-skip so the item can be suggested as a Flip Pick again
                    if (panel != null) SwingUtilities.invokeLater(() -> panel.unskipFlipPickItem(completedId));
                    // Prompt user to collect GP before placing a new buy
                    step = 12;
                    updateAssistPanel();
                }
                else if (state == GrandExchangeOfferState.CANCELLED_BUY)
                {
                    // Buy was cancelled â€” skip this item and guide user to pick a different one.
                    if (panel != null) SwingUtilities.invokeLater(() -> panel.skipFlipPickItem());
                    activeFlipItemId = -1;
                    boughtItemId     = -1;
                    boughtItemName   = null;
                    sellTargetPrice  = 0;
                    step = 0;
                    updateAssistPanel();
                }
                else if (state == GrandExchangeOfferState.CANCELLED_SELL)
                {
                    // User aborted a sell â€” tell them the price to re-sell at (step 10)
                    // boughtItemId/boughtItemName/sellTargetPrice are still set from the buy phase
                    step = 10;
                    updateAssistPanel();
                }
            }
        }

        // ---- Stats tracking ----
        if (state == GrandExchangeOfferState.BOUGHT)
        {
            GEPricerItem item = itemsById.get(offer.getItemId());
            String name = item != null ? item.getName() : "Item " + offer.getItemId();
            tradeSession.onBought(offer.getItemId(), name,
                                  offer.getQuantitySold(), (long) offer.getSpent());
            if (config.enableNotifications())
                notifier.notify("Bought " + offer.getQuantitySold() + "\u00d7 " + name + " \u2014 ready to sell.");
            saveSession();
            SwingUtilities.invokeLater(() -> { if (panel != null) panel.refreshStats(); });
        }
        else if (state == GrandExchangeOfferState.SOLD)
        {
            GEPricerItem item = itemsById.get(offer.getItemId());
            String name = item != null ? item.getName() : "Item " + offer.getItemId();
            long gross   = (long) offer.getSpent();
            long tax     = Math.min((long) Math.floor(gross * 0.02), 5_000_000L);
            long netRecv = gross - tax;
            long buySpent = tradeSession.peekBuySpent(offer.getItemId());
            long profit   = buySpent >= 0 ? netRecv - buySpent : Long.MIN_VALUE;
            tradeSession.onSold(offer.getItemId(), name,
                                offer.getQuantitySold(), netRecv, tax);
            if (config.enableNotifications())
            {
                String profStr = profit != Long.MIN_VALUE
                    ? " | " + (profit >= 0 ? "+" : "") + GEPricerItemPanel.compactGp(profit) + " gp"
                    : "";
                notifier.notify("Sold " + offer.getQuantitySold() + "\u00d7 " + name + profStr);
            }
            saveSession();
            if (profit != Long.MIN_VALUE)
            {
                final int  slotIdx    = slot;
                final long flipProfit = profit;
                overlayManager.add(new GpDropOverlay(overlayManager, client, flipProfit, slotIdx));
            }
            SwingUtilities.invokeLater(() -> { if (panel != null) panel.refreshStats(); });
        }
    }

    /**
     * Called on the first game tick after each login to reconcile actual GE offer state
     * with the persisted assist state.  Handles offer completions that occurred while the
     * player was logged out, updates stats, and sets the correct guided-workflow step.
     * Must be called on the client thread.
     */
    private void performStartupGeScan()
    {
        if (tradeSession == null) return;
        GrandExchangeOffer[] offers = client.getGrandExchangeOffers();
        if (offers == null)
        {
            updateAssistPanel();
            return;
        }

        // ---- Stats: record completions that happened while offline ----
        boolean statsUpdated = false;
        for (GrandExchangeOffer o : offers)
        {
            if (o == null) continue;
            GrandExchangeOfferState st = o.getState();
            GEPricerItem item = itemsById.get(o.getItemId());
            String name = item != null ? item.getName() : "Item " + o.getItemId();

            if (st == GrandExchangeOfferState.BOUGHT)
            {
                // Only add to pendingBuys if not already present â€” avoids double-counting
                // when the offer was in BOUGHT state at logout and fires again on login.
                if (!tradeSession.hasPendingBuy(o.getItemId()))
                {
                    tradeSession.onBought(o.getItemId(), name,
                            o.getQuantitySold(), (long) o.getSpent());
                    statsUpdated = true;
                }
            }
            else if (st == GrandExchangeOfferState.SOLD)
            {
                // Only record if there is a matching pending buy â€” this means the sell
                // completed while offline (between RL sessions).  If no pending buy exists
                // the SOLD event already fired in-session and was recorded then; processing
                // it again would create a duplicate unmatched "?" entry.
                if (tradeSession.hasPendingBuy(o.getItemId()))
                {
                    long gross = (long) o.getSpent();
                    long tax   = Math.min((long) Math.floor(gross * 0.02), 5_000_000L);
                    tradeSession.onSold(o.getItemId(), name,
                            o.getQuantitySold(), gross - tax, tax);
                    statsUpdated = true;
                }
            }
        }
        if (statsUpdated)
        {
            saveSession();
            SwingUtilities.invokeLater(() -> { if (panel != null) panel.refreshStats(); });
        }

        // Mark any pre-existing BUYING/SELLING offers as unknown start time for slot timers.
        // We can't know when they were placed, so we don't show inaccurate elapsed times.
        for (int i = 0; i < offers.length && i < 8; i++)
        {
            GrandExchangeOffer o = offers[i];
            if (o == null || o.getItemId() == 0) continue;
            GrandExchangeOfferState st = o.getState();
            if (st == GrandExchangeOfferState.BUYING || st == GrandExchangeOfferState.SELLING)
            {
                slotIsBuy[i] = (st == GrandExchangeOfferState.BUYING);
                // Only mark unknown if we have no persisted timestamp from a previous session
                if (slotTradeStart[i] == null)
                    slotTimerUnknown[i] = true;
            }
        }

        // ---- Step guidance: set step from current offer state (highest priority first) ----

        // Priority 1: a BOUGHT (filled buy, not yet collected) offer exists â†’ guide to collect+sell
        for (GrandExchangeOffer o : offers)
        {
            if (o == null) continue;
            if (o.getState() == GrandExchangeOfferState.BOUGHT)
            {
                GEPricerItem item = itemsById.get(o.getItemId());
                long sellUndercut = panel != null ? panel.getFlipPickSellUndercutGp() : 0;
                activeFlipItemId = o.getItemId();
                boughtItemId     = o.getItemId();
                boughtItemName   = item != null ? item.getName()
                        : (boughtItemName != null ? boughtItemName : "Item " + o.getItemId());
                boughtQuantity   = o.getQuantitySold();
                totalQuantity    = o.getTotalQuantity();
                sellTargetPrice  = calcSellTarget(o.getItemId(), o.getQuantitySold(), sellUndercut);
                step = 5;
                updateAssistPanel();
                return;
            }
        }

        // Priority 2: a SOLD (completed sell, not yet collected) offer exists â†’ guide to collect GP
        for (GrandExchangeOffer o : offers)
        {
            if (o == null) continue;
            if (o.getState() == GrandExchangeOfferState.SOLD)
            {
                if (boughtItemId > 0)
                {
                    GEPricerItem item = itemsById.get(boughtItemId);
                    if (item != null) boughtItemName = item.getName();
                }
                step = 12;
                updateAssistPanel();
                return;
            }
        }

        // Priority 3: our tracked item is still filling (BUYING offer in progress)
        if (boughtItemId > 0)
        {
            for (GrandExchangeOffer o : offers)
            {
                if (o == null) continue;
                if (o.getItemId() == boughtItemId && o.getState() == GrandExchangeOfferState.BUYING)
                {
                    boughtQuantity = o.getQuantitySold();
                    totalQuantity  = o.getTotalQuantity();
                    step = 4;
                    updateAssistPanel();
                    return;
                }
            }

            // Priority 4: our tracked item is in a SELLING offer (sell in progress)
            for (GrandExchangeOffer o : offers)
            {
                if (o == null) continue;
                if (o.getItemId() == boughtItemId && o.getState() == GrandExchangeOfferState.SELLING)
                {
                    if (step < 7) step = 7;
                    updateAssistPanel();
                    return;
                }
            }
        }

        // No actionable offers found.  If the saved step was mid-flow (e.g. step 4 with no
        // matching BUYING offer because the fill completed and was collected before login),
        // reset to idle so guidance doesn't get stuck.
        if (step > 3 && step != 12)
        {
            boughtItemId     = -1;
            activeFlipItemId = -1;
            boughtItemName   = null;
            step             = -1;
        }
        updateAssistPanel();
    }

    /**
     * Checks whether all 8 GE slots are occupied (no EMPTY slot).
     * If full and a BOUGHT slot exists, populates boughtItem* fields and sets step = 5 (collect + sell).
     * If full but no BOUGHT slot exists, sets step = 8 (waiting for items to fill).
     * Returns true if the GE is full (caller should NOT fall through to step = 0).
     * Must be called on the client thread.
     */
    private boolean checkAndRedirectToCollect()
    {
        GrandExchangeOffer[] offers = client.getGrandExchangeOffers();
        if (offers == null) return false;

        // Check if any slot is empty â€” if so the GE is not full, no redirect needed.
        for (GrandExchangeOffer o : offers)
        {
            if (o.getState() == GrandExchangeOfferState.EMPTY) return false;
        }

        // GE is full. Look for the first BOUGHT slot so we can guide to collect + sell.
        for (GrandExchangeOffer o : offers)
        {
            if (o.getState() == GrandExchangeOfferState.BOUGHT)
            {
                GEPricerItem item    = itemsById.get(o.getItemId());
                activeFlipItemId     = o.getItemId();
                boughtItemId         = o.getItemId();
                boughtItemName       = item != null ? item.getName() : "Item " + o.getItemId();
                boughtQuantity       = o.getQuantitySold();
                totalQuantity        = o.getTotalQuantity();
                long sellUndercut    = panel != null ? panel.getFlipPickSellUndercutGp() : 0;
                sellTargetPrice      = calcSellTarget(o.getItemId(), o.getQuantitySold(), sellUndercut);
                step = 5;
                updateAssistPanel();
                return true;
            }
        }

        // Full but nothing to collect yet â€” all offers still filling/selling.
        step = 8;
        updateAssistPanel();
        return true;
    }

    /**
     * Read the current Flip Pick from the panel's flipPickPanel field.
     * Returns null if no item is available.
     */
    GEPricerItem getFlipPickItem()
    {
        if (panel == null) return null;
        return panel.getFlipPickItem();
    }

    /**
     * Returns the minimum sell price per unit that avoids a loss on an item the user bought.
     * Formula: ceil( buySpent / qty ) + 1  â€” enough to cover cost + 1 gp per unit after 2% GE tax.
     * More precisely: we need sellPrice_per_unit such that sellPrice * 0.98 >= costPerUnit,
     * so sellPrice >= ceil(costPerUnit / 0.98).
     *
     * Returns 0 if no buy is recorded for this item (no floor can be determined).
     *
     * @param itemId   OSRS item ID of the item being sold
     * @param qty      quantity being sold (from the offer / inventory)
     */
    private long breakEvenSellPrice(int itemId, int qty)
    {
        if (tradeSession == null || qty <= 0) return 0;
        long buySpent = tradeSession.peekBuySpent(itemId);
        if (buySpent <= 0) return 0;
        double costPerUnit = (double) buySpent / qty;
        return (long) Math.ceil(costPerUnit / 0.98);
    }

    /** Computes the recommended sell target: instaBuy minus undercut, floored at break-even. */
    private long calcSellTarget(int itemId, int qty, long sellUndercut)
    {
        GEPricerItem it = itemsById.get(itemId);
        long ib  = (it != null) ? it.getInstaBuy() : 0;
        long raw = ib > 0 ? (sellUndercut < ib ? ib - sellUndercut : ib) : 0;
        long floor = breakEvenSellPrice(itemId, qty);
        return raw > 0 ? Math.max(raw, floor) : floor;
    }

    // (onGrandExchangeOfferChanged merged above â€” handles stats tracking)

    // -----------------------------------------------------------------------
    // Session persistence
    // -----------------------------------------------------------------------

    private static final String CONFIG_GROUP   = "gepricer";
    private static final String CONFIG_SESSION = "tradeSession";

    /** Serialises the current trade session to ConfigManager. */
    private void saveSession()
    {
        if (tradeSession == null || configManager == null) return;
        try
        {
            configManager.setConfiguration(CONFIG_GROUP, CONFIG_SESSION, tradeSession.toJsonString());
        }
        catch (Exception e)
        {
            log.warn("GEPricer: failed to save trade session", e);
        }
    }

    /** Loads a previously saved trade session from ConfigManager into the current session. */
    private void loadSession()
    {
        if (tradeSession == null || configManager == null) return;
        try
        {
            String raw = configManager.getConfiguration(CONFIG_GROUP, CONFIG_SESSION);
            tradeSession.loadFromJsonString(raw);
        }
        catch (Exception e)
        {
            log.warn("GEPricer: failed to load saved trade session", e);
        }
    }

    /** Clears the persisted trade session from ConfigManager (called on stats Reset). */
    void clearSavedSession()
    {
        if (configManager != null)
        {
            configManager.unsetConfiguration(CONFIG_GROUP, CONFIG_SESSION);
            configManager.unsetConfiguration(CONFIG_GROUP, CONFIG_ASSIST_STATE);
        }
    }

    private static final String CONFIG_ASSIST_STATE = "assistState";
    private static final String CONFIG_SLOT_TIMERS   = "slotTimers";

    /**
     * Serialises the current GE assist workflow state (step + item context) to ConfigManager
     * so it can be restored after a logout / client restart.
     */
    private void saveAssistState()
    {
        if (configManager == null) return;
        try
        {
            JsonObject obj = new JsonObject();
            obj.addProperty("step",             step);
            obj.addProperty("activeFlipItemId", activeFlipItemId);
            obj.addProperty("boughtItemId",     boughtItemId);
            obj.addProperty("boughtItemName",   boughtItemName != null ? boughtItemName : "");
            obj.addProperty("boughtQuantity",   boughtQuantity);
            obj.addProperty("totalQuantity",    totalQuantity);
            obj.addProperty("sellTargetPrice",  sellTargetPrice);
            configManager.setConfiguration(CONFIG_GROUP, CONFIG_ASSIST_STATE, obj.toString());
        }
        catch (Exception e)
        {
            log.warn("GEPricer: failed to save assist state", e);
        }
    }

    /**
     * Restores the GE assist workflow state saved by {@link #saveAssistState()}.
     * Must be called after the panel has been created.
     */
    private void loadAssistState()
    {
        if (configManager == null) return;
        try
        {
            String raw = configManager.getConfiguration(CONFIG_GROUP, CONFIG_ASSIST_STATE);
            if (raw == null || raw.isBlank()) return;
            JsonObject obj = new JsonParser().parse(raw).getAsJsonObject();
            step             = obj.has("step")             ? obj.get("step").getAsInt()            : -1;
            activeFlipItemId = obj.has("activeFlipItemId") ? obj.get("activeFlipItemId").getAsInt(): -1;
            boughtItemId     = obj.has("boughtItemId")     ? obj.get("boughtItemId").getAsInt()    : -1;
            String name      = obj.has("boughtItemName")   ? obj.get("boughtItemName").getAsString(): "";
            boughtItemName   = name.isBlank() ? null : name;
            boughtQuantity   = obj.has("boughtQuantity")   ? obj.get("boughtQuantity").getAsInt()  : 0;
            totalQuantity    = obj.has("totalQuantity")    ? obj.get("totalQuantity").getAsInt()   : 0;
            sellTargetPrice  = obj.has("sellTargetPrice")  ? obj.get("sellTargetPrice").getAsLong(): 0;
            // Reflect restored step in the assist panel immediately
            if (panel != null) SwingUtilities.invokeLater(this::updateAssistPanel);
        }
        catch (Exception e)
        {
            log.warn("GEPricer: failed to load assist state", e);
            step = -1;
        }
    }

    // -----------------------------------------------------------------------
    // Slot timer persistence helpers
    // -----------------------------------------------------------------------

    private void saveSlotTimers()
    {
        if (configManager == null) return;
        try
        {
            JsonArray arr = new JsonArray();
            for (int i = 0; i < 8; i++)
            {
                JsonObject obj = new JsonObject();
                obj.addProperty("tradeStart",  slotTradeStart[i]  != null ? slotTradeStart[i].getEpochSecond()  : 0L);
                obj.addProperty("lastUpdate",  slotLastUpdate[i]  != null ? slotLastUpdate[i].getEpochSecond()  : 0L);
                obj.addProperty("isBuy",       slotIsBuy[i]);
                obj.addProperty("isComplete",  slotIsComplete[i]);
                obj.addProperty("unknown",     slotTimerUnknown[i]);
                obj.addProperty("lastQty",     slotLastQty[i]);
                arr.add(obj);
            }
            configManager.setConfiguration(CONFIG_GROUP, CONFIG_SLOT_TIMERS, arr.toString());
        }
        catch (Exception e)
        {
            log.warn("GEPricer: failed to save slot timers", e);
        }
    }

    private void loadSlotTimers()
    {
        if (configManager == null) return;
        try
        {
            String raw = configManager.getConfiguration(CONFIG_GROUP, CONFIG_SLOT_TIMERS);
            if (raw == null || raw.isBlank()) return;
            JsonArray arr = new JsonParser().parse(raw).getAsJsonArray();
            for (int i = 0; i < arr.size() && i < 8; i++)
            {
                JsonObject obj = arr.get(i).getAsJsonObject();
                long ts = obj.has("tradeStart") ? obj.get("tradeStart").getAsLong() : 0L;
                long lu = obj.has("lastUpdate") ? obj.get("lastUpdate").getAsLong() : 0L;
                slotTradeStart[i]   = ts > 0 ? Instant.ofEpochSecond(ts) : null;
                slotLastUpdate[i]   = lu > 0 ? Instant.ofEpochSecond(lu) : null;
                slotIsBuy[i]        = obj.has("isBuy")      && obj.get("isBuy").getAsBoolean();
                slotIsComplete[i]   = obj.has("isComplete") && obj.get("isComplete").getAsBoolean();
                slotTimerUnknown[i] = obj.has("unknown")    ? obj.get("unknown").getAsBoolean()
                                                             : (slotTradeStart[i] == null);
                slotLastQty[i]      = obj.has("lastQty")    ? obj.get("lastQty").getAsInt() : -1;
            }
        }
        catch (Exception e)
        {
            log.warn("GEPricer: failed to load slot timers", e);
        }
    }

    // -----------------------------------------------------------------------
    // Coin-icon used in the navigation button
    // -----------------------------------------------------------------------
    private static BufferedImage buildIcon()
    {
        BufferedImage img = new BufferedImage(16, 16, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = img.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);

        // Gold coin body
        g.setColor(new Color(220, 165, 25));
        g.fillOval(1, 1, 14, 14);

        // Coin rim
        g.setColor(new Color(160, 115, 10));
        g.setStroke(new BasicStroke(1.2f));
        g.drawOval(1, 1, 14, 14);

        // "G" letter
        g.setColor(new Color(255, 230, 100));
        g.setFont(new Font("SansSerif", Font.BOLD, 8));
        FontMetrics fm = g.getFontMetrics();
        String letter = "G";
        int tx = (16 - fm.stringWidth(letter)) / 2;
        int ty = (16 - fm.getHeight()) / 2 + fm.getAscent();
        g.drawString(letter, tx, ty);

        g.dispose();
        return img;
    }

    // -----------------------------------------------------------------------

    @Provides
    GEPricerConfig provideConfig(ConfigManager configManager)
    {
        return configManager.getConfig(GEPricerConfig.class);
    }

    // -----------------------------------------------------------------------
    // Slot activity timers â€” mirrors the Flipping Utilities SlotActivityTimer
    // -----------------------------------------------------------------------

    /**
     * Updates per-slot timer state whenever an offer event fires.
     * Called from {@link #onGrandExchangeOfferChanged} on the client thread.
     */
    private void updateSlotTimerState(int slot, GrandExchangeOffer offer)
    {
        if (slot < 0 || slot >= 8) return;
        GrandExchangeOfferState state = offer.getState();

        if (offer.getItemId() == 0)
        {
            // Slot emptied (offer collected) â€” clear timer state
            slotTradeStart[slot]   = null;
            slotLastUpdate[slot]   = null;
            slotTimerUnknown[slot] = true;
            slotIsComplete[slot]   = false;
            slotLastQty[slot]      = -1;
            return;
        }

        boolean isBuy = state == GrandExchangeOfferState.BUYING
                     || state == GrandExchangeOfferState.BOUGHT
                     || state == GrandExchangeOfferState.CANCELLED_BUY;
        slotIsBuy[slot] = isBuy;

        boolean isComplete = state == GrandExchangeOfferState.BOUGHT
                          || state == GrandExchangeOfferState.SOLD
                          || state == GrandExchangeOfferState.CANCELLED_BUY
                          || state == GrandExchangeOfferState.CANCELLED_SELL;

        int     newQty      = offer.getQuantitySold();
        int     prevQty     = slotLastQty[slot];      // -1 = first event ever this process lifetime
        boolean prevComplete = slotIsComplete[slot];

        slotIsComplete[slot]   = isComplete;
        slotTimerUnknown[slot] = false;
        slotLastQty[slot]      = newQty;

        // Determine whether this is a genuine new state change vs. a reconnect/duplicate event
        // that carries the same quantitySold we already persisted.
        //
        // We must NOT overwrite slotLastUpdate with Instant.now() for reconnect events because
        // that would reset the "time since last fill" timer to zero on every login.
        //
        // Cases where we DO update timestamps:
        //   (a) No persisted data yet                      â†’ record baseline
        //   (b) Offer just placed this session (qty==0)    â†’ start from now
        //   (c) quantitySold increased                     â†’ genuine new fill
        //   (d) Offer just completed (state transition)    â†’ record completion time
        // Otherwise (same qty, same completion state, data already loaded) â†’ preserve timestamps.

        // If the item ID in this slot changed, it is definitely a new offer â€” always reset.
        boolean itemChanged     = (slotItemId[slot] != 0 && slotItemId[slot] != offer.getItemId());
        slotItemId[slot]        = offer.getItemId();

        boolean noPersistedData = (slotLastUpdate[slot] == null);
        boolean newOfferPlaced  = (newQty == 0 && !isComplete
                                   && (slotTradeStart[slot] == null || prevQty > 0 || itemChanged));
        boolean genuineFill     = (prevQty >= 0 && newQty > prevQty && !itemChanged);
        boolean justCompleted   = (isComplete && !prevComplete);

        if (noPersistedData || newOfferPlaced || itemChanged)
        {
            slotTradeStart[slot] = Instant.now();
            slotLastUpdate[slot] = Instant.now();
        }
        else if (genuineFill || justCompleted)
        {
            slotLastUpdate[slot] = Instant.now();
            if (slotTradeStart[slot] == null)
                slotTradeStart[slot] = Instant.now();
        }
        // else: reconnect / duplicate event â€” silently preserve persisted timestamps.
    }

    /**
     * Builds the formatted "HH:MM:SS" timer string for a slot.
     * <ul>
     *   <li>Active (BUYING/SELLING) â€” counts up from the last fill / initial placement,
     *       resetting to 0 on each partial fill (same as Flipping Utilities).</li>
     *   <li>Complete (BOUGHT/SOLD/CANCELLED) â€” shows total offer duration, frozen.</li>
     * </ul>
     */
    private String createTimerString(int slot)
    {
        Instant start  = slotTradeStart[slot];
        Instant update = slotLastUpdate[slot];
        if (start == null || update == null) return null;

        long seconds;
        if (slotIsComplete[slot])
        {
            seconds = Math.max(0, Duration.between(start, update).getSeconds());
        }
        else
        {
            seconds = Math.max(0, Duration.between(update, Instant.now()).getSeconds());
        }

        long h = seconds / 3600;
        long m = (seconds % 3600) / 60;
        long s = seconds % 60;
        return String.format("%02d:%02d:%02d", h, m, s);
    }

    /**
     * Updates each visible GE slot widget with the elapsed time displayed next to
     * the "Buy"/"Sell" state label, exactly matching the Flipping Utilities visual:
     * <pre>  Buy  00:00:00</pre>
     * Timer is white while active, orange when stagnant (no fill in 5 min), green when done.
     * Must be called on the client thread.
     */
    private void updateSlotTimerWidgets()
    {
        if (client.getGameState() != GameState.LOGGED_IN) return;
        GrandExchangeOffer[] offers = client.getGrandExchangeOffers();
        if (offers == null) return;

        for (int i = 0; i < 8; i++)
        {
            Widget slotWidget = client.getWidget(GE_GROUP_ID, 7 + i);
            if (slotWidget == null || slotWidget.isHidden()) continue;

            Widget stateWidget = slotWidget.getChild(SLOT_STATE_CHILD_IDX);
            if (stateWidget == null) continue;

            GrandExchangeOffer offer = (i < offers.length) ? offers[i] : null;
            if (offer == null || offer.getItemId() == 0)
            {
                stateWidget.setText("Empty");
                stateWidget.setFontId(SLOT_FONT_DEFAULT);
                stateWidget.setXTextAlignment(1);
                continue;
            }

            if (slotTimerUnknown[i] || slotLastUpdate[i] == null || slotTradeStart[i] == null)
            {
                // Offer was there before plugin could track it â€” leave widget as game renders it
                stateWidget.setFontId(SLOT_FONT_DEFAULT);
                stateWidget.setXTextAlignment(1);
                continue;
            }

            String timeStr = createTimerString(i);
            if (timeStr == null) continue;

            // Re-read actual state from client to avoid using stale local state
            GrandExchangeOfferState st = offer.getState();
            boolean isBuy = st == GrandExchangeOfferState.BUYING
                         || st == GrandExchangeOfferState.BOUGHT
                         || st == GrandExchangeOfferState.CANCELLED_BUY;
            String stateName = isBuy ? "Buy" : "Sell";

            boolean isComplete = slotIsComplete[i];
            boolean isStagnant = !isComplete
                && slotLastUpdate[i].isBefore(Instant.now().minusSeconds(SLOT_STAGNATION_SECS));

            // Green = done, orange = no fills in 5+ min, white = actively filling
            String timerColor = isComplete ? "00B400"
                              : isStagnant ? "FF6400"
                              :              "FFFFFF";

            // Same HTML color-tag format as Flipping Utilities' SlotActivityTimer.setText()
            String text = "  <html><col=FFFFFF>" + stateName + "</col>"
                        + SLOT_TIMER_SPACER
                        + "<col=" + timerColor + ">" + timeStr + "</col></html>";

            stateWidget.setText(text);
            stateWidget.setFontId(SLOT_FONT_TIMER);
            stateWidget.setXTextAlignment(0); // left-align to fit "Buy  00:00:00"
        }
    }

    /**
     * Restores all GE slot widgets to the default game text ("Buy"/"Sell"/"Empty").
     * Called on plugin shutdown so the GE looks normal without the plugin.
     */
    private void resetSlotTimerWidgets()
    {
        if (client.getGameState() != GameState.LOGGED_IN) return;
        GrandExchangeOffer[] offers = client.getGrandExchangeOffers();

        for (int i = 0; i < 8; i++)
        {
            Widget slotWidget = client.getWidget(GE_GROUP_ID, 7 + i);
            if (slotWidget == null) continue;
            Widget stateWidget = slotWidget.getChild(SLOT_STATE_CHILD_IDX);
            if (stateWidget == null) continue;

            boolean isEmpty = offers == null || i >= offers.length || offers[i] == null
                           || offers[i].getItemId() == 0;
            if (isEmpty)
            {
                stateWidget.setText("Empty");
            }
            else
            {
                GrandExchangeOfferState st = offers[i].getState();
                boolean isBuy = st == GrandExchangeOfferState.BUYING
                             || st == GrandExchangeOfferState.BOUGHT
                             || st == GrandExchangeOfferState.CANCELLED_BUY;
                stateWidget.setText(isBuy ? "Buy" : "Sell");
            }
            stateWidget.setFontId(SLOT_FONT_DEFAULT);
            stateWidget.setXTextAlignment(1);
        }
    }
}
