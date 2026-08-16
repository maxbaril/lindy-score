'use strict';

/* =====================================================================
   CONFIG — all tunable constants live here. Also exposed as UI controls.
   ===================================================================== */
const CONFIG = {
  // Polite pool: OpenAlex asks for a mailto so slow/heavy users can be
  // reached before being rate-limited, and get routed to faster servers.
  // Replace with your own address if you fork this.
  OPENALEX_MAILTO: 'maximebar@outlook.com',
  OPENALEX_BASE: 'https://api.openalex.org',

  HALF_LIFE_REFERENCE: 20,     // years; aging sub-score = min(halfLife/REF, 1.0)
  MAX_EFFECTIVE_FIELDS: 5,     // divisor for diffusion sub-scores derived from a field count
  AGE_GATE_MIN_YEARS: 10,      // papers younger than this never get a score
  SERIES_START_GAP_WARNING_YEARS: 5, // flag if the earliest citing work is later than pubYear + this

  SMOOTHING_WINDOW_DEFAULT: 3, // years; centered moving average window for peak/half-life. 1 = raw/unsmoothed.
  SUSTAIN_YEARS_DEFAULT: 3,    // consecutive years <= half peak required before half-life is "reached". 1 = old single-year rule.
  VOLUME_GATE_MIN_PEAK: 10,    // below this smoothed peak (citations/yr, active basis), half-life is withheld and
                                // the aging sub-score is dropped from the composite rather than reported on thin signal
  OUTLIER_RATIO_THRESHOLD: 2.5, // flag a year if raw count exceeds this multiple of its immediate neighbours' mean
  OUTLIER_MIN_COUNT: 6,         // a year must exceed this raw count to be eligible for the ratio test at all —
                                 // otherwise old/obscure papers' sparse early tail (e.g. 1 vs 5 citations, a 5x
                                 // "spike" that's meaningless in absolute terms) drowns out real artifacts

  WEIGHTS: { sustained: 1 / 3, aging: 1 / 3, diffusion: 1 / 3 },

  DIFFUSION_DEFAULT_MEASURE: 'effectiveFields', // 'topShare' | 'richness' | 'effectiveFields' | 'raoStirling'

  RARE_FIELD_MIN_WORKS: 3,     // used only when the rare-field threshold toggle is on
  RARE_FIELD_MIN_PCT: 1,       // percent of total citations

  BAND_DURABLE: 70,
  BAND_MODERATE: 40,

  // Fixed field-merge rule, always applied (not user-configurable). Matched by
  // OpenAlex subfield display name rather than id, since the id would mean nothing
  // to a reader. Verified against the Salter & Harris (1963) validation case: raw
  // Epidemiology (~46%) + raw Surgery (~25%) => ~72% merged, matching the manuscript's
  // expected number for "orthopedic surgery" post-merge. Note OpenAlex's actual
  // subfield display name is "Surgery", not "Orthopedic Surgery" - the merge output
  // is deliberately re-labeled to make that reclassification visible, see index.html.
  DEFAULT_MERGE_RULES: [
    { targetLabel: 'Orthopedic Surgery (reclassified)', sourceNames: ['Epidemiology', 'Surgery'] },
  ],

  COLORS: ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00'],
  DASH_PATTERNS: [[], [6, 4], [2, 2], [8, 3, 2, 3], [1, 3]],
  MARKERS: ['circle', 'square', 'triangle', 'diamond', 'cross'],
};

/* =====================================================================
   FETCH LAYER
   ===================================================================== */

class OpenAlexError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'not_found' | 'rate_limited' | 'network' | 'other'
  }
}

function politeParams(params) {
  const p = new URLSearchParams(params);
  p.set('mailto', CONFIG.OPENALEX_MAILTO);
  return p;
}

async function openAlexFetch(path, params) {
  const url = `${CONFIG.OPENALEX_BASE}${path}?${politeParams(params).toString()}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new OpenAlexError('network', 'Could not reach OpenAlex. Check your internet connection and try again.');
  }
  if (res.status === 404) {
    throw new OpenAlexError('not_found', 'Not found in OpenAlex.');
  }
  if (res.status === 429) {
    throw new OpenAlexError('rate_limited', 'OpenAlex is rate-limiting requests right now. Wait a moment and try again.');
  }
  if (!res.ok) {
    throw new OpenAlexError('other', `OpenAlex returned an error (HTTP ${res.status}).`);
  }
  return res.json();
}

function normalizeDoi(input) {
  let d = input.trim();
  d = d.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  d = d.replace(/^doi:/i, '');
  return d;
}

async function fetchWorkByDoi(doiInput) {
  const doi = normalizeDoi(doiInput);
  return openAlexFetch(`/works/doi:${encodeURIComponent(doi)}`, {});
}

/** Title search fallback for pre-DOI works. Returns a disambiguation list. */
async function searchWorksByTitle(title) {
  const data = await openAlexFetch('/works', {
    filter: `title.search:${title}`,
    per_page: '10',
  });
  return data.results;
}

/** Citing-work field breakdown, grouped by primary_topic.subfield.id. */
async function fetchCitingFieldBreakdown(openAlexId) {
  const shortId = openAlexId.split('/').pop();
  const data = await openAlexFetch('/works', {
    filter: `cites:${shortId}`,
    group_by: 'primary_topic.subfield.id',
    per_page: '200', // group_by pages groups, not works; 200 is the max OpenAlex allows per call
  });
  return {
    totalCitingWorks: data.meta.count,
    groupsCount: data.meta.groups_count,
    possiblyTruncated: data.meta.groups_count >= 200, // defensive: no paper realistically has 200+ distinct subfields
    groups: data.group_by.map(g => ({
      subfieldId: g.key.split('/').pop(),
      name: g.key_display_name,
      count: g.count,
    })),
  };
}

/**
 * Annual citation series, built from citing works grouped by their own
 * publication_year — NOT from the work object's `counts_by_year`.
 * `counts_by_year` is a precomputed, periodically-refreshed shortcut capped
 * at roughly the last decade; this query is the same one OpenAlex's own web
 * UI uses for its Year facet, and returns the complete history.
 * group_by pages at up to 200 groups; a citation-year span will never
 * approach that, but we request the max and flag it defensively if it ever did.
 */
async function fetchCitingYearBreakdown(openAlexId) {
  const shortId = openAlexId.split('/').pop();
  const data = await openAlexFetch('/works', {
    filter: `cites:${shortId}`,
    group_by: 'publication_year',
    per_page: '200',
  });
  const series = [];
  let unknownYearCount = 0;
  for (const g of data.group_by) {
    const year = Number(g.key);
    if (g.key === null || g.key === undefined || !Number.isFinite(year)) {
      unknownYearCount += g.count;
    } else {
      series.push({ year, count: g.count });
    }
  }
  series.sort((a, b) => a.year - b.year);
  return {
    totalCitingWorks: data.meta.count, // sum of all groups, including any unknown-year ones
    groupsCount: data.meta.groups_count,
    possiblyTruncated: data.meta.groups_count >= 200,
    series,
    unknownYearCount,
  };
}

/* =====================================================================
   SERIES NORMALIZATION
   The annual series comes from fetchCitingYearBreakdown (see above), which
   is a complete, unbounded history — not the capped work-object shortcut.
   We still check that the series starts reasonably close to the paper's own
   publication year, since a large gap there would indicate an indexing gap
   rather than a genuinely slow-to-be-cited paper.
   ===================================================================== */

function normalizeSeries(work, yearBreakdown, now = new Date()) {
  const currentYear = now.getUTCFullYear();
  const lastCompleteYear = currentYear - 1; // exclude the in-progress calendar year

  const filtered = yearBreakdown.series.filter(c => c.year <= lastCompleteYear);
  const firstYear = yearBreakdown.series.length ? yearBreakdown.series[0].year : null;
  // group_by only returns years with >=1 citing work, so a year with zero citations is
  // simply absent from the raw response. Densify so moving averages, outlier detection,
  // and "first later year" half-life search all see true calendar-adjacent years rather
  // than silently skipping over an implicit zero.
  const series = densifySeries(filtered, firstYear, lastCompleteYear);

  const pubYear = work.publication_year;
  const gapYears = firstYear !== null && pubYear !== null ? firstYear - pubYear : 0;
  const unexpectedStart = gapYears > CONFIG.SERIES_START_GAP_WARNING_YEARS;

  return {
    series,               // [{year, count}], complete years only, ascending, full history, 0-filled
    firstYearInApi: firstYear,
    lastCompleteYear,
    currentYear,
    publicationYear: pubYear,
    unexpectedStart,
    gapYears,
    unknownYearCount: yearBreakdown.unknownYearCount,
    citingWorksTotal: yearBreakdown.totalCitingWorks,   // sum via the cites: filter (this query's source of truth)
    storedCitedByCount: work.cited_by_count,             // the work object's own cached counter
    totalsDiffer: yearBreakdown.totalCitingWorks !== work.cited_by_count,
  };
}

function densifySeries(series, firstYear, lastYear) {
  if (firstYear === null || lastYear === null || firstYear > lastYear) return series.slice();
  const byYear = new Map(series.map(c => [c.year, c.count]));
  const dense = [];
  for (let y = firstYear; y <= lastYear; y++) {
    dense.push({ year: y, count: byYear.get(y) ?? 0 });
  }
  return dense;
}

/**
 * Centered moving average, window in years (1 = no smoothing, returns a copy of the input).
 * At the series edges there are fewer than `window` calendar years available; per the
 * chosen convention, average over whatever's there rather than dropping those years.
 */
function movingAverageSeries(series, window) {
  if (window <= 1) return series.map(c => ({ ...c }));
  const half = Math.floor(window / 2);
  return series.map((c, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(series.length - 1, i + half);
    const slice = series.slice(lo, hi + 1);
    const avg = slice.reduce((s, x) => s + x.count, 0) / slice.length;
    return { year: c.year, count: avg };
  });
}

/**
 * Flags years whose raw count exceeds OUTLIER_RATIO_THRESHOLD times the mean of their
 * immediate calendar-year neighbours — a heuristic for single-year indexing artifacts
 * (e.g. Salter & Harris 1963's year 2000, 79 against neighbours averaging ~24). Runs on
 * the raw (unsmoothed) dense series; edge years are skipped since they only have one
 * neighbour and can't be judged the same way.
 *
 * A year must also clear OUTLIER_MIN_COUNT before the ratio test applies at all. Without
 * this floor, an old or obscure paper's sparse early citation history — where single
 * digits are the norm — throws a wall of spurious "5x spike" flags (1 citation to 5, 1 to
 * 6, etc.) that are meaningless in absolute terms and drown out a real artifact like 2000.
 */
function detectOutliers(series, ratioThreshold, minCount) {
  const outliers = [];
  for (let i = 1; i < series.length - 1; i++) {
    const prev = series[i - 1].count;
    const cur = series[i].count;
    const next = series[i + 1].count;
    if (cur <= minCount) continue;
    const neighboursMean = (prev + next) / 2;
    const ratio = neighboursMean > 0 ? cur / neighboursMean : (cur > 0 ? Infinity : 0);
    if (ratio > ratioThreshold) {
      outliers.push({ year: series[i].year, count: cur, neighboursMean, ratio });
    }
  }
  return outliers;
}

/* =====================================================================
   METRIC 1 — CITATION PERSISTENCE
   Sum of citations over the last five complete calendar years, plus
   whether the series is still rising (most recent complete year is at
   or above the visible-window peak).
   ===================================================================== */

function citationPersistence(norm) {
  const { series, lastCompleteYear } = norm;
  const windowStart = lastCompleteYear - 4;
  const windowYears = series.filter(c => c.year >= windowStart && c.year <= lastCompleteYear);
  const sum = windowYears.reduce((s, c) => s + c.count, 0);

  const peak = peakOf(series);
  const stillRising = peak !== null && peak.year === lastCompleteYear;

  return {
    sum,
    windowStart,
    windowEnd: lastCompleteYear,
    yearsAvailableInWindow: windowYears.length, // < 5 if the series doesn't cover the full window
    stillRising,
  };
}

/** Peak annual count. Ties resolve to the LATEST year (series is ascending),
 *  so a plateau into the most recent year reads as "still at peak," not "declined." */
function peakOf(series) {
  if (!series.length) return null;
  return series.reduce((best, c) => (c.count >= best.count ? c : best), series[0]);
}

/* =====================================================================
   METRIC 2 — CITATION HALF-LIFE
   Years from the peak annual-citation year to the first later year that
   begins a run of `sustainYears` consecutive years all at or below half the
   peak. "Not reached" if no such run occurs within the visible series.

   sustainYears=1 reproduces the original single-year rule exactly: "the
   first later year at or below half the peak." That rule was replaced as
   the default because Monte Carlo simulation under negative-binomial
   citation noise (the overdispersion real citation counts show relative to
   Poisson) found it flags a spurious half-life on a genuinely flat,
   non-declining series 71-89% of the time, essentially regardless of
   citation volume — a single noisy low year, not a real decline, is enough.
   Requiring several consecutive years below the threshold cuts this
   substantially (more under Poisson-like noise than under strong
   overdispersion — see the methodology section for the full comparison)
   while detecting genuine declines just as reliably (>=95% in the same
   simulation, across every condition tested).

   Operates on whichever series is passed in — raw or a moving-average
   smoothed copy (see movingAverageSeries above) — so the caller controls
   the basis. A single unusually high year (an indexing artifact) can
   otherwise register as an inflated "peak" immediately followed by a false
   "decline," which is why smoothing is the default basis for this metric;
   see detectOutliers for the diagnostic that flags such years directly.
   ===================================================================== */

function citationHalfLife(series, lastCompleteYear, sustainYears = 1) {
  const peak = peakOf(series);
  if (!peak) {
    return { peakYear: null, peakValue: null, halfLifeYears: null, reached: false, hasPeakedAndDeclined: false };
  }
  const threshold = peak.count / 2;
  const later = series.filter(c => c.year > peak.year);

  let hit = null;
  for (let i = 0; i + sustainYears <= later.length; i++) {
    const window = later.slice(i, i + sustainYears);
    if (window.every(c => c.count <= threshold)) {
      hit = window[0];
      break;
    }
  }

  const hasPeakedAndDeclined =
    peak.year !== lastCompleteYear &&
    (series.find(c => c.year === lastCompleteYear)?.count ?? Infinity) < peak.count;

  return {
    peakYear: peak.year,
    peakValue: peak.count,
    halfLifeYears: hit ? hit.year - peak.year : null,
    reached: !!hit,
    hasPeakedAndDeclined,
  };
}

/* =====================================================================
   METRIC 3 — CROSS-SPECIALTY DIFFUSION
   ===================================================================== */

/** Apply the fixed merge rules to raw per-subfield citing-work counts. Rules match by
 *  case-insensitive field display name rather than subfield id, since the id would
 *  mean nothing to a reader checking the logic. */
function applyMergeRules(groups, mergeRules) {
  if (!mergeRules || !mergeRules.length) return groups.map(g => ({ ...g }));

  const nameToRule = new Map();
  mergeRules.forEach(rule =>
    rule.sourceNames.forEach(name => nameToRule.set(name.trim().toLowerCase(), rule))
  );

  const merged = [];
  const targetBuckets = new Map(); // targetLabel -> accumulated group

  for (const g of groups) {
    const rule = nameToRule.get(g.name.trim().toLowerCase());
    if (!rule) {
      merged.push({ ...g });
      continue;
    }
    if (!targetBuckets.has(rule.targetLabel)) {
      const bucket = { subfieldId: `merged:${rule.targetLabel}`, name: rule.targetLabel, count: 0, mergedFrom: [] };
      targetBuckets.set(rule.targetLabel, bucket);
      merged.push(bucket);
    }
    const bucket = targetBuckets.get(rule.targetLabel);
    bucket.count += g.count;
    bucket.mergedFrom.push({ subfieldId: g.subfieldId, name: g.name, count: g.count });
  }
  return merged;
}

/** Optional rare-field noise filter. Returns groups passing the threshold. */
function applyRareFieldThreshold(groups, totalCitingWorks, opts) {
  if (!opts || !opts.enabled) return groups.map(g => ({ ...g }));
  const minWorks = opts.minWorks ?? CONFIG.RARE_FIELD_MIN_WORKS;
  const minPct = opts.minPct ?? CONFIG.RARE_FIELD_MIN_PCT;
  return groups.filter(g => g.count >= minWorks && (100 * g.count) / totalCitingWorks >= minPct);
}

function subfieldDistance(idA, idB) {
  if (idA === idB) return 0;
  const a = SUBFIELD_BY_ID[idA];
  const b = SUBFIELD_BY_ID[idB];
  if (!a || !b) return 1.0; // unknown ids: treat as far
  if (a.fieldId === b.fieldId) return 0.33;
  if (a.domainId === b.domainId) return 0.66;
  return 1.0;
}

/** Distance from a (possibly merged) citing-field group to the paper's home subfield.
 *  A merged bucket has no single OpenAlex id, so its distance is the count-weighted
 *  average of its original constituent subfields' distances — otherwise a merge that
 *  happens to absorb the home subfield itself would read as "maximally far," which
 *  would silently inflate Rao-Stirling for exactly the papers whose dominant field got
 *  relabeled. */
function distanceToHome(group, homeSubfieldId) {
  if (group.mergedFrom) {
    const total = group.mergedFrom.reduce((s, c) => s + c.count, 0);
    if (total === 0) return 1.0;
    return group.mergedFrom.reduce((sum, c) => sum + (c.count / total) * subfieldDistance(c.subfieldId, homeSubfieldId), 0);
  }
  return subfieldDistance(group.subfieldId, homeSubfieldId);
}

/**
 * Compute all four diffusion measures for a given (possibly merged,
 * possibly threshold-filtered) set of citing-field groups.
 *
 * Denominator conventions (a deliberate, documented judgment call):
 *  - `topShare` and the displayed per-field `shareOfTotal` use TOTAL
 *    citations to the work as the denominator, per the manuscript's
 *    definition. These will not sum to 100% when some citing works are
 *    untagged or when total citations != total citing works retrieved.
 *  - `effectiveFields`/`normalizedEffective`/`raoStirling` use shares
 *    renormalized among TAGGED citing works only (sum to 1), because
 *    exp(Shannon entropy) is only meaningful as an "effective count of
 *    categories" over a proper probability distribution. Mixing in the
 *    untagged mass would silently understate diversity for well-tagged
 *    papers and overstate it for poorly-tagged ones.
 */
function diffusionMeasures(groups, totalCitations, homeSubfieldId) {
  const totalTagged = groups.reduce((s, g) => s + g.count, 0);
  const fieldsPresent = groups.filter(g => g.count > 0);
  const S = fieldsPresent.length;

  const ranked = fieldsPresent
    .map(g => ({ ...g, shareOfTotal: totalCitations > 0 ? g.count / totalCitations : 0 }))
    .sort((a, b) => b.count - a.count);

  const topShare = ranked.length ? ranked[0].shareOfTotal : 0;
  const richness = S;

  const taggedShares = fieldsPresent.map(g => g.count / totalTagged);
  const H = -taggedShares.reduce((s, p) => s + (p > 0 ? p * Math.log(p) : 0), 0);
  const effectiveFields = totalTagged > 0 ? Math.exp(H) : 0;
  const normalizedEffective = S > 1 ? H / Math.log(S) : (S === 1 ? 0 : null);

  let raoStirling = null;
  if (homeSubfieldId && totalTagged > 0) {
    raoStirling = fieldsPresent.reduce((sum, g, i) => {
      const p = taggedShares[i];
      return sum + p * distanceToHome(g, homeSubfieldId);
    }, 0);
  }

  return {
    totalTagged,
    totalCitations,
    fieldsPresent: S,
    ranked, // sorted desc by count, includes shareOfTotal
    topShare,
    oneMinusTopShare: 1 - topShare,
    richness,
    shannonEntropy: H,
    effectiveFields,
    normalizedEffective,
    raoStirling,
  };
}

function diffusionSubScore(measures, which, maxEffectiveFields) {
  switch (which) {
    case 'topShare':
      return clamp01(measures.oneMinusTopShare);
    case 'richness':
      return clamp01(measures.richness / maxEffectiveFields);
    case 'effectiveFields':
      return clamp01(measures.effectiveFields / maxEffectiveFields);
    case 'raoStirling':
      return measures.raoStirling === null ? null : clamp01(measures.raoStirling);
    default:
      return null;
  }
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/* =====================================================================
   DURABILITY SCORE
   ===================================================================== */

function sustainedRateSubScore(persistence, halfLife) {
  if (!halfLife.peakValue) return null;
  const meanLast5 = persistence.sum / 5;
  return clamp01(meanLast5 / halfLife.peakValue);
}

function agingSubScore(halfLife, halfLifeReference) {
  if (halfLife.reached === false && halfLife.peakYear !== null) return 1.0;
  if (halfLife.halfLifeYears === null) return null;
  return Math.min(halfLife.halfLifeYears / halfLifeReference, 1.0);
}

function ageGatePasses(norm, halfLife, ageGateMinYears) {
  const age = norm.currentYear - norm.publicationYear;
  if (age < ageGateMinYears) return { passes: false, reason: 'too_young' };
  if (!halfLife.hasPeakedAndDeclined) return { passes: false, reason: 'still_rising' };
  return { passes: true, reason: null };
}

/** Renormalizes over whichever sub-scores are non-null. Aging is the one that
 *  can legitimately be null — dropped by the volume gate when there's too
 *  little citation volume to trust a half-life reading — in which case the
 *  composite is the weighted mean of sustained rate and diffusion alone. */
function compositeScore(subScores, weights) {
  const entries = [
    [subScores.sustained, weights.sustained],
    [subScores.aging, weights.aging],
    [subScores.diffusion, weights.diffusion],
  ].filter(([v]) => v !== null);
  if (!entries.length) return null;
  const wSum = entries.reduce((s, [, w]) => s + w, 0);
  if (wSum <= 0) return null;
  const weighted = entries.reduce((s, [v, w]) => s + v * w, 0);
  return 100 * weighted / wSum;
}

function bandFor(composite) {
  if (composite === null) return null;
  if (composite >= CONFIG.BAND_DURABLE) return 'Durable';
  if (composite >= CONFIG.BAND_MODERATE) return 'Moderately durable';
  return 'Faded';
}

/* =====================================================================
   TOP-LEVEL ANALYSIS PIPELINE
   Ties the above together for one work under one set of settings.
   ===================================================================== */

async function fetchCitingBreakdowns(work) {
  const [fieldBreakdown, yearBreakdown] = await Promise.all([
    fetchCitingFieldBreakdown(work.id),
    fetchCitingYearBreakdown(work.id),
  ]);
  return {
    groups: fieldBreakdown.groups,
    totalCitingWorks: fieldBreakdown.totalCitingWorks,
    yearBreakdown,
  };
}

/** Pure — no network. Re-run freely whenever settings change. */
function computeAnalysis(work, groups, totalCitingWorks, yearBreakdown, settings) {
  const norm = normalizeSeries(work, yearBreakdown);
  const persistence = citationPersistence(norm);

  // Peak/half-life computed on three smoothing bases (raw, 3-year, 5-year), each
  // under the active sustained-decline requirement (settings.sustainYears, default 3
  // consecutive years <= half peak; see citationHalfLife). Raw is kept and always
  // shown alongside — see index.html — because a single indexing-artifact year can
  // otherwise register as an inflated peak immediately followed by a false "decline."
  // The active (smoothingWindow, sustainYears) combination feeds the sustained-rate
  // and aging sub-scores and the age gate; the rest is display-only context.
  const smoothingWindows = [1, 3, 5];
  const activeSustainYears = Number.isInteger(settings.sustainYears) && settings.sustainYears >= 1
    ? settings.sustainYears
    : CONFIG.SUSTAIN_YEARS_DEFAULT;
  const halfLifeByWindow = {};
  for (const w of smoothingWindows) {
    halfLifeByWindow[w] = citationHalfLife(movingAverageSeries(norm.series, w), norm.lastCompleteYear, activeSustainYears);
  }
  const activeSmoothingWindow = smoothingWindows.includes(settings.smoothingWindow) ? settings.smoothingWindow : 1;
  const halfLife = halfLifeByWindow[activeSmoothingWindow];

  // Fixed reference point, independent of the active sustainYears setting: the
  // original single-year rule on the raw series, always available for comparison
  // ("keep displaying the raw single-year result alongside, as now").
  const halfLifeInstantaneousRaw = citationHalfLife(movingAverageSeries(norm.series, 1), norm.lastCompleteYear, 1);

  const outliers = detectOutliers(norm.series, CONFIG.OUTLIER_RATIO_THRESHOLD, CONFIG.OUTLIER_MIN_COUNT);

  const homeSubfieldId = work.primary_topic?.subfield?.id?.split('/').pop() ?? null;

  // norm.citingWorksTotal (sum via the cites: filter) is the denominator for field
  // shares, since it's drawn from the exact same filter=cites:{id} query as the
  // field breakdown itself — internally consistent, even where it differs slightly
  // from the work object's own cached cited_by_count (both are shown on the card).
  const totalForShares = norm.citingWorksTotal;

  const rawFiltered = applyRareFieldThreshold(groups, totalForShares, settings.threshold);
  // The Epidemiology/Surgery -> Orthopedic Surgery correction (CONFIG.DEFAULT_MERGE_RULES) is
  // always applied, not user-toggleable: it's a fixed correction for a known OpenAlex mistagging
  // pattern in this literature, not an experimental option. Raw tags are still always shown
  // alongside so readers can judge the reclassification for themselves.
  const mergedGroups = applyMergeRules(groups, CONFIG.DEFAULT_MERGE_RULES);
  const mergedFiltered = applyRareFieldThreshold(mergedGroups, totalForShares, settings.threshold);

  const diffusionRaw = diffusionMeasures(rawFiltered, totalForShares, homeSubfieldId);
  const diffusionMerged = diffusionMeasures(mergedFiltered, totalForShares, homeSubfieldId);

  const diffusionSub = diffusionSubScore(diffusionMerged, settings.diffusionMeasure, settings.maxEffectiveFields);

  // Volume gate: below this smoothed peak (active basis), there's too little citation
  // volume to trust a half-life reading at all — smoothing and the sustained-decline
  // rule both assume enough signal to average over, and neither fixes a series that's
  // mostly noise to begin with. Half-life is withheld and aging is dropped from the
  // composite (renormalized over sustained rate + diffusion) rather than reported thin.
  const volumeGated = halfLife.peakValue !== null && halfLife.peakValue < CONFIG.VOLUME_GATE_MIN_PEAK;

  const sustainedSub = sustainedRateSubScore(persistence, halfLife);
  const agingSub = volumeGated ? null : agingSubScore(halfLife, settings.halfLifeReference);

  const gate = ageGatePasses(norm, halfLife, settings.ageGateMinYears);

  const subScores = { sustained: sustainedSub, aging: agingSub, diffusion: diffusionSub };
  const composite = gate.passes ? compositeScore(subScores, settings.weights) : null;
  const band = gate.passes ? bandFor(composite) : null;

  return {
    work,
    norm,
    persistence,
    halfLife,             // active basis (settings.smoothingWindow, settings.sustainYears)
    halfLifeByWindow,      // { 1: raw, 3: ..., 5: ... } at the active sustainYears — always all three, for side-by-side display
    halfLifeInstantaneousRaw, // fixed reference: raw series, original single-year rule, regardless of settings
    activeSmoothingWindow,
    activeSustainYears,
    volumeGated,
    outliers,
    homeSubfieldId,
    totalCitingWorks,
    diffusionRaw,
    diffusionMerged,
    activeDiffusionKey: 'merged',
    subScores,
    composite,
    band,
    gate,
  };
}
