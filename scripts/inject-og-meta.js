#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function parseArgs(){
  const out = {};
  const argv = process.argv.slice(2);
  for (let i=0;i<argv.length;i++){
    const a = argv[i];
    if(a.startsWith('--')){
      const k = a.slice(2);
      const v = argv[i+1] && !argv[i+1].startsWith('--') ? argv[++i] : true;
      out[k]=v;
    }
  }
  return out;
}

function titleFromHtml(content){
  const m = content.match(/<title>([^<]+)<\/title>/i);
  return m ? m[1].trim() : null;
}

function firstParagraph(content){
  const m = content.match(/<p[^>]*>([\s\S]{20,}?)<\/p>/i);
  return m ? m[1].replace(/<[^>]+>/g,'').trim().slice(0,200) : '';
}

function injectMeta(filePath, opts){
  const raw = fs.readFileSync(filePath,'utf8');
  if (/property=\"og:title\"|name=\"twitter:card\"/i.test(raw)){
    console.log('Skipping (already has OG meta):', filePath);
    return;
  }
  const headIndex = raw.search(/<head[^>]*>/i);
  if (headIndex === -1){ console.warn('No <head> found:', filePath); return; }
  const insertPoint = raw.indexOf('>', headIndex) + 1;
  const title = titleFromHtml(raw) || path.basename(filePath, '.html');
  const desc = firstParagraph(raw) || opts.description || '';
  const imageUrl = (opts.imageBase || '').replace(/\/$/, '') + '/' + path.basename(filePath, '.html') + '.png';

  const meta = `\n    <!-- Social sharing meta injected by inject-og-meta.js -->\n    <meta property="og:title" content="${escapeHtml(title)}" />\n    <meta property="og:description" content="${escapeHtml(desc)}" />\n    <meta property="og:image" content="${escapeHtml(imageUrl)}" />\n    <meta property="og:image:width" content="1200" />\n    <meta property="og:image:height" content="630" />\n    <meta name="twitter:card" content="summary_large_image" />\n    <meta name="twitter:site" content="@yourhandle" />\n`;

  const backup = filePath + '.bak';
  fs.copyFileSync(filePath, backup);
  const updated = raw.slice(0, insertPoint) + meta + raw.slice(insertPoint);
  fs.writeFileSync(filePath, updated, 'utf8');
  console.log('Injected meta into', filePath, '(backup ->', backup,')');
}

function escapeHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function main(){
  const args = parseArgs();
  const dir = args.dir || process.cwd();
  const imageBase = args.imageBase || '';
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
  files.forEach(f => {
    try{ injectMeta(path.join(dir,f), { imageBase, description: args.description }); }
    catch(e){ console.error('Error processing', f, e.message); }
  });
}

main();
