# -*- coding: utf-8 -*-
import os, sys
base = r'C:\Users\48139\Doubao\chats\2026-09-27\new-chat\zibby-port\covercraft'
txt = open(os.path.join(base, 'index.html'), 'rb').read().decode('utf-8')
checks = {
  'module app.js': 'type="module" src="./assets/app.js"' in txt,
  'inline script removed': "function(){\n  'use strict';" not in txt,
  'jspdf vendor': 'src="./assets/vendor/jspdf.umd.min.js"' in txt,
  'jspdf CDN removed': 'cdn.jsdelivr' not in txt,
  'BUY_URL neutralised': '__BUY_URL__' not in txt,
  'canonical removed': 'rel="canonical"' not in txt,
  'old domain gone': 'c1.ersilabs.com' not in txt,
  'example links relative': 'href="./pages/data-analyst-cover-letter.html"' in txt,
  # ---- Konstantin review fixes (2026-10-12) ----
  'pro pricing removed': 'Free vs' not in txt and 'Unlock Pro' not in txt,
  'daily quota removed': 'quotaFree' not in txt and 'Free letters left today' not in txt,
  'no sign-up claims removed': 'No sign-up' not in txt and 'no sign-up' not in txt,
  'leaving links removed': 'a1.ersilabs.com' not in txt and 'Free Resume Check' not in txt,
  'postyourstartup badge removed': 'postyourstartup' not in txt,
  'privacy/terms links removed': 'privacy.html' not in txt and 'terms.html' not in txt,
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
