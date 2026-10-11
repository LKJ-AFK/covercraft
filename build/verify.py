# -*- coding: utf-8 -*-
import os, sys
base = r'C:\Users\48139\Doubao\chats\2026-09-27\new-chat\zibby-port\covercraft'
txt = open(os.path.join(base, 'index.html'), 'rb').read().decode('utf-8')
checks = {
  'module app.js': 'type="module" src="./app.js"' in txt,
  'inline script removed': "function(){\n  'use strict';" not in txt,
  'jspdf vendor': 'src="./vendor/jspdf.umd.min.js"' in txt,
  'jspdf CDN removed': 'cdn.jsdelivr' not in txt,
  'BUY_URL neutralised': '__BUY_URL__' not in txt,
  'canonical removed': 'rel="canonical"' not in txt,
  'old domain gone': 'c1.ersilabs.com' not in txt,
  'example links relative': 'href="./pages/data-analyst-cover-letter.html"' in txt,
  'privacy relative': 'href="./pages/privacy.html"' in txt,
  'appears complete': txt.rstrip().endswith('</html>')
}
print('== index.html ==')
for k, v in checks.items():
    print(('OK  ' if v else 'FAIL'), k)
p2 = os.path.join(base, 'pages')
files = sorted(os.listdir(p2))
print('== pages dir: %d files ==' % len(files))
for f in files:
    c = open(os.path.join(p2, f), 'rb').read().decode('utf-8')
    old = 'c1.ersilabs.com' in c
    rel = ('href="./"' in c) or ('href="./pages/' in c)
    print(' ', f, len(c), 'chars | old domain:', old, '| relative links:', rel)
