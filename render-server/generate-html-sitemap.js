const https = require('https');
const fs = require('fs');
const path = require('path');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'sitemap-generator' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

const BLACKLISTED_NAMES = new Set([
  'blighted snare sack', 'blighted bind sack', 'not meat', 'fish chunks', 'chitin', "morrigan's javelin"
]);

function slugify(name) {
  return name.toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

(async () => {
  console.log('Fetching item mapping...');
  const mapping = await fetch('https://prices.runescape.wiki/api/v1/osrs/mapping');
  const filtered = mapping
    .filter(item => !BLACKLISTED_NAMES.has((item.name || '').toLowerCase()))
    .filter(item => slugify(item.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Group items by first letter
  const groups = {};
  for (const item of filtered) {
    const letter = item.name.charAt(0).toUpperCase();
    const key = /[A-Z]/.test(letter) ? letter : '#';
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }

  const sortedKeys = Object.keys(groups).sort((a, b) => {
    if (a === '#') return -1;
    if (b === '#') return 1;
    return a.localeCompare(b);
  });

  // Build HTML
  let letterNav = sortedKeys.map(k =>
    `<a href="#section-${k === '#' ? 'num' : k}">${k}</a>`
  ).join(' ');

  let sections = '';
  for (const key of sortedKeys) {
    const id = key === '#' ? 'num' : key;
    sections += `<h2 id="section-${id}">${key} (${groups[key].length} items)</h2>\n<ul>\n`;
    for (const item of groups[key]) {
      const slug = slugify(item.name);
      sections += `<li><a href="/${slug}">${escapeHtml(item.name)}</a></li>\n`;
    }
    sections += `</ul>\n`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>All OSRS Items - Grand Exchange Sitemap | TheRealGE</title>
  <meta name="description" content="Complete list of all ${filtered.length} OSRS Grand Exchange items with live price tracking. Browse every Old School RuneScape tradeable item.">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://therealge.com/sitemap-index">
  <link rel="icon" href="coins_10000.ico">
  <meta property="og:type" content="website">
  <meta property="og:title" content="All OSRS Items - Grand Exchange Sitemap">
  <meta property="og:description" content="Complete list of all ${filtered.length} OSRS Grand Exchange items.">
  <meta property="og:url" content="https://therealge.com/sitemap-index">
  <meta property="og:site_name" content="OSRS Grand Exchange Tracker">
  <style>
    body { font-family: Inter, system-ui, sans-serif; background: #0f1117; color: #e0e0e0; margin: 0; padding: 20px; }
    h1 { color: #f5c842; text-align: center; }
    h2 { color: #f5c842; border-bottom: 1px solid #333; padding-bottom: 6px; margin-top: 30px; }
    a { color: #7cb3ff; text-decoration: none; }
    a:hover { text-decoration: underline; color: #f5c842; }
    .letter-nav { text-align: center; margin: 20px 0; font-size: 1.1em; line-height: 2; }
    .letter-nav a { margin: 0 6px; padding: 4px 8px; border: 1px solid #333; border-radius: 4px; }
    .letter-nav a:hover { background: #222; }
    ul { columns: 2; column-gap: 40px; list-style: none; padding: 0; }
    li { padding: 3px 0; break-inside: avoid; }
    .back-link { text-align: center; margin: 20px 0; font-size: 1.1em; }
    @media (min-width: 768px) { ul { columns: 3; } }
    @media (min-width: 1200px) { ul { columns: 4; } }
    .container { max-width: 1200px; margin: 0 auto; }
  </style>
</head>
<body>
  <div class="container">
    <p class="back-link"><a href="/">← Back to Grand Exchange Tracker</a></p>
    <h1>All OSRS Grand Exchange Items (${filtered.length})</h1>
    <p style="text-align:center;color:#999;">Complete index of every tradeable item on the Old School RuneScape Grand Exchange.</p>
    <nav class="letter-nav">${letterNav}</nav>
    ${sections}
    <p class="back-link"><a href="/">← Back to Grand Exchange Tracker</a></p>
  </div>
</body>
</html>`;

  const outputPath = path.join(__dirname, '..', 'sitemap-index.html');
  fs.writeFileSync(outputPath, html, 'utf8');
  console.log(`Generated HTML sitemap with ${filtered.length} item links -> sitemap-index.html`);
})();
