const https = require('https');
const fs = require('fs');
const path = require('path');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'page-generator' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

const BLACKLISTED_NAMES = new Set([
  'blighted snare sack', 'blighted bind sack', 'not meat', 'fish chunks', 'chitin', "morrigan's javelin"
]);

function slugify(name) {
  return name.toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function formatPrice(price) {
  if (price >= 1000000) return (price / 1000000).toFixed(1) + 'M';
  if (price >= 1000) return (price / 1000).toFixed(1) + 'K';
  return price.toString();
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

function generateHtmlPage(item, prices, indexHtml) {
  const slug = slugify(item.name);
  const currentPrice = prices?.data?.[item.id]?.high || 0;
  const avgPrice = prices?.data?.[item.id]?.avgHighPrice || currentPrice;
  
  const title = `${item.name} | OSRS Price Tracker`;
  const description = `Track OSRS ${item.name} prices. Current price: ${formatPrice(currentPrice)} gp. View price history, trends, and market data.`;
  const imageUrl = `https://oldschool.runescape.wiki/images/${item.icon || 'Item_None.png'}`;
  
  // Use index.html as a base and inject item metadata into the <head>
  // Replace the title and add item-specific meta tags
  let html = indexHtml;
  
  // Insert title
  html = html.replace(
    /<title>OSRS Grand Exchange Tracker<\/title>/,
    `<title>${escapeHtml(title)}</title>`
  );
  
  // Insert metadata before </head>
  const metaTags = `
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="keywords" content="OSRS, Grand Exchange, ${escapeHtml(item.name)}, price, tracker">
    
    <!-- Open Graph Tags -->
    <meta property="og:type" content="website">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:image" content="${escapeHtml(imageUrl)}">
    <meta property="og:url" content="https://therealge.com/${slug}">
    <meta property="og:site_name" content="OSRS Grand Exchange Tracker">
    
    <!-- Twitter Card Tags -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(title)}">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="${escapeHtml(imageUrl)}">
    
    <!-- Canonical URL -->
    <link rel="canonical" href="https://therealge.com/${slug}">
    
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Product",
      "name": "${escapeHtml(item.name)}",
      "description": "${escapeHtml(description)}",
      "image": "${escapeHtml(imageUrl)}",
      "offers": {
        "@type": "Offer",
        "priceCurrency": "GP",
        "price": "${currentPrice}"
      },
      "url": "https://therealge.com/${slug}"
    }
    </script>
    `;
  
  html = html.replace('</head>', metaTags + '\n</head>');
  
  // Set data-initial-item attribute on body
  html = html.replace('<body>', `<body data-initial-item="${item.id}">`);
  
  return html;
}

(async () => {
  try {
    console.log('🔄 Loading index.html template...');
    const indexHtmlPath = path.join(__dirname, '..', 'index.html');
    const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
    
    console.log('🔄 Fetching item mapping...');
    const mapping = await fetch('https://prices.runescape.wiki/api/v1/osrs/mapping');
    const filtered = mapping.filter(item => !BLACKLISTED_NAMES.has((item.name || '').toLowerCase()));
    
    console.log(`📦 Found ${filtered.length} items to generate`);
    
    // Also fetch current prices for enhanced metadata
    console.log('🔄 Fetching current prices...');
    const latest = await fetch('https://prices.runescape.wiki/api/v1/osrs/latest');
    
    const outputDir = path.join(__dirname, '..');
    let successCount = 0;
    let errorCount = 0;
    
    for (let i = 0; i < filtered.length; i++) {
      const item = filtered[i];
      const slug = slugify(item.name);
      
      if (!slug) continue;
      
      try {
        const html = generateHtmlPage(item, latest, indexHtml);
        const filePath = path.join(outputDir, `${slug}.html`);
        fs.writeFileSync(filePath, html, 'utf8');
        successCount++;
        
        if ((i + 1) % 100 === 0) {
          console.log(`  ✓ Generated ${i + 1}/${filtered.length} pages...`);
        }
      } catch (e) {
        console.error(`  ✗ Failed to generate ${item.name}:`, e.message);
        errorCount++;
      }
    }
    
    console.log(`\n✅ Generation complete!`);
    console.log(`   ✓ ${successCount} pages created`);
    if (errorCount > 0) {
      console.log(`   ✗ ${errorCount} pages failed`);
    }
    console.log(`\nFiles saved to: ${outputDir}`);
    
  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  }
})();
