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

function generateHtmlPage(item, prices, indexHtml, allItems) {
  const slug = slugify(item.name);
  const currentPrice = prices?.data?.[item.id]?.high || 0;
  const avgPrice = prices?.data?.[item.id]?.avgHighPrice || currentPrice;
  
  const title = `${item.name} | OSRS Price Tracker`;
  const description = `Track ${item.name} price on the OSRS Grand Exchange. Current price: ${formatPrice(currentPrice)} gp. View live price history, margins, volume, and market trends for Old School RuneScape.`;
  const imageUrl = `https://oldschool.runescape.wiki/images/${item.icon || 'Item_None.png'}`;
  
  // Use index.html as a base and inject item metadata into the <head>
  let html = indexHtml;
  
  // Insert title
  html = html.replace(
    /<title>[^<]*<\/title>/,
    `<title>${escapeHtml(title)}</title>`
  );
  
  // Insert metadata before </head>
  const metaTags = `
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="keywords" content="OSRS, Grand Exchange, ${escapeHtml(item.name)}, price, tracker, market data, price history">
    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
    
    <!-- Open Graph Tags -->
    <meta property="og:type" content="website">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:image" content="${escapeHtml(imageUrl)}">
    <meta property="og:image:alt" content="${escapeHtml(item.name)} - OSRS Grand Exchange item">
    <meta property="og:url" content="https://therealge.com/${slug}">
    <meta property="og:site_name" content="OSRS Grand Exchange Tracker">
    <meta property="og:locale" content="en_US">
    
    <!-- Twitter Card Tags -->
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="${escapeHtml(title)}">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="${escapeHtml(imageUrl)}">
    <meta name="twitter:image:alt" content="${escapeHtml(item.name)} - OSRS Grand Exchange item">
    
    <!-- Canonical URL -->
    <link rel="canonical" href="https://therealge.com/${slug}">
    
    <!-- BreadcrumbList Schema -->
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://therealge.com/"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "${escapeHtml(item.name)}",
          "item": "https://therealge.com/${slug}"
        }
      ]
    }
    </script>

    <!-- Product Schema -->
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Product",
      "name": "${escapeHtml(item.name)}",
      "description": "${escapeHtml(item.examine || description)}",
      "image": "${escapeHtml(imageUrl)}",
      "url": "https://therealge.com/${slug}",
      "brand": {
        "@type": "Brand",
        "name": "Old School RuneScape"
      },
      "category": "${item.members ? 'Members' : 'Free-to-Play'} OSRS Item",
      "offers": {
        "@type": "Offer",
        "priceCurrency": "GP",
        "price": "${currentPrice}",
        "availability": "https://schema.org/InStock",
        "url": "https://therealge.com/${slug}"
      }
    }
    </script>
    `;
  
  html = html.replace('</head>', metaTags + '\n</head>');
  
  // Set data-initial-item attribute on body (match any existing body tag)
  html = html.replace(/<body[^>]*>/, `<body data-initial-item="${item.id}">`);
  
  // Build noscript fallback content + internal links for crawlers
  const priceStr = currentPrice ? formatPrice(currentPrice) : 'N/A';
  const memberStr = item.members ? 'Members' : 'Free-to-Play';
  const examineStr = item.examine ? escapeHtml(item.examine) : '';
  
  // Pick related items: same first letter, capped at 20 links for crawlability
  const firstChar = item.name.charAt(0).toLowerCase();
  const related = allItems
    .filter(other => other.name.charAt(0).toLowerCase() === firstChar && slugify(other.name) !== slug)
    .slice(0, 20);
  
  let relatedLinks = related.map(other => {
    const otherSlug = slugify(other.name);
    const otherPrice = prices?.data?.[other.id]?.high;
    const otherPriceStr = otherPrice ? formatPrice(otherPrice) : '';
    return `<li><a href="/${otherSlug}">${escapeHtml(other.name)}</a>${otherPriceStr ? ' - ' + otherPriceStr + ' gp' : ''}</li>`;
  }).join('\n');
  
  const noscriptBlock = `
    <noscript>
    <div class="seo-fallback">
      <h1>${escapeHtml(item.name)} - OSRS Grand Exchange Price</h1>
      <p>Current price: <strong>${priceStr} gp</strong> | ${memberStr} item</p>
      ${examineStr ? '<p>' + examineStr + '</p>' : ''}
      <p>Track real-time prices, margins, volume, and historical price charts for ${escapeHtml(item.name)} on the Old School RuneScape Grand Exchange.</p>
      <p><a href="/">Back to Grand Exchange Tracker</a> | <a href="/sitemap-index">All Items</a></p>
      ${related.length > 0 ? '<h2>Related Items</h2><ul>' + relatedLinks + '</ul>' : ''}
    </div>
    </noscript>`;
  
  // Insert SEO H1 + noscript block right after <body>
  html = html.replace(
    /(<body[^>]*>)/,
    `$1\n    <h1 class="seo-item-title">${escapeHtml(item.name)} - OSRS Grand Exchange Price</h1>${noscriptBlock}`
  );
  
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
        const html = generateHtmlPage(item, latest, indexHtml, filtered);
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
