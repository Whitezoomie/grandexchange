package com.therealge.gepricer;

import net.runelite.client.game.ItemManager;
import net.runelite.client.ui.ColorScheme;
import net.runelite.client.ui.FontManager;
import net.runelite.client.util.AsyncBufferedImage;

import javax.swing.*;
import javax.swing.border.EmptyBorder;
import java.awt.*;
import java.text.NumberFormat;
import java.util.Locale;

/**
 * Side-panel widget that guides players through the step-by-step flip workflow.
 * All guidance is shown here — there is no game-canvas overlay.
 *
 * Steps:
 *  -1  GE closed — idle message
 *   0  GE open  — "Click a Buy offer slot"
 *   1  Buy screen open, item not selected — "Search for: [item]"
 *   2  Correct item, price not set — "Set buy price to X gp"
 *   3  Correct item + price — "Confirm your buy offer"
 *   4  Offer placed, filling — "Buying... X/Y filled"
 *   5  Buy complete — "âœ“ Bought! Collect items, then sell"
 *   6  Sell screen open, price not set — "Set sell price to X gp"
 *   7  Sell screen open + price set — "Confirm your sell offer"
 *   8  GE full, no collectable items yet — "GE Full — waiting for offers"
 *   9  Buy offer cancelled — "Buy cancelled — re-buy at X gp"
 *  10  Sell offer cancelled — "Sell cancelled — re-sell at X gp"
 */
public class GEFlipAssistPanel extends JPanel {
    private static final Color BG_DEFAULT = ColorScheme.DARKER_GRAY_COLOR;
    private static final Color BG_WAITING = new Color(40, 30, 10);
    private static final Color BG_DONE    = new Color(10, 45, 10);

    private static final Color BORDER_DEFAULT = new Color(60, 60, 60);
    private static final Color BORDER_WAITING = new Color(200, 130, 0);
    private static final Color BORDER_DONE    = new Color(0, 160, 60);

    private static final Color TEXT_WHITE  = Color.WHITE;
    private static final Color TEXT_MUTED  = new Color(160, 160, 160);

    private static final NumberFormat NF = NumberFormat.getNumberInstance(Locale.US);

    // Dependencies
    private final ItemManager itemManager;

    // Pause / Sell-Only state
    private volatile boolean paused    = false;
    private volatile boolean sellOnly  = false;
    private Runnable onResume = null;
    private Runnable onPauseStateChanged = null;

    /** Set a callback to invoke immediately when the user clicks Resume. */
    public void setOnResume(Runnable r) { onResume = r; }

    /** Set a callback that fires whenever the paused state changes (from either source). */
    public void setOnPauseStateChanged(Runnable r) { onPauseStateChanged = r; }

    /** Toggles the paused state programmatically (safe to call from any thread). *
     *  Flips {@code paused} immediately so callers on the client thread can read
     *  the updated value right away, then dispatches UI work to the EDT.
     */
    public void togglePaused() {
        paused = !paused;                          // immediate volatile write — readable from any thread
        final boolean nowPaused = paused;
        SwingUtilities.invokeLater(() -> {
            if (pauseBtn != null) {
                pauseBtn.setText(nowPaused ? "▶" : "⏸");
                pauseBtn.setBackground(nowPaused ? new Color(40, 80, 40) : new Color(100, 60, 20));
            }
            if (nowPaused) showPaused();
            else if (onResume != null) onResume.run();
            if (onPauseStateChanged != null) onPauseStateChanged.run();
        });
    }

    // UI components
    private final JLabel iconLabel  = new JLabel();
    private final JLabel mainLabel  = new JLabel();
    private final JLabel subLabel   = new JLabel();
    private JButton pauseBtn;
    private JButton sellOnlyBtn;

    // Constructor

    public GEFlipAssistPanel(ItemManager itemManager) {
        this.itemManager = itemManager;

        setBackground(BG_DEFAULT);
        setBorder(buildBorder(BORDER_DEFAULT));
        setLayout(new BorderLayout(10, 0));

        iconLabel.setPreferredSize(new Dimension(40, 40));
        iconLabel.setHorizontalAlignment(SwingConstants.CENTER);
        iconLabel.setVisible(false);

        mainLabel.setForeground(TEXT_WHITE);
        mainLabel.setFont(FontManager.getRunescapeBoldFont());
        mainLabel.setAlignmentX(Component.LEFT_ALIGNMENT);

        subLabel.setForeground(TEXT_MUTED);
        subLabel.setFont(FontManager.getRunescapeSmallFont().deriveFont(Font.PLAIN, 12f));
        subLabel.setAlignmentX(Component.LEFT_ALIGNMENT);
        subLabel.setVisible(false);

        JPanel textPanel = new JPanel();
        textPanel.setLayout(new BoxLayout(textPanel, BoxLayout.Y_AXIS));
        textPanel.setOpaque(false);
        textPanel.add(mainLabel);
        textPanel.add(Box.createVerticalStrut(4));
        textPanel.add(subLabel);

        add(iconLabel, BorderLayout.WEST);
        add(textPanel, BorderLayout.CENTER);

        // ---- Pause button ----
        pauseBtn = new JButton("⏸");
        pauseBtn.setFont(pauseBtn.getFont().deriveFont(15f));
        pauseBtn.setForeground(Color.WHITE);
        pauseBtn.setBackground(new Color(100, 60, 20));
        pauseBtn.setBorderPainted(false);
        pauseBtn.setFocusPainted(false);
        pauseBtn.setPreferredSize(new Dimension(30, 24));
        pauseBtn.setMinimumSize(new Dimension(30, 24));
        pauseBtn.setMaximumSize(new Dimension(30, 24));
        pauseBtn.addActionListener(e -> {
            paused = !paused;
            pauseBtn.setText(paused ? "▶" : "⏸");
            pauseBtn.setBackground(paused ? new Color(40, 80, 40) : new Color(100, 60, 20));
            if (paused) showPaused();
            else if (onResume != null) onResume.run();
            if (onPauseStateChanged != null) onPauseStateChanged.run();
        });

        // ---- Sell Only toggle button ----
        sellOnlyBtn = new JButton("S");
        sellOnlyBtn.setFont(sellOnlyBtn.getFont().deriveFont(12f));
        sellOnlyBtn.setForeground(new Color(160, 160, 160));
        sellOnlyBtn.setBackground(new Color(50, 50, 50));
        sellOnlyBtn.setBorderPainted(false);
        sellOnlyBtn.setFocusPainted(false);
        sellOnlyBtn.setPreferredSize(new Dimension(30, 24));
        sellOnlyBtn.setMinimumSize(new Dimension(30, 24));
        sellOnlyBtn.setMaximumSize(new Dimension(30, 24));
        sellOnlyBtn.setToolTipText("Sell Only — skip buy guidance; just sell inventory items");
        sellOnlyBtn.addActionListener(e -> {
            sellOnly = !sellOnly;
            sellOnlyBtn.setForeground(sellOnly ? new Color(255, 200, 0) : new Color(160, 160, 160));
            sellOnlyBtn.setBackground(sellOnly ? new Color(80, 55, 0) : new Color(50, 50, 50));
            if (!paused) showIdle();
            if (onPauseStateChanged != null) onPauseStateChanged.run();
        });

        JPanel btnRow = new JPanel(new GridLayout(1, 2, 2, 0));
        btnRow.setOpaque(false);
        btnRow.add(sellOnlyBtn);
        btnRow.add(pauseBtn);
        add(btnRow, BorderLayout.EAST);

        // Initial idle message
        showIdle();
    }

    // Public update method — call from EDT

    public boolean isPaused() { return paused; }

    public boolean isSellOnlyMode() { return sellOnly; }

    /** Refresh the panel to reflect the current guided-workflow step. Always called on the Swing EDT. */
    public void update(int step, GEPricerItem pick,
                       String boughtItemName, int boughtItemId,
                       int boughtQty, int totalQty, long sellPrice,
                       long overcutGp, long sellUndercutGp) {
        if (paused) return;  // don't overwrite the paused message
        if (!SwingUtilities.isEventDispatchThread()) { SwingUtilities.invokeLater(() -> update(step, pick, boughtItemName, boughtItemId, boughtQty, totalQty, sellPrice, overcutGp, sellUndercutGp)); return; }

        switch (step) {
            case 0:
                applyTheme(BG_DEFAULT, BORDER_DEFAULT);
                if (sellOnly) {
                    clearIcon();
                    setMain("<html><font color='#FFD700'><b>Sell Only mode</b></font></html>");
                    setSub("");
                } else {
                    if (pick != null) setItemIcon(pick.getId()); else clearIcon();
                    setMain("<html><font color='#FFD700'><b>Click a Buy Offer slot</b></font></html>");
                    setSub("");
                }
                break;

            case 1:
                applyTheme(BG_DEFAULT, BORDER_DEFAULT);
                if (pick != null) setItemIcon(pick.getId()); else clearIcon();
                setMain("<html>Search for: <font color='white'><b>"
                    + (pick != null ? esc(pick.getName()) : "?") + "</b></font></html>");
                setSub("");
                break;

            case 2:
                applyTheme(BG_DEFAULT, BORDER_DEFAULT);
                if (pick != null) setItemIcon(pick.getId()); else clearIcon();
                long buyPrice = pick != null ? pick.getInstaSell() + overcutGp : 0;
                int buyQty = pick != null ? pick.getBuyLimit() : 0;
                if (buyPrice > 10_000_000L) buyQty = 1;
                setMain("<html><font color='#FFD700'><b>Set buy offer qty &amp; price</b></font></html>");
                setSub("");
                break;

            case 3:
                applyTheme(BG_DEFAULT, BORDER_DEFAULT);
                if (pick != null) setItemIcon(pick.getId()); else clearIcon();
                setMain("<html><font color='#00DC64'><b>Confirm your buy offer</b></font></html>");
                setSub("");
                break;

            case 4:
                applyTheme(BG_WAITING, BORDER_WAITING);
                if (boughtItemId > 0) setItemIcon(boughtItemId); else clearIcon();
                setMain("<html><font color='#FF8C00'><b>Buying... please wait</b></font></html>");
                setSub("");
                break;

            case 5:
                applyTheme(BG_DONE, BORDER_DONE);
                if (boughtItemId > 0) setItemIcon(boughtItemId); else clearIcon();
                setMain("<html><font color='#00DC64'><b>&#10003; Bought!</b> Collect, then sell:</font></html>");
                setSub("<html>" + esc(boughtItemName != null ? boughtItemName : "Item") + "</html>");
                break;

            case 6:
                applyTheme(BG_DEFAULT, BORDER_DEFAULT);
                if (boughtItemId > 0) setItemIcon(boughtItemId); else clearIcon();
                setMain("<html><font color='#FFD700'><b>Set sell offer qty &amp; price</b></font></html>");
                setSub("");
                break;

            case 7:
                applyTheme(BG_DEFAULT, BORDER_DEFAULT);
                if (boughtItemId > 0) setItemIcon(boughtItemId); else clearIcon();
                setMain("<html><font color='#00DC64'><b>Confirm your sell offer</b></font></html>");
                setSub("");
                break;

            case 8:
                applyTheme(BG_WAITING, BORDER_WAITING);
                clearIcon();
                setMain("<html><font color='#FF8C00'><b>GE Full — No empty slots</b></font></html>");
                setSub("");
                break;
            case 9:
                applyTheme(BG_WAITING, BORDER_WAITING);
                if (boughtItemId > 0) setItemIcon(boughtItemId); else clearIcon();
                setMain("<html><font color='#FF8C00'><b>Buy cancelled \u2014 re-buy:</b></font></html>");
                setSub("");
                break;

            case 10:
                applyTheme(BG_WAITING, BORDER_WAITING);
                if (boughtItemId > 0) setItemIcon(boughtItemId); else clearIcon();
                setMain("<html><font color='#FF8C00'><b>Sell cancelled \u2014 re-sell:</b></font></html>");
                setSub("");
                break;

            case 11:
                applyTheme(BG_DONE, BORDER_DONE);
                if (boughtItemId > 0) setItemIcon(boughtItemId); else clearIcon();
                setMain("<html><font color='#00DC64'><b>Item found in inventory!</b></font></html>");
                setSub("");
                break;

            case 12:
                applyTheme(BG_DONE, BORDER_DONE);
                if (boughtItemId > 0) setItemIcon(boughtItemId); else clearIcon();
                setMain("<html><font color='#00DC64'><b>&#10003; Sold! Click Collect</b></font></html>");
                setSub("");
                break;

            case 13: // Modify stagnant buy offer — raise the buy price
                applyTheme(BG_WAITING, BORDER_WAITING);
                if (boughtItemId > 0) setItemIcon(boughtItemId); else clearIcon();
                setMain("<html><font color='#FF9800'><b>Raise buy to "
                    + NF.format(sellPrice) + " gp</b></font></html>");
                setSub("");
                break;

            case 14: // New item — cancel the stagnant buy offer first
                applyTheme(BG_WAITING, BORDER_WAITING);
                if (boughtItemId > 0) setItemIcon(boughtItemId); else clearIcon();
                setMain("<html><font color='#EF5350'><b>Cancel the buy offer</b></font></html>");
                setSub("");
                break;
            default: // -1 or unknown
                showIdle();
                break;
        }

        revalidate();
        repaint();
    }

    // Private helpers

    private void showIdle() {
        applyTheme(BG_DEFAULT, BORDER_DEFAULT);
        clearIcon();
        if (sellOnly) {
            setMain("<html><font color='#FFD700'><b>Sell Only mode</b></font></html>");
            setSub("");
        } else {
            setMain("<html>Open the Grand Exchange<br>to get a flip suggestion.</html>");
            setSub("");
        }
    }

    private void showPaused() {
        applyTheme(BG_DEFAULT, BORDER_DEFAULT);
        clearIcon();
        setMain("<html><font color='#A0A0A0'><b>Guidance paused.</b></font></html>");
        setSub("<html><font color='#606060'>GE assistance is disabled.</font></html>");
        revalidate();
        repaint();
    }

    private void applyTheme(Color bg, Color borderColor) {
        setBackground(bg);
        setBorder(buildBorder(borderColor));
    }

    private static javax.swing.border.Border buildBorder(Color borderColor) {
        return BorderFactory.createCompoundBorder(
            BorderFactory.createMatteBorder(0, 0, 1, 0, borderColor),
            new EmptyBorder(10, 10, 10, 10));
    }

    private void setMain(String html) {
        mainLabel.setText(html);
    }

    private void setSub(String html) {
        boolean hasContent = (html != null && !html.isEmpty());
        subLabel.setText(hasContent ? html : "");
        subLabel.setVisible(hasContent);
    }

    private void setItemIcon(int itemId) {
        if (itemManager == null) {
            iconLabel.setVisible(false);
            return;
        }
        try {
            AsyncBufferedImage img = itemManager.getImage(itemId);
            iconLabel.setIcon(new ImageIcon(img));
            img.onLoaded(() -> SwingUtilities.invokeLater(() -> {
                iconLabel.setIcon(new ImageIcon(img));
                iconLabel.repaint();
            }));
            iconLabel.setVisible(true);
        } catch (Exception ignored) {
            iconLabel.setVisible(false);
        }
    }

    private void clearIcon() {
        iconLabel.setIcon(null);
        iconLabel.setVisible(false);
    }

    /** Escape HTML special characters in item names. */
    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }
}
