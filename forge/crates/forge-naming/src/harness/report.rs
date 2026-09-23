//! Aggregates and the Markdown report of a harness run.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use super::mutate::Family;
use super::{Outcome, RefRecord, Report};

/// Counts of outcomes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tally {
    /// All references.
    pub total: usize,
    /// [`Outcome::Correct`].
    pub correct: usize,
    /// [`Outcome::FlaggedCorrectly`].
    pub flagged_correctly: usize,
    /// [`Outcome::SilentWrong`].
    pub silent_wrong: usize,
    /// [`Outcome::WrongButFlagged`].
    pub wrong_but_flagged: usize,
    /// [`Outcome::Excluded`].
    pub excluded: usize,
}

impl Tally {
    /// Count one outcome.
    pub fn add(&mut self, o: Outcome) {
        self.total += 1;
        match o {
            Outcome::Correct => self.correct += 1,
            Outcome::FlaggedCorrectly => self.flagged_correctly += 1,
            Outcome::SilentWrong => self.silent_wrong += 1,
            Outcome::WrongButFlagged => self.wrong_but_flagged += 1,
            Outcome::Excluded => self.excluded += 1,
        }
    }
    /// Scored references (not excluded).
    pub fn scored(&self) -> usize {
        self.total - self.excluded
    }
    /// `(CORRECT + FLAGGED_CORRECTLY) / scored`: the spike's "correct" rate.
    pub fn correct_rate(&self) -> f64 {
        ratio(self.correct + self.flagged_correctly, self.scored())
    }
    /// `CORRECT / scored`: resolved exactly, with no user attention needed.
    pub fn exact_rate(&self) -> f64 {
        ratio(self.correct, self.scored())
    }
    /// Of the references whose name did not simply resolve correctly, the fraction that
    /// were flagged: `(FLAGGED_CORRECTLY + WRONG_BUT_FLAGGED) / (scored − CORRECT)`.
    pub fn fallbacks_flagged_rate(&self) -> f64 {
        ratio(
            self.flagged_correctly + self.wrong_but_flagged,
            self.scored() - self.correct,
        )
    }
}

fn ratio(a: usize, b: usize) -> f64 {
    if b == 0 { 1.0 } else { a as f64 / b as f64 }
}

fn pct(x: f64) -> String {
    format!("{:.2} %", 100.0 * x)
}

/// The role class of a stored name, for the per-role table: `face cap`, `face side`,
/// `edge side|side`, `edge cap|side`, … with ` #k` when the name carries an index.
pub fn role_class(name: &str) -> String {
    let role = |n: &str| -> &'static str {
        let r = n.split_once('/').map_or(n, |(_, r)| r);
        if r.starts_with("cap:") {
            "cap"
        } else if r.starts_with("endcap:") {
            "endcap"
        } else if r.starts_with("side") {
            "side"
        } else {
            "other"
        }
    };
    let indexed = if name
        .rsplit_once('#')
        .is_some_and(|(_, k)| k.chars().all(|c| c.is_ascii_digit()))
    {
        " #k"
    } else {
        ""
    };
    match name.split_once("/edge:{") {
        Some((_, rest)) => {
            let inner = rest.rsplit_once('}').map_or(rest, |(a, _)| a);
            let mut parts: Vec<&str> = inner.split('|').map(role).collect();
            parts.sort_unstable();
            format!("edge {}{indexed}", parts.join("|"))
        }
        None => format!("face {}{indexed}", role(name)),
    }
}

/// Tally references grouped by `key`.
pub fn tally_by<K: Ord>(refs: &[RefRecord], key: impl Fn(&RefRecord) -> K) -> BTreeMap<K, Tally> {
    let mut m: BTreeMap<K, Tally> = BTreeMap::new();
    for r in refs {
        m.entry(key(r)).or_default().add(r.outcome);
    }
    m
}

/// The spike's go/no-go numbers.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Criteria {
    /// Correct rate on (a) dimension edits.
    pub dimension: f64,
    /// Correct rate on (b) suppress edits.
    pub suppress: f64,
    /// Correct rate on (c) topology edits.
    pub topology: f64,
    /// Fraction of fallbacks flagged (all families).
    pub fallbacks_flagged: f64,
    /// Silent-wrong references (all families).
    pub silent_wrong: usize,
    /// Scored references.
    pub scored: usize,
}

impl Criteria {
    /// ≥ 97 % on (a) and on (b), ≥ 90 % on (c), 100 % of fallbacks flagged.
    pub fn go(&self) -> bool {
        self.dimension >= 0.97
            && self.suppress >= 0.97
            && self.topology >= 0.90
            && self.silent_wrong == 0
    }
}

/// Compute the criteria of a run.
pub fn criteria(rep: &Report) -> Criteria {
    let fam = tally_by(&rep.refs, |r| r.family);
    let all = tally_by(&rep.refs, |_| ());
    let t = |f: Family| fam.get(&f).copied().unwrap_or_default();
    let a = all.get(&()).copied().unwrap_or_default();
    Criteria {
        dimension: t(Family::Dimension).correct_rate(),
        suppress: t(Family::Suppress).correct_rate(),
        topology: t(Family::Topology).correct_rate(),
        fallbacks_flagged: a.fallbacks_flagged_rate(),
        silent_wrong: a.silent_wrong,
        scored: a.scored(),
    }
}

fn tally_header(out: &mut String, first: &str) {
    let _ = writeln!(
        out,
        "| {first} | Refs | CORRECT | FLAGGED_CORRECTLY | WRONG_BUT_FLAGGED | SILENT_WRONG | Excluded | Correct | Exact | Fallbacks flagged |"
    );
    let _ = writeln!(out, "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
}

fn tally_row(out: &mut String, first: &str, t: &Tally) {
    let _ = writeln!(
        out,
        "| {first} | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
        t.total,
        t.correct,
        t.flagged_correctly,
        t.wrong_but_flagged,
        t.silent_wrong,
        t.excluded,
        pct(t.correct_rate()),
        pct(t.exact_rate()),
        pct(t.fallbacks_flagged_rate()),
    );
}

/// Render the run as Markdown.
pub fn render(rep: &Report) -> String {
    let mut out = String::new();
    let c = criteria(rep);
    let n_mut = rep.mutations.len();
    let fam_mut = {
        let mut m: BTreeMap<Family, usize> = BTreeMap::new();
        for x in &rep.mutations {
            *m.entry(x.family).or_default() += 1;
        }
        m
    };
    let _ = writeln!(out, "# Naming harness report\n");
    let _ = writeln!(
        out,
        "{} models, {} accepted mutations ({} rejected), {} references scored ({} excluded).\n",
        rep.sanity.len(),
        n_mut,
        rep.skipped.len(),
        c.scored,
        rep.refs.len() - c.scored
    );

    let _ = writeln!(out, "## Criteria\n");
    let _ = writeln!(out, "| Criterion | Target | Measured | Pass |");
    let _ = writeln!(out, "|---|---|---|---|");
    let yn = |b: bool| if b { "yes" } else { "**no**" };
    let _ = writeln!(
        out,
        "| Correct on (a) dimension edits | ≥ 97 % | {} | {} |",
        pct(c.dimension),
        yn(c.dimension >= 0.97)
    );
    let _ = writeln!(
        out,
        "| Correct on (b) suppress edits | ≥ 97 % | {} | {} |",
        pct(c.suppress),
        yn(c.suppress >= 0.97)
    );
    let _ = writeln!(
        out,
        "| Correct on (c) topology-changing edits | ≥ 90 % | {} | {} |",
        pct(c.topology),
        yn(c.topology >= 0.90)
    );
    let _ = writeln!(
        out,
        "| Fallbacks flagged (SILENT_WRONG = 0) | 100 % | {} ({} silent-wrong) | {} |",
        pct(c.fallbacks_flagged),
        c.silent_wrong,
        yn(c.silent_wrong == 0)
    );
    let _ = writeln!(
        out,
        "\n**Verdict: {}**\n",
        if c.go() { "GO" } else { "NO-GO" }
    );

    let _ = writeln!(out, "## Per family\n");
    tally_header(&mut out, "Family (mutations)");
    for (f, t) in tally_by(&rep.refs, |r| r.family) {
        tally_row(
            &mut out,
            &format!("{} ({})", f.as_str(), fam_mut.get(&f).copied().unwrap_or(0)),
            &t,
        );
    }
    if let Some(t) = tally_by(&rep.refs, |_| ()).get(&()) {
        tally_row(&mut out, &format!("**all** ({n_mut})"), t);
    }

    let _ = writeln!(out, "\n## Names-only baseline\n");
    let _ = writeln!(
        out,
        "Exact provenance lookup (narrowed by region), no fingerprint validation, no fallback: how far raw names go.\n"
    );
    let base: Vec<RefRecord> = rep
        .refs
        .iter()
        .map(|r| RefRecord {
            outcome: r.baseline,
            ..r.clone()
        })
        .collect();
    tally_header(&mut out, "Family");
    for (f, t) in tally_by(&base, |r| r.family) {
        tally_row(&mut out, f.as_str(), &t);
    }
    if let Some(t) = tally_by(&base, |_| ()).get(&()) {
        tally_row(&mut out, "**all**", t);
    }
    let _ = writeln!(
        out,
        "\nBaseline SILENT_WRONG by mutation kind (all prevented by the resolver's validation layer unless listed above):\n"
    );
    let _ = writeln!(
        out,
        "| Kind | Baseline SILENT_WRONG | Resolver SILENT_WRONG |"
    );
    let _ = writeln!(out, "|---|---:|---:|");
    let bk = tally_by(&base, |r| r.kind);
    let rk = tally_by(&rep.refs, |r| r.kind);
    for (k, t) in &bk {
        if t.silent_wrong > 0 {
            let _ = writeln!(
                out,
                "| `{k}` | {} | {} |",
                t.silent_wrong,
                rk.get(k).map_or(0, |x| x.silent_wrong)
            );
        }
    }

    let _ = writeln!(out, "\n## Per stored-name role\n");
    let _ = writeln!(
        out,
        "| Role | Refs | CORRECT | FLAGGED_CORRECTLY | WRONG_BUT_FLAGGED | SILENT_WRONG | Exact | Names-only SILENT_WRONG |"
    );
    let _ = writeln!(out, "|---|---:|---:|---:|---:|---:|---:|---:|");
    let base_roles = tally_by(&base, |r| role_class(&r.name));
    for (k, t) in tally_by(&rep.refs, |r| role_class(&r.name)) {
        let _ = writeln!(
            out,
            "| {k} | {} | {} | {} | {} | {} | {} | {} |",
            t.total,
            t.correct,
            t.flagged_correctly,
            t.wrong_but_flagged,
            t.silent_wrong,
            pct(t.exact_rate()),
            base_roles.get(&k).map_or(0, |b| b.silent_wrong)
        );
    }

    let _ = writeln!(out, "\n## Per mutation kind\n");
    let mut kind_mut: BTreeMap<(Family, &str), usize> = BTreeMap::new();
    for m in &rep.mutations {
        *kind_mut.entry((m.family, m.kind)).or_default() += 1;
    }
    tally_header(&mut out, "Kind (mutations)");
    for ((f, k), t) in tally_by(&rep.refs, |r| (r.family, r.kind)) {
        tally_row(
            &mut out,
            &format!(
                "{} `{k}` ({})",
                &f.as_str()[..3],
                kind_mut.get(&(f, k)).copied().unwrap_or(0)
            ),
            &t,
        );
    }

    let _ = writeln!(out, "\n## Per model\n");
    let _ = writeln!(
        out,
        "| Model | Source | Bodies | Entities | GT unlabelled | GT ↔ names agree | Mutations | Refs | Correct | Exact | SILENT_WRONG |"
    );
    let _ = writeln!(
        out,
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
    );
    let per_model = tally_by(&rep.refs, |r| r.model.clone());
    for s in &rep.sanity {
        let t = per_model.get(&s.model).copied().unwrap_or_default();
        let _ = writeln!(
            out,
            "| {} | {} | {} | {} | {} | {}/{} | {} | {} | {} | {} | {} |",
            s.model,
            s.source,
            s.bodies,
            s.entities,
            s.unlabelled,
            s.agree,
            s.entities,
            s.mutations,
            t.total,
            pct(t.correct_rate()),
            pct(t.exact_rate()),
            t.silent_wrong
        );
    }

    let _ = writeln!(out, "\n## Resolution status × reason per family\n");
    let _ = writeln!(
        out,
        "| Family | Status | Reason | Refs | CORRECT | FLAGGED_CORRECTLY | WRONG_BUT_FLAGGED | SILENT_WRONG |"
    );
    let _ = writeln!(out, "|---|---|---|---:|---:|---:|---:|---:|");
    for ((f, s, r), t) in tally_by(&rep.refs, |x| (x.family, x.status, x.reason)) {
        let _ = writeln!(
            out,
            "| {} | {s} | {} | {} | {} | {} | {} | {} |",
            f.as_str(),
            r.as_str(),
            t.total,
            t.correct,
            t.flagged_correctly,
            t.wrong_but_flagged,
            t.silent_wrong
        );
    }

    let _ = writeln!(out, "\n## Ground truth per family\n");
    let _ = writeln!(
        out,
        "| Family | Ground truth | Refs | CORRECT | FLAGGED_CORRECTLY | WRONG_BUT_FLAGGED | SILENT_WRONG |"
    );
    let _ = writeln!(out, "|---|---|---:|---:|---:|---:|---:|");
    for ((f, e), t) in tally_by(&rep.refs, |x| (x.family, x.expected_kind)) {
        let _ = writeln!(
            out,
            "| {} | {e} | {} | {} | {} | {} | {} |",
            f.as_str(),
            t.total,
            t.correct,
            t.flagged_correctly,
            t.wrong_but_flagged,
            t.silent_wrong
        );
    }

    let _ = writeln!(out, "\n## SILENT_WRONG cases\n");
    let silent: Vec<&RefRecord> = rep
        .refs
        .iter()
        .filter(|r| r.outcome == Outcome::SilentWrong)
        .collect();
    if silent.is_empty() {
        let _ = writeln!(out, "None.");
    } else {
        let _ = writeln!(
            out,
            "| Model | Mutation | Ref | Ground truth | Resolution |"
        );
        let _ = writeln!(out, "|---|---|---|---|---|");
        for r in silent {
            let _ = writeln!(
                out,
                "| {} | `{}` | `{}` | {} | {} |",
                r.model, r.mutation, r.name, r.expected, r.resolution
            );
        }
    }

    let _ = writeln!(
        out,
        "\n## WRONG_BUT_FLAGGED cases (first 3 per mutation kind)\n"
    );
    let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
    let wbf: Vec<&RefRecord> = rep
        .refs
        .iter()
        .filter(|r| r.outcome == Outcome::WrongButFlagged)
        .collect();
    if wbf.is_empty() {
        let _ = writeln!(out, "None.");
    } else {
        let _ = writeln!(
            out,
            "| Model | Mutation | Ref | Ground truth | Resolution |"
        );
        let _ = writeln!(out, "|---|---|---|---|---|");
        for r in wbf {
            let n = seen.entry(r.kind).or_default();
            *n += 1;
            if *n <= 3 {
                let _ = writeln!(
                    out,
                    "| {} | `{}` | `{}` | {} | {} |",
                    r.model, r.mutation, r.name, r.expected, r.resolution
                );
            }
        }
        for (k, n) in &seen {
            let _ = writeln!(out, "\n`{k}`: {n} in total.");
        }
    }

    let _ = writeln!(out, "\n## Rejected mutations\n");
    if rep.skipped.is_empty() {
        let _ = writeln!(out, "None.");
    } else {
        let _ = writeln!(out, "| Model | Mutation | Family | Reason |");
        let _ = writeln!(out, "|---|---|---|---|");
        for s in &rep.skipped {
            let _ = writeln!(
                out,
                "| {} | `{}` | {} | {} |",
                s.model,
                s.id,
                s.family.as_str(),
                s.reason
            );
        }
    }

    let _ = writeln!(out, "\n## Accepted mutations\n");
    let _ = writeln!(
        out,
        "| Model | Family | Mutation | Refs | GT gaps | Description |"
    );
    let _ = writeln!(out, "|---|---|---|---:|---:|---|");
    for m in &rep.mutations {
        let _ = writeln!(
            out,
            "| {} | {} | `{}` | {} | {} | {} |",
            m.model,
            &m.family.as_str()[..3],
            m.id,
            m.refs,
            m.truth_problems,
            m.description
        );
    }
    out
}
