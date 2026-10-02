'use strict';

/* =====================================================================
   APPLICATION STATE
   ===================================================================== */

const MAX_PAPERS = 5;

const state = {
  papers: [],       // { uid, doiInput, work, groups, totalCitingWorks, yearBreakdown, error, judgment:{reuse,relevance} }
  nextUid: 1,
  settings: {
    halfLifeReference: CONFIG.HALF_LIFE_REFERENCE,
    maxEffectiveFields: CONFIG.MAX_EFFECTIVE_FIELDS,
    ageGateMinYears: CONFIG.AGE_GATE_MIN_YEARS,
    weights: { ...CONFIG.WEIGHTS },
    diffusionMeasure: CONFIG.DIFFUSION_DEFAULT_MEASURE,
    smoothingWindow: CONFIG.SMOOTHING_WINDOW_DEFAULT, // 1 (raw) | 3 | 5 — basis for peak/half-life/sustained-rate
    sustainYears: CONFIG.SUSTAIN_YEARS_DEFAULT,       // consecutive years <= half peak required to call half-life "reached". 1 = old single-year rule.
    threshold: { enabled: false, minWorks: CONFIG.RARE_FIELD_MIN_WORKS, minPct: CONFIG.RARE_FIELD_MIN_PCT },
  },
  chartXAxisMode: 'calendar', // 'calendar' | 'sincePublication'
};

function $(sel) { return document.querySelector(sel); }
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) e.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach(c => {
    if (c === null || c === undefined) return;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return e;
}

/* =====================================================================
   DOI ROWS
   ===================================================================== */

function addPaperRow(prefill = '') {
  if (state.papers.length >= MAX_PAPERS) return;
  const uid = state.nextUid++;
  state.papers.push({ uid, doiInput: prefill, work: null, groups: null, totalCitingWorks: null, yearBreakdown: null, error: null, judgment: { reuse: '', relevance: '' } });
  renderDoiRows();
}

function removePaperRow(uid) {
  state.papers = state.papers.filter(p => p.uid !== uid);
  renderDoiRows();
  renderAll();
}

function renderDoiRows() {
  const container = $('#doi-rows');
  container.innerHTML = '';
  state.papers.forEach((p, i) => {
    const swatch = el('span', { class: 'swatch', style: `background:${CONFIG.COLORS[i % CONFIG.COLORS.length]}`, 'aria-hidden': 'true' });
    const input = el('input', {
      type: 'text',
      id: `doi-input-${p.uid}`,
      placeholder: 'DOI (e.g. 10.1016/j.arthro.2007.03.092) or paper title',
      value: p.doiInput,
      'aria-label': `Paper ${i + 1}: DOI or title`,
      oninput: e => { p.doiInput = e.target.value; },
    });
    const label = el('label', { for: `doi-input-${p.uid}`, class: 'sr-only', text: `Paper ${i + 1}` });
    const removeBtn = el('button', { type: 'button', 'aria-label': `Remove paper ${i + 1}`, onclick: () => removePaperRow(p.uid), text: '✕' });
    const row = el('div', { class: 'doi-row' }, [swatch, label, input, removeBtn]);
    if (p.error) row.appendChild(el('span', { class: 'status-msg status-error', role: 'alert', text: p.error }));
    container.appendChild(row);
  });
  $('#add-paper-btn').disabled = state.papers.length >= MAX_PAPERS;
}

/* =====================================================================
   FETCH + ANALYZE PIPELINE
   ===================================================================== */

async function resolveWork(doiInput) {
  const looksLikeDoi = /10\.\d{4,9}\/\S+/.test(doiInput);
  if (looksLikeDoi) {
    return await fetchWorkByDoi(doiInput);
  }
  // Title-search fallback for pre-DOI works.
  const results = await searchWorksByTitle(doiInput);
  if (!results.length) throw new OpenAlexError('not_found', `No works found matching "${doiInput}".`);
  if (results.length === 1) return results[0];
  return { disambiguation: results };
}

async function handleAnalyze(e) {
  e.preventDefault();
  const statusEl = $('#status-area');
  statusEl.textContent = 'Fetching from OpenAlex…';
  statusEl.className = 'status-msg status-loading';

  for (const p of state.papers) {
    p.error = null;
    if (!p.doiInput.trim()) continue;
    try {
      const result = await resolveWork(p.doiInput.trim());
      if (result.disambiguation) {
        p.disambiguation = result.disambiguation;
        continue;
      }
      p.disambiguation = null;
      p.work = result;
      const breakdowns = await fetchCitingBreakdowns(result);
      p.groups = breakdowns.groups;
      p.totalCitingWorks = breakdowns.totalCitingWorks;
      p.yearBreakdown = breakdowns.yearBreakdown;
    } catch (err) {
      p.error = err instanceof OpenAlexError ? err.message : `Unexpected error: ${err.message}`;
      p.work = null;
    }
  }

  statusEl.textContent = '';
  renderDoiRows();
  renderDisambiguation();
  renderAll();
}

function renderDisambiguation() {
  const container = $('#disambiguation-area');
  container.innerHTML = '';
  state.papers.forEach(p => {
    if (!p.disambiguation) return;
    const list = el('ul', { class: 'disambig-list' },
      p.disambiguation.map(w => el('li', {}, [
        el('button', {
          type: 'button',
          onclick: async () => {
            p.work = w;
            p.disambiguation = null;
            const breakdowns = await fetchCitingBreakdowns(w);
            p.groups = breakdowns.groups;
            p.totalCitingWorks = breakdowns.totalCitingWorks;
            p.yearBreakdown = breakdowns.yearBreakdown;
            renderDisambiguation();
            renderAll();
          },
          text: `${w.display_name} · ${w.publication_year ?? '?'} · ${w.cited_by_count} citations${w.authorships?.[0]?.author?.display_name ? ' · ' + w.authorships[0].author.display_name + (w.authorships.length > 1 ? ' et al.' : '') : ''}`,
        }),
      ]))
    );
    container.appendChild(el('div', { class: 'warning-box' }, [
      `Multiple matches for "${p.doiInput}". Pick one:`, list,
    ]));
  });
}

/* =====================================================================
   SETTINGS PANEL WIRING
   ===================================================================== */

function readWeightsFromForm() {
  const s = state.settings.weights;
  s.sustained = parseFloat($('#weight-sustained').value) || 0;
  s.aging = parseFloat($('#weight-aging').value) || 0;
  s.diffusion = parseFloat($('#weight-diffusion').value) || 0;
}

function wireSettingsPanel() {
  $('#half-life-reference').value = state.settings.halfLifeReference;
  $('#max-effective-fields').value = state.settings.maxEffectiveFields;
  $('#weight-sustained').value = fmt2(state.settings.weights.sustained);
  $('#weight-aging').value = fmt2(state.settings.weights.aging);
  $('#weight-diffusion').value = fmt2(state.settings.weights.diffusion);
  $(`#diffusion-measure-${state.settings.diffusionMeasure}`).checked = true;
  $(`#smoothing-window-${state.settings.smoothingWindow}`).checked = true;
  $(`#sustain-years-${state.settings.sustainYears}`).checked = true;
  $('#threshold-toggle').checked = state.settings.threshold.enabled;
  $('#threshold-min-works').value = state.settings.threshold.minWorks;
  $('#threshold-min-pct').value = state.settings.threshold.minPct;

  const recalc = () => { renderAll(); };

  $('#half-life-reference').addEventListener('input', e => { state.settings.halfLifeReference = parseFloat(e.target.value) || CONFIG.HALF_LIFE_REFERENCE; recalc(); });
  $('#max-effective-fields').addEventListener('input', e => { state.settings.maxEffectiveFields = parseFloat(e.target.value) || CONFIG.MAX_EFFECTIVE_FIELDS; recalc(); });
  ['sustained', 'aging', 'diffusion'].forEach(k => {
    $(`#weight-${k}`).addEventListener('input', () => { readWeightsFromForm(); recalc(); });
  });
  document.querySelectorAll('input[name=diffusion-measure]').forEach(r => {
    r.addEventListener('change', e => { state.settings.diffusionMeasure = e.target.value; recalc(); });
  });
  document.querySelectorAll('input[name=smoothing-window]').forEach(r => {
    r.addEventListener('change', e => { state.settings.smoothingWindow = parseInt(e.target.value, 10); recalc(); });
  });
  document.querySelectorAll('input[name=sustain-years]').forEach(r => {
    r.addEventListener('change', e => { state.settings.sustainYears = parseInt(e.target.value, 10); recalc(); });
  });
  $('#threshold-toggle').addEventListener('change', e => { state.settings.threshold.enabled = e.target.checked; recalc(); });
  $('#threshold-min-works').addEventListener('input', e => { state.settings.threshold.minWorks = parseFloat(e.target.value) || 0; recalc(); });
  $('#threshold-min-pct').addEventListener('input', e => { state.settings.threshold.minPct = parseFloat(e.target.value) || 0; recalc(); });
}

/* =====================================================================
   RENDER: SCORECARDS
   ===================================================================== */

function analyzedPapers() {
  return state.papers
    .filter(p => p.work && p.groups && p.yearBreakdown)
    .map(p => ({ paper: p, analysis: computeAnalysis(p.work, p.groups, p.totalCitingWorks, p.yearBreakdown, state.settings) }));
}

function fmtPct(x) { return x === null || x === undefined ? '—' : `${(100 * x).toFixed(1)}%`; }
function fmt2(x) { return x === null || x === undefined ? '—' : x.toFixed(2); }
function fmt0(x) { return x === null || x === undefined ? '—' : Math.round(x).toString(); }
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function fmt1(x) { return x === null || x === undefined ? '—' : x.toFixed(1); }

function describeLevel(x, labels) {
  if (x === null || x === undefined) return null;
  if (x >= 0.66) return labels[2];
  if (x >= 0.33) return labels[1];
  return labels[0];
}

/** Turns the three sub-scores into a plain-English sentence for a paper that's too young
 *  to score. Gives a reader something more useful than three bare numbers, without implying
 *  a verdict: no combined number here, just a description of what's happened so far. */
/** Returns a lowercase, comma-joined fragment like "strong sustained citation rate so
 *  far, no decline from its peak yet, narrow spread across fields" — meant to be dropped
 *  into a sentence, not read standalone. */
function buildProvisionalGloss(a) {
  const { subScores, halfLife, volumeGated } = a;
  const sustainedWord = describeLevel(subScores.sustained, ['weak', 'moderate', 'strong']);
  const diffusionWord = describeLevel(subScores.diffusion, ['narrow', 'moderate', 'wide']);
  const agingPhrase = volumeGated
    ? 'too few citations yet to judge aging'
    : halfLife.reached
      ? `already down to half its peak rate, about ${halfLife.halfLifeYears} year${halfLife.halfLifeYears === 1 ? '' : 's'} after peaking`
      : 'no decline from its peak yet';
  const bits = [];
  if (sustainedWord) bits.push(`${sustainedWord} sustained citation rate so far`);
  bits.push(agingPhrase);
  if (diffusionWord) bits.push(`${diffusionWord} spread across fields`);
  return bits.join(', ');
}

function bandClass(band) {
  if (band === 'Durable') return 'band-durable';
  if (band === 'Moderately durable') return 'band-moderate';
  if (band === 'Faded') return 'band-faded';
  return 'band-gated';
}

function renderScorecards(items) {
  const container = $('#scorecards');
  container.innerHTML = '';
  items.forEach(({ paper, analysis }, i) => {
    container.appendChild(buildScorecard(paper, analysis, i));
  });
}

function buildScorecard(paper, a, colorIndex) {
  const { work, norm, persistence, halfLife, subScores, composite, band, gate } = a;
  const color = CONFIG.COLORS[colorIndex % CONFIG.COLORS.length];

  const header = el('div', {}, [
    el('h3', { text: work.display_name }),
    el('div', { class: 'paper-meta', text: `${work.publication_year} · ${norm.citingWorksTotal} citing works found (${norm.firstYearInApi}–${norm.lastCompleteYear}) · ${norm.storedCitedByCount} in OpenAlex's cached total` }),
  ]);

  const warnings = [];
  if (norm.totalsDiffer) {
    const diff = norm.citingWorksTotal - norm.storedCitedByCount;
    warnings.push(`The live count of citing works (${norm.citingWorksTotal}) and OpenAlex's own cached total (${norm.storedCitedByCount}) differ by ${Math.abs(diff)}, with the ${diff > 0 ? 'live count higher' : 'live count lower'}. OpenAlex refreshes these two figures on different schedules, so this is a normal lag rather than an error. Every calculation on this card uses the live count.`);
  }
  if (norm.unexpectedStart) {
    warnings.push(`The earliest citing work found is from ${norm.firstYearInApi}, ${norm.gapYears} years after this paper's ${norm.publicationYear} publication date. That's a wider gap than expected for a genuinely slow-to-be-cited paper, so it's worth checking whether this reflects an indexing gap rather than a real citation pattern.`);
  }
  if (norm.unknownYearCount > 0) {
    warnings.push(`${norm.unknownYearCount} citing work(s) have no recorded publication year in OpenAlex, so they're left out of the annual series and the persistence/half-life calculations. They're still counted in the citing-works total above.`);
  }
  if (persistence.yearsAvailableInWindow < 5) {
    warnings.push(`Only ${persistence.yearsAvailableInWindow} of the last 5 complete years are present in the returned series.`);
  }
  if (a.volumeGated) {
    warnings.push(`Volume gate: the active basis's smoothed peak (${fmt1(a.halfLife.peakValue)}/yr) is below ${CONFIG.VOLUME_GATE_MIN_PEAK}/yr, too little citation volume for smoothing or the sustained-decline rule to fix. Half-life isn't reported, and the aging sub-score is dropped from the composite below and renormalized over sustained rate and diffusion only.`);
  }

  let scoreBlock;
  if (!gate.passes) {
    const reasonText = gate.reason === 'too_young'
      ? `under ${state.settings.ageGateMinYears} years old`
      : `hasn't peaked and declined yet`;

    const provisionalBlock = el('div', { class: 'provisional-callout' }, [
      el('strong', { text: `Provisional read: ${fmt0(a.provisionalComposite)}/100. ` }),
      `${capitalize(buildProvisionalGloss(a))}. This is an early estimate, not a durability verdict, and will likely shift as more citation history comes in.`,
    ]);

    scoreBlock = el('div', {}, [
      el('div', { class: 'composite-row' }, [
        el('span', { class: 'band-badge band-gated', text: 'Too recent to judge' }),
      ]),
      el('p', { class: 'weights-note', text: `No official score: this paper is ${reasonText}.` }),
      provisionalBlock,
    ]);
  } else {
    scoreBlock = el('div', {}, [
      el('div', { class: 'composite-row' }, [
        el('span', { class: 'composite-number', text: fmt0(composite) }),
        el('span', { class: `band-badge ${bandClass(band)}`, text: band }),
      ]),
    ]);
  }

  const subList = el('ul', { class: 'subscore-list' }, [
    el('li', {}, [el('span', { text: 'Sustained rate' }), el('span', { text: fmt2(subScores.sustained) })]),
    el('li', {}, [el('span', { text: 'Aging' }), el('span', { text: a.volumeGated ? 'dropped (volume gate)' : fmt2(subScores.aging) })]),
    el('li', {}, [el('span', { text: `Diffusion (${diffusionMeasureLabel(state.settings.diffusionMeasure)})` }), el('span', { text: fmt2(subScores.diffusion) })]),
  ]);

  const weightsNote = el('p', { class: 'weights-note', text:
    `Weights used: sustained ${fmt2(state.settings.weights.sustained)} · aging ${a.volumeGated ? 'dropped' : fmt2(state.settings.weights.aging)} · diffusion ${fmt2(state.settings.weights.diffusion)}` +
    (a.volumeGated ? ' (renormalized over the remaining two)' : '') + '. ' +
    `Smoothing basis: ${windowLabel(a.activeSmoothingWindow)}, sustain ${a.activeSustainYears}yr. This score is a provisional heuristic, not a validated instrument, and excludes the two human-judgment dimensions below.`
  });

  const metricsBlock = el('div', {}, [
    el('h4', { text: 'Computed metrics' }),
    el('ul', { class: 'subscore-list' }, [
      el('li', {}, [el('span', { text: 'Persistence (last 5 complete yrs)' }), el('span', { text: `${persistence.sum} (${persistence.stillRising ? 'still rising' : 'past peak'})` })]),
    ]),
    buildHalfLifeTable(a),
    buildOutlierNote(a),
  ]);

  const diffusionBlock = buildDiffusionTable(a);
  const judgmentBlock = buildJudgmentFields(paper);

  const card = el('div', { class: 'scorecard', style: `border-left: 4px solid ${color}` }, [
    header,
    ...warnings.map(w => el('div', { class: 'warning-box', text: w })),
    scoreBlock,
    subList,
    weightsNote,
    metricsBlock,
    diffusionBlock,
    judgmentBlock,
  ]);
  return card;
}

function diffusionMeasureLabel(key) {
  return { topShare: '1 − top field share', richness: 'field richness', effectiveFields: 'effective # fields', raoStirling: 'Rao-Stirling distance' }[key] || key;
}

function windowLabel(w) {
  return w === 1 ? 'Raw (unsmoothed)' : `${w}-year moving avg`;
}

function formatHalfLifeCell(hl, lastCompleteYear) {
  if (hl.peakValue !== null && hl.peakValue < CONFIG.VOLUME_GATE_MIN_PEAK) {
    return `not reported (peak < ${CONFIG.VOLUME_GATE_MIN_PEAK}/yr)`;
  }
  if (hl.halfLifeYears !== null) return `${hl.halfLifeYears} yr`;
  if (hl.peakYear === null) return '—';
  return `not reached after ${lastCompleteYear - hl.peakYear} yr`;
}

/** Always shows raw alongside every smoothed basis, and the original single-year
 *  rule alongside the active sustained-decline requirement — never just the
 *  active combination. */
function buildHalfLifeTable(a) {
  const windows = [1, 3, 5];
  const refHl = a.halfLifeInstantaneousRaw;
  const rows = [
    [
      'Raw, single-year rule (reference, always shown)',
      refHl.peakYear !== null ? `${refHl.peakYear} (${fmt1(refHl.peakValue)})` : '—',
      formatHalfLifeCell(refHl, a.norm.lastCompleteYear),
    ],
    ...windows.map(w => {
      const hl = a.halfLifeByWindow[w];
      return [
        `${windowLabel(w)}, sustain ${a.activeSustainYears}yr` + (w === a.activeSmoothingWindow ? ' (active)' : ''),
        hl.peakYear !== null ? `${hl.peakYear} (${fmt1(hl.peakValue)})` : '—',
        formatHalfLifeCell(hl, a.norm.lastCompleteYear),
      ];
    }),
  ];
  const table = el('table', {}, [
    el('caption', { text: `Peak and half-life under each smoothing basis, with the active sustained-decline requirement (${a.activeSustainYears} consecutive year${a.activeSustainYears === 1 ? '' : 's'}). The active row feeds the sustained-rate and aging sub-scores. The reference row is the original single-year rule, always shown regardless of settings.` }),
    el('thead', {}, el('tr', {}, [el('th', { text: 'Basis' }), el('th', { text: 'Peak (yr / value)' }), el('th', { text: 'Half-life' })])),
    el('tbody', {}, rows.map(r => el('tr', {}, r.map((c, i) => el(i === 0 ? 'th' : 'td', { scope: i === 0 ? 'row' : undefined, text: String(c) }))))),
  ]);
  return el('div', { class: 'table-scroll' }, table);
}

function buildOutlierNote(a) {
  if (!a.outliers.length) return el('p', { class: 'weights-note', text: 'No single-year outliers detected (raw count more than 2.5 times the average of its immediate neighbouring years).' });
  const desc = a.outliers.map(o => `${o.year} (${o.count}, vs. neighbours averaging ${fmt1(o.neighboursMean)}, ${o.ratio === Infinity ? '∞' : fmt1(o.ratio)}x)`).join('; ');
  return el('div', { class: 'warning-box', text: `Possible indexing artifact: ${desc}. The raw peak and half-life above may be distorted by this. The smoothed bases are less sensitive to it.` });
}

function buildDiffusionTable(a) {
  const raw = a.diffusionRaw;
  const merged = a.diffusionMerged;
  const rows = [
    ['1 − top field share', fmt2(raw.oneMinusTopShare), fmt2(merged.oneMinusTopShare)],
    ['Field richness (S)', raw.richness, merged.richness],
    ['Effective # fields (exp H)', fmt2(raw.effectiveFields), fmt2(merged.effectiveFields)],
    ['Normalized (H / ln S)', fmt2(raw.normalizedEffective), fmt2(merged.normalizedEffective)],
    ['Rao-Stirling (home-anchored)', fmt2(raw.raoStirling), fmt2(merged.raoStirling)],
  ];
  const table = el('table', {}, [
    el('caption', { text: `Diffusion measures, raw tags vs. merged. Active for scoring: ${a.activeDiffusionKey}.` }),
    el('thead', {}, el('tr', {}, [el('th', { text: 'Measure' }), el('th', { text: 'Raw' }), el('th', { text: 'Merged' })])),
    el('tbody', {}, rows.map(r => el('tr', {}, r.map((c, i) => el(i === 0 ? 'th' : 'td', { scope: i === 0 ? 'row' : undefined, text: String(c) }))))),
  ]);

  const topFieldsRaw = topFieldsList(raw);
  const topFieldsMerged = topFieldsList(merged);

  return el('div', {}, [
    el('h4', { text: 'Cross-specialty diffusion' }),
    el('div', { class: 'table-scroll' }, table),
    el('p', { class: 'weights-note', text: 'Field shares below are percentages of total citations to this work, not of tagged citing works, so they will not add up to 100%.' }),
    el('div', { class: 'table-scroll' }, [el('strong', { text: 'Raw tag shares (top 5): ' }), el('span', { text: topFieldsRaw })]),
    el('div', { class: 'table-scroll' }, [el('strong', { text: 'Merged shares (top 5): ' }), el('span', { text: topFieldsMerged })]),
  ]);
}

function topFieldsList(measures) {
  return measures.ranked.slice(0, 5).map(g => `${g.name} ${fmtPct(g.shareOfTotal)}`).join(', ') || '—';
}

function buildJudgmentFields(paper) {
  const reuseId = `judgment-reuse-${paper.uid}`;
  const relevanceId = `judgment-relevance-${paper.uid}`;
  return el('div', { class: 'judgment-fields' }, [
    el('h4', { text: 'Human judgment (not computed, excluded from composite)' }),
    el('label', { for: reuseId, text: 'Educational reuse (e.g. cited in textbooks, guidelines, training curricula)' }),
    el('textarea', { id: reuseId, oninput: e => { paper.judgment.reuse = e.target.value; } }, paper.judgment.reuse),
    el('label', { for: relevanceId, text: 'Expert-validated relevance (e.g. still cited as current best practice by specialists)' }),
    el('textarea', { id: relevanceId, oninput: e => { paper.judgment.relevance = e.target.value; } }, paper.judgment.relevance),
  ]);
}

/* =====================================================================
   RENDER: COMPARISON TABLE
   ===================================================================== */

function renderComparisonTable(items) {
  const container = $('#comparison-table-wrap');
  container.innerHTML = '';
  if (items.length < 1) return;

  const cols = ['Paper', 'Year', 'Citing works found', 'OpenAlex cached total', 'Last-5yr sum', 'Still rising?', `Peak (yr/val, ${windowLabel(state.settings.smoothingWindow)})`, `Half-life (sustain ${state.settings.sustainYears}yr)`, 'Composite', 'Band'];
  const table = el('table', {}, [
    el('caption', { text: 'Comparison across loaded papers, under current settings. Peak and half-life use the active smoothing basis and sustained-decline requirement; see each scorecard for the full breakdown.' }),
    el('thead', {}, el('tr', {}, cols.map(c => el('th', { text: c })))),
    el('tbody', {}, items.map(({ paper, analysis: a }, i) => el('tr', {}, [
      el('th', { scope: 'row', text: a.work.display_name.slice(0, 40) + (a.work.display_name.length > 40 ? '…' : '') }),
      el('td', { text: a.work.publication_year }),
      el('td', { text: a.norm.citingWorksTotal }),
      el('td', { text: a.norm.storedCitedByCount }),
      el('td', { text: a.persistence.sum }),
      el('td', { text: a.persistence.stillRising ? 'Yes' : 'No' }),
      el('td', { text: a.halfLife.peakYear ? `${a.halfLife.peakYear} / ${fmt1(a.halfLife.peakValue)}` : '—' }),
      el('td', { text: formatHalfLifeCell(a.halfLife, a.norm.lastCompleteYear) }),
      el('td', { text: a.gate.passes ? fmt0(a.composite) : '—' }),
      el('td', { text: a.gate.passes ? a.band : 'Too recent' }),
    ]))),
  ]);
  container.appendChild(el('div', { class: 'table-scroll' }, table));
}

/* =====================================================================
   RENDER: CHART (canvas, no external library)
   ===================================================================== */

function renderChart(items) {
  const canvas = $('#chart-canvas');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 800;
  const cssH = canvas.clientHeight || 380;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const axisColor = isDark ? '#a8b3ba' : '#52626b';
  const textColor = isDark ? '#e9edef' : '#1a2226';

  $('#chart-legend').innerHTML = '';
  if (!items.length) {
    ctx.fillStyle = axisColor;
    ctx.font = '14px sans-serif';
    ctx.fillText('Load at least one paper to see the citations-per-year chart.', 10, 20);
    return;
  }

  const mode = state.chartXAxisMode;
  const series = items.map(({ paper, analysis: a }, i) => {
    const pts = a.norm.series.map(c => ({
      x: mode === 'calendar' ? c.year : c.year - a.work.publication_year,
      y: c.count,
    }));
    return { label: a.work.display_name, color: CONFIG.COLORS[i % CONFIG.COLORS.length], dash: CONFIG.DASH_PATTERNS[i % CONFIG.DASH_PATTERNS.length], marker: CONFIG.MARKERS[i % CONFIG.MARKERS.length], pts };
  });

  const allX = series.flatMap(s => s.pts.map(p => p.x));
  const allY = series.flatMap(s => s.pts.map(p => p.y));
  if (!allX.length) return;
  const xMin = Math.min(...allX), xMax = Math.max(...allX);
  const yMin = 0, yMax = Math.max(1, ...allY);

  const margin = { top: 16, right: 16, bottom: 36, left: 44 };
  const plotW = cssW - margin.left - margin.right;
  const plotH = cssH - margin.top - margin.bottom;

  const xToPx = x => margin.left + (xMax === xMin ? plotW / 2 : ((x - xMin) / (xMax - xMin)) * plotW);
  const yToPx = y => margin.top + plotH - (y / yMax) * plotH;

  // Gridlines + axes
  ctx.strokeStyle = axisColor;
  ctx.fillStyle = textColor;
  ctx.font = '11px sans-serif';
  ctx.lineWidth = 1;
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = yMax * (i / yTicks);
    const py = yToPx(y);
    ctx.globalAlpha = 0.2;
    ctx.beginPath(); ctx.moveTo(margin.left, py); ctx.lineTo(cssW - margin.right, py); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(Math.round(y).toString(), margin.left - 6, py);
  }
  const xTickCount = Math.min(8, Math.max(2, Math.round(xMax - xMin)));
  for (let i = 0; i <= xTickCount; i++) {
    const x = xMin + ((xMax - xMin) * i) / xTickCount;
    const px = xToPx(x);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(Math.round(x).toString(), px, cssH - margin.bottom + 6);
  }
  ctx.textAlign = 'center';
  ctx.fillText(mode === 'calendar' ? 'Calendar year' : 'Years since publication', margin.left + plotW / 2, cssH - 6);

  // Series lines + markers
  series.forEach(s => {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.setLineDash(s.dash);
    ctx.beginPath();
    s.pts.forEach((p, i) => {
      const px = xToPx(p.x), py = yToPx(p.y);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = s.color;
    s.pts.forEach(p => drawMarker(ctx, xToPx(p.x), yToPx(p.y), s.marker));
  });

  // Legend (color + dash + shape, redundant with text — not color-only)
  series.forEach(s => {
    const item = el('div', { class: 'legend-item' }, [
      el('span', { class: 'legend-line', style: `background:${s.color}` }),
      el('span', { text: s.label }),
    ]);
    $('#chart-legend').appendChild(item);
  });
}

function drawMarker(ctx, x, y, shape) {
  const r = 3;
  ctx.beginPath();
  if (shape === 'circle') { ctx.arc(x, y, r, 0, 2 * Math.PI); }
  else if (shape === 'square') { ctx.rect(x - r, y - r, 2 * r, 2 * r); }
  else if (shape === 'triangle') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r); ctx.lineTo(x - r, y + r); ctx.closePath(); }
  else if (shape === 'diamond') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
  else { ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); }
  ctx.fill();
}

/* =====================================================================
   EXPORT: CSV + PNG
   ===================================================================== */

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(items) {
  const lines = [];
  lines.push('# Lindy Durability Scorecard export');
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push(`# Settings: halfLifeReference=${state.settings.halfLifeReference}, maxEffectiveFields=${state.settings.maxEffectiveFields}, ageGateMinYears=${state.settings.ageGateMinYears}`);
  lines.push(`# Weights: sustained=${state.settings.weights.sustained}, aging=${state.settings.weights.aging}, diffusion=${state.settings.weights.diffusion}`);
  lines.push(`# Diffusion measure used for composite: ${state.settings.diffusionMeasure}`);
  lines.push(`# Smoothing basis used for peak/half-life/sustained-rate: ${state.settings.smoothingWindow}-year (1 = raw/unsmoothed); outlier flag threshold: ${CONFIG.OUTLIER_RATIO_THRESHOLD}x neighbour mean, minimum ${CONFIG.OUTLIER_MIN_COUNT} raw citations to be eligible`);
  lines.push(`# Sustained-decline requirement: half-life reached only after ${state.settings.sustainYears} consecutive year(s) <= half peak (1 = original single-year rule)`);
  lines.push(`# Volume gate: below smoothed peak ${CONFIG.VOLUME_GATE_MIN_PEAK}/yr (active basis), half-life withheld and aging sub-score dropped from composite (renormalized)`);
  lines.push(`# Field merge (fixed, always applied): ${JSON.stringify(CONFIG.DEFAULT_MERGE_RULES)}`);
  lines.push(`# Rare-field threshold: enabled=${state.settings.threshold.enabled}, minWorks=${state.settings.threshold.minWorks}, minPct=${state.settings.threshold.minPct}`);
  lines.push('');

  lines.push('# Annual series source: works?filter=cites:{id}&group_by=publication_year (full history, not the capped counts_by_year shortcut)');
  lines.push('paper,year,openalex_id,citing_works_total,stored_cited_by_count,unexpected_start,first_year_in_api,unknown_year_count,year_col,citations_col');
  items.forEach(({ analysis: a }) => {
    a.norm.series.forEach(c => {
      lines.push([
        a.work.display_name, a.work.publication_year, a.work.id,
        a.norm.citingWorksTotal, a.norm.storedCitedByCount, a.norm.unexpectedStart,
        a.norm.firstYearInApi, a.norm.unknownYearCount, c.year, c.count,
      ].map(csvEscape).join(','));
    });
  });
  lines.push('');

  lines.push('# provisional_composite is computed the same way as composite but ignores the age gate; it is NOT a durability verdict and has no band, see README/methodology');
  lines.push('paper,persistence_sum_last5,still_rising,active_smoothing_window,active_sustain_years,peak_year,peak_value,volume_gated,half_life_years,half_life_reached,sustained_subscore,aging_subscore,diffusion_subscore,composite,band,provisional_composite,gate_passes,gate_reason');
  items.forEach(({ analysis: a }) => {
    lines.push([
      a.work.display_name, a.persistence.sum, a.persistence.stillRising, a.activeSmoothingWindow, a.activeSustainYears,
      a.halfLife.peakYear, a.halfLife.peakValue, a.volumeGated,
      a.volumeGated ? null : a.halfLife.halfLifeYears, a.volumeGated ? null : a.halfLife.reached,
      a.subScores.sustained, a.subScores.aging, a.subScores.diffusion,
      a.composite, a.band, a.provisionalComposite, a.gate.passes, a.gate.reason,
    ].map(csvEscape).join(','));
  });
  lines.push('');

  lines.push('# Reference: original single-year rule, raw series, always reported regardless of settings');
  lines.push('paper,peak_year,peak_value,half_life_years,half_life_reached');
  items.forEach(({ analysis: a }) => {
    const hl = a.halfLifeInstantaneousRaw;
    lines.push([a.work.display_name, hl.peakYear, hl.peakValue, hl.halfLifeYears, hl.reached].map(csvEscape).join(','));
  });
  lines.push('');

  lines.push('# Peak/half-life under every smoothing basis, at the active sustain_years above (not just the active smoothing basis)');
  lines.push('paper,smoothing_window,sustain_years,peak_year,peak_value,half_life_years,half_life_reached');
  items.forEach(({ analysis: a }) => {
    [1, 3, 5].forEach(w => {
      const hl = a.halfLifeByWindow[w];
      lines.push([a.work.display_name, w, a.activeSustainYears, hl.peakYear, hl.peakValue, hl.halfLifeYears, hl.reached].map(csvEscape).join(','));
    });
  });
  lines.push('');

  lines.push('# Years flagged as possible indexing artifacts: raw count > 2.5x the mean of the two immediate neighbouring years');
  lines.push('paper,outlier_year,raw_count,neighbours_mean,ratio');
  items.forEach(({ analysis: a }) => {
    a.outliers.forEach(o => lines.push([a.work.display_name, o.year, o.count, o.neighboursMean, o.ratio].map(csvEscape).join(',')));
  });
  lines.push('');

  lines.push('paper,view,field,citing_count,share_of_total_citations');
  items.forEach(({ analysis: a }) => {
    a.diffusionRaw.ranked.forEach(g => lines.push([a.work.display_name, 'raw', g.name, g.count, g.shareOfTotal].map(csvEscape).join(',')));
    a.diffusionMerged.ranked.forEach(g => lines.push([a.work.display_name, 'merged', g.name, g.count, g.shareOfTotal].map(csvEscape).join(',')));
  });
  lines.push('');

  lines.push('paper,view,one_minus_top_share,field_richness,effective_fields,normalized_effective,rao_stirling');
  items.forEach(({ analysis: a }) => {
    const r = a.diffusionRaw, m = a.diffusionMerged;
    lines.push([a.work.display_name, 'raw', r.oneMinusTopShare, r.richness, r.effectiveFields, r.normalizedEffective, r.raoStirling].map(csvEscape).join(','));
    lines.push([a.work.display_name, 'merged', m.oneMinusTopShare, m.richness, m.effectiveFields, m.normalizedEffective, m.raoStirling].map(csvEscape).join(','));
  });
  lines.push('');

  lines.push('paper,educational_reuse_note,expert_validated_relevance_note');
  items.forEach(({ paper, analysis: a }) => {
    lines.push([a.work.display_name, paper.judgment.reuse, paper.judgment.relevance].map(csvEscape).join(','));
  });

  return lines.join('\n');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function handleExportCsv() {
  const items = analyzedPapers();
  if (!items.length) return;
  const csv = buildCsv(items);
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'lindy-durability-scorecard.csv');
}

function handleExportPng() {
  const canvas = $('#chart-canvas');
  canvas.toBlob(blob => downloadBlob(blob, 'lindy-citations-chart.png'));
}

/* =====================================================================
   MAIN RENDER
   ===================================================================== */

function renderAll() {
  const items = analyzedPapers();
  renderScorecards(items);
  renderComparisonTable(items);
  renderChart(items);
  const hasData = items.length > 0;
  $('#export-csv-btn').disabled = !hasData;
  $('#export-png-btn').disabled = !hasData;
}

/* =====================================================================
   INIT
   ===================================================================== */

function init() {
  addPaperRow('10.1016/j.arthro.2007.03.092');
  $('#add-paper-btn').addEventListener('click', () => addPaperRow(''));
  $('#paper-form').addEventListener('submit', handleAnalyze);
  document.querySelectorAll('input[name=chart-xaxis]').forEach(r => {
    r.addEventListener('change', e => { state.chartXAxisMode = e.target.value; renderAll(); });
  });
  $('#export-csv-btn').addEventListener('click', handleExportCsv);
  $('#export-png-btn').addEventListener('click', handleExportPng);
  wireSettingsPanel();
  renderAll();
  window.addEventListener('resize', () => renderChart(analyzedPapers()));
}

document.addEventListener('DOMContentLoaded', init);
