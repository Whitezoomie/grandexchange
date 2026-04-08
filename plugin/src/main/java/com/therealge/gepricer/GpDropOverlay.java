package com.therealge.gepricer;

import net.runelite.api.Client;
import net.runelite.api.widgets.Widget;
import net.runelite.client.ui.FontManager;
import net.runelite.client.ui.overlay.Overlay;
import net.runelite.client.ui.overlay.OverlayLayer;
import net.runelite.client.ui.overlay.OverlayManager;
import net.runelite.client.ui.overlay.OverlayPosition;
import net.runelite.client.ui.overlay.components.TextComponent;

import java.awt.*;
import java.text.NumberFormat;
import java.util.Locale;

/**
 * Short-lived overlay that animates a floating profit/loss label rising from a
 * GE offer slot for 3 seconds after a sell offer completes.
 *
 * Each instance is created when a SOLD event fires, added to OverlayManager,
 * and removes itself once the animation is done.
 */
class GpDropOverlay extends Overlay {
    private static final int GE_GROUP_ID         = 465;
    private static final int GE_SLOT_CHILD_START = 7;

    private static final long DURATION_MS = 3_000L;

    private static final NumberFormat NF = NumberFormat.getNumberInstance(Locale.US);

    private final OverlayManager overlayManager;
    private final long           startMs;
    private final int            startX;
    private final int            startY;
    private final long           profit;
    private final TextComponent  text = new TextComponent();

    /**
     * @param overlayManager used so the overlay can remove itself when done
     * @param client         to look up the slot widget position
     * @param profit         net profit (positive) or loss (negative) in GP
     * @param slotIndex      GE slot index (0-7)
     */
    GpDropOverlay(OverlayManager overlayManager, Client client, long profit, int slotIndex) {
        this.overlayManager = overlayManager;
        this.startMs        = System.currentTimeMillis();
        this.profit         = profit;

        // Position: centre-bottom of the slot widget, so the text floats upward from there
        Widget slot = client.getWidget(GE_GROUP_ID, GE_SLOT_CHILD_START + slotIndex);
        if (slot != null) {
            net.runelite.api.Point loc = slot.getCanvasLocation();
            startX = loc.getX() + slot.getWidth() / 2 - 20;
            startY = loc.getY() + slot.getHeight() - 10;
        } else {
            startX = 100;
            startY = 100;
        }

        setPosition(OverlayPosition.DYNAMIC);
        setLayer(OverlayLayer.ABOVE_WIDGETS);

        String sign   = profit >= 0 ? "+" : "-";
        String amount = NF.format(Math.abs(profit));
        text.setText(sign + amount + " gp");
        text.setFont(FontManager.getRunescapeFont().deriveFont(Font.BOLD, 15f));
        text.setColor(profit >= 0 ? new Color(0, 220, 80) : new Color(255, 80, 80));
    }

    @Override
    public Dimension render(Graphics2D graphics) {
        long elapsed = System.currentTimeMillis() - startMs;
        if (elapsed >= DURATION_MS) {
            overlayManager.remove(this);
            return null;
        }

        // Float upward: 1 px every 50 ms (60 px over 3 s), fade alpha linearly from 255 → 0
        float progress = elapsed / (float) DURATION_MS;
        int   yOffset  = (int) (elapsed / 50);
        int   alpha    = (int) (255 * (1f - progress));

        Color base = profit >= 0 ? new Color(0, 220, 80) : new Color(255, 80, 80);
        text.setColor(new Color(base.getRed(), base.getGreen(), base.getBlue(), alpha));

        text.setPosition(new java.awt.Point(startX, startY - yOffset));
        text.render(graphics);
        return null;
    }
}
