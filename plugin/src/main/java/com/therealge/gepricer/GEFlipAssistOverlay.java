package com.therealge.gepricer;

import net.runelite.api.GrandExchangeOffer;
import net.runelite.api.GrandExchangeOfferState;
import net.runelite.api.Client;
import net.runelite.api.widgets.Widget;
import net.runelite.api.widgets.ComponentID;
import net.runelite.client.ui.overlay.Overlay;
import net.runelite.client.ui.overlay.OverlayLayer;
import net.runelite.client.ui.overlay.OverlayPosition;
import net.runelite.client.ui.overlay.OverlayPriority;

import javax.inject.Inject;
import java.awt.*;

/**
 * Lightweight canvas overlay that draws "click here" highlights on the GE UI.
 * No info panels â€” those live in the side panel (GEFlipAssistPanel).
 */
public class GEFlipAssistOverlay extends Overlay {
    private static final Color GLOW_GREEN  = new Color(0, 220, 100, 255);
    private static final Color GLOW_GOLD   = new Color(255, 200, 0, 255);
    private static final Color GLOW_ORANGE = new Color(255, 120, 0, 255);

    private static final int GE_GROUP_ID              = 465;
    private static final int GE_SLOT_CHILD_START      = 7;
    private static final int GE_SLOT_COUNT            = 8;
    private static final int INVENTORY_GROUP          = 149; // RuneLite inventory widget group ID (standalone).
    private static final int GE_OPEN_INVENTORY_GROUP  = 467; // Inventory group when the GE interface is open (replaces 149).
    private static final int GE_NEWOFFER_PRICE        = 4398; // Varbit: current price entered in the GE offer setup screen.
    private static final int GE_NEWOFFER_QUANTITY     = 4396; // Varbit: current quantity entered in the GE offer setup screen.

    private final Client         client;
    private final GEPricerPlugin plugin;

    @Inject
    GEFlipAssistOverlay(Client client, GEPricerPlugin plugin) {
        this.client = client;
        this.plugin = plugin;
        setPosition(OverlayPosition.DYNAMIC);
        setLayer(OverlayLayer.ABOVE_WIDGETS);
        setPriority(OverlayPriority.HIGH);
    }

    @Override
    public Dimension render(Graphics2D g) {
        if (plugin.isGuidancePaused()) return null;
        boolean sellOnly = plugin.isSellOnlyMode();

        // Always highlight GE slots with active price-modify alerts (independent of step).
        highlightAlertSlots(g);

        switch (plugin.getStep()) {
            case 0:  if (!sellOnly) highlightFirstBuySlot(g);  break;
            case 2:  highlightQuantityButton(g); highlightPriceButton(g);   break;
            case 3:  highlightConfirmButton(g);  break;
            case 5:  highlightOfferSlot(g); highlightFirstSellSlot(g);  highlightCollectButton(g); highlightInventoryItem(g); break;
            case 6:  highlightQuantityButton(g); highlightPriceButton(g);   break;
            case 7:  highlightConfirmButton(g);  break;
            case 9:  highlightOfferSlot(g); if (!sellOnly) highlightFirstBuySlot(g);  break;
            case 10: highlightOfferSlot(g); highlightFirstSellSlot(g);  highlightCollectButton(g); highlightInventoryItem(g); break;
            case 11: highlightFirstSellSlot(g);  highlightInventoryItem(g); break;
            case 12: highlightOfferSlot(g); highlightCollectButton(g);  break;
        }
        return null;
    }

    /**
     * Highlights GE offer slots orange for any item that has an active price-modify alert.
     * Runs every frame so the highlight appears regardless of the current guided step.
     */
    private void highlightAlertSlots(Graphics2D g) {
        java.util.List<Integer> alertIds = plugin.getActiveAlertItemIds();
        if (alertIds == null || alertIds.isEmpty()) return;
        GrandExchangeOffer[] offers = client.getGrandExchangeOffers();
        if (offers == null) return;
        for (int i = 0; i < offers.length; i++) {
            GrandExchangeOffer o = offers[i];
            if (o == null) continue;
            GrandExchangeOfferState st = o.getState();
            if (st != GrandExchangeOfferState.BUYING && st != GrandExchangeOfferState.SELLING) continue;
            if (!alertIds.contains(o.getItemId())) continue;
            Widget slot = client.getWidget(GE_GROUP_ID, GE_SLOT_CHILD_START + i);
            if (slot == null || slot.isHidden()) continue;
            drawHighlight(g, slot, GLOW_ORANGE);
        }
    }

    /**
     * Highlights the GE offer slot that contains the tracked item (boughtItemId)
     * in an actionable state (BOUGHT, SOLD, CANCELLED_BUY, CANCELLED_SELL) with orange.
     * Slot index matches GrandExchangeOffers array order â†’ widget child GE_SLOT_CHILD_START+i.
     */
    private void highlightOfferSlot(Graphics2D g) {
        int targetId = plugin.getBoughtItemId();
        GrandExchangeOffer[] offers = client.getGrandExchangeOffers();
        if (offers == null) return;

        // No tracked item â€” highlight every SOLD slot orange so the user knows to collect.
        if (targetId <= 0) {
            for (int i = 0; i < offers.length; i++) {
                GrandExchangeOffer o = offers[i];
                if (o != null && o.getState() == GrandExchangeOfferState.SOLD) {
                    Widget slot = client.getWidget(GE_GROUP_ID, GE_SLOT_CHILD_START + i);
                    if (slot != null && !slot.isHidden()) drawHighlight(g, slot, GLOW_ORANGE);
                }
            }
            return;
        }

        for (int i = 0; i < offers.length; i++) {
            GrandExchangeOffer o = offers[i];
            if (o == null) continue;
            GrandExchangeOfferState st = o.getState();
            if (o.getItemId() != targetId) continue;
            if (st == GrandExchangeOfferState.EMPTY
             || st == GrandExchangeOfferState.BUYING
             || st == GrandExchangeOfferState.SELLING) continue;
            Widget slot = client.getWidget(GE_GROUP_ID, GE_SLOT_CHILD_START + i);
            if (slot == null || slot.isHidden()) continue;
            Color slotColor = (st == GrandExchangeOfferState.BOUGHT) ? GLOW_GREEN : GLOW_ORANGE;
            drawHighlight(g, slot, slotColor);
            break;
        }
    }

    private void highlightFirstBuySlot(Graphics2D g) {
        for (int slot = 0; slot < GE_SLOT_COUNT; slot++) {
            Widget slotWidget = client.getWidget(GE_GROUP_ID, GE_SLOT_CHILD_START + slot);
            if (slotWidget == null || slotWidget.isHidden()) continue;
            Widget buyBtn = slotWidget.getChild(0);
            if (buyBtn != null && !buyBtn.isHidden()) {
                drawHighlight(g, buyBtn, GLOW_GREEN);
                break;
            }
        }
    }

    private void highlightFirstSellSlot(Graphics2D g) {
        for (int slot = 0; slot < GE_SLOT_COUNT; slot++) {
            Widget slotWidget = client.getWidget(GE_GROUP_ID, GE_SLOT_CHILD_START + slot);
            if (slotWidget == null || slotWidget.isHidden()) continue;
            Widget sellBtn = slotWidget.getChild(1); // child 1 = sell/down-arrow button
            if (sellBtn != null && !sellBtn.isHidden()) {
                drawHighlight(g, sellBtn, GLOW_GOLD);
                break;
            }
        }
    }

    private void highlightPriceButton(Graphics2D g) {
        Widget offer = getOfferContainer();
        if (offer == null) return;
        // child(54) = set-price button (source: flipping-copilot GrandExchange.java)
        Widget btn = offer.getChild(54);
        if (btn == null || btn.isHidden()) btn = findChildByAction(offer, "Set price");
        if (btn == null || btn.isHidden()) btn = findChildByText(offer, "...");
        if (btn != null && !btn.isHidden()) drawHighlight(g, btn, GLOW_GREEN);
    }

    private void highlightQuantityButton(Graphics2D g) {
        Widget offer = getOfferContainer();
        if (offer == null) return;
        // child(51) = set-quantity button; child(50) = "All" quantity shortcut button
        Widget btn = offer.getChild(51);
        if (btn == null || btn.isHidden()) btn = offer.getChild(50);
        if (btn != null && !btn.isHidden()) drawHighlight(g, btn, GLOW_GOLD);
    }

    private void highlightCollectButton(Graphics2D g) {
        // Collect button is at group 465, child 6 â†’ then its child 2
        Widget collectContainer = client.getWidget(GE_GROUP_ID, 6);
        if (collectContainer == null || collectContainer.isHidden()) return;
        Widget btn = collectContainer.getChild(2);
        if (btn != null && !btn.isHidden()) drawHighlight(g, btn, GLOW_GREEN);
    }

    private void highlightConfirmButton(Graphics2D g) {
        Widget offer = getOfferContainer();
        if (offer == null) return;
        // child(58) = confirm button (source: flipping-copilot GrandExchange.java)
        Widget btn = offer.getChild(58);
        if (btn == null || btn.isHidden()) btn = findChildByText(offer, "Confirm");
        if (btn == null || btn.isHidden()) btn = findChildByAction(offer, "Confirm");
        if (btn != null && !btn.isHidden()) drawHighlight(g, btn, GLOW_GREEN);
    }

    /** Returns the GE offer setup container. Tries (465, 26) first (current OSRS layout). */
    private Widget getOfferContainer() {
        Widget w = client.getWidget(465, 26);
        if (w != null && !w.isHidden()) return w;
        return client.getWidget(ComponentID.GRAND_EXCHANGE_OFFER_CONTAINER);
    }

    private void highlightInventoryItem(Graphics2D g) {
        // Only highlight while the GE interface is open
        Widget geMain = client.getWidget(GE_GROUP_ID, 0);
        if (geMain == null || geMain.isHidden()) return;

        int itemId = plugin.getBoughtItemId();
        if (itemId <= 0) return;

        // When GE is open, the inventory is rendered in group 467 (GE inventory tab).
        // Fall back to the standalone inventory group 149 if 467 is not available.
        Widget inv = client.getWidget(GE_OPEN_INVENTORY_GROUP, 0);
        if (inv == null || inv.isHidden()) inv = client.getWidget(INVENTORY_GROUP, 0);
        if (inv == null || inv.isHidden()) return;
        Widget[] children = inv.getDynamicChildren();
        if (children == null) return;
        for (Widget child : children) {
            if (child != null && !child.isHidden() && child.getItemId() == itemId) { drawHighlight(g, child, GLOW_GREEN); }
        }
    }

    private static void drawHighlight(Graphics2D g, Widget w, Color color) {
        Rectangle b = w.getBounds();
        // Fill
        g.setColor(new Color(color.getRed(), color.getGreen(), color.getBlue(), 40));
        g.fillRect(b.x, b.y, b.width, b.height);
        // Border
        g.setColor(color);
        g.setStroke(new BasicStroke(2f));
        g.drawRect(b.x, b.y, b.width, b.height);
    }

    private static Widget findChildByText(Widget parent, String text) {
        Widget[] s = parent.getStaticChildren();
        if (s != null) for (Widget c : s)
            if (c != null && !c.isHidden() && text.equals(c.getText())) return c;
        Widget[] d = parent.getDynamicChildren();
        if (d != null) for (Widget c : d)
            if (c != null && !c.isHidden() && text.equals(c.getText())) return c;
        return null;
    }

    private static Widget findChildByAction(Widget parent, String action) {
        Widget[] s = parent.getStaticChildren();
        if (s != null) for (Widget c : s) {
            String[] actions = c.getActions();
            if (actions != null) for (String a : actions)
                if (action.equals(a)) return c;
        }
        return null;
    }
}
