// ============================================
// CoverCraft — Zibby edition: core engine
// Ported from cover-letter-worker-v2.js (v2.x, Cloudflare Worker bundle).
// Pure logic only: no fetch, no secrets, no Cloudflare APIs, no license/Pro gate.
// All AI calls are injected via callAI(sys, user) -> Promise<string> (raw text).
// Quality gates, deterministic fallbacks and post-cleanup run unchanged.
// ============================================

export const MAX_LEN = 2000;

export const TONE_CN = {
  professional: 'Professional and polished: confident, precise, formal but not stiff',
  confident:    'Confident and assertive: direct, bold, highlights leadership and measurable impact',
  enthusiastic: 'Enthusiastic and warm: positive energy, genuine interest in the role, friendly',
  concise:      'Concise and punchy: short paragraphs, maximum impact per sentence, minimal fluff',
  warm:         'Warm and personable: approachable, human, slightly conversational but still professional'
};

const DIAG_SECRET = 'cc-diag-2026-v1';

// ---- BANNED phrase patterns (deterministic cleanup + gate detection) ----
const BANNED_PATTERNS = [
  /\bthrilled\b/i, /\bexcited\b/i, /\bpassionate\b/i, /\beager\b/i, /\blooking forward\b/i, /\blook forward to\b/i,
  /\bkeen eye for detail\b/i, /\bexceed expectations\b/i, /\bpassion for innovation\b/i,
  /\bI am writing to express\b/i, /\bI am confident\b/i, /\bstrong fit\b/i, /\bperfect fit\b/i,
  /\bspearheaded\b/i, /\borchestrated\b/i, /\bcross-functional\b/i, /\bstakeholder alignment\b/i,
  /\bstreamlined\b/i, /\bseamless\b/i, /\bleveraged\b/i, /\bholistic\b/i, /\bcutting-edge\b/i,
  /\btechnical acumen\b/i, /\bdelivered measurable outcomes\b/i, /\bprocess optimization\b/i,
  /\bstrategic execution\b/i, /\bIn today['\u2019]s competitive landscape\b/i,
  /\bforward-thinking\b/i, /\bpractical experience\b/i, /\bI have a strong background\b/i,
  /\bMy experience in\b/i, /\bmy expertise in\b/i,
  /\bWith a track record of\b/i, /\bWith a proven track record\b/i,
  /\bI would welcome the chance to discuss how my approach would serve\b/i,
  /\bwould welcome the chance to discuss how my\b/i, /\bhow my approach would serve\b/i,
  /\bnext phase of growth\b/i, /\bconduct a thorough analysis of current\b/i,
  /\bidentify key areas for improvement\b/i, /\bidentify areas for improvement\b/i,
  /\bI understand the importance of\b/i, /\bThese achievements reflect\b/i,
  /\bI am glad to discuss how my\b/i, /\bI would be glad to discuss how my\b/i,
  /\bglad to discuss how my\b/i, /\b(?:would|'d|will)\s+be\s+glad\s+to\b/i,
  /\b(?:am|are|is|would be|'d be|will be)\s+glad to walk\b/i,
  /\bwould like to walk (?:you )?through\b/i,
  /\bthrive\b/i, /\bstreamline\b/i,
  /\bI have spent my career making sure the work I own is the work people can rely on\b/i,
  /\ba\s+\d+\s+years?\b/i,
  /\bAs an? [A-Z][a-z]+ and [a-z]+ (?:professional|analyst|designer|developer|manager|specialist|engineer|writer|marketer|leader|executive)\b/,
  /\bI bring a (?:sharp|results-driven|execution-focused|detail-oriented|passionate|dedicated)\b/i
];

// ---- BAD opening patterns: paragraph must not start with these ----
const BAD_OPEN_RE = /^(?:With\s+\d+(?:\.\d+)?\s+years?\b|As\s+a\s+(?:skilled|seasoned|experienced|detail-oriented|highly-motivated|results-driven|passionate|dedicated|hardworking|accomplished|senior|proven|dynamic|self-motivated|driven)\b|My\s+expertise\s+in\b|With\s+a\s+(?:track\s+record|proven\s+track\s+record)\b|I\s+am\s+(?:writing|excited|eager|passionate|thrilled)\b|I\s+believe\s+I\s+am\s+the\s+perfect\s+fit\b)/i;

// ---- company fallback shown to the user only (never into the body) ----
const FALLBACK_COMPANY = 'I have been following [Company]\'s work in [field] for a while, and the way your team approaches [area] is what drew me to this role.';
const HINT_COMPANY = 'This sentence about the company is an AI-generated example, not real data. This data is fabricated by us: if you don\'t have the real company data, use the fallback sentence below instead; if you do have it, replace it with your real data.';
const HINT_NUMBER = 'This number/achievement is an AI-generated example, not data you provided. This data is fabricated by us: if you have real data, replace it with your real data; if not, use the fallback sentence below.';
const FALLBACK_NUMBER = 'I delivered strong, measurable results in this area during my previous role.';

// ---- small helpers ----
function checksumStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; }
  return h.toString(36);
}

// stateless diagnostic token: letterHash:timestamp:checksum, valid 2 minutes
export function diagToken(lh) {
  const ts = Date.now();
  const checksum = checksumStr(String(lh) + ':' + ts + ':' + DIAG_SECRET);
  return String(lh) + ':' + ts + ':' + checksum;
}
export function checkDiagToken(tok, lh) {
  if (!tok) return false;
  const parts = String(tok).split(':');
  if (parts.length !== 3) return false;
  const ts = parseInt(parts[1], 10);
  if (!ts || isNaN(ts)) return false;
  if (Date.now() - ts > 120000) return false;
  const expect = checksumStr(String(lh) + ':' + ts + ':' + DIAG_SECRET);
  return parts[2] === expect;
}

const DS_LENGTH_SUFFIX = String.fromCharCode(10) + String.fromCharCode(10) +
  'LENGTH CHECK: count your output words before finishing. Write 175-215 words total across EXACTLY 3 paragraphs separated by a blank line (two newlines) — aim ~200, never above 235. Keep sentences SHORT: average under 14 words per sentence (cut filler adjectives like "significant/robust/comprehensive", cut redundant clauses). Paragraph word targets: 55-75 / 60-80 / 45-65. FACT CHECK: re-read the user\'s input and confirm EVERY number, year, percentage, tool and role they gave appears verbatim in the letter — re-add anything you dropped; never invent PRECISE numbers they did not give — prefer soft magnitude phrasing ("roughly 40%", "almost half", "millions of", "above 99%", "3x+") that reads as reasonable inference and needs NO marker; only a precise invented figure (exact %, $, count, multiple) that is a KEY quantified achievement the letter cannot communicate without may be written, and it MUST be wrapped in «VERIFY»...«/VERIFY». Under 170 words, over 235 words, or a single long paragraph is an automatic failure — rewrite until the contract holds.';

// ---- deterministic fallbacks: used only when the AI call fails, so the
// user always gets a usable, factual result instead of an upstream error ----
function fallbackLetter(jobTitle, company, skills, companyIntel, jd, tone, count) {
  const S = String(skills || '').replace(/[`*_~>#]/g, '').replace(/\s+/g, ' ').trim();
  const C = String(company || 'the company').trim();
  const J = String(jobTitle || 'the role').trim();
  const intel = String(companyIntel || '').trim();
  const sentences = S.split(/[.;\n]+/).map(function(s){ return s.trim(); }).filter(Boolean);
  function norm(t) {
    return String(t).replace(/^(in my last role|in my previous role|previously|at my last company|at my previous company|over the past \d+ years)[,:;\s-]*(?:I\s+)?/i, '').trim();
  }
  function lowerFirst(t) { return t ? t.charAt(0).toLowerCase() + t.slice(1) : t; }
  function titleCase(t) { return t ? t.replace(/\b[a-z][a-z'-]*\b/g, function(w){ return w.charAt(0).toUpperCase() + w.slice(1); }) : t; }
  function evidence(t) {
    const n0 = norm(t);
    if (!n0) return '';
    if (/^\d/.test(n0)) {
      const parts = n0.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
      let joined = n0;
      if (parts.length > 1) joined = parts.slice(0, -1).join(', ') + ', and ' + parts[parts.length - 1];
      if (/^\d+(?:\.\d+)?\s+(?:years?|months?|weeks?|days?)\b/i.test(n0)) return 'I spent ' + joined;
      return 'I maintained ' + joined;
    }
    const n1 = n0.replace(/^I\s+/i, '');
    if (/^(opened|led|cut|built|grew|reduced|improved|increased|managed|created|launched|saved|boosted|helped|designed|developed|owned|drove|oversaw|delivered|handled|ran|wrote|taught|trained|coordinated|introduced|revamped|modernized|automated|shortened)/i.test(n1)) {
      return 'I ' + lowerFirst(n1);
    }
    if (/(?:^|[,\s])(?:bsc|bsn|ba|ma|ms|mba|phd|rn|lpn|lvn|np|pa|dpt|ot|ccrn|acls|pals|bls|cpr|first[- ]aid|license|licensure|licens|registered|certificat\w*|diploma|degree|credential\w*)\b/i.test(n1)) {
      return 'I hold ' + n1;
    }
    return 'I bring hands-on experience with ' + lowerFirst(n1);
  }
  const evid = sentences.map(evidence).filter(Boolean);
  function splitDense(t) {
    const wc = String(t).split(' ').length;
    if (wc <= 48) return String(t);
    const idxs = [];
    for (let i = 0; i < t.length; i++) { if (t[i] === ',') idxs.push(i); }
    if (idxs.length >= 3) {
      const cut = idxs[2];
      const a = String(t).slice(0, cut).trim().replace(/,$/, '') + ',';
      let b = String(t).slice(cut + 1).trim();
      b = b.charAt(0).toUpperCase() + b.slice(1);
      return a + ' ' + b;
    }
    return String(t);
  }
  const p1 = evid.length
    ? splitDense(evid[0] + (evid[0].endsWith('.') ? '' : '.'))
    : ('I have hands-on experience in ' + J + '-related work across my previous roles, and I focus on the details that make results visible.');
  const p2Parts = evid.slice(1).map(function(s){ return s + (s.endsWith('.') ? '' : '.'); });
  let rolePhrase = J ? String(J).replace(/\s+/g, ' ').trim() : '';
  rolePhrase = rolePhrase.replace(/^(the|a|an)\s+/i, '') || 'this role';
  rolePhrase = titleCase(rolePhrase);
  p2Parts.push('In the ' + rolePhrase + ' seat, I bring the same discipline I brought to the work above: I keep priorities clear, flag problems early, and follow through on what I commit to.');
  p2Parts.push('I write everything down so decisions and context survive when people change roles, and I treat deadlines as commitments rather than suggestions.');
  const p2 = p2Parts.slice(0, 4).join(' ');
  let conn = '', verifyItems = [];
  if (intel) {
    conn = 'I am drawn to ' + C + "'s work in this space - the role matches how I like to operate and the problems I want to help solve. I would bring the same hands-on approach to the " + J + ' role every day.';
  } else {
    const rawConn = C + ' is growing and investing in its ' + J + ' function right now, and that momentum is exactly what draws me to this team.';
    conn = '«VERIFY»' + rawConn + '«/VERIFY»';
    verifyItems.push({
      sentence: rawConn,
      hint: 'Search the company\'s recent news, funding or product launches and replace this with one real, checkable fact.',
      fallback: 'I have been following ' + C + "'s work for a while, and the way your team approaches " + J + ' is what drew me to this role.'
    });
  }
  const p3 = conn + ' In my first month, I would learn your current process inside out, shadow the team, and pick one small inefficiency to fix end to end - then measure whether it helped before moving on.';
  const body = p1 + '\n\n' + p2 + '\n\n' + p3;
  const letters = [];
  const angles = [
    { note: 'Factual opening with your own numbers; company sentence marked for verification.', score: 79 },
    { note: 'Results-first angle; every claim comes from your own input.', score: 78 },
    { note: 'Direct, team-focused angle; the marked sentence needs a real fact.', score: 77 }
  ];
  for (let i = 0; i < count; i++) {
    const a = angles[Math.min(i, angles.length - 1)];
    letters.push({
      body: body,
      score: a.score,
      note: a.note,
      paragraph_notes: [
        { p: 1, note: 'Opens with your own evidence.' },
        { p: 2, note: 'Real skill statements, no invented numbers.' },
        { p: 3, note: 'Connection sentence is marked for you to verify.' }
      ],
      verify_items: verifyItems,
      _tpl: true
    });
  }
  return {
    letters: letters,
    subjects: [J + ' - ' + C, 'Your next ' + J, J + ' application - ' + C],
    strengths: ['Built from your own facts', 'No invented numbers', 'Clear first-month action'],
    tips: ['Add one measurable outcome from a real project', 'Check the marked company sentence and replace it with a real fact', 'Tie your skills to the job description'],
    fallback: true
  };
}

function fallbackDiagCore(letter, jd) {
  const paras = String(letter).split(/\n\s*\n/).filter(function(p){ return p.trim().length > 0; });
  const paragraphs = paras.map(function(p, i){
    const sentences = splitSentences(p).map(function(s){
      let tag = 'good', why = 'Specific statement';
      if (hasBannedPhrase(s)) { tag = 'bad'; why = 'Banned cliche'; }
      else if (s.trim().length < 60) { tag = 'weak'; why = 'Short, no proof'; }
      return { s: s, tag: tag, why: why };
    });
    return {
      p: i + 1,
      diagnosis: sentences.some(function(s){ return s.tag === 'bad'; })
        ? 'This paragraph has a banned cliche to replace.'
        : 'Solid paragraph - could carry one more concrete detail.',
      fix: 'Keep every real fact; cut filler; add one measurable outcome if you have it.',
      sentences: sentences
    };
  });
  return {
    score: 78,
    overall: 'Solid content with room to add measurable outcomes and remove any cliches.',
    paragraphs: paragraphs,
    jd_match: [],
    issues: ['Not every paragraph has a measurable outcome', 'One or two generic phrases'],
    improvements: ['Add one number to the second paragraph', 'End with a concrete first-month action'],
    fallback: true
  };
}

function fallbackDiagFull(letter) {
  return {
    improved_letter: cleanBanned(String(letter).trim()),
    changes: ['Removed banned phrases and tightened the wording', 'Kept every real fact exactly as you wrote it'],
    fallback: true
  };
}

function fallbackInterview(ivLetter, ivJd) {
  const factRe = /(?:\d+(?:\.\d+)?\s*(?:years?|months?|weeks?|days?|%|percent|x|times?|people|members|users?|customers?|clients?|projects?|campaigns?|products?|apps?))|(?:team of \d+)|(?:[A-Z][a-z]+ (?:SEO|CRM|SQL|AWS|React|Figma|Python|Excel|Google Analytics|Photoshop|Sketch|WordPress))/g;
  const facts = (String(ivLetter).match(factRe) || []).slice(0, 3);
  const questions = [
    { q: 'Walk me through the most impactful thing you did in your last role.', why: 'Opens on the headline result', points: ['The problem you saw', 'What you did', 'The outcome'] },
    { q: 'What would you change about how this team works in your first month?', why: 'Tests your first-month plan', points: ['Map the current workflow', 'Find what nobody uses', 'Replace it with something measurable'] },
    { q: 'Tell me about a time something you built was not used.', why: 'Tests user focus', points: ['The report or tool nobody opened', 'How you found out', 'What you did instead'] },
    { q: 'Why this role, and why here?', why: 'Tests motivation and fit', points: ['One real reason from your background', 'What the role offers you', 'What you would bring'] }
  ];
  if (facts.length) {
    questions.splice(1, 0, { q: 'Tell me more about the ' + facts[0] + ' you mentioned.', why: 'Probes a specific fact from your letter', points: ['The before state', 'Your action', 'The result'] });
  }
  return { questions: questions.slice(0, 5), fallback: true };
}

function fallbackEmail(jobTitle, company, skills, companyIntel, jd) {
  const S = String(skills || '').trim();
  const C = String(company || 'the company').trim();
  const sentences = S.split(/[.;\n]+/).map(function(s){ return s.trim(); }).filter(Boolean);
  const open = (sentences[0] || 'I have hands-on experience in this work.')
    .replace(/^(In my last role|In my previous role|Previously)[,:;\s-]*/i, '');
  const body = 'Dear Hiring Manager,\n\nIn my last role, ' + open + (open.endsWith('.') ? '' : '.') +
    ' I keep my work grounded in what actually ships and what the team ends up using - if something does not help the work get done, I stop doing it.\n\n' +
    'In my first month at ' + C + ' I would learn how the team operates today, shadow the people doing the work, and pick one small inefficiency to fix end to end. I can walk you through a before-and-after of that work in an interview.\n\nBest regards';
  return { body: body, score: 84, note: 'Built from your own facts - add one more measurable result if you have it.', fallback: true };
}

// ==================== text & quality gates ====================
function parseAIContent(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  const candidate = s.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    try {
      const fixed = candidate
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']')
        .replace(/[\u201c\u201d]/g, '"')
        .replace(/[\u2018\u2019]/g, "'");
      const parsed2 = JSON.parse(fixed);
      return parsed2 && typeof parsed2 === 'object' ? parsed2 : null;
    } catch (e2) { return null; }
  }
}

function sanitize(t) {
  if (!t) return '';
  return String(t)
    .replace(/\\n\\n/g, '\n\n')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\[Your Name\]/g, '')
    .replace(/\[Company\]/g, '')
    .trim();
}

export function wordCount(t) {
  if (!t) return 0;
  return String(t).split(/\s+/).filter(Boolean).length;
}

function hasBannedPhrase(t) {
  if (!t) return false;
  return BANNED_PATTERNS.some(function(re){ return re.test(String(t)); });
}

function hasBadOpen(t) {
  if (!t) return false;
  return String(t).split(/\n\s*\n/).some(function(p){
    return BAD_OPEN_RE.test(p.trim());
  });
}

function needsVerify(t, companyIntel) {
  if (companyIntel) return false;
  if (!t) return true;
  return !/«VERIFY»[\s\S]*?«\/VERIFY»/.test(String(t));
}

function cleanBanned(t) {
  if (!t) return t;
  let s = String(t);
  const pairs = [
    [/\bforward-thinking\b/gi, 'innovative'],
    [/\bpractical experience\b/gi, 'hands-on work'],
    [/\bI have a strong background\b/gi, 'I have worked on'],
    [/\bMy experience in\b/gi, 'I have worked on'],
    [/\bmy expertise in\b/gi, 'my work in'],
    [/\bthrilled\b/gi, 'pleased'],
    [/\bexcited\b/gi, 'glad'],
    [/\bpassionate\b/gi, 'committed'],
    [/\beager\b/gi, 'ready'],
    [/\blooking forward to\b/gi, 'would welcome'],
    [/\bkeen eye for detail\b/gi, 'strong attention to detail'],
    [/\bexceed expectations\b/gi, 'deliver strong results'],
    [/\bpassion for innovation\b/gi, 'interest in building'],
    [/\bI am confident that\b/gi, 'I believe'],
    [/\bstrong fit\b/gi, 'good fit'],
    [/\bperfect fit\b/gi, 'good fit'],
    [/\bspearheaded\b/gi, 'led'],
    [/\borchestrated\b/gi, 'coordinated'],
    [/\bcross-functional\b/gi, 'cross-team'],
    [/\bstakeholder alignment\b/gi, 'alignment across teams'],
    [/\bstreamlined\b/gi, 'simplified'],
    [/\bseamless\b/gi, 'smooth'],
    [/\bleveraged\b/gi, 'used'],
    [/\bholistic\b/gi, 'complete'],
    [/\bcutting-edge\b/gi, 'modern'],
    [/\btechnical acumen\b/gi, 'technical skill'],
    [/\bdelivered measurable outcomes\b/gi, 'delivered strong results'],
    [/\bprocess optimization\b/gi, 'process improvements'],
    [/\bstrategic execution\b/gi, 'delivering on strategy'],
    [/\bI thrive on\b/gi, 'I am at my best when'],
    [/\bI thrive in\b/gi, 'I do well in'],
    [/\bthrive\b/gi, 'do well'],
    [/\bstreamline\b/gi, 'simplify'],
    [/\bI look forward to contributing\b/gi, 'I would welcome the chance to contribute'],
    [/\blook forward to\b/gi, 'would welcome'],
    [/\bIn today['\u2019]s competitive landscape\b/gi, 'In today\'s market'],
    [/\bglad to discuss how my\b/gi, 'happy to talk about how my'],
    [/\b(?:would|'d|will)\s+be\s+glad\s+to\b/gi, 'can'],
    [/\b(?:am|are|is|would be|'d be|will be)\s+glad to walk\b/gi, 'can walk'],
    [/\bwould like to walk (?:you )?through\b/gi, 'can walk you through'],
    [/\bI am writing to express my interest\b/gi, 'I am applying for'],
    [/\bI am writing to apply\b/gi, 'I am applying for'],
    [/\bI am writing to express\b/gi, 'I am writing about'],
    [/\bI would welcome the chance to discuss how my approach would serve\b/gi, 'I would welcome the chance to talk with you'],
    [/\bwould welcome the chance to discuss how my\b/gi, 'would welcome the chance to talk about how my'],
    [/\bhow my approach would serve\b/gi, 'how my experience could help'],
    [/\bnext phase of growth\b/gi, 'next stage'],
    [/\bconduct a thorough analysis of current\b/gi, 'review current'],
    [/\bidentify key areas for improvement\b/gi, 'find quick wins'],
    [/\bidentify areas for improvement\b/gi, 'find quick wins'],
    [/\bI understand the importance of\b/gi, 'I know the value of'],
    [/\bThese achievements reflect\b/gi, 'These results show'],
    [/\bWith a track record of\b/gi, 'Having'],
    [/\bWith a proven track record\b/gi, 'Having a proven record'],
    [/\bI have spent my career making sure the work I own is the work people can rely on[^.]*\.\s*/gi, ''],
    [/\ba\s+(\d+(?:\.\d+)?\s+(?:years?|months?|weeks?|days?))\b/gi, '$1'],
  ];
  for (let i = 0; i < pairs.length; i++) {
    s = s.replace(pairs[i][0], pairs[i][1]);
  }
  s = s.replace(/\[Your Name\]/g, '').replace(/\[Company\]/g, '').replace(/\[field\]/g, '').replace(/\[area\]/g, '');
  const PIPE = '\\|\u2502\u2503\u2551\u2550\uff5c\u2223\u2224\u2225\u2226\u4e28\u2016\u00a6\u01c0\u01c1\u250a\u250b\u254e\u254f';
  s = s.replace(new RegExp('[' + PIPE + ']\\s*[' + PIPE + ']\\s*', 'g'), ' ')
        .replace(new RegExp('^\\s*[' + PIPE + ']\\s*', 'gm'), '')
        .replace(new RegExp('\\s*[' + PIPE + ']\\s*$', 'gm'), '')
        .replace(new RegExp('\\s*[' + PIPE + ']\\s+', 'g'), ' ');
  s = s.replace(/(?:^|(?<=[.!?]\s))(?:I am applying for|I apply for|I applied for)\b[^.!?\n]*[.!?]\s*/gi, '');
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/^\s+/, '').replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\bI\s+i\s+/gi, 'I ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s;
}

function ensureThreeParas(body) {
  let outParas = String(body).split(/\n\s*\n/).map(function(p){ return p.trim(); }).filter(Boolean);
  if (outParas.length > 3) {
    outParas = outParas.slice(0, 2).concat([ outParas.slice(2).join(' ') ]);
  } else if (outParas.length < 3) {
    let guard = 0;
    while (outParas.length < 3 && guard++ < 4) {
      let li = -1, bestN = 0;
      outParas.forEach(function(p, i){
        const n = splitSentences(p).length;
        if (n >= 3 && n > bestN) { bestN = n; li = i; }
      });
      if (li < 0) break;
      const sents = splitSentences(outParas[li]);
      const wc = sents.map(function(s){ return wordCount(s); });
      let cut = -1, bestDiff = Infinity;
      for (let c = 2; c <= sents.length - 1; c++) {
        let left = 0, right = 0, k;
        for (k = 0; k < c; k++) left += wc[k];
        for (k = c; k < sents.length; k++) right += wc[k];
        const diff = Math.abs(left - right);
        if (diff < bestDiff) { bestDiff = diff; cut = c; }
      }
      if (cut < 0) break;
      outParas[li] = sents.slice(0, cut).join(' ');
      outParas.splice(li + 1, 0, sents.slice(cut).join(' '));
    }
  }
  return outParas.join('\n\n');
}

function extractInputNums(t) {
  const nums = new Set();
  if (!t) return nums;
  const s = String(t);
  const re = /(\d+(?:\.\d+)?)\s*(%|percent|x|times|hours|minutes|weeks?|months?|days?|years?|stakeholders|accounts|users?|customers?|clients?|projects?|campaigns?|products?|apps?|tickets?|leads?|people|members|team|revenue|sales|conversions?|signups?|\$|[MBK])?\b/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[1]) nums.add(m[1]);
    if (m[0]) nums.add(m[0].trim());
  }
  const reMoney = /\$\d+(?:[\d,]*\.?\d*)?[MBK]?\b/gi;
  while ((m = reMoney.exec(s)) !== null) { if (m[0]) nums.add(m[0].trim()); }
  return nums;
}

function splitSentences(t) {
  return String(t)
    .replace(/\n\s*\n/g, ' \u0001 ')
    .split(/(?<=[.!?])\s+|\u0001/)
    .map(function(s){ return s.replace(/\u0001/g, '\n\n').trim(); })
    .filter(Boolean);
}

function postCleanup(letter, inputNums, companyIntel, inputTextRaw) {
  let body = String(letter.body || '').replace(/«\/?VERIFY»/g, '');
  let score = letter.score === undefined || letter.score === null ? null : Math.max(0, Math.min(100, Math.round(Number(letter.score) || 0)));
  const verifyItems = [];
  const marks = [];
  const inputText = String(inputTextRaw || '');
  const RE_PERCENT = /\d+(?:\.\d+)?\s*(?:%|percent\b)/i;
  const RE_MONEY = /\$\d+(?:[\d,]*\.?\d*)?[MBK]?\b/;
  const RE_ACHIEVE = /\b\d+\+?\s*(?:hours|minutes|weeks?|months?|stakeholders|accounts|users?|customers?|clients?|projects?|campaigns?|products?|apps?|tickets?|leads?|revenue|sales|conversions?|signups?)\b/i;
  function isInInput(num) {
    const n = String(num).trim();
    if (inputNums.has(n)) return true;
    let hit = false;
    inputNums.forEach(function(v){
      if (!hit && (n.includes(v) || v.includes(n))) hit = true;
    });
    return hit;
  }
  function percentInInput(num) {
    return new RegExp('(?:^|[^\\d.])' + String(num).replace(/\./g, '\\.') + '\\s*(?:%|percent\\b)', 'i').test(inputText);
  }
  function moneyInInput(m) {
    const norm = String(m).toLowerCase().replace(/\s+/g, '');
    return inputText.toLowerCase().replace(/\s+/g, '').indexOf(norm) >= 0;
  }
  function softBefore(s, idx) {
    const before = s.slice(Math.max(0, idx - 30), idx);
    return /(?:roughly|about|almost|nearly|approximately|around|close to|up to|over|above|more than|at least|~|≈|\+)\s*$/i.test(before);
  }
  if (!companyIntel) {
    const items = (Array.isArray(letter.verify_items) ? letter.verify_items : []).filter(function(v){ return v && v.sentence; });
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const s = String(it.sentence).trim();
      if (!s) continue;
      if (/^(?:I|My|Through my|In my|At my|As part of my|During my)\b/i.test(s)) continue;
      const idx = body.indexOf(s);
      if (idx >= 0) {
        body = body.slice(0, idx) + '«VERIFY»' + s + '«/VERIFY»' + body.slice(idx + s.length);
        marks.push({ sentence: s, hint: String(it.hint || HINT_COMPANY), fallback: String(it.fallback || FALLBACK_COMPANY), type: 'company' });
        break;
      }
    }
  }
  const paras = body.split(/\n\s*\n/);
  const rebuiltParas = [];
  for (let pi = 0; pi < paras.length; pi++) {
    const sentences = splitSentences(paras[pi]);
    const rebuilt = [];
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      if (s.indexOf('«VERIFY»') >= 0 || s.indexOf('«/VERIFY»') >= 0) { rebuilt.push(s); continue; }
      const mP = s.match(RE_PERCENT);
      const mM = s.match(RE_MONEY);
      const mA = s.match(RE_ACHIEVE);
      let fabricated = false;
      if (mP) {
        const pNum = mP[0].match(/\d+(?:\.\d+)?/)[0];
        if (!percentInInput(pNum) && !softBefore(s, mP.index)) fabricated = true;
      }
      if (!fabricated && mM && !moneyInInput(mM[0]) && !softBefore(s, mM.index)) fabricated = true;
      if (!fabricated && mA && !isInInput(mA[0]) && !softBefore(s, mA.index)) fabricated = true;
      if (fabricated) {
        rebuilt.push('«VERIFY»' + s + '«/VERIFY»');
        marks.push({ sentence: s, hint: HINT_NUMBER, fallback: FALLBACK_NUMBER, type: 'data' });
      } else {
        rebuilt.push(s);
      }
    }
    rebuiltParas.push(rebuilt.join(' '));
  }
  body = rebuiltParas.join('\n\n');
  body = body.replace(/\s*(?:Sincerely|Best regards|Warm regards|Warmly|Regards|Yours truly|Yours faithfully|Kind regards)\b[^\n.!?]*$/i, '').trim();
  body = ensureThreeParas(body);
  marks.forEach(function(m){
    if (verifyItems.length >= 2) return;
    verifyItems.push({ sentence: m.sentence, hint: m.hint, fallback: m.fallback });
  });
  const w = wordCount(body);
  if (score === null || !(score > 0)) score = w >= 170 ? 82 : (w >= 150 ? 78 : 72);
  if (w < 150 && score !== null && score > 78) score = 78;
  if (w > 300 && score !== null) score = Math.max(60, score - 5);
  return {
    body: body,
    score: score,
    note: String(letter.note || '').trim().slice(0, 300),
    paragraph_notes: (Array.isArray(letter.paragraph_notes) ? letter.paragraph_notes : [])
      .map(function(p){ return { p: Number(p && p.p) || 0, note: String(p && p.note || '').trim().slice(0, 200) }; })
      .filter(function(p){ return p.note.length > 0; })
      .slice(0, 3),
    verify_items: verifyItems,
    breakdown: fixBreakdown(letter.breakdown, w),
    _tpl: letter._tpl ? true : undefined
  };
}

// Deterministic guard for the 4-dimension score breakdown.
function fixBreakdown(bd, w) {
  if (!bd || typeof bd !== 'object') return null;
  const keys = ['job_match', 'ats', 'persuasion', 'length'];
  const out = { reasons: {} };
  keys.forEach(function (k) {
    const v = Number(bd[k]);
    out[k] = isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 0;
  });
  const rr = (bd.reasons && typeof bd.reasons === 'object') ? bd.reasons : {};
  keys.forEach(function (k) {
    const r = String(rr[k] || '').trim().slice(0, 120);
    if (r) out.reasons[k] = r;
  });
  // length dimension is deterministic: under 150 words can't score high, over 300 loses points
  if (w < 150) out.length = Math.min(out.length || 0, 65);
  if (w > 300) out.length = Math.min(out.length || 0, 55);
  if (w >= 150 && w <= 300 && (!out.length || out.length === 0)) out.length = 90;
  if (!Object.keys(out.reasons).length) return null;
  return out;
}

// ==================== prompt builders ====================
function buildBaseSys(tone) {
  return [
    'You are a senior career coach. Write ONE impeccable, ATS-friendly cover letter in plain, confident business English — the way a real, well-spoken applicant writes. Short concrete sentences with real numbers beat buzzword sentences. Output ONLY one JSON object, no markdown, no commentary:',
    '{"letters":[{"body":"...","score":82,"note":"...","paragraph_notes":[{"p":1,"note":"..."}],"verify_items":[],"breakdown":{"job_match":85,"ats":80,"persuasion":88,"length":90,"reasons":{"job_match":"...","ats":"...","persuasion":"...","length":"..."}}}],"subjects":["","",""],"strengths":["","",""],"tips":["",""]}',
    'RULES:',
    '1. Exactly 1 letter, 3 paragraphs separated by \\n\\n, first person, no placeholders, ready to send. LENGTH CONTRACT — count sentences before responding: paragraph 1 = 5-6 sentences (opening achievement + the company sentence); paragraph 2 = 6-7 sentences (the mini-story: situation, action, result, then a second supporting detail built from the provided numbers); paragraph 3 = 4-5 sentences (a concrete first-weeks action + sign-off). Total 180-220 words, aim ~200, hard minimum 170 (under 170 is rejected). Do not stop until every paragraph reaches its sentence count.',
    '2. Tone: ' + TONE_CN[tone] + '. Weave in the candidate\'s real skills (and the JD\'s key requirements if provided).',
    '3. OPENING: first sentence names the role/company and leads with the strongest real achievement as a concrete number or project ("In my last role I cut...", "At my previous company I built..."). Never open with "I am writing", "I am excited/eager/thrilled/passionate", "With X years...", "With a track record...", "As a skilled...", or "My expertise in...". Any number in the opening sentence MUST come straight from the user-provided skills — never invent a new percentage for the opener.',
    '4. ANTI-HALLUCINATION: never invent employers, projects, degrees, numbers or results the user did not give; with thin input stay general ("across my previous roles"). When describing PAST experience NEVER use the target company\'s name — say "my previous company". Tell one 2-3 sentence achievement mini-story (situation -> action -> result) using only provided facts. To add scale to a result, prefer soft magnitude phrasing ("roughly 40%", "almost half", "millions of", "double-digit", "3x+") — soft phrasing reads as reasonable inference and needs NO marker; only a precise invented figure (exact %, $, count, multiple) that is essential to the story must be wrapped in «VERIFY»...«/VERIFY» with a verify_items entry.',
    '5. COMPANY SENTENCE (exactly one, inside the body, paragraph 1-2): if company info was provided, use ONE real detail from THAT INFO plainly, stated only once, with NO markers — and never invent any other company fact (founding year, HQ, headcount, customer counts are off-limits; re-use the provided fact). If NO company info was provided, invent ONE concrete checkable fact ABOUT THE COMPANY (a number, date, product, funding or event — never a vague "your commitment to excellence"), wrap the WHOLE sentence in «VERIFY»...«/VERIFY», and add verify_items {"sentence":"exact sentence without markers","hint":"Check/replace with a real company fact","fallback":"safe claim-free alternative"}. Any invented PRECISE ACHIEVEMENT number (not given by the user — an exact %, $, count or multiple) must also be wrapped in «VERIFY»...«/VERIFY» with a verify_items entry, even when real company info exists; soft magnitude phrasing ("roughly", "almost half", "millions of", "3x+") needs no marker. The marked sentence must describe the COMPANY, never the candidate\'s own achievement. Never put [bracketed placeholders] in the body.',
    '6. BANNED WORDS (never anywhere): thrilled, excited, passionate, eager, "looking forward", "keen eye", "strong fit", "I am confident that", "I am writing to express", "exceed expectations". BANNED BUZZWORDS: spearheaded, orchestrated, cross-functional, stakeholder alignment, streamlined, seamless, leveraged, holistic, cutting-edge, forward-thinking, technical acumen, "delivered measurable outcomes". Use plain verbs: led, built, improved, cut, managed, shipped, taught, wrote. Never stack parallel openers like "I have a strong background... / My experience in... / These achievements reflect...".',
    '7. CLOSING: end with ONE concrete first-weeks action specific to THIS role (a metric you would pull, accounts/people you would talk to, a process you would fix) — never the generic "I would welcome the chance to discuss how my approach would serve your next phase of growth" or any variant of it; never "identify areas for improvement"; never "would be glad to walk you through", "am glad to walk", or "would like to walk you through" closers — replace with a direct "I can walk you through how I built..." if you must offer. Use one closing construction only.',
    '8. Vary sentence rhythm; not every sentence starts with "I"; warmth comes from concrete specifics, never emotional adjectives. Sound like a person, not a press release.',
    '10. NEVER paste the user\'s skills input verbatim into the body — rewrite EVERY point into natural, grammatically correct, flowing sentences (fragments like "a 3 years building..." are fatal). If the user\'s phrasing is non-native or awkward (e.g. "I am very hardworking, I can do many things"), fix it to professional English while keeping the facts. Every sentence must be specific to THIS job, THIS company and THIS candidate — never reuse a generic sentence that could fit any role (e.g. "I have spent my career making sure the work I own is the work people can rely on"). When input is thin, still end paragraph 3 with ONE concrete action you would take in the first 30 days of THIS role, derived from the skills the user gave.',
    '9. FIELDS: score = YOUR honest integer 60-95 for THIS job (a solid specific letter is 80-92; never copy the example, never output 0 or leave it blank); note = 8-18 words on what works; paragraph_notes = one specific 6-15 word note per paragraph (exactly 3 entries); subjects = 3 email subject lines under 45 characters containing the role or company; strengths = 3 short points for this job; tips = 2 concrete actions; breakdown = 4 dimension scores 0-100 (job_match = how well it fits THIS job description, ats = ATS/parseability friendliness, persuasion = how convincing the evidence is, length = how well it hits the 180-220 word target) plus reasons = one 6-12 word why per dimension; the overall score should feel consistent with the breakdown.'
  ].join(String.fromCharCode(10));
}

const LETTER_ANGLES = [
  'focus on the candidate\'s skills and qualifications and how they match THIS specific role',
  'focus on results and impact: lead with measurable outcomes and what the candidate actually delivered',
  'focus on culture fit and motivation, expressed through concrete specifics (never emotional adjectives)'
];

function singleLetterSys(baseSys, angleIdx, withExtras, extraSuffix) {
  var s = baseSys.replace(/Generate exactly \d+ letter object\(s\) inside "letters"/,
    'Generate exactly 1 letter object inside "letters"');
  s += String.fromCharCode(10) + String.fromCharCode(10) +
    'THIS LETTER\'S ANGLE: ' + LETTER_ANGLES[angleIdx] +
    '. Structure and emphasize THIS angle so it is genuinely different from the other versions.';
  if (!withExtras) {
    s += String.fromCharCode(10) + 'For this request return "subjects", "strengths" and "tips" as empty arrays [] — only the single letter matters.';
  }
  if (extraSuffix) s += extraSuffix;
  return s;
}

// ==================== AI layer (injected callAI) ====================
async function callOnce(callAI, sys, user) {
  try {
    const text = await callAI(sys, user);
    const parsed = parseAIContent(text);
    if (parsed) return parsed;
    return null;
  } catch (e) {
    return null;
  }
}

async function runAIWithFallback(sys, user, callAI) {
  const parsed = await callOnce(callAI, sys, user);
  if (parsed) return parsed;
  throw new Error('AI call failed or returned unparseable JSON');
}

// Fires `count` single-letter requests concurrently.
async function runAIWithFallbackMulti(baseSys, userMsg, count, strictSuffixForMain, callAI) {
  async function one(angleIdx, withExtras) {
    var r = await runAIWithFallback(singleLetterSys(baseSys, angleIdx, withExtras),
      userMsg + DS_LENGTH_SUFFIX, callAI);
    if (!r || !Array.isArray(r.letters) || !r.letters[0] || !r.letters[0].body) {
      throw new Error('no letter in response');
    }
    return r;
  }
  var idxs = [];
  for (var k = 0; k < count; k++) idxs.push(k);
  var settled = await Promise.allSettled(idxs.map(function(i) { return one(i, i === 0); }));
  var results = settled.map(function(s) { return s.status === 'fulfilled' ? s.value : null; });
  var mainReason = settled[0].status === 'rejected'
    ? String((settled[0].reason && settled[0].reason.message) || settled[0].reason)
    : 'unknown';
  if (!results[0] && strictSuffixForMain !== false) {
    try {
      var retry = await runAIWithFallback(singleLetterSys(baseSys, 0, true, String.fromCharCode(10) + String.fromCharCode(10) + strictSuffixForMain),
        userMsg + DS_LENGTH_SUFFIX, callAI);
      if (retry && Array.isArray(retry.letters) && retry.letters[0] && retry.letters[0].body) results[0] = retry;
    } catch (e) { /* still missing -> caller falls back */ }
  }
  if (!results[0]) throw new Error('main letter generation failed (' + mainReason + ')');
  var main = results[0];
  var letters = [main.letters[0]];
  for (var k2 = 1; k2 < count; k2++) {
    if (results[k2] && results[k2].letters[0]) letters.push(results[k2].letters[0]);
  }
  return {
    letters: letters,
    subjects: main.subjects || [],
    strengths: main.strengths || [],
    tips: main.tips || [],
    _got: letters.length
  };
}

// ==================== main generation pipeline ====================
const STRICT_SUFFIX = String.fromCharCode(10) + String.fromCharCode(10) +
  'Your previous letter was REJECTED. Fix every failed point and output the JSON only: (1) concrete achievement/company opening, never "I am writing/I am excited/With X years/As a skilled/My expertise in"; (2) no banned words or buzzwords from rule 6; (3) 170-220 words in 3 paragraphs and score a real integer 60-95 (never 0); (4) no invented numbers or past-employer use of the target company name; (5) exactly one company sentence in the body: plain when real company info was given, otherwise the WHOLE sentence wrapped in «VERIFY»...«/VERIFY» with a matching verify_items entry and a concrete checkable fact; any invented precise achievement number (exact %, $, count, multiple) also wrapped — soft magnitude phrasing like roughly/almost/millions of needs no marker; (6) concrete first-weeks closing, never the "welcome the chance to discuss how my approach would serve" closer; (7) never paste the skills input verbatim — rewrite it into grammatically correct flowing sentences, fix non-native phrasing to professional English, and never reuse a generic sentence that could fit any role. Failed checks: ';

export async function generateAll(opts) {
  const jobTitle = String(opts.jobTitle || '').trim().slice(0, 80);
  const company  = String(opts.company || '').trim().slice(0, 80);
  const skills   = String(opts.skills || '').trim().slice(0, MAX_LEN);
  const jd       = String(opts.jd || '').trim().slice(0, MAX_LEN);
  const companyIntel = String(opts.companyIntel || '').trim().slice(0, 500);
  const tone     = TONE_CN[opts.tone] ? opts.tone : 'professional';
  const count    = (opts.count === 1 || opts.count === 2) ? opts.count : 3;
  const callAI   = opts.callAI;
  const baseSys  = buildBaseSys(tone);
  const userMsg = [
    'Job title: ' + jobTitle,
    'Company: ' + company,
    'Candidate skills & experience: ' + skills,
    companyIntel ? ('Company info the candidate knows (use only this, never invent more): ' + companyIntel) : 'Company info: (none provided — if you write a company-connection sentence it MUST be wrapped in «VERIFY»...«/VERIFY» with a verify_items entry)',
    jd ? ('Job description: ' + jd) : ''
  ].filter(function(s){ return s; }).join(String.fromCharCode(10));
  let retryDiag = '';
  try {
    let result;
    try { result = await runAIWithFallbackMulti(baseSys, userMsg, count, STRICT_SUFFIX, callAI); }
    catch (e) { result = fallbackLetter(jobTitle, company, skills, companyIntel, jd, tone, count); result._aiError = e && e.message ? e.message : 'AI call failed'; }
    if (!result || !Array.isArray(result.letters) || result.letters.length === 0) {
      return { success: false, error: 'AI returned no letters. Please try again.' };
    }
    const inputNums = extractInputNums(skills + ' ' + jd + ' ' + companyIntel);
    function normalizeLetter(l) {
      const raw = sanitize(String((l && l.body) || ''));
      let body = cleanBanned(raw).trim();
      if (company) {
        const escC = String(company).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        body = body
          .replace(new RegExp('(my (?:work|role|time|experience|team|position|tenure|stint) at) ' + escC, 'gi'), '$1 my previous company')
          .replace(new RegExp('((?:while|during my time) at) ' + escC, 'gi'), '$1 my previous company');
      }
      body = ensureThreeParas(body);
      return { body: body, score: l && l.score, note: l && l.note, paragraph_notes: l && l.paragraph_notes, verify_items: l && l.verify_items, breakdown: l && l.breakdown, _tpl: l && l._tpl ? true : undefined, _softFail: l && l._softFail ? String(l._softFail).slice(0, 200) : undefined };
    }
    let letters = result.letters.map(normalizeLetter);
    function copiedFromInput(t, skillsRaw) {
      const src = String(skillsRaw || '').replace(/[`*_~>#]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (src.length < 30) return false;
      const words = src.split(' ');
      if (words.length < 6) return false;
      const bodyLow = String(t).toLowerCase();
      for (let i = 0; i + 6 <= words.length; i++) {
        const chunk = words.slice(i, i + 6).join(' ');
        if (chunk.length >= 30 && bodyLow.indexOf(chunk) >= 0) return true;
      }
      return false;
    }
    function gateOf(l, i) {
      const t = l.body;
      if (!t || !t.trim()) return 'letter ' + (i + 1) + ' body is empty';
      if (hasBannedPhrase(t)) return 'letter ' + (i + 1) + ': banned phrase detected';
      if (hasBadOpen(t)) return 'letter ' + (i + 1) + ': bad opening detected';
      if (needsVerify(t, companyIntel)) return 'letter ' + (i + 1) + ': missing company VERIFY sentence (no company info provided)';
      if (copiedFromInput(t, skills)) return 'letter ' + (i + 1) + ': skills input copied verbatim - rewrite into your own flowing sentences';
      const w = wordCount(t);
      const sc = Number(l.score);
      if (!Number.isFinite(sc) || sc <= 0) return 'letter ' + (i + 1) + ': score missing or zero (give a real 60-95 integer)';
      if (sc < 75) return 'letter ' + (i + 1) + ': score ' + sc + ' is too low, write a stronger, more specific letter (target 80+)';
      const paraArr = String(t).split(/\n\s*\n/).filter(function(p){ return p.trim(); });
      const paraCount = paraArr.length;
      if (paraCount !== 3) return 'letter ' + (i + 1) + ': must be exactly 3 paragraphs (got ' + paraCount + ')';
      const shortestPara = paraArr.reduce(function(m, p){ return Math.min(m, wordCount(p)); }, 1e9);
      if (shortestPara < 25) return 'letter ' + (i + 1) + ': a paragraph is only ' + shortestPara + ' words (each paragraph needs 4+ substantial sentences)';
      if (w < 160) return 'letter ' + (i + 1) + ': too short (' + w + ' words, need 170+)';
      if (w > 260) return 'letter ' + (i + 1) + ': too long (' + w + ' words, keep 255 or fewer - tighten the prose, cut filler adjectives and redundant clauses)';
      return null;
    }
    if (!result._aiError) {
      const failing = [];
      letters.forEach(function(l, i){ const g = gateOf(l, i); if (g) failing.push({ i: i, gate: g }); });
      if (failing.length) {
        const retried = await Promise.allSettled(failing.map(function(f) {
          const angleIdx = f.i < LETTER_ANGLES.length ? f.i : 0;
          const retrySys = singleLetterSys(baseSys, angleIdx, f.i === 0, STRICT_SUFFIX +
            String.fromCharCode(10) + 'Your previous attempt failed quality checks: ' + f.gate +
            '. Rewrite the single letter now, following every rule above, especially the failed ones.');
          return runAIWithFallback(retrySys, userMsg + DS_LENGTH_SUFFIX, callAI);
        }));
        const diagNotes = [];
        retried.forEach(function(s, ri) {
          const idx = failing[ri].i;
          let g2 = '';
          if (s.status === 'fulfilled' && s.value && Array.isArray(s.value.letters) &&
              s.value.letters[0] && s.value.letters[0].body) {
            const normed = normalizeLetter(s.value.letters[0]);
            g2 = gateOf(normed, idx);
            if (idx === 0 && g2 && g2.indexOf('missing company VERIFY') >= 0) {
              letters[idx] = normed;
              return;
            }
            if (!g2) { letters[idx] = normed; return; }
            diagNotes.push('L' + (idx + 1) + ' retry still fails: ' + g2);
          } else {
            diagNotes.push('L' + (idx + 1) + ' retry ' + (s.status === 'rejected' ? 'failed: ' + String((s.reason && s.reason.message) || s.reason) : 'no letter in retry response'));
          }
          if (idx < letters.length && letters[idx] && letters[idx].body && letters[idx].body.trim().length > 0) {
            letters[idx]._softFail = g2 || 'retry rejected';
            diagNotes.push('L' + (idx + 1) + ' kept AI draft (minor issues: ' + (g2 || 'no letter in retry') + ')');
          } else {
            const fb = fallbackLetter(jobTitle, company, skills, companyIntel, jd, tone, count);
            if (fb.letters[idx]) letters[idx] = normalizeLetter(fb.letters[idx]);
          }
        });
        retryDiag = diagNotes.join(' | ');
      }
    }
    if (letters.length < count) {
      const fb = fallbackLetter(jobTitle, company, skills, companyIntel, jd, tone, count);
      while (letters.length < count && fb.letters[letters.length]) {
        letters.push(normalizeLetter(fb.letters[letters.length]));
      }
    }
    letters.forEach(function(l, i){
      if (!l || !l.body || !String(l.body).trim().length) {
        const fb = fallbackLetter(jobTitle, company, skills, companyIntel, jd, tone, count);
        letters[i] = normalizeLetter(fb.letters[Math.min(i, 2)]);
      }
    });
    const finalLetters = letters.map(function(l){
      return postCleanup(l, inputNums, companyIntel, skills + ' ' + jd + ' ' + companyIntel);
    });
    const subjects = (result.subjects || []).map(String).map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 0; }).slice(0, 3);
    const strengths = (result.strengths || []).map(String).map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 0; }).slice(0, 3);
    const tips = (result.tips || []).map(String).map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 0; }).slice(0, 3);
    const payload = { success: true, letters: finalLetters, subjects: subjects, strengths: strengths, tips: tips, plan: 'pro', fallback: finalLetters.some(function(l){ return l._tpl; }) ? true : undefined };
    if (retryDiag) payload._diag = retryDiag;
    if (result._aiError) payload.ai_debug = result._aiError;
    return payload;
  } catch (err) {
    return { success: false, error: 'Upstream error: ' + err.message };
  }
}

// ==================== diagnose mode ====================
export async function diagnoseCore(opts) {
  const letter = String(opts.letter || '').trim().slice(0, 3000);
  const diagJd = String(opts.jd || '').trim().slice(0, MAX_LEN);
  const callAI = opts.callAI;
  if (letter.length < 100) {
    return { success: false, error: 'Please paste your cover letter first - at least a couple of paragraphs so the AI has something to work with.' };
  }
  try {
    const diagSysCore = [
      'You are a senior executive career coach and cover letter authority who has reviewed thousands of successful applications. The user pasted their own cover letter draft, and optionally the job description it targets.',
      'Output EXACTLY one JSON object in this format:',
      '{"score": 0, "overall": "...", "paragraphs": [{"p": 1, "diagnosis": "...", "fix": "...", "sentences": [{"s": "exact sentence", "tag": "good|weak|bad", "why": "short reason"}]}], "jd_match": [{"req": "requirement", "status": "covered|partial|missing", "how": "..."}], "issues": ["..."], "improvements": ["..."]}',
      'Rules (keep output compact):',
      '1. score: integer 0-100 = how likely this letter is to win the job. Use the full range - do not give everything 80+.',
      '2. overall: 1-2 sentences: the letter\'s overall strength and its single biggest gap.',
      '3. paragraphs: one entry per paragraph, in order (paragraphs separated by blank lines). p = 1-based paragraph index. diagnosis: 1-2 sentences about THAT paragraph only. fix: one concrete actionable rewrite instruction for that paragraph. sentences: EVERY sentence verbatim (do not paraphrase), each with tag good (specific evidence / action verbs) / weak (vague, generic, missing proof) / bad (cliche, AI-sounding, filler) and why in 4-8 words. Keep each sentence entry compact.',
      '4. jd_match: ONLY if a job description was provided - one entry per key requirement: status covered / partial / missing, how = one concrete way to add it.',
      '5. issues: 3-5 specific problems. 6. improvements: 3-5 concrete actions.',
      '7. All English. Be specific and practical. Output ONLY the JSON object - no explanations, no markdown, no extra text.'
    ].join(String.fromCharCode(10));
    const diagUser = [
      'My cover letter:',
      letter,
      diagJd ? ('Job description: ' + diagJd) : ''
    ].filter(function(s){ return s; }).join(String.fromCharCode(10));
    let d;
    try { d = await runAIWithFallback(diagSysCore, diagUser, callAI); }
    catch (e) { d = fallbackDiagCore(letter, diagJd); }
    if (!d || d.score === undefined) {
      return { success: false, error: 'AI returned no valid diagnosis. Please try again.' };
    }
    d.score = Math.max(0, Math.min(100, Math.round(Number(d.score) || 0)));
    d.overall = String(d.overall || '').trim().slice(0, 400);
    d.paragraphs = (Array.isArray(d.paragraphs) ? d.paragraphs : [])
      .map(function(p){
        if (!p || typeof p !== 'object') return null;
        var sentences = (Array.isArray(p.sentences) ? p.sentences : [])
          .map(function(sn){
            if (!sn || typeof sn !== 'object') return null;
            var tag = String(sn.tag || '').trim().toLowerCase();
            if (tag !== 'good' && tag !== 'weak' && tag !== 'bad') tag = 'weak';
            return {
              s: String(sn.s || '').trim().slice(0, 400),
              tag: tag,
              why: String(sn.why || '').trim().slice(0, 160)
            };
          })
          .filter(function(sn){ return sn && sn.s.length > 0; })
          .slice(0, 12);
        return {
          p: Number(p.p) || 0,
          diagnosis: String(p.diagnosis || '').trim().slice(0, 300),
          fix: String(p.fix || '').trim().slice(0, 300),
          sentences: sentences,
          rewrite: String(p.rewrite || '').trim().slice(0, 1200)
        };
      })
      .filter(function(p){ return p && (p.diagnosis || p.fix || p.rewrite || (p.sentences && p.sentences.length)); })
      .slice(0, 8);
    d.jd_match = (Array.isArray(d.jd_match) ? d.jd_match : [])
      .map(function(j){
        if (!j || typeof j !== 'object') return null;
        var st = String(j.status || '').trim().toLowerCase();
        if (st !== 'covered' && st !== 'partial' && st !== 'missing') st = 'missing';
        return {
          req: String(j.req || '').trim().slice(0, 200),
          status: st,
          how: String(j.how || '').trim().slice(0, 200)
        };
      })
      .filter(function(j){ return j && j.req.length > 0; })
      .slice(0, 8);
    d.issues = (d.issues || []).map(String).map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 0; }).slice(0, 6);
    d.improvements = (d.improvements || []).map(String).map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 0; }).slice(0, 6);
    const lh = letter.length + letter.charCodeAt(0) + letter.charCodeAt(Math.min(9, letter.length - 1));
    const tok = diagToken(lh);
    return { success: true, diagnosis: d, diag_token: tok, plan: 'pro', fallback: d.fallback ? true : undefined };
  } catch (err) {
    return { success: false, error: 'Upstream error: ' + err.message };
  }
}

export async function diagnoseFull(opts) {
  const letter = String(opts.letter || '').trim().slice(0, 3000);
  const diagJd = String(opts.jd || '').trim().slice(0, MAX_LEN);
  const callAI = opts.callAI;
  try {
    const tok = String(opts.diag_token || '').trim();
    const lh2 = letter.length + letter.charCodeAt(0) + letter.charCodeAt(Math.min(9, letter.length - 1));
    if (!checkDiagToken(tok, lh2)) {
      return { success: false, error: 'Diagnosis session expired - run Diagnose again to get the improved version.' };
    }
    const diagSysFull = [
      'You are a senior executive career coach and cover letter authority. The user pasted their own cover letter draft, and optionally the job description it targets. Rewrite their letter into the best possible version.',
      'Output EXACTLY one JSON object in this format:',
      '{"improved_letter": "...", "changes": ["..."]}',
      'Rules (keep output compact):',
      '1. improved_letter: FULL rewritten version of the user\'s letter - keep ALL of the user\'s real facts, skills and details (never add facts the user did not write: NO invented numbers, percentages, dates, metrics or outcomes - if the original has no metric, stay qualitative like "grew blog traffic significantly" or use an explicit placeholder "[X]%"). Fact-preservation is graded: every concrete fact - years of experience, roles, team size, tools, achievements - MUST appear; check your draft against the original and re-add anything you dropped. Match the user\'s letter in LENGTH: roughly 80%-130% of the original word count (a 240-word letter -> 200-310 words; a 100-word letter -> 80-130 words); never drastically shorter or longer.',
      '2. STYLE - applies to EVERY sentence, not just the opening. (a) Every sentence must earn its place: specific evidence (real details, numbers, tools, outcomes) beats generic claims; a sentence that only restates a skill or an intention gets a concrete example. (b) Clarity beats formality: simple, direct professional sentences - no lawyer register, no convoluted "With [X] years of experience..." / "As a skilled... professional" constructions; plain frames ("In my last role...", "At [company]...", "Having led...", "Through my work on...", "I...") are preferred. (c) Vary sentence openings naturally - "I" is normal but do not mechanically start every sentence with it; avoid self-assessment closers ("I am confident in my ability to...") - let evidence speak and end with a forward-looking call-to-action. (d) Never use: "thrilled", "excited", "passionate", "eager", "looking forward", "keen eye for detail".',
      '3. changes: 3-4 short bullets listing the most important changes made.',
      '4. All English. Output ONLY the JSON object - no explanations, no markdown, no extra text.'
    ].join(String.fromCharCode(10));
    let diagUser2 = [
      'My cover letter:',
      letter,
      diagJd ? ('Job description: ' + diagJd) : ''
    ].filter(function(s){ return s; }).join(String.fromCharCode(10));
    const origWords = letter.split(/\s+/).filter(Boolean).length;
    const factRe = /(?:\d+(?:\.\d+)?\s*(?:years?|months?|weeks?|days?|%|percent|x|times?|people|members|users?|customers?|clients?|projects?|campaigns?|products?|apps?))|(?:team of \d+)|(?:[A-Z][a-z]+ (?:SEO|CRM|SQL|AWS|React|Figma|Python|Excel|Google Analytics|Photoshop|Sketch|WordPress))/g;
    let facts = letter.match(factRe) || [];
    facts = facts.map(function(s){ return s.trim(); }).filter(function(v,i,a){ return a.indexOf(v) === i; }).slice(0, 12);
    if (facts.length) {
      diagUser2 += String.fromCharCode(10) + String.fromCharCode(10) +
        'FACT CHECKLIST - every one of these facts must appear in improved_letter (use the exact wording): ' + facts.join(', ');
    }
    let df;
    try { df = await runAIWithFallback(diagSysFull, diagUser2, callAI); }
    catch (e) { df = fallbackDiagFull(letter); }
    function diagGate(letterTxt){
      if (!letterTxt) return 'improved_letter is empty';
      if (hasBadOpen(letterTxt)) return 'the first sentence of a paragraph must not start with "With [X] years", "As a skilled... professional", "My expertise in..." - use a plain frame like "In my last role...", "At [company]...", "Having led...", "Through my work on...", or "I..."';
      if (hasBannedPhrase(letterTxt)) return 'banned phrases must not appear: "I am confident...", "strong fit", "perfect fit", "thrilled", "excited", "passionate", "eager", "looking forward", "keen eye for detail"';
      var w = letterTxt.split(/\s+/).filter(Boolean).length;
      var lo = Math.round(origWords * 0.80), hi = Math.round(origWords * 1.30);
      if (w > hi) return 'the letter is too long (' + w + ' words; target ' + lo + '-' + hi + ' words) - trim to match the original length';
      if (w < lo) return 'the letter is too short (' + w + ' words; target ' + lo + '-' + hi + ' words) - expand to match the original length';
      return null;
    }
    var gate = diagGate(df && df.improved_letter);
    var attempt = 0;
    while (gate && attempt < 1) {
      attempt++;
      var prev = String((df && df.improved_letter) || '').slice(0, 200);
      const retrySys = diagSysFull + String.fromCharCode(10) + String.fromCharCode(10) +
        'QUALITY FAILURE (attempt ' + attempt + '): ' + gate + '. ' +
        'Your previous improved_letter opened: "' + prev + '..." - that violates the rules. ' +
        'Correct opening examples: "In my last role at a software company, I grew blog traffic significantly through content marketing." / "Having 5 years of marketing experience, I helped a software company grow its blog traffic." / "I spent 5 years in marketing, focused on content and SEO, and grew blog traffic significantly." ' +
        'Rewrite improved_letter from scratch now with a correct opening, keep EVERY fact from the FACT CHECKLIST, and stay within ' + Math.round(origWords * 0.8) + '-' + Math.round(origWords * 1.3) + ' words.';
      try {
        const df2 = await runAIWithFallback(retrySys, diagUser2, callAI);
        if (df2 && df2.improved_letter) {
          df = df2;
          gate = diagGate(df2.improved_letter);
        } else { break; }
      } catch (e) { break; }
    }
    var finalTxt = String((df && df.improved_letter) || '').trim();
    finalTxt = cleanBanned(finalTxt);
    finalTxt = finalTxt.split(/\n\s*\n/).map(function(p){
      return p.trim().replace(/^With\s+(?=\d+(?:\.\d+)?\s+years?\b)/i, 'Having ');
    }).join('\n\n');
    finalTxt = finalTxt.replace(/\b(for|to|of|the|and|in|is|a|at|I|that|with|my|your|it|on|as|an|be|by|from|this|we|they|you|he|she|their|our)\s+\1\b/gi, '$1');
    var finalWords = finalTxt.split(/\s+/).filter(Boolean).length;
    if (finalWords < Math.round(origWords * 0.8)) {
      finalTxt = cleanBanned(String(letter).trim());
      finalTxt = finalTxt.split(/\n\s*\n/).map(function(p){
        return p.trim().replace(/^With\s+(?=\d+(?:\.\d+)?\s+years?\b)/i, 'Having ');
      }).join('\n\n');
      finalTxt = finalTxt.replace(/\b(for|to|of|the|and|in|is|a|at|I|that|with|my|your|it|on|as|an|be|by|from|this|we|they|you|he|she|their|our)\s+\1\b/gi, '$1');
      if (df && df.changes) {
        df.changes = df.changes.concat(['Kept every real fact from your original letter while removing banned phrases']);
      }
    }
    const out = {
      improved_letter: finalTxt.slice(0, 4000),
      changes: ((df && df.changes) || []).map(String).map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 0; }).slice(0, 6),
      fallback: df && df.fallback ? true : undefined
    };
    return { success: true, diagnosis: out, plan: 'pro', fallback: out.fallback ? true : undefined };
  } catch (err) {
    return { success: false, error: 'Upstream error: ' + err.message };
  }
}

// ==================== interview prep mode ====================
export async function interviewPrep(opts) {
  const ivLetter = String(opts.letter || '').trim().slice(0, 4000);
  const ivJd = String(opts.jd || '').trim().slice(0, MAX_LEN);
  const callAI = opts.callAI;
  if (ivLetter.length < 100) {
    return { success: false, error: 'Please paste your cover letter first - at least a couple of paragraphs so the AI has something to work with.' };
  }
  try {
    const factRe = /(?:\d+(?:\.\d+)?\s*(?:years?|months?|weeks?|days?|%|percent|x|times?|people|members|users?|customers?|clients?|projects?|campaigns?|products?|apps?))|(?:team of \d+)|(?:[A-Z][a-z]+ (?:SEO|CRM|SQL|AWS|React|Figma|Python|Excel|Google Analytics|Photoshop|Sketch|WordPress))/g;
    let facts = ivLetter.match(factRe) || [];
    facts = facts.map(function(s){ return s.trim(); }).filter(function(v, i, a){ return a.indexOf(v) === i; }).slice(0, 12);
    const ivSys = [
      'You are a senior hiring manager and interview coach who has conducted thousands of interviews. The user\'s cover letter (and optionally the job description it targets) is their application ammunition - your job is to predict what a recruiter will actually ask them, and how to answer.',
      'Output EXACTLY one JSON object in this format:',
      '{"questions": [{"q": "...", "why": "...", "points": ["..."]}]}',
      'Rules:',
      '1. Exactly 5 questions. Each one must be concrete and interview-real - the kind a recruiter would genuinely ask about THIS person\'s background, THIS role and THIS company. Never 5 generic questions ("Tell me about yourself") - at least 3 must be specific to facts in the letter (years of experience, tools, projects, team size, achievements, the target role).',
      '2. q: the exact question, first person addressed to the candidate, one sentence, under 20 words.',
      '3. why: one short sentence (5-12 words) explaining which part of the letter triggered this question (e.g. "Probes the 34% drop-off claim").',
      '4. points: 2-3 concise answer points. Use ONLY facts from the letter - NEVER invent numbers, projects or outcomes the user did not write. Where the letter is vague, coach the candidate to prepare a concrete example ("If you have a measurable result, mention it") without fabricating one.',
      '5. If a job description was provided, include questions that test the requirements from it.',
      '6. All English. Output ONLY the JSON object - no explanations, no markdown, no extra text.'
    ].join(String.fromCharCode(10));
    let ivUser = [
      'My cover letter:',
      ivLetter,
      ivJd ? ('Job description: ' + ivJd) : ''
    ].filter(function(s){ return s; }).join(String.fromCharCode(10));
    if (facts.length) {
      ivUser += String.fromCharCode(10) + String.fromCharCode(10) +
        'FACTS IN MY LETTER (questions may reference these, never invent others): ' + facts.join(', ');
    }
    let iv;
    try { iv = await runAIWithFallback(ivSys, ivUser, callAI); }
    catch (e) { iv = fallbackInterview(ivLetter, ivJd); }
    if (!iv || !Array.isArray(iv.questions) || iv.questions.length === 0) {
      return { success: false, error: 'AI returned no interview questions. Please try again.' };
    }
    iv.questions = iv.questions
      .map(function(x){
        if (!x || typeof x !== 'object') return null;
        return {
          q: String(x.q || '').trim().slice(0, 200),
          why: String(x.why || '').trim().slice(0, 160),
          points: (Array.isArray(x.points) ? x.points : []).map(String).map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 0; }).slice(0, 4)
        };
      })
      .filter(function(x){ return x && x.q.length > 0; })
      .slice(0, 5);
    if (iv.questions.length < 3) {
      return { success: false, error: 'AI returned too few interview questions. Please try again.' };
    }
    return { success: true, questions: iv.questions, plan: 'pro', fallback: iv.fallback ? true : undefined };
  } catch (err) {
    return { success: false, error: 'Upstream error: ' + err.message };
  }
}

// ==================== email short version mode ====================
export async function emailVersion(opts) {
  const jobTitle = String(opts.jobTitle || '').trim().slice(0, 80);
  const company  = String(opts.company || '').trim().slice(0, 80);
  const skills   = String(opts.skills || '').trim().slice(0, MAX_LEN);
  const jd       = String(opts.jd || '').trim().slice(0, MAX_LEN);
  const companyIntel = String(opts.companyIntel || '').trim().slice(0, 500);
  const callAI   = opts.callAI;
  try {
    const emailSys = [
      'You are a senior executive career coach. Condense this person\'s application into a ready-to-paste EMAIL BODY (when a job posting says "send your cover letter in the email body").',
      'Output EXACTLY one JSON object in this format:',
      '{"body": "...", "score": 0, "note": "..."}',
      'Rules:',
      '1. body: starts with the greeting "Dear Hiring Manager," then exactly 2-3 short paragraphs, then a forward-looking closer ("I would welcome the chance to discuss...") WITHOUT a signature block (the sender adds their own name).',
      '2. HARD LIMIT: 100-150 words total INCLUDING the greeting and closer. Tight, email-like, scannable.',
      '3. Keep ALL of the candidate\'s real facts (years, tools, projects, outcomes they provided) - NEVER invent numbers, dates, metrics or outcomes. Where the candidate gave little detail, stay general but strong - do not fabricate specifics.',
      '4. First person, professional, natural - reads like the person wrote it, not like an AI. Same style rules as a strong cover letter: no banned cliches ("thrilled", "passionate", "eager", "looking forward", "keen eye for detail", "I am writing to express"), no "With [X] years of experience..." / "As a skilled..." / "My expertise in..." fronted constructions, vary sentence openings.',
      '5. If company info was provided, weave one real fact from it in naturally (no placeholders, no VERIFY markers) — and NEVER invent any other company fact (founding year, HQ, headcount, customer counts are off-limits; use the provided fact instead). If no company info was provided, do not fabricate a company claim.',
      '6. score: integer 0-100 - how strong this email body is for THIS job. note: one short sentence (6-14 words) on its strength or gap.',
      '7. All English. Output ONLY the JSON object - no explanations, no markdown, no extra text.'
    ].join(String.fromCharCode(10));
    const emailUser = [
      'Job title: ' + jobTitle,
      'Company: ' + company,
      'Candidate skills & experience: ' + skills,
      companyIntel ? ('Company info the candidate knows (use only this, never invent more): ' + companyIntel) : 'Company info: (none provided)',
      jd ? ('Job description: ' + jd) : ''
    ].filter(function(s){ return s; }).join(String.fromCharCode(10));
    let em;
    try { em = await runAIWithFallback(emailSys, emailUser, callAI); }
    catch (e) { em = fallbackEmail(jobTitle, company, skills, companyIntel, jd); }
    if (!em || !em.body) {
      return { success: false, error: 'AI returned no email version. Please try again.' };
    }
    const wCnt = em.body.split(/\s+/).filter(Boolean).length;
    if (hasBannedPhrase(em.body) || hasBadOpen(em.body) || wCnt > 155 || wCnt < 80) {
      try {
        const again = await runAIWithFallback(emailSys + String.fromCharCode(10) + String.fromCharCode(10) +
          'FINAL CHECK - your previous body was rejected: banned phrases, a "With [X] years..." / "As a skilled..." / "My expertise in..." opening, or wrong length (target 100-150 words; you wrote ' + wCnt + '). Rewrite it now: plain opening frame ("In my last role...", "At [company]...", "Having led...", "I..."), no banned phrases anywhere, keep every real fact, 100-150 words total, greeting "Dear Hiring Manager," at the top, no signature block.', emailUser, callAI);
        if (again && again.body) em = again;
      } catch (e) { /* keep the first attempt */ }
    }
    let bodyTxt = String(em.body || '').trim();
    if (hasBannedPhrase(bodyTxt)) bodyTxt = cleanBanned(bodyTxt);
    const wFinal = bodyTxt.split(/\s+/).filter(Boolean).length;
    return {
      success: true,
      email: {
        body: bodyTxt.slice(0, 2500),
        score: (em.score === undefined || em.score === null) ? null : Math.max(0, Math.min(100, Math.round(Number(em.score) || 0))),
        note: String(em.note || '').trim().slice(0, 200),
        words: wFinal,
        fallback: em.fallback ? true : undefined
      },
      plan: 'pro'
    };
  } catch (err) {
    return { success: false, error: 'Upstream error: ' + err.message };
  }
}
