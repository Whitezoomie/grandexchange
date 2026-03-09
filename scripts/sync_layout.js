const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const indexPath = path.join(root, 'index.html');

function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, d) { fs.writeFileSync(p, d, 'utf8'); }

const indexHtml = read(indexPath);

const headerMatch = indexHtml.match(/<header class="header">[\s\S]*?<\/header>/i);
const footerMatch = indexHtml.split('</main>')[1];

if (!headerMatch || footerMatch === undefined) {
  console.error('Failed to extract header/footer from index.html');
  process.exit(1);
}

const headerTemplate = headerMatch[0];
const footerTemplate = '</main>' + footerMatch; // include </main> so we replace from that point

console.log('Header and footer templates extracted.');

const files = fs.readdirSync(root).filter(f => f.endsWith('.html') && f !== 'index.html');
console.log(`Found ${files.length} HTML files to process.`);

files.forEach(file => {
  const p = path.join(root, file);
  let content = read(p);
  const original = content;

  // Replace header
  if (content.match(/<header class="header">[\s\S]*?<\/header>/i)) {
    content = content.replace(/<header class="header">[\s\S]*?<\/header>/i, headerTemplate);
  } else if (content.includes('<body')) {
    // insert header after <body ...>
    content = content.replace(/(<body[\s\S]*?>)/i, `$1\n${headerTemplate}`);
  }

  // Replace footer: find first </main> and replace from there to end with footerTemplate
  const mainIndex = content.indexOf('</main>');
  if (mainIndex !== -1) {
    content = content.substring(0, mainIndex) + footerTemplate;
  } else {
    // if no main tag, append footerTemplate before </body> or at end
    if (content.includes('</body>')) {
      content = content.replace(/<\/body>/i, `${footerTemplate}\n</body>`);
    } else {
      content = content + '\n' + footerTemplate;
    }
  }

  if (content !== original) {
    // backup
    write(p + '.bak', original);
    write(p, content);
    console.log(`Updated: ${file} (backup: ${file}.bak)`);
  } else {
    console.log(`No changes for: ${file}`);
  }
});

console.log('Done.');
