# lindy-score

A free tool for estimating how durable a paper is: whether it has stayed in
active use over time, rather than simply accumulating citations.

**Live tool:** https://maxbaril.github.io/lindy-score/

Companion to a manuscript proposing durability as a complement to citation
counts and evidence hierarchies when deciding what learners should read.

## What it does

Paste a DOI and the tool computes three of five durability dimensions from
OpenAlex data. The remaining two require human judgment and are left as
free-text fields.

**Computed**

- **Citation persistence.** Total citations over the last five complete
  calendar years, and whether the annual series is still rising.
- **Citation half-life.** Years from the peak annual citation rate to the first
  sustained decline to half that peak. Computed on a 3-year centered moving
  average, not the raw series, and withheld below a minimum citation volume
  (see Methods) — the least robust of the three, read it as directional.
- **Cross-specialty diffusion.** How widely the citing literature is spread
  across fields. Four measures are reported.

**Human judgment, not computed**

- **Educational reuse.** Whether the paper is assigned or taught.
- **Expert-validated relevance.** Whether current practitioners still consider
  it relevant.

## Methods

### Why half-life is fragile, and how it is guarded

Half-life is the least robust of the three computed dimensions, and the tool
treats it accordingly. Three separate mechanisms address three separate
failure modes.

**Smoothing fixes a bad peak.** Single-year citation peaks are fragile against
indexing artifacts. In the Salter and Harris 1963 series, the year 2000 records
79 citations against 17 in 1999 and 31 in 2001. Half-life is therefore computed
on a 3-year centered moving average, with the unsmoothed result shown alongside.

**A sustained-decline rule fixes a noisy decline test.** The smoothed series
must stay at or below half its smoothed peak for 3 consecutive years before a
half-life is declared, so a transient dip does not trigger it. This is
configurable.

**A volume gate withholds a number when there is too little signal.** Below a
smoothed peak of 10 citations per year, half-life is not reported and the aging
sub-score is dropped from the composite, with the remaining weights
renormalised.

These help but do not fully solve the problem. On simulated flat series (no
real decline) under negative-binomial noise, which is the realistic model for
overdispersed citation counts, the sustained rule lowers the spurious half-life
rate substantially under moderate dispersion but leaves it above 55% under
heavy dispersion (variance = mean + mean^2/2) even at 4 sustained years and high
citation volume. Detection of genuine declines remains 96 to 100% throughout.

The practical conclusion, which the accompanying manuscript states directly, is
that half-life should be read as a directional signal rather than a precise
value, and that citation persistence, a simple sum of recent citations
unaffected by any of this, carries more weight in the durability judgment.

### Age gate

The tool declines to score rather than producing a number it cannot support.
Papers under 10 years old, or whose citation rate has not yet peaked and
declined, return "too recent to judge" instead of a composite.

### Score

Three sub-scores on a 0 to 1 scale, combined as a weighted mean and multiplied
by 100. Weights default to equal and are adjustable.

- Sustained rate: mean annual citations over the last five complete years,
  divided by the smoothed peak, capped at 1.
- Aging: 1.0 if no half-life was reached, otherwise the half-life divided by a
  20-year reference, capped at 1 — or dropped entirely if the volume gate
  applies, in which case the composite is renormalised over the other two.
- Diffusion: effective number of fields divided by a reference of 5, capped
  at 1.

Bands: 70 and above durable, 40 to 69 moderately durable, below 40 faded.

The composite is a provisional heuristic, not a validated instrument. It is
never displayed without its components, the active settings, and the two
judgment dimensions it omits.

### Diffusion measures

Four are computed and displayed: one minus the largest field's share; field
richness; effective number of fields via Shannon entropy; and a
distance-weighted Rao-Stirling diversity anchored on the paper's own subfield.
Rankings between papers are sensitive to which measure is used and to whether
rare fields are excluded, so all four are shown rather than one.

### Field merging

OpenAlex subfield tags are sometimes substantively wrong. Many orthopaedic
papers citing Salter and Harris are tagged Epidemiology. Users can define merge
rules; raw and merged shares are always shown side by side, and merge rules are
recorded in the CSV export.

## Data source

OpenAlex, no account or subscription required.

The annual series is built from citing works grouped by publication year
(`works?filter=cites:{id}&group_by=publication_year`), not from the work
object's `counts_by_year`, which is a pre-computed field capped at roughly the
last decade. Field breakdowns use the same filter grouped by subfield.

The live citing-works count can run slightly above the stored `cited_by_count`
because of an update lag on that field. Both are displayed.

## Limitations

- Two of the five dimensions cannot be automated.
- Half-life is unreliable for papers below roughly 10 to 15 citations per year.
- Subfield tags contain errors, which affects diffusion more than the other
  dimensions.
- Citation counts change continuously. Record an access date when reporting
  results.
- Thresholds and reference constants are provisional and have not been
  validated against expert judgment.

## Citation

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21953675.svg)](https://doi.org/10.5281/zenodo.21953675)

Baril, M. (2026). *lindy-score* (v1.0) [Computer software]. Zenodo.
https://doi.org/10.5281/zenodo.21953675

## License

MIT