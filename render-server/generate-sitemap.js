const https = require('https');

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

(async () => {
  const mapping = await fetch('https://prices.runescape.wiki/api/v1/osrs/mapping');
  const filtered = mapping.filter(item => !BLACKLISTED_NAMES.has((item.name || '').toLowerCase()));
  const slugs = filtered.map(item => slugify(item.name)).filter(Boolean);

  // Add custom items
  slugs.push('annihilation-weapon-scroll', 'annihilation-blueprints', 'annihilation-teleport-scroll');

  const today = new Date().toISOString().split('T')[0];
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  xml += `  <url>\n    <loc>https://therealge.com/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>\n`;

  for (const slug of slugs) {
    xml += `  <url>\n    <loc>https://therealge.com/${slug}</loc>\n    <changefreq>daily</changefreq>\n    <priority>0.7</priority>\n  </url>\n`;
  }
  xml += '</urlset>\n';

  require('fs').writeFileSync('sitemap.xml', xml);
  console.log('Generated sitemap with ' + (slugs.length + 1) + ' URLs');
})();
