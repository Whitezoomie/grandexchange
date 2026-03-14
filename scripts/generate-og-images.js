#!/usr/bin/env node
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');

function parseArgs() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i+1] && !argv[i+1].startsWith('--') ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

function sanitizeFileName(s){
  return s.replace(/[^a-z0-9-_]/gi,'_').replace(/__+/g,'_').toLowerCase();
}

async function main(){
  const args = parseArgs();
  const name = args.name || args.title || 'Item';
  const id = args.id || sanitizeFileName(name);
  const price = args.price || '';
  const imagePath = args.image || null;
  const outDir = args.out || path.join(process.cwd(),'og-images');
  fs.mkdirSync(outDir, { recursive: true });

  const width = 1200, height = 630;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background gradient
  const g = ctx.createLinearGradient(0,0,width,height);
  g.addColorStop(0,'#0f1724');
  g.addColorStop(1,'#0b1220');
  ctx.fillStyle = g;
  ctx.fillRect(0,0,width,height);

  // subtle pattern / card area
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(40,40,width-80,height-80);

  // Item image
  if (imagePath) {
    try {
      const img = await loadImage(path.resolve(imagePath));
      const imgW = Math.floor(width * 0.36);
      const imgH = Math.floor(height - 120);
      const x = 60;
      const y = 60;
      ctx.drawImage(img, x, y, imgW, imgH);
    } catch(e) {
      console.error('Failed to load image:', e.message);
    }
  }

  // Title
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 56px Inter, Arial';
  const metaX = imagePath ? Math.floor(width * 0.44) : 80;
  const metaW = width - metaX - 80;
  // wrap title if needed
  function drawWrapped(text, x, y, maxWidth, lineHeight) {
    const words = text.split(' ');
    let line = '';
    let curY = y;
    for (let n = 0; n < words.length; n++) {
      const testLine = line + words[n] + ' ';
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth && n > 0) {
        ctx.fillText(line.trim(), x, curY);
        line = words[n] + ' ';
        curY += lineHeight;
      } else {
        line = testLine;
      }
    }
    if (line) ctx.fillText(line.trim(), x, curY);
    return curY;
  }

  ctx.fillStyle = '#fff';
  ctx.font = '700 56px Inter, Arial';
  drawWrapped(name, metaX, 160, metaW, 66);

  // Price badge
  if (price) {
    ctx.fillStyle = 'rgba(200,170,110,0.95)';
    ctx.beginPath();
    const bx = metaX;
    const by = 260;
    const bh = 44;
    const bw = Math.min(420, metaW);
    ctx.roundRect ? ctx.roundRect(bx, by, bw, bh, 8) : null;
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#0b1220';
    ctx.font = '700 20px Inter, Arial';
    ctx.fillText(price, bx + 16, by + 28);
  }

  // site logo / credit
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(width - 220, height - 80, 180, 48);
  ctx.fillStyle = '#fff';
  ctx.font = '600 16px Inter, Arial';
  ctx.fillText('Grand Exchange', width - 180, height - 50);

  const outPath = path.join(outDir, `${id}.png`);
  const out = fs.createWriteStream(outPath);
  const stream = canvas.createPNGStream();
  stream.pipe(out);
  out.on('finish', () => console.log('Wrote', outPath));
}

main().catch(err=>{ console.error(err); process.exit(1); });
