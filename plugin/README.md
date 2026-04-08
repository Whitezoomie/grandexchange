# Zoom Flips – RuneLite Plugin

A RuneLite plugin that shows live Old School RuneScape Grand Exchange prices directly in your sidebar, powered by the same Wiki price API used by **therealge.com**.

---

## Features

| Feature | Details |
|---|---|
| **Wiki insta-buy price** | Highest current buy offer (what you get selling instantly) |
| **Wiki insta-sell price** | Lowest current sell offer (what you pay buying instantly) |
| **Net margin** | `instaBuy − instaSell − GE tax (2%, capped 5M)` |
| **Margin %** | Profit as a percentage of the insta-buy price |
| **Buy limit** | GE 4-hour purchase cap for the item |
| **Daily volume** | Estimated trade count from the Wiki `/volumes` endpoint |
| **Last updated** | How many minutes/hours ago the price was last observed |
| **Search** | Real-time item name filter |
| **Favourites** | Star any item; filter to show only favourites |
| **Sort** | Margin ↓ · Insta-Buy ↓ · Insta-Sell ↓ · Name A–Z · Volume ↓ |
| **Auto-refresh** | Configurable interval (default 5 min), or manual with ↻ button |

---

## Panel screenshot

```
┌───────────────────────────────────────┐
│  GE Price Tracker                 [↻] │
│  powered by therealge.com             │
├───────────────────────────────────────┤
│  [ Search items…               ] [★]  │
│  Sort: [Margin ↓            ▼]        │
├──────────────┬──────────────┬─────────┤
│  ▲ Insta-Buy │  ▼ Insta-Sell│ Δ Margin│
├───────────────────────────────────────┤
│  Dragon hunter crossbow           [★] │
│  ▲ 39.3M       ▼ 38.4M    Δ +914K    │
│                                       │
│  ▼ (click to expand)                  │
│    Wiki insta-buy:   39,272,481 gp    │
│    Wiki insta-sell:  38,358,192 gp    │
│    GE tax (2%):         785,449 gp    │
│    Net margin:          914,289 gp    │
│    Margin %:              2.30%       │
│    Buy limit:                   8     │
│    Daily volume:        1,234,567     │
│    Last price:              3m ago    │
├───────────────────────────────────────┤
│  4,312 items · updated 3m ago         │
└───────────────────────────────────────┘
```

---

## Data Sources

- **[OSRS Wiki Prices API](https://prices.runescape.wiki/api/v1/osrs/)** — live insta-buy/sell prices and volume
- **Prediction server** — polls the Wiki `/5m` endpoint every 5 minutes, stores 3 hours of history, and runs linear regression to score items by margin trend

---

## License

BSD 2-Clause — see [LICENSE](LICENSE)
