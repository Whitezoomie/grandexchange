Social sharing cards (Open Graph / Twitter)
=========================================

This scaffold provides two small scripts and a template to create social sharing images (1200x630) and inject meta tags into your HTML pages.

1) Generate an OG image (requires `canvas`)

Install dependencies in the project root:

```bash
npm init -y
npm install canvas
```

Generate a single image:

```bash
node scripts/generate-og-images.js --id "item_id" --name "Item Name" --price "123k" --image path/to/sprite.png --out ./og-images
```

The script writes PNG files to `./og-images` by default.

2) Inject meta tags into HTML files

The injector will add basic OG/Twitter meta tags to every `.html` file in a directory (creates `.bak` backups):

```bash
node scripts/inject-og-meta.js --dir ./ --imageBase https://yourdomain.com/og-images
```

It constructs image URLs by taking the HTML filename (e.g. `abyssal-whip.html` -> `.../abyssal-whip.png`).

3) Template

See `templates/og-meta.html` for a copy/paste snippet with placeholders.

Notes & recommendations
- Generate images as part of your build when item data changes (CI or local script).
- Upload images to a CDN and use long cache TTLs; invalidate on updates.
- Test with Facebook Sharing Debugger and Twitter Card Validator.
