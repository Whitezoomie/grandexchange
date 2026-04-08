package com.therealge.gepricer;

import net.runelite.client.config.Config;
import net.runelite.client.config.ConfigGroup;
import net.runelite.client.config.ConfigItem;
import net.runelite.client.config.Range;

@ConfigGroup("gepricer")
public interface GEPricerConfig extends Config {
    @ConfigItem(
        keyName    = "refreshInterval",
        name       = "Refresh Interval (minutes)",
        description = "How often prices refresh automatically. 0 = manual only.",
        position   = 1
    )
    @Range(min = 0, max = 60)
    default int refreshInterval() {
        return 5;
    }

    @ConfigItem(
        keyName    = "defaultSort",
        name       = "Default Sort",
        description = "How to order items in the panel.",
        position   = 2
    )
    default SortType defaultSort() {
        return SortType.MARGIN_DESC;
    }

    @ConfigItem(
        keyName    = "hideNoPrices",
        name       = "Hide items without prices",
        description = "Don't show items that have no recent price data.",
        position   = 3
    )
    default boolean hideNoPrices() {
        return false;
    }

    @ConfigItem(
        keyName    = "enableNotifications",
        name       = "Enable Notifications",
        description = "Show a RuneLite notification when a buy or sell completes.",
        position   = 4
    )
    default boolean enableNotifications() {
        return true;
    }

    // Persisted as comma-separated IDs, not shown in config UI
    @ConfigItem(
        keyName    = "favorites",
        name       = "Favorites",
        description = "Comma-separated list of favorited item IDs (managed by the panel).",
        hidden     = true
    )
    default String favorites() {
        return "";
    }

    enum SortType {
        MARGIN_DESC("Margin ↓"),
        INSTABUY_DESC("Insta-Buy ↓"),
        INSTASELL_DESC("Insta-Sell ↓"),
        NAME_ASC("Name A-Z"),
        VOLUME_DESC("Volume ↓");

        private final String label;

        SortType(String label) {
            this.label = label;
        }

        @Override
        public String toString() {
            return label;
        }
    }
}
