Check sitemap URLs

This folder contains a small utility to validate the `sitemap.xml` entries against
the local HTML files in the repository and to check canonical/meta tags.

Run:

```bash
python scripts/check_sitemap_urls.py         # just report problems
python scripts/check_sitemap_urls.py --fix   # also fix canonical mismatches (backups created)
```

Output:
- `sitemap_check_report.txt` will be written in the repository root with results.

Notes:
- The script only performs filesystem checks (no network requests). To fully validate
  how Google sees the live site, run the curl/wget commands suggested in the main
  repo README or use Search Console's Live Test.
