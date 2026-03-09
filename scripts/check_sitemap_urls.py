#!/usr/bin/env python3
"""
Validate sitemap URLs against local .html files and check canonical/meta tags.

Usage:
  python scripts/check_sitemap_urls.py [--fix]

Outputs a report to stdout and writes `sitemap_check_report.txt`.
With `--fix`, the script will update mismatched canonical hrefs in-place
and create a `.bak` backup for each file it changes.
"""
import sys
import os
import re
import argparse
from urllib.parse import urlparse
import xml.etree.ElementTree as ET


WORKDIR = os.path.dirname(os.path.dirname(__file__))
SITEMAP = os.path.join(WORKDIR, 'sitemap.xml')


def parse_sitemap(path):
    tree = ET.parse(path)
    root = tree.getroot()
    ns = {'ns': 'http://www.sitemaps.org/schemas/sitemap/0.9'}
    urls = []
    for url in root.findall('ns:url', ns):
        loc = url.find('ns:loc', ns)
        if loc is not None and loc.text:
            urls.append(loc.text.strip())
    return urls


def expected_filepath_from_url(loc_url):
    p = urlparse(loc_url).path
    if p.endswith('/') or p == '':
        # root or directory — map to index.html if present
        candidate = os.path.join(WORKDIR, 'index.html')
        return candidate
    # remove leading slash
    if p.startswith('/'):
        p = p[1:]
    # add .html
    return os.path.join(WORKDIR, p + '.html')


CANONICAL_RE = re.compile(r'<link[^>]+rel=["\']canonical["\'][^>]*>', re.I)
HREF_RE = re.compile(r'href=["\']([^"\']+)["\']', re.I)


def read_file(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        return f.read()


def write_file(path, contents):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(contents)


def check_and_fix(loc_url, fix=False):
    fp = expected_filepath_from_url(loc_url)
    rel = os.path.relpath(fp, WORKDIR)
    result = {'url': loc_url, 'file': rel, 'exists': False, 'canonical_ok': None, 'meta_robots': None, 'fixed': False}
    if os.path.exists(fp):
        result['exists'] = True
        html = read_file(fp)
        # find canonical
        m = CANONICAL_RE.search(html)
        expected = loc_url.rstrip('/') if not loc_url.endswith('/') else loc_url.rstrip('/')
        if m:
            tag = m.group(0)
            href_m = HREF_RE.search(tag)
            href = href_m.group(1).strip() if href_m else ''
            # normalize
            href_norm = href.rstrip('/')
            if href_norm == expected.rstrip('/'):
                result['canonical_ok'] = True
            else:
                result['canonical_ok'] = False
                result['found_canonical'] = href
                if fix:
                    # replace the canonical tag with correct href
                    new_tag = re.sub(HREF_RE, "href=\"%s\"" % expected, tag)
                    new_html = html.replace(tag, new_tag)
                    # backup
                    bak = fp + '.bak'
                    if not os.path.exists(bak):
                        write_file(bak, html)
                    write_file(fp, new_html)
                    result['fixed'] = True
        else:
            result['canonical_ok'] = False
            result['found_canonical'] = None
            if fix:
                # insert canonical into <head>
                head_open = re.search(r'<head[^>]*>', html, re.I)
                if head_open:
                    insert_at = head_open.end()
                    canonical_tag = f'\n    <link rel="canonical" href="{loc_url}" />\n'
                    new_html = html[:insert_at] + canonical_tag + html[insert_at:]
                    bak = fp + '.bak'
                    if not os.path.exists(bak):
                        write_file(bak, html)
                    write_file(fp, new_html)
                    result['fixed'] = True
        # check meta robots noindex
        mr = re.search(r'<meta[^>]+name=["\']robots["\'][^>]*>', html, re.I)
        if mr:
            content_m = re.search(r'content=["\']([^"\']+)["\']', mr.group(0), re.I)
            result['meta_robots'] = content_m.group(1).lower() if content_m else ''
    else:
        result['exists'] = False
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fix', action='store_true', help='Automatically fix canonical mismatches')
    args = parser.parse_args()

    if not os.path.exists(SITEMAP):
        print('sitemap.xml not found at', SITEMAP)
        sys.exit(2)

    urls = parse_sitemap(SITEMAP)
    print(f'Parsed {len(urls)} URLs from sitemap.xml')
    report_lines = []
    problems = 0
    for u in urls:
        r = check_and_fix(u, fix=args.fix)
        if not r['exists']:
            problems += 1
            report_lines.append(f"MISSING FILE: {r['url']} -> local file {r['file']} not found")
        else:
            if r['canonical_ok'] is True:
                report_lines.append(f"OK: {r['url']} -> {r['file']}")
            else:
                problems += 1
                fc = r.get('found_canonical')
                if fc is None:
                    report_lines.append(f"NO CANONICAL: {r['url']} -> {r['file']} (no canonical tag)")
                else:
                    report_lines.append(f"BAD CANONICAL: {r['url']} -> {r['file']} (found: {fc})")
                if r.get('fixed'):
                    report_lines.append(f"  -> Fixed canonical in {r['file']} (backup created .bak)")
            if r['meta_robots']:
                if 'noindex' in r['meta_robots']:
                    problems += 1
                    report_lines.append(f"META NOINDEX: {r['url']} -> {r['file']} (meta robots: {r['meta_robots']})")

    summary = [f'Checked {len(urls)} urls, problems found: {problems}']
    out = '\n'.join(summary + [''] + report_lines)
    print(out)
    with open(os.path.join(WORKDIR, 'sitemap_check_report.txt'), 'w', encoding='utf-8') as f:
        f.write(out)


if __name__ == '__main__':
    main()
