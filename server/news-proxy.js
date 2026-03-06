const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

const TARGET = 'https://oldschool.runescape.com/news';

app.get('/osrs-news', async (req, res) => {
  try {
    const resp = await axios.get(TARGET, { timeout: 8000, headers: { 'User-Agent': 'GrandExchangeSite/1.0 (+https://example.com)' } });
    const html = resp.data;
    const $ = cheerio.load(html);

    // Find candidate links that look like news items
    const selectors = ['article a', 'h2 a', 'h3 a', '.news-list a', '.newsItem a', 'a[href*="/news/"]'];
    const found = [];
    selectors.forEach(sel => {
      $(sel).each((i, el) => {
        const href = $(el).attr('href');
        const text = ($(el).text() || '').trim();
        if (href && text) {
          const url = href.startsWith('http') ? href : new URL(href, TARGET).href;
          found.push({ title: text, url });
        }
      });
    });

    // Deduplicate by URL and return up to 12 items
    const seen = new Set();
    const unique = [];
    for (const it of found) {
      if (!seen.has(it.url)) { seen.add(it.url); unique.push(it); }
      if (unique.length >= 12) break;
    }

    if (unique.length === 0) return res.status(502).json({ error: 'no_headlines' });
    return res.json(unique);
  } catch (err) {
    console.error('news-proxy error:', err && err.message);
    return res.status(500).json({ error: 'fetch_failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('OSRS news proxy listening on port', PORT);
});
