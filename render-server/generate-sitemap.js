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

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

(async () => {
  const mapping = await fetch('https://prices.runescape.wiki/api/v1/osrs/mapping');
  const filtered = mapping.filter(item => !BLACKLISTED_NAMES.has((item.name || '').toLowerCase()));

  // Add custom items
  const customItems = [
    { name: 'Annihilation weapon scroll', icon: 'Annihilation_weapon_scroll.png' },
    { name: 'Annihilation blueprints', icon: 'Annihilation_blueprints.png' },
    { name: 'Annihilation teleport scroll', icon: 'Annihilation_teleport_scroll.png' },
  ];

  const today = new Date().toISOString().split('T')[0];
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n';
  xml += '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n';

  // Homepage
  xml += `  <url>\n    <loc>https://therealge.com/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n    <image:image>\n      <image:loc>https://therealge.com/og-image.png</image:loc>\n      <image:title>OSRS Grand Exchange Tracker</image:title>\n      <image:caption>Live item prices and market data for Old School RuneScape</image:caption>\n    </image:image>\n  </url>\n`;

  // Item pages
  for (const item of filtered) {
    const slug = slugify(item.name);
    if (!slug) continue;
    const imageUrl = `https://oldschool.runescape.wiki/images/${item.icon || 'Item_None.png'}`;
    xml += `  <url>\n    <loc>https://therealge.com/${slug}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.7</priority>\n    <image:image>\n      <image:loc>${escapeXml(imageUrl)}</image:loc>\n      <image:title>${escapeXml(item.name)}</image:title>\n      <image:caption>OSRS ${escapeXml(item.name)} - Grand Exchange price tracker</image:caption>\n    </image:image>\n  </url>\n`;
  }

  // Custom items
  for (const item of customItems) {
    const slug = slugify(item.name);
    const imageUrl = `https://oldschool.runescape.wiki/images/${item.icon}`;
    xml += `  <url>\n    <loc>https://therealge.com/${slug}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.7</priority>\n    <image:image>\n      <image:loc>${escapeXml(imageUrl)}</image:loc>\n      <image:title>${escapeXml(item.name)}</image:title>\n      <image:caption>OSRS ${escapeXml(item.name)} - Grand Exchange price tracker</image:caption>\n    </image:image>\n  </url>\n`;
  }

  xml += '</urlset>\n';

  const outputPath = path.join(__dirname, '..', 'sitemap.xml');
  fs.writeFileSync(outputPath, xml);
  console.log('Generated sitemap with ' + (filtered.length + customItems.length + 1) + ' URLs (with image extensions)');
})();
