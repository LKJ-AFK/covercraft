// ============================================
// CoverCraft — Zibby edition: front-end UI
// Ported from the CoverCraft worker's front-end script.
// All AI calls go through Zibby (streamZibbyAi) via core.js.
// Pro gate / quotas / license / waitlist removed — every feature is open.
// ============================================
import {
  generateAll, diagnoseCore, diagnoseFull, interviewPrep, emailVersion,
  MAX_LEN
} from './core.js';
import {
  streamZibbyAi, installHostBridge, navigateHost, ZIBBY_CREDITS_PATH
} from './vendor/zibby/index.js';

(function(){
  'use strict';

  var jobEl     = document.getElementById('jobTitle');
  var companyEl = document.getElementById('company');
  var skillsEl  = document.getElementById('skills');
  var jdEl      = document.getElementById('jd');
  var btn       = document.getElementById('genBtn');
  var diagBtn   = document.getElementById('diagBtn');
  var dLetterEl = document.getElementById('dLetter');
  var dJdEl     = document.getElementById('dJd');
  var modeGen   = document.getElementById('modeGen');
  var modeDiag  = document.getElementById('modeDiag');
  var genPanel  = document.getElementById('genPanel');
  var diagPanel = document.getElementById('diagPanel');
  var diagResults = document.getElementById('diagResults');
  var dScoreBox = document.getElementById('dScoreBox');
  var dParas    = document.getElementById('dParas');
  var dIssuesPanel = document.getElementById('dIssuesPanel');
  var dIssuesList  = document.getElementById('dIssuesList');
  var dImpPanel = document.getElementById('dImpPanel');
  var dImpList  = document.getElementById('dImpList');
  var dJdPanel  = document.getElementById('dJdPanel');
  var dJdList   = document.getElementById('dJdList');
  var dImproved = document.getElementById('dImproved');
  var dImprovedBody = document.getElementById('dImprovedBody');
  var loading   = document.getElementById('loading');
  var results   = document.getElementById('results');
  var bestBox   = document.getElementById('bestBox');
  var bestNote  = document.getElementById('bestNote');
  var bestScore = document.getElementById('bestScore');
  var tabsEl    = document.getElementById('tabs');
  var letterTag = document.getElementById('letterTag');
  var wordCount = document.getElementById('wordCount');
  var letterBody= document.getElementById('letterBody');
  var letterNote= document.getElementById('letterNote');
  var subjPanel = document.getElementById('subjPanel');
  var subjList  = document.getElementById('subjList');
  var tipsPanel = document.getElementById('tipsPanel');
  var tipsList  = document.getElementById('tipsList');
  var msgEl     = document.getElementById('msg');
  var quotaFree = document.getElementById('quotaFree');
  var quotaPro  = document.getElementById('quotaPro');
  var proUser   = document.getElementById('proUser');
  var toastEl   = document.getElementById('toast');
  var emailThis = document.getElementById('emailThis');
  var emailBox  = document.getElementById('emailBox');
  var emailBody = document.getElementById('emailBody');
  var interviewBtn  = document.getElementById('interviewBtn');
  var interviewBox  = document.getElementById('interviewBox');
  var interviewList = document.getElementById('interviewList');
  var toneNow   = 'professional';
  var letters   = [];
  var curIdx    = 0;

  // ---- Zibby host bridge: enables credits display + shell navigation ----
  try { installHostBridge(); } catch (e) { /* non-fatal */ }

  // ---- AI transport: one callAI(sys, user) -> raw text ----
  var MODEL = 'moonshotai/kimi-k2'; // provider 'openai'; quality strong, cost low
  function callAI(sys, user) {
    var ctrl = new AbortController();
    var timer = setTimeout(function(){ ctrl.abort(); }, 45000);
    return streamZibbyAi({
      action: 'chat',
      provider: 'openai',
      model: MODEL,
      payload: {
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user }
        ]
      }
    }, { signal: ctrl.signal, onDelta: function(){} })
    .then(function(res){
      clearTimeout(timer);
      if (!res || typeof res.text !== 'string' || !res.text.trim()) {
        throw new Error('Empty AI response');
      }
      return res.text;
    }, function(err){
      clearTimeout(timer);
      var code = err && err.code;
      if (code === 'insufficient_credits') {
        showMsg('You ran out of Zibby credits. Top up to keep generating.', 6000);
        if (ZIBBY_CREDITS_PATH) { try { navigateHost(ZIBBY_CREDITS_PATH); } catch (e2) {} }
      } else if (code === 'rate_limited') {
        showMsg('Zibby is rate-limiting right now — please wait a moment and try again.', 6000);
      } else if (code === 'locked' || code === 'unauthenticated') {
        showMsg('Zibby sign-in issue detected. Please re-open this app after signing in.', 6000);
      } else {
        showMsg('AI call failed (' + ((err && err.message) || 'unknown error') + ').', 6000);
      }
      throw err;
    });
  }

  // ---- simple UI helpers ----
  function showMsg(t, ms) {
    if (!msgEl) return;
    msgEl.textContent = t;
    msgEl.classList.add('show');
    if (ms) {
      setTimeout(function(){ msgEl.classList.remove('show'); }, ms);
    }
  }
  function toast(t) {
    if (!toastEl) return;
    toastEl.textContent = t;
    toastEl.classList.add('show');
    setTimeout(function(){ toastEl.classList.remove('show'); }, 2200);
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---- paint Pro state: everything is unlocked on Zibby ----
  function paintPro() {
    if (quotaFree) quotaFree.style.display = 'none';
    if (quotaPro) quotaPro.style.display = 'flex';
    if (proUser) proUser.classList.add('show');
    // hide the legacy paywall / waitlist blocks (still present in the HTML)
    ['unlockBtn', 'wlPanel', 'licensePanel'].forEach(function(id){
      var el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  }
  paintPro();

  // ---- back-to-top + side nav highlight (light version of the original) ----
  var backTop = document.getElementById('backTop');
  if (backTop) {
    backTop.addEventListener('click', function(){ window.scrollTo({ top: 0, behavior: 'smooth' }); });
  }
  var sideNavLinks = document.querySelectorAll('.sidenav a');
  function onScroll() {
    var cur = '';
    ['generator', 'pricing', 'features', 'examples', 'how', 'faq'].forEach(function(id){
      var el = document.getElementById(id);
      if (el && el.getBoundingClientRect().top <= 140) cur = '#' + id;
    });
    sideNavLinks.forEach(function(a){
      a.classList.toggle('on', a.getAttribute('href') === cur);
    });
    if (backTop) backTop.classList.toggle('show', window.scrollY > 600);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---- prefill from ATSCheck (?role=&jd=) ----
  try {
    var qs = new URLSearchParams(window.location.search);
    var r = qs.get('role'), j = qs.get('jd');
    if (r && jobEl && !jobEl.value) jobEl.value = r.slice(0, 80);
    if (j && jdEl && !jdEl.value) jdEl.value = j.slice(0, MAX_LEN);
  } catch (e) { /* noop */ }

  // ---- mode tabs ----
  if (modeGen && modeDiag) {
    function setMode(m) {
      var gen = m === 'gen';
      modeGen.classList.toggle('active', gen);
      modeDiag.classList.toggle('active', !gen);
      genPanel.style.display = gen ? 'block' : 'none';
      diagPanel.style.display = gen ? 'none' : 'block';
      diagResults.style.display = 'none';
      if (!gen && dLetterEl) dLetterEl.focus();
    }
    modeGen.addEventListener('click', function(){ setMode('gen'); });
    modeDiag.addEventListener('click', function(){ setMode('diag'); });
  }

  // ---- tone chips ----
  document.querySelectorAll('.tone-chip').forEach(function(chip){
    chip.addEventListener('click', function(){
      document.querySelectorAll('.tone-chip').forEach(function(c){ c.classList.remove('active'); });
      chip.classList.add('active');
      toneNow = chip.getAttribute('data-tone') || 'professional';
    });
  });

  // ---- generate ----
  function genPayload() {
    return {
      job_title: (jobEl.value || '').trim(),
      company: (companyEl.value || '').trim(),
      skills: (skillsEl.value || '').trim(),
      jd: (jdEl.value || '').trim(),
      company_intel: '',
      tone: toneNow
    };
  }
  if (btn) {
    btn.addEventListener('click', function(){
      var p = genPayload();
      if (!p.job_title || !p.company || !p.skills) {
        showMsg('Please fill in the job title, company and your skills.');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Writing your letters…';
      loading.style.display = 'block';
      msgEl.classList.remove('show');
      emailBox.style.display = 'none';
      interviewBox.style.display = 'none';
      generateAll({
        jobTitle: p.job_title,
        company: p.company,
        skills: p.skills,
        jd: p.jd,
        companyIntel: p.company_intel,
        tone: p.tone,
        count: 3,
        callAI: callAI
      }).then(function(data){
        btn.disabled = false;
        btn.textContent = 'Generate Cover Letters';
        loading.style.display = 'none';
        if (!data || !data.success) {
          showMsg((data && data.error) || 'Something went wrong. Please try again.');
          return;
        }
        renderAll(data);
      }).catch(function(err){
        btn.disabled = false;
        btn.textContent = 'Generate Cover Letters';
        loading.style.display = 'none';
        showMsg('Generation failed. Please try again.');
        if (window.console) console.error(err);
      });
    });
  }

  // ---- diagnose (two-stage) ----
  if (diagBtn) {
    diagBtn.addEventListener('click', function(){
      var letter = (dLetterEl.value || '').trim();
      var jd = (dJdEl.value || '').trim();
      if (letter.length < 100) {
        showMsg('Please paste your cover letter first - at least a couple of paragraphs so the AI has something to work with.');
        return;
      }
      diagBtn.disabled = true;
      diagBtn.textContent = 'Analyzing…';
      loading.style.display = 'block';
      msgEl.classList.remove('show');
      diagnoseCore({ letter: letter, jd: jd, callAI: callAI }).then(function(res){
        if (!res || !res.success) {
          diagBtn.disabled = false;
          diagBtn.textContent = 'Diagnose My Letter';
          loading.style.display = 'none';
          showMsg((res && res.error) || 'Diagnosis failed. Please try again.');
          return;
        }
        renderDiagnosis(res.diagnosis, res.plan);
        var tok = res.diag_token || '';
        if (!tok) {
          diagBtn.disabled = false;
          diagBtn.textContent = 'Diagnose My Letter';
          loading.style.display = 'none';
          return;
        }
        return diagnoseFull({ letter: letter, jd: jd, diag_token: tok, callAI: callAI }).then(function(res2){
          if (res2 && res2.success && res2.diagnosis) {
            renderImproved(res2.diagnosis);
          } else if (res2 && res2.error) {
            showMsg(res2.error);
          }
        });
      }).catch(function(err){
        diagBtn.disabled = false;
        diagBtn.textContent = 'Diagnose My Letter';
        loading.style.display = 'none';
        showMsg('Diagnosis failed. Please try again.');
        if (window.console) console.error(err);
      }).then(function(){
        diagBtn.disabled = false;
        diagBtn.textContent = 'Diagnose My Letter';
        loading.style.display = 'none';
      });
    });
  }

  // ---- email short version ----
  if (emailThis) {
    emailThis.addEventListener('click', function(){
      var p = genPayload();
      if (!p.job_title || !p.company || !p.skills) {
        showMsg('Please fill in the job title, company and your skills first.');
        return;
      }
      emailThis.disabled = true;
      emailThis.textContent = 'Writing…';
      loading.style.display = 'block';
      emailVersion({
        jobTitle: p.job_title,
        company: p.company,
        skills: p.skills,
        jd: p.jd,
        companyIntel: p.company_intel,
        callAI: callAI
      }).then(function(data){
        emailThis.disabled = false;
        emailThis.textContent = 'Email Version';
        loading.style.display = 'none';
        if (!data || !data.success) {
          showMsg((data && data.error) || 'Could not generate the email version.');
          return;
        }
        renderEmail(data.email);
      }).catch(function(err){
        emailThis.disabled = false;
        emailThis.textContent = 'Email Version';
        loading.style.display = 'none';
        showMsg('Email generation failed. Please try again.');
        if (window.console) console.error(err);
      });
    });
  }

  // ---- interview prep ----
  if (interviewBtn) {
    interviewBtn.addEventListener('click', function(){
      var letter = (dLetterEl.value || '').trim();
      var jd = (dJdEl.value || '').trim();
      if (letter.length < 100) {
        showMsg('Please paste your cover letter first - at least a couple of paragraphs so the AI has something to work with.');
        return;
      }
      interviewBtn.disabled = true;
      interviewBtn.textContent = 'Preparing…';
      loading.style.display = 'block';
      interviewPrep({ letter: letter, jd: jd, callAI: callAI }).then(function(data){
        interviewBtn.disabled = false;
        interviewBtn.textContent = 'Interview Prep';
        loading.style.display = 'none';
        if (!data || !data.success) {
          showMsg((data && data.error) || 'Could not generate interview questions.');
          return;
        }
        renderInterview(data.questions);
      }).catch(function(err){
        interviewBtn.disabled = false;
        interviewBtn.textContent = 'Interview Prep';
        loading.style.display = 'none';
        showMsg('Interview prep failed. Please try again.');
        if (window.console) console.error(err);
      });
    });
  }

  // ==================== rendering (ported unchanged) ====================
  function renderAll(d) {
    letters = d.letters || [];
    curIdx = 0;
    results.style.display = 'block';
    var best = letters[0] || {};
    var bestScoreV = Math.round(Number(best.score) || 0);
    bestScore.textContent = bestScoreV;
    bestNote.textContent = best.note || '';
    bestBox.style.display = 'block';
    if (d.subjects && d.subjects.length) {
      subjPanel.style.display = 'block';
      subjList.innerHTML = '';
      d.subjects.forEach(function(s){
        var li = document.createElement('li');
        li.textContent = s;
        subjList.appendChild(li);
      });
    } else { subjPanel.style.display = 'none'; }
    if (d.tips && d.tips.length) {
      tipsPanel.style.display = 'block';
      tipsList.innerHTML = '';
      d.tips.forEach(function(t){
        var li = document.createElement('li');
        li.textContent = t;
        tipsList.appendChild(li);
      });
    } else { tipsPanel.style.display = 'none'; }
    tabsEl.innerHTML = '';
    letters.forEach(function(l, i){
      var tab = document.createElement('button');
      tab.className = 'tab' + (i === 0 ? ' active' : '');
      tab.textContent = 'Letter ' + (i + 1) + ' · ' + (Math.round(Number(l.score) || 0));
      tab.addEventListener('click', function(){
        showLetter(i);
      });
      tabsEl.appendChild(tab);
    });
    showLetter(0);
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showLetter(i) {
    curIdx = i;
    var l = letters[i];
    if (!l) return;
    document.querySelectorAll('#tabs .tab').forEach(function(t, ti){
      t.classList.toggle('active', ti === i);
    });
    letterTag.textContent = 'Letter ' + (i + 1);
    var sc = Math.round(Number(l.score) || 0);
    bestScore.textContent = sc;
    bestNote.textContent = l.note || '';
    var clean = String(l.body || '').replace(/«VERIFY»/g, '').replace(/«\/VERIFY»/g, '');
    var w = clean.split(/\s+/).filter(Boolean).length;
    // length badge: unified with the deterministic length dimension (150-300 ok)
    letterTag.classList.remove('short', 'long');
    if (w < 150) letterTag.classList.add('short');
    if (w > 300) letterTag.classList.add('long');
    wordCount.textContent = w + ' words';
    letterBody.innerHTML = renderBodyHtml(l.body || '');
    letterNote.textContent = l.note || '';
    if (l.verify_items && l.verify_items.length) {
      verifyWrap(l.verify_items);
    } else {
      var old = document.querySelector('.verify-wrap');
      if (old) old.remove();
    }
    if (l.breakdown) {
      scoreBreak(l.breakdown, sc);
    } else {
      var oldB = document.querySelector('.breakdown');
      if (oldB) oldB.remove();
    }
  }

  function renderBodyHtml(body) {
    var s = String(body || '');
    var out = '';
    var paras = s.split(/\n\s*\n/);
    for (var pi = 0; pi < paras.length; pi++) {
      var p = escapeHtml(paras[pi]);
      p = p.replace(/«VERIFY»([\s\S]*?)«\/VERIFY»/g, function(m, inner){
        var t = inner.trim();
        return '<mark class="vchip" data-s="' + t + '">' + t + '</mark>';
      });
      p = p.replace(/\n/g, '<br>');
      out += '<p>' + p + '</p>';
    }
    return out;
  }

  function verifyWrap(items) {
    var old = document.querySelector('.verify-wrap');
    if (old) old.remove();
    var wrap = document.createElement('div');
    wrap.className = 'verify-wrap';
    var title = document.createElement('div');
    title.className = 'verify-title';
    title.textContent = 'Verify before sending';
    wrap.appendChild(title);
    items.forEach(function(v){
      var box = document.createElement('div');
      box.className = 'verify-item';
      var s = document.createElement('div');
      s.className = 'verify-s';
      s.textContent = v.sentence || '';
      var h = document.createElement('div');
      h.className = 'verify-h';
      h.textContent = v.hint || '';
      var f = document.createElement('div');
      f.className = 'verify-f';
      f.textContent = v.fallback || '';
      box.appendChild(s);
      box.appendChild(h);
      box.appendChild(f);
      wrap.appendChild(box);
    });
    letterBody.parentNode.insertBefore(wrap, letterBody.nextSibling);
  }

  function scoreBreak(bd, overall) {
    var old = document.querySelector('.breakdown');
    if (old) old.remove();
    var wrap = document.createElement('div');
    wrap.className = 'breakdown';
    var title = document.createElement('div');
    title.className = 'breakdown-title';
    title.textContent = 'Score breakdown';
    wrap.appendChild(title);
    ['job_match', 'ats', 'persuasion', 'length'].forEach(function(k){
      var row = document.createElement('div');
      row.className = 'bd-row';
      var label = document.createElement('span');
      label.className = 'bd-label';
      label.textContent = ({ job_match: 'Job match', ats: 'ATS friendly', persuasion: 'Persuasion', length: 'Length' })[k];
      var bar = document.createElement('div');
      bar.className = 'bd-bar';
      var fill = document.createElement('div');
      fill.className = 'bd-fill';
      var v = Math.round(Number(bd[k]) || 0);
      fill.style.width = v + '%';
      bar.appendChild(fill);
      var val = document.createElement('span');
      val.className = 'bd-val';
      val.textContent = v;
      row.appendChild(label);
      row.appendChild(bar);
      row.appendChild(val);
      wrap.appendChild(row);
    });
    letterBody.parentNode.insertBefore(wrap, letterBody.nextSibling);
  }

  // ---- copy + download ----
  function copyText(t) {
    // execCommand must run synchronously inside the user gesture; try it first.
    // It is not affected by Permissions-Policy (clipboard-write), which Zibby's
    // embedded page blocks for navigator.clipboard.
    var ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (ok) {
      toast('Copied!');
      return Promise.resolve();
    }
    // Async fallback: clipboard API may be blocked by the embedding page policy.
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(t).then(function(){ toast('Copied!'); }, function(){
        toast('Copy blocked by this page — select the text and press Ctrl+C');
        return Promise.reject(new Error('copy failed'));
      });
    }
    toast('Copy blocked by this page — select the text and press Ctrl+C');
    return Promise.reject(new Error('copy failed'));
  }

  document.addEventListener('click', function(e){
    var v = e.target.closest('.vchip');
    if (v) {
      var s = v.getAttribute('data-s') || '';
      copyText(s).catch(function(){});
      return;
    }
    var copy = e.target.closest('[data-copy]');
    if (copy) {
      copyText(copy.getAttribute('data-copy') || '').catch(function(){});
    }
  });

  if (window.jsPDFAvailable !== false) {
    try {
      var dlBtn = document.getElementById('dlPdf');
      if (dlBtn) {
        dlBtn.addEventListener('click', function(){
          var l = letters[curIdx];
          if (!l) return;
          downloadPdf(l);
        });
      }
    } catch (e) { /* noop */ }
  }

  function downloadPdf(l) {
    if (!window.jspdf) {
      toast('PDF engine not loaded — copying instead');
      copyText(String(l.body || '').replace(/«VERIFY»/g, '').replace(/«\/VERIFY»/g, '')).catch(function(){});
      return;
    }
    try {
      var doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
      var margin = 48;
      var w = doc.internal.pageSize.getWidth();
      var maxW = w - margin * 2;
      var y = margin + 10;
      var lines = doc.splitTextToSize(String(l.body || '').replace(/«VERIFY»/g, '').replace(/«\/VERIFY»/g, ''), maxW);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(30);
      for (var i = 0; i < lines.length; i++) {
        if (y > doc.internal.pageSize.getHeight() - margin) {
          doc.addPage();
          y = margin + 10;
        }
        doc.text(lines[i], margin, y);
        y += 15;
      }
      doc.save('cover-letter.pdf');
      setTimeout(function(){ toast('PDF download started — check your downloads bar'); }, 80);
    } catch (e) {
      toast('PDF blocked in this embedded view — tap Full Screen (top-right) and try again');
    }
  }

  // ==================== diagnose rendering ====================
  function renderDiagnosis(d, plan) {
    diagResults.style.display = 'block';
    dScoreBox.textContent = Math.round(Number(d.score) || 0);
    dScoreBox.className = 'score-ring' + (d.score >= 75 ? ' good' : (d.score >= 55 ? ' mid' : ' bad'));
    dParas.innerHTML = '';
    (d.paragraphs || []).forEach(function(p){
      var box = document.createElement('div');
      box.className = 'diag-para';
      var head = document.createElement('div');
      head.className = 'diag-para-head';
      head.textContent = 'Paragraph ' + p.p + (p.diagnosis ? ' — ' + p.diagnosis : '');
      box.appendChild(head);
      if (p.fix) {
        var fx = document.createElement('div');
        fx.className = 'diag-fix';
        fx.textContent = 'Fix: ' + p.fix;
        box.appendChild(fx);
      }
      if (p.sentences && p.sentences.length) {
        var sl = document.createElement('div');
        sl.className = 'sent-list';
        p.sentences.forEach(function(sn){
          var row = document.createElement('div');
          row.className = 'sent-row sent-' + (sn.tag || 'weak');
          var txt = document.createElement('span');
          txt.className = 'sent-txt';
          txt.textContent = sn.s || '';
          var why = document.createElement('span');
          why.className = 'sent-why';
          why.textContent = sn.why || '';
          row.appendChild(txt);
          row.appendChild(why);
          sl.appendChild(row);
        });
        box.appendChild(sl);
      }
      dParas.appendChild(box);
    });
    if (d.jd_match && d.jd_match.length) {
      dJdPanel.style.display = 'block';
      dJdList.innerHTML = '';
      d.jd_match.forEach(function(j){
        var li = document.createElement('li');
        li.className = 'jd-' + (j.status || 'missing');
        li.textContent = j.req + ' — ' + j.status + (j.how ? ': ' + j.how : '');
        dJdList.appendChild(li);
      });
    } else { dJdPanel.style.display = 'none'; }
    if (d.issues && d.issues.length) {
      dIssuesPanel.style.display = 'block';
      dIssuesList.innerHTML = '';
      d.issues.forEach(function(x){
        var li = document.createElement('li');
        li.textContent = x;
        dIssuesList.appendChild(li);
      });
    } else { dIssuesPanel.style.display = 'none'; }
    if (d.improvements && d.improvements.length) {
      dImpPanel.style.display = 'block';
      dImpList.innerHTML = '';
      d.improvements.forEach(function(x){
        var li = document.createElement('li');
        li.textContent = x;
        dImpList.appendChild(li);
      });
    } else { dImpPanel.style.display = 'none'; }
    dImproved.style.display = 'none';
    diagResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderImproved(d) {
    dImproved.style.display = 'block';
    dImprovedBody.innerHTML = '';
    String(d.improved_letter || '').split(/\n\s*\n/).forEach(function(p){
      var el = document.createElement('p');
      el.textContent = p.trim();
      dImprovedBody.appendChild(el);
    });
  }

  function renderEmail(em) {
    emailBox.style.display = 'block';
    emailBody.textContent = em.body || '';
    var copyBtn = document.createElement('button');
    copyBtn.className = 'mini-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.setAttribute('data-copy', em.body || '');
    emailBox.appendChild(copyBtn);
    emailBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderInterview(questions) {
    interviewBox.style.display = 'block';
    interviewList.innerHTML = '';
    (questions || []).forEach(function(q, i){
      var li = document.createElement('li');
      li.className = 'iv-item';
      var qEl = document.createElement('div');
      qEl.className = 'iv-q';
      qEl.textContent = (i + 1) + '. ' + (q.q || '');
      li.appendChild(qEl);
      if (q.why) {
        var wEl = document.createElement('div');
        wEl.className = 'iv-why';
        wEl.textContent = q.why;
        li.appendChild(wEl);
      }
      if (q.points && q.points.length) {
        var ul = document.createElement('ul');
        q.points.forEach(function(pt){
          var pi = document.createElement('li');
          pi.textContent = pt;
          ul.appendChild(pi);
        });
        li.appendChild(ul);
      }
      interviewList.appendChild(li);
    });
    interviewBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // expose for inline buttons
  window.__cc = { renderAll: renderAll, showLetter: showLetter, downloadPdf: downloadPdf };
})();
