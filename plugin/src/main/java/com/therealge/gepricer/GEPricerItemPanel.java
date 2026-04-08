package com.therealge.gepricer;

import net.runelite.client.ui.ColorScheme;
import net.runelite.client.ui.FontManager;
import net.runelite.client.game.ItemManager;
import net.runelite.client.util.AsyncBufferedImage;

import javax.swing.*;
import javax.swing.border.CompoundBorder;
import javax.swing.border.EmptyBorder;
import javax.swing.border.MatteBorder;
import java.awt.*;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.Desktop;
import java.net.URI;
import java.text.NumberFormat;
import java.util.Locale;
import java.util.function.Consumer;

/**
 * One row in the GE Price Tracker panel.
 *
 * Compact view (always visible):
 *   [ Item Name                                   ★ ]
 *   [ ▲ Buy  39.3M    ▼ Sell  38.4M    Δ +914K      ]
 *
 * Expanded view (click to toggle):
 *   Wiki insta-buy:    39,272,481 gp
 *   Wiki insta-sell:   38,358,192 gp
 *   GE Tax (2%):          785,449 gp
 *   Net margin:           914,289 gp  (+2.30%)
 *   Buy limit:                      8
 *   Daily volume:         1,234,567
 *   Last updated:               3m ago
 */
public class GEPricerItemPanel extends JPanel {
    // Palette â€“ matches the dark RuneLite look with OSRS-gold accents
    private static final Color BG_NORMAL     = ColorScheme.DARKER_GRAY_COLOR;
    private static final Color BG_HOVER      = new Color(50, 50, 50);
    private static final Color BG_EXPANDED   = new Color(35, 35, 35);
    private static final Color TEXT_PRIMARY  = Color.WHITE;
    private static final Color TEXT_MUTED    = new Color(160, 160, 160);
    private static final Color COLOR_BUY     = new Color(0, 200, 83);    // green  (sell for profit)
    private static final Color COLOR_SELL    = new Color(255, 95, 95);   // red    (costs this much)
    private static final Color COLOR_MARGIN_POS = new Color(255, 215, 0); // gold  (positive margin)
    private static final Color COLOR_MARGIN_NEG = new Color(200, 80, 80); // red   (negative margin)
    private static final Color COLOR_STAR_ON  = new Color(255, 200, 0);
    private static final Color COLOR_STAR_OFF = new Color(100, 100, 100);
    private static final Color BORDER_COLOR  = new Color(60, 60, 60);

    private static final NumberFormat NF = NumberFormat.getNumberInstance(Locale.US);

    private final GEPricerItem         item;
    private       boolean              expanded     = false;
    private       boolean              isFavorite   = false;
    private final Consumer<GEPricerItem> onFavToggle;

    // UI nodes we need to update on reprice
    private final JLabel nameLabel;
    private final JLabel buyLabel;
    private final JLabel sellLabel;
    private final JLabel marginLabel;
    private final JLabel activityBadge;
    private final JPanel detailsPanel;

    // Detail rows (updated on expand / refresh)
    private final JLabel dInstaBuy;
    private final JLabel dInstaSell;
    private final JLabel dTax;
    private final JLabel dMargin;
    private final JLabel dMarginPct;
    private final JLabel dLimit;
    private final JLabel dVolume;
    private final JLabel dUpdated;
    private final JLabel dSellTime;

    public GEPricerItemPanel(GEPricerItem item, boolean favorite,
                             Consumer<GEPricerItem> onFavToggle,
                             ItemManager itemManager) {
        this.item        = item;
        this.isFavorite  = favorite;
        this.onFavToggle = onFavToggle;

        setLayout(new BorderLayout(0, 0));
        setBackground(BG_NORMAL);
        setBorder(new CompoundBorder(
            new MatteBorder(0, 0, 1, 0, BORDER_COLOR),
            new EmptyBorder(0, 0, 0, 0)
        ));

        // ---- Header / compact row ----
        JPanel header = new JPanel(new BorderLayout(4, 0));
        header.setBackground(BG_NORMAL);
        header.setBorder(new EmptyBorder(10, 8, 4, 8));
        header.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));

        nameLabel = new JLabel(item.isTaxExempt()
            ? "<html>" + item.getName() + "&nbsp;<span style='color:#FFD700;font-size:9'>[TAX FREE]</span></html>"
            : item.getName());
        nameLabel.setForeground(TEXT_PRIMARY);
        nameLabel.setFont(FontManager.getRunescapeSmallFont());

        JLabel starLabel = buildStarLabel();

        // ---- Item icon ----
        JLabel iconLabel = new JLabel();
        iconLabel.setPreferredSize(new Dimension(36, 32));
        iconLabel.setBorder(new EmptyBorder(0, 0, 0, 4));
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

        header.add(iconLabel, BorderLayout.WEST);
        header.add(nameLabel, BorderLayout.CENTER);
        header.add(starLabel, BorderLayout.EAST);

        // ---- Compact price strip: buy+sell on row 1, margin on row 2 ----
        JPanel buyRow = new JPanel(new GridLayout(1, 2, 0, 0));
        buyRow.setBackground(BG_NORMAL);
        buyRow.setBorder(new EmptyBorder(2, 8, 0, 8));

        buyLabel  = priceLabel("▲ —", COLOR_BUY);
        sellLabel = priceLabel("▼ —", COLOR_SELL);
        buyRow.add(buyLabel);
        buyRow.add(sellLabel);

        JPanel marginRow = new JPanel(new BorderLayout());
        marginRow.setBackground(BG_NORMAL);
        marginRow.setBorder(new EmptyBorder(1, 8, 10, 8));

        marginLabel = priceLabel("Δ  —", TEXT_MUTED);
        marginRow.add(marginLabel, BorderLayout.WEST);

        activityBadge = new JLabel();
        activityBadge.setFont(FontManager.getRunescapeSmallFont());
        activityBadge.setVisible(false);
        marginRow.add(activityBadge, BorderLayout.EAST);

        JPanel priceStrip = new JPanel();
        priceStrip.setLayout(new BoxLayout(priceStrip, BoxLayout.Y_AXIS));
        priceStrip.setBackground(BG_NORMAL);
        priceStrip.add(buyRow);
        priceStrip.add(marginRow);

        JPanel top = new JPanel(new BorderLayout(0, 0));
        top.setBackground(BG_NORMAL);
        top.add(header,     BorderLayout.NORTH);
        top.add(priceStrip, BorderLayout.SOUTH);

        // ---- Detail section ----
        detailsPanel = new JPanel();
        detailsPanel.setLayout(new BoxLayout(detailsPanel, BoxLayout.Y_AXIS));
        detailsPanel.setBackground(BG_EXPANDED);
        detailsPanel.setBorder(new EmptyBorder(6, 12, 8, 12));
        detailsPanel.setVisible(false);

        dInstaBuy  = detailLabel();
        dInstaSell = detailLabel();
        dTax       = detailLabel();
        dMargin    = detailLabel();
        dMarginPct = detailLabel();
        dLimit     = detailLabel();
        dVolume    = detailLabel();
        dUpdated   = detailLabel();
        dSellTime  = detailLabel();

        detailsPanel.add(buildDetailRow("Insta-buy:",   dInstaBuy));
        detailsPanel.add(buildDetailRow("Insta-sell:",  dInstaSell));
        detailsPanel.add(buildDetailRow("GE tax:",      dTax));
        detailsPanel.add(Box.createVerticalStrut(3));
        detailsPanel.add(buildDetailRow("Net margin:",  dMargin));
        detailsPanel.add(buildDetailRow("Margin %:",    dMarginPct));
        detailsPanel.add(Box.createVerticalStrut(3));
        detailsPanel.add(buildDetailRow("Buy limit:",   dLimit));
        detailsPanel.add(buildDetailRow("Volume:",      dVolume));
        detailsPanel.add(buildDetailRow("Sell time:",   dSellTime));
        detailsPanel.add(buildDetailRow("Updated:",     dUpdated));
        detailsPanel.add(Box.createVerticalStrut(6));
        detailsPanel.add(buildWebsiteLink());

        add(top,          BorderLayout.NORTH);
        add(detailsPanel, BorderLayout.CENTER);

        // Toggle expand on click of header
        MouseAdapter clickToggle = new MouseAdapter() {
            @Override public void mousePressed(MouseEvent e) { toggleExpand(); }
            @Override public void mouseEntered(MouseEvent e) { setHeaderBg(BG_HOVER); }
            @Override public void mouseExited(MouseEvent e)  { setHeaderBg(BG_NORMAL); }
        };
        header.addMouseListener(clickToggle);
        priceStrip.addMouseListener(clickToggle);

        refresh();
    }

    // Public API

    /** Called when new price data arrives â€“ updates all labels in-place. */
    public void refresh() {
        // Compact strip
        buyLabel.setText("▲ " + gp(item.getInstaBuy()));
        sellLabel.setText("▼ " + gp(item.getInstaSell()));

        long margin = item.getMargin();
        String sign = margin >= 0 ? "+" : "";
        marginLabel.setForeground(margin >= 0 ? COLOR_MARGIN_POS : COLOR_MARGIN_NEG);
        marginLabel.setText("Δ " + sign + gp(margin));

        // Detail section
        dInstaBuy.setText(gp(item.getInstaBuy()));
        dInstaBuy.setForeground(COLOR_BUY);

        dInstaSell.setText(gp(item.getInstaSell()));
        dInstaSell.setForeground(COLOR_SELL);

        if (item.isTaxExempt()) {
            dTax.setText("TAX FREE (0 gp)");
            dTax.setForeground(new Color(255, 215, 0));
        } else {
            dTax.setText(gp(item.getTax()));
            dTax.setForeground(TEXT_MUTED);
        }

        dMargin.setText(sign + gp(margin));
        dMargin.setForeground(margin >= 0 ? COLOR_MARGIN_POS : COLOR_MARGIN_NEG);

        dMarginPct.setText(String.format("%.2f%%", item.getMarginPercent()));
        dMarginPct.setForeground(margin >= 0 ? COLOR_MARGIN_POS : COLOR_MARGIN_NEG);

        dLimit.setText(item.getBuyLimit() > 0 ? NF.format(item.getBuyLimit()) : "N/A");
        dLimit.setForeground(TEXT_MUTED);

        dVolume.setText(item.getVolume() > 0 ? NF.format(item.getVolume()) : "N/A");
        dVolume.setForeground(TEXT_MUTED);

        // Activity badge: compare last-1h volume vs expected per-hour from daily volume
        long vol1h = item.getHighPriceVolume1h() + item.getLowPriceVolume1h();
        long dailyVol = item.getVolume();
        if (vol1h > 0 && dailyVol > 0) {
            double ratio = vol1h / (dailyVol / 24.0);
            if (ratio >= 1.5) {
                activityBadge.setText("● PEAK");
                activityBadge.setForeground(new Color(0, 200, 83));
                activityBadge.setVisible(true);
            } else if (ratio <= 0.35) {
                activityBadge.setText("● QUIET");
                activityBadge.setForeground(new Color(100, 140, 200));
                activityBadge.setVisible(true);
            } else {
                activityBadge.setVisible(false);
            }
        } else {
            activityBadge.setVisible(false);
        }

        if (item.getBuyLimit() > 0 && item.getVolume() > 0) {
            double hrs = item.getBuyLimit() * 48.0 / item.getVolume();
            dSellTime.setText(hrs < 1.0 ? String.format("%.0f min", hrs * 60) : String.format("%.1f hrs", hrs));
            dSellTime.setForeground(hrs > 2.0 ? new Color(255, 120, 50) : TEXT_MUTED);
        } else {
            dSellTime.setText("N/A");
            dSellTime.setForeground(TEXT_MUTED);
        }

        dUpdated.setText(item.getLastUpdatedText());
        dUpdated.setForeground(TEXT_MUTED);
    }

    public void setFavorite(boolean fav) {
        this.isFavorite = fav;
        // Find and repaint the star label
        Component east = ((BorderLayout) ((JPanel) getComponent(0)).getLayout()) // top
            .getLayoutComponent(BorderLayout.NORTH); // header panel
        // Easier: just repaint the whole item so star rebuilds next revalidate
        // Instead we iterate header children
        refreshStarInHeader();
    }

    // Private helpers

    private void toggleExpand() {
        expanded = !expanded;
        detailsPanel.setVisible(expanded);
        setBackground(expanded ? BG_EXPANDED : BG_NORMAL);
        revalidate();
        repaint();
    }

    private void setHeaderBg(Color c) {
        Component[] all = getComponents();
        if (all.length > 0 && all[0] instanceof JPanel) {
            JPanel top = (JPanel) all[0];
            top.setBackground(c);
            for (Component sub : top.getComponents())
                sub.setBackground(c);
        }
    }

    private JLabel buildStarLabel() {
        JLabel star = new JLabel(isFavorite ? "★" : "☆");
        star.setForeground(isFavorite ? COLOR_STAR_ON : COLOR_STAR_OFF);
        star.setFont(FontManager.getRunescapeSmallFont().deriveFont(13f));
        star.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        star.addMouseListener(new MouseAdapter() {
            @Override
            public void mousePressed(MouseEvent e) {
                e.consume(); // don't propagate to toggle-expand
                onFavToggle.accept(item);
            }
        });
        return star;
    }

    private void refreshStarInHeader() {
        // The star lives at EAST of the header panel (index 0 of top panel â†’ index 0 there)
        // Walk the tree and update
        SwingUtilities.invokeLater(() -> {
            JPanel top = (JPanel) getComponent(0);       // BorderLayout.NORTH
            JPanel header = (JPanel) top.getComponent(0); // BorderLayout.NORTH inside top
            for (Component c : header.getComponents()) {
                if (c instanceof JLabel && (((JLabel) c).getText().equals("★") || ((JLabel) c).getText().equals("☆"))) {
                    JLabel lbl = (JLabel) c;
                    lbl.setText(isFavorite ? "★" : "☆");
                    lbl.setForeground(isFavorite ? COLOR_STAR_ON : COLOR_STAR_OFF);
                    break;
                }
            }
        });
    }

    // Label factory helpers

    private JLabel buildWebsiteLink() {
        JLabel link = new JLabel("<html><u>View graph on therealge.com \u2197</u></html>");
        link.setForeground(new Color(100, 180, 255));
        link.setFont(FontManager.getRunescapeSmallFont());
        link.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        link.setAlignmentX(Component.LEFT_ALIGNMENT);
        link.addMouseListener(new MouseAdapter() {
            @Override
            public void mousePressed(MouseEvent e) {
                e.consume();
                try {
                    String slug = toSlug(item.getName());
                    Desktop.getDesktop().browse(new URI("https://therealge.com/" + slug + ".html"));
                } catch (Exception ignored) {}
            }
        });
        return link;
    }

    private static String toSlug(String name) {
        return name.toLowerCase(Locale.ROOT)
            .replaceAll("[^a-z0-9 ]", " ")
            .trim()
            .replaceAll("\\s+", "-");
    }

    private static JLabel priceLabel(String text, Color fg) {
        JLabel l = new JLabel(text);
        l.setForeground(fg);
        l.setFont(FontManager.getRunescapeSmallFont());
        l.setHorizontalAlignment(SwingConstants.LEFT);
        return l;
    }

    private static JLabel detailLabel() {
        JLabel l = new JLabel("—");
        l.setForeground(TEXT_MUTED);
        l.setFont(FontManager.getRunescapeSmallFont());
        return l;
    }

    private static JPanel buildDetailRow(String key, JLabel valueLabel) {
        JPanel row = new JPanel(new BorderLayout(4, 0));
        row.setBackground(BG_EXPANDED);
        row.setBorder(new EmptyBorder(1, 0, 1, 0));
        row.setMaximumSize(new Dimension(Integer.MAX_VALUE, 18));
        row.setAlignmentX(Component.LEFT_ALIGNMENT);

        JLabel keyLabel = new JLabel(key);
        keyLabel.setForeground(TEXT_MUTED);
        keyLabel.setFont(FontManager.getRunescapeSmallFont());

        valueLabel.setHorizontalAlignment(SwingConstants.RIGHT);
        row.add(keyLabel,   BorderLayout.WEST);
        row.add(valueLabel, BorderLayout.CENTER);
        return row;
    }

    // Number formatting

    /** "39,272,481 gp" */
    static String gp(long v) {
        if (v == 0) return "N/A";
        return NF.format(v) + " gp";
    }

    /** Compact: "39.3M", "914K", "500" */
    static String compactGp(long v) {
        if (v == 0) return "—";
        if (v >= 1_000_000_000L) return String.format("%.1fB", v / 1_000_000_000.0);
        if (v >= 1_000_000L)     return String.format("%.1fM", v / 1_000_000.0);
        if (v >= 1_000L)         return String.format("%.1fK", v / 1_000.0);
        return NF.format(v);
    }
}
