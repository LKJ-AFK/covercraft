// Headless verification of CoverCraft Zibby core (no DOM, no Zibby host needed).
// Verifies: exports exist, deterministic fallback paths return complete payloads,
// quality-gate helpers behave, generated letter body passes the 3-paragraph contract.
import {
  generateAll, diagnoseCore, diagnoseFull, interviewPrep, emailVersion,
  MAX_LEN, TONE_CN, diagToken, checkDiagToken, wordCount
} from '../core.js';

let failed = 0;
function check(name, cond, extra) {
  if (cond) { console.log('OK  ', name); }
  else { failed++; console.log('FAIL', name, extra || ''); }
}

// --- exports ---
check('exports present', typeof generateAll === 'function' && typeof diagnoseCore === 'function' && typeof emailVersion === 'function' && typeof interviewPrep === 'function' && typeof MAX_LEN === 'number' && typeof TONE_CN === 'object' && typeof diagToken === 'function' && typeof checkDiagToken === 'function');
check('5 tones', Object.keys(TONE_CN).length === 5);

// --- AI that always fails -> deterministic fallback path ---
const failAI = async () => { throw new Error('simulated upstream failure'); };

const gen = await generateAll({
  jobTitle: 'Data Analyst',
  company: 'Acme Corp',
  skills: '3 years in SQL and Excel, cut reporting time by 40%, built dashboards for a team of 12',
  jd: 'SQL, dashboards, stakeholder comms',
  companyIntel: '',
  tone: 'professional',
  count: 3,
  callAI: failAI
});
check('gen success with fallback', gen.success === true, JSON.stringify(gen && gen.error));
check('gen 3 letters', gen.letters && gen.letters.length === 3, gen.letters && gen.letters.length);
const body0 = gen.letters[0].body || '';
const paras0 = body0.split(/\n\s*\n/).filter(p => p.trim());
check('letter body 3 paragraphs', paras0.length === 3, paras0.length);
check('letter score present', typeof gen.letters[0].score === 'number' && gen.letters[0].score > 0, gen.letters[0].score);
// fallback with no companyIntel must mark the company sentence for verification (design contract)
check('letter VERIFY marks + verify_items', /«VERIFY»/.test(gen.letters[0].body) && gen.letters[0].verify_items.length >= 1, gen.letters[0].verify_items && gen.letters[0].verify_items.length);
check('letter VERIFY well-formed', !/«VERIFY»([^«]*?)«VERIFY»/.test(gen.letters[0].body) && /«VERIFY»[\s\S]*?«\/VERIFY»/.test(gen.letters[0].body));
check('subjects/strengths/tips arrays', Array.isArray(gen.subjects) && Array.isArray(gen.strengths) && Array.isArray(gen.tips));

// --- diagnose fallback ---
const diag = await diagnoseCore({ letter: 'In my last role I built SQL dashboards used weekly by a team of 12. I cut report time by 40%. I enjoy detail work.', jd: 'SQL expert needed', callAI: failAI });
check('diag success fallback', diag.success === true);
check('diag has score/paragraphs', typeof (diag.diagnosis && diag.diagnosis.score) === 'number' && Array.isArray(diag.diagnosis.paragraphs));
check('diag token issued', typeof diag.diag_token === 'string' && diag.diag_token.length > 10);

const full = await diagnoseFull({ letter: 'In my last role I built SQL dashboards used weekly by a team of 12. I cut report time by 40%. I enjoy detail work.', jd: '', diag_token: diag.diag_token, callAI: failAI });
check('diag full success (fallback)', full.success === true);
check('improved letter non-empty', typeof (full.diagnosis && full.diagnosis.improved_letter) === 'string' && full.diagnosis.improved_letter.length > 50);

// --- token expiry (2 min) ---
const tok = diagToken(12345);
check('token valid immediately', checkDiagToken(tok, 12345) === true);
check('token rejects wrong hash', checkDiagToken(tok, 99999) === false);

// --- email fallback ---
const em = await emailVersion({ jobTitle: 'Data Analyst', company: 'Acme Corp', skills: '3 years SQL and Excel, cut reporting time by 40%', jd: '', companyIntel: '', callAI: failAI });
check('email fallback success', em.success === true && !!em.email.body);
check('email word count sane', em.email.words >= 80 && em.email.words <= 160, em.email && em.email.words);
check('email greeting', (em.email.body || '').startsWith('Dear Hiring Manager'));

// --- interview fallback (letter must be >=100 chars) ---
const ivLetter = 'I built SQL dashboards for a team of 12 and cut reporting time by 40% over 3 years at my previous company, where I also trained 4 junior analysts and presented weekly findings to the head of finance. I enjoy detail work and stakeholder communication.';
const iv = await interviewPrep({ letter: ivLetter, jd: 'SQL expert needed for reporting team', callAI: failAI });
check('interview fallback success', iv.success === true);
check('interview 3-5 questions', Array.isArray(iv.questions) && iv.questions.length >= 3 && iv.questions.length <= 5, iv.questions && iv.questions.length);

// --- quality helper: wordCount ---
check('wordCount works', wordCount('a b c') === 3);

console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);
