const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const indexPath = path.join(root, 'index.html');
const indexHtml = fs.readFileSync(indexPath, 'utf8');

function extractBetween(html, startTag, endTag, flags='i'){
  const re = new RegExp(startTag + '([\s\S]*?)' + endTag, flags);
  const m = html.match(re);
  return m ? m[1] : null;
}

function getTag(html, re){
  const m = html.match(re);
  return m ? m[0] : null;
}

function replaceTag(html, re, replacement){
  return html.replace(re, replacement);
}

const files = fs.readdirSync(root).filter(f => f.endsWith('.html') && f !== 'index.html');
console.log('Files to process:', files.length);

files.forEach(file => {
  const p = path.join(root, file);
  const original = fs.readFileSync(p, 'utf8');

  // Extract item-specific pieces
  const title = extractBetween(original, '<title>', '</title>') || '';
  const metaDesc = getTag(original, /<meta\s+name=["']description["'][^>]*>/i);
  const metaKeywords = getTag(original, /<meta\s+name=["']keywords["'][^>]*>/i);
  const canonical = getTag(original, /<link\s+rel=["']canonical["'][^>]*>/i);
  const ogTags = original.match(/<meta\s+property=["']og:[^>]*>/ig) || [];
  const twitterTags = original.match(/<meta\s+name=["']twitter:[^>]*>/ig) || [];
  const ldjson = original.match(/<script\s+type=["']application\/ld\+json["'][\s\S]*?<\/script>/ig) || [];
  const bodyMatch = original.match(/<body( [^>]*)?>/i);
  const bodyAttrs = bodyMatch ? bodyMatch[1] || '' : '';
  const dataInitialMatch = original.match(/data-initial-item=["'](\d+)["']/i);
  const dataInitial = dataInitialMatch ? dataInitialMatch[1] : null;
  const seoH1 = getTag(original, /<h1\s+class=["']seo-item-title["'][\s\S]*?<\/h1>/i);

  let newHtml = indexHtml;

  // Replace title
  if (title) {
    newHtml = newHtml.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`);
  }

  // Replace description
  if (metaDesc) {
    newHtml = newHtml.replace(/<meta\s+name=["']description["'][^>]*>/i, metaDesc);
  }

  // Replace keywords
  if (metaKeywords) {
    if (newHtml.match(/<meta\s+name=["']keywords["'][^>]*>/i)) {
      newHtml = newHtml.replace(/<meta\s+name=["']keywords["'][^>]*>/i, metaKeywords);
    } else {
      newHtml = newHtml.replace(/<\/title>/i, `</title>\n    ${metaKeywords}`);
    }
  }

  // Replace canonical
  if (canonical) {
    if (newHtml.match(/<link\s+rel=["']canonical["'][^>]*>/i)) {
      newHtml = newHtml.replace(/<link\s+rel=["']canonical["'][^>]*>/i, canonical);
    } else {
      newHtml = newHtml.replace(/<meta\s+name=["']theme-color["'][^>]*>/i, `$&\n    ${canonical}`);
    }
  }

  // Replace OG & Twitter tags: remove existing and insert originals
  newHtml = newHtml.replace(/<meta\s+property=["']og:[^>]*>\s*/ig, '');
  newHtml = newHtml.replace(/<meta\s+name=["']twitter:[^>]*>\s*/ig, '');
  if (ogTags.length) newHtml = newHtml.replace(/<link\s+rel=["']canonical["'][^>]*>\s*/i, `$&\n    ${ogTags.join('\n    ')}`);
  if (twitterTags.length) newHtml = newHtml.replace(/<link\s+rel=["']canonical["'][^>]*>\s*/i, `$&\n    ${twitterTags.join('\n    ')}`);

  // Insert ld+json blocks by removing existing ld+json in template and adding originals before closing head
  newHtml = newHtml.replace(/<script\s+type=["']application\/ld\+json["'][\s\S]*?<\/script>\s*/ig, '');
  if (ldjson.length) {
    const insertion = ldjson.join('\n    ');
    newHtml = newHtml.replace(/<link\s+rel=["']icon["'][^>]*>\s*<\/head>/i, `${insertion}\n</head>`);
  }

  // Set body data-initial-item
  if (dataInitial) {
    newHtml = newHtml.replace(/<body( [^>]*)?>/i, `<body data-initial-item="${dataInitial}">`);
  }

  // Insert seo h1 after opening body
  if (seoH1) {
    newHtml = newHtml.replace(/<body[^>]*>/i, match => `${match}\n    ${seoH1}`);
  }

  // Write backup and new file
  fs.writeFileSync(p + '.bak2', original, 'utf8');
  fs.writeFileSync(p, newHtml, 'utf8');
  console.log('Patched:', file);
});

console.log('All done.');
