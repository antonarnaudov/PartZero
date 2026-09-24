# ADR 0020: Funded eval API keys as a fallback

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** owner (approved [docs/NORTH-STAR.md](../NORTH-STAR.md))
- **Plan reference:** [NORTH-STAR.md](../NORTH-STAR.md) §8 B18 and §7 "How we measure the AI numbers"; [ARCHITECTURE.md](../ARCHITECTURE.md) §8 (eval budget)
- **Amends:** [ADR 0014](0014-cli-agents-as-providers.md). For eval runs only, it supersedes ADR 0014's "no paid per-token API keys for now" and amends its Consequences. The rest of ADR 0014 stands.

## Context

- **Evals run on the maintainer's plan today.** ADR 0014 records the owner's rule: no paid per-token API keys for now. NHL runs use his Claude Code plan, weekly, on the public MakerBench subset, and that plan is shared with development work (NORTH-STAR §7).
- **A full run is slow on a plan.** It can take hours of plan time, because a struggling task burns about 10 minutes (BACKLOG P1). BACKLOG's per-task wall-time cap is not built yet.
- **The metrics need other model families.**
  - Benchmark NHL requires an independent reader: a model from a different family that reads the exported file against the prompt (NORTH-STAR §7).
  - ADR 0009 routes roles by a cross-provider leaderboard, and its judge comes from a different family than the builder.
  - With only a Claude plan, those rows need a Codex or Gemini CLI plan, a local model (accuracy unmeasured) or an API key.
- **Evidence is thin, and open alpha is when we publish.** Live AI accuracy is one Claude Code smoke run: 2 of 3 tasks, 17 of 20 hidden tests. No live model has been scored on MakerBench's 61 tasks. From open alpha (~M8, May 2027) we publish a MakerBench subset, NHL T1 and a head-to-head table (NORTH-STAR §5, §7). Those need a steady weekly series.
- **The money is already budgeted.** ARCHITECTURE §8 sets about $1–2k a month for evals, and ADR 0009 lists that cost. The owner approved NORTH-STAR B18: fund API keys from that budget only if plan runs cannot keep a weekly cadence.
- **Rough size (an estimate from cost targets, not a measurement).** ARCHITECTURE §6 targets a median of $0.75 per T1 part and $2.50 per T2 part on the Anthropic default profile. Today's 34 T1 and 14 T2 tasks at pass@1 come to about $60 per designer profile per run. Three profiles a week is about $180, or about $790 a month, before reader and judge calls. MakerBench is planned to reach 300 tasks by beta, so the cap will bind and rows need a priority order.
- **Keys are sensitive, and agents write this repo.** The owner never shares keys with agents. The app already stores keys encrypted with `safeStorage`, and development keys come from the gitignored repo-root `.env` ([AGENT-IN-APP.md](../AGENT-IN-APP.md), "API keys: storage and security"). Agents also write the CI workflows.

## Decision

We will fund API keys for eval runs only, and only as a fallback when plan runs cannot keep a weekly cadence.

1. **Plans first.** Eval runs use CLI plans and local models first (ADR 0014). Keys pay only for the rows plans cannot run. A *row* is one model profile on the weekly task set; the reader and the judge are rows too.

2. **What the keys pay for.** The weekly eval run:
   - benchmark NHL on the public MakerBench subset, with its different-family reader (NORTH-STAR §7);
   - the cross-provider leaderboard rows that route roles, including the judge (ADR 0009).

   They do not pay for development work, coding agents or app users. Users still bring their own CLI, local model or key, and no key ships in any build.

3. **Trigger.** The weekly eval report keeps a missed-week log.
   - **Precondition:** BACKLOG's per-task wall-time cap has landed.
   - A row **misses** a week when it does not finish within 7 days of the run's start because:
     - it hit plan limits (for Claude, the seven-day window that `rate_limit_event` reports);
     - no plan or usable local model exists for it;
     - or the owner stopped it to keep the plan free for development.
   - A row becomes **eligible** for funding after it misses 2 weeks in any 4 consecutive weeks.
   - Funded runs start **no earlier than open alpha** (~M8, May 2027). Before then, misses are logged, not bought, and this ADR funds no eval run, the spike 07 bake-off (BACKLOG P0) included: before open alpha it uses CLI plans or local models (ADR 0014).
   - Eligibility allows funding; it does not start it. The owner starts it by creating and pasting the keys (item 5).

4. **Budget.**
   - **Hard cap: $2k a month across all vendors,** the top of ARCHITECTURE §8's existing eval budget. No new money.
   - **Three stops:**
     - a monthly spend limit that the owner sets on each eval key or vendor project, where the vendor offers one. This is the hard stop;
     - the runner's monthly ledger, which refuses to start a run whose estimate (the same rows' last cost) exceeds what is left this month;
     - the per-task budget (the bench CLI's `--budget`, $1.50 by default). The gateway enforces it at tool-call boundaries, so one turn can overshoot (ADR 0014); the vendor limit covers that.
   - **When the cap binds,** rows are funded in this order:
     1. the NHL designer row the router picks, with its reader;
     2. at least one non-Claude designer row, so the leaderboard stays model-agnostic;
     3. more providers and extra passes (pass@3).
   - **Cost levers:** batch APIs for single-turn reader and judge calls (ARCHITECTURE §6), prompt caching, and every row a plan can run stays on the plan.
   - Raising the cap is an owner decision, recorded as an amendment to this ADR.

5. **Keys stay with the owner.**
   - The owner creates eval-only keys (in a separate vendor project or workspace where offered), sets their spend limits and pastes them in himself: into the gitignored repo-root `.env` on the machine that runs evals, or into the app's Settings.
   - Agents never ask for a key and never receive one in chat or a prompt. They never open, print, copy or search `.env`, never echo `*_API_KEY` variables, and never write a key into a file, commit, log, issue, CI config or CI secret.
   - An agent that sees a key by accident stops and tells the owner, without repeating the key. The owner rotates it.
   - Existing protections apply unchanged: sanitized environments for child processes, key scrubbing in events and logs, and no keys in argv or URLs. ADR 0014's allowlisted CLI environment means a funded key never reaches a CLI child process.

6. **Where funded runs execute, and who starts them.**
   - On a machine the owner controls, started by the owner or by a local schedule he set up.
   - Never from CI workflows, hosted or self-hosted. Agents write those workflows, and any workflow change could read a secret. ADR 0014's rule that live plan runs never run in CI stays.
   - Agents do not start funded runs. They may prepare runs, run the same rows on plans, local models or recorded fixtures, and analyse the reports.
   - The runner uses metered keys only in an explicit funded mode. Without it, metered profiles are refused.

7. **Honest reporting.**
   - Every result row names its profile (`claude-cli:opus` is not an `anthropic` API profile), its billing kind (`subscription`, `metered` or `local`, ADR 0014) and the model version.
   - CLI and API rows are ranked as separate rows and never merged into one number, because the CLI's runtime mode and a direct API call behave differently.
   - Metered cost is billed spend. Plan cost stays labelled notional.
   - The weekly eval report shows spend per vendor, cost per task, the budget left this month and the missed-week log.

8. **Review and exit.** The owner reviews spend monthly from the report. Funding for a row stops when the reason is gone (for example, a Codex or Gemini plan or a local model now runs it on cadence) or at the owner's call. The owner then revokes the key.

9. **What changes in ADR 0014.**

   | ADR 0014 text | Now |
   |---|---|
   | Context: "We will not pay for per-token API keys for now." | Still true for the app and for development. Eval runs may use owner-funded keys under this ADR. |
   | Consequences, Positive: "Its cost per task to us is zero." | Unchanged for app users. |
   | Consequences, Negative / costs | Add: "Evals may spend up to $2k a month on metered API keys when ADR 0020's trigger fires." |
   | Decision 4: we never read, copy or forward CLI credentials | Unchanged. Funded keys never reach a CLI child process. |
   | Decision 8: the live suite never runs in CI | Unchanged. Funded runs stay out of CI too. |

## Consequences

- **Positive:**
  - The weekly NHL series and the numbers published from open alpha no longer depend on spare plan capacity.
  - NHL gets its different-family reader, and the leaderboard gets non-Claude rows, even while the owner pays only for Claude.
  - Development keeps its plan capacity.
  - Keys stay in the owner's hands. What agents can reach does not change.
- **Negative / costs:**
  - Up to $2k a month once triggered, inside the existing eval budget. The size estimate comes from cost targets, not measurements.
  - A row that moves from a plan to a key becomes a different profile. The report marks the switch, and that row's trend line restarts.
  - Owner time: creating keys, setting spend limits, setting up the schedule and a monthly review.
  - Scheduled funded runs need the owner's machine to be on.
  - On a shared development machine, a funded key sits near agents that have shell access. The protection is this rule plus a read-deny on `.env`, not a sandbox.
- **Follow-ups:**
  - BACKLOG's per-task wall-time cap comes first.
  - Eval runner: an explicit funded mode, the monthly ledger, profile and billing kind on every row, and the missed-week log in the weekly report.
  - The owner adds `.env` to the coding agents' read-deny permissions on any machine that holds eval keys.
  - Docs outside this ADR: ADR 0014's status line gains "Amended by ADR 0020 (eval runs only)"; the ADR index gains this row; ARCHITECTURE §8's budget line points here. BACKLOG's P0 bake-off item and CLAUDE.md's key rule wait in [NORTH-STAR-DEFERRED.md](../NORTH-STAR-DEFERRED.md) until Phase C frees those files.
  - Gates: none change. NHL T1 at open alpha is published, not gating. NORTH-STAR A1 already names this ADR as its fallback for plan time.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Stay plan-only and accept missed weeks | The weekly series gets gaps. With only a Claude plan, the different-family reader and non-Claude rows cannot run at all. Published open-alpha numbers would rest on whatever plan time was left over. |
| Fund keys now, before open alpha | NORTH-STAR B18 sets open alpha. Nothing is published before then, and the wall-time cap may be enough on its own. |
| Buy more CLI plans (Codex, Gemini) instead of keys | Not ruled out: a plan row is a plan row, and plans come first. It is not the fallback, because plan limits are shared, sized for interactive use and change over time, which is the problem this ADR solves. |
| Local models only for the missing rows | Free and offline, but their accuracy is unmeasured (NORTH-STAR §5), and a leaderboard of local models says little about the models users will pick. It stays a plans-first option for rows where it is good enough. |
| Keys as CI secrets, evals in CI workflows | Agents write the workflows, and any workflow change could read the secret. The owner's rule is that keys live only where he pastes them. |
| Give agents a key so they can run evals on demand | Breaks the owner's rule that keys are never shared with agents. Spending money is the owner's call. |
| A budget above $2k a month | No new money was approved. ARCHITECTURE §8's eval budget is the envelope; a higher cap needs the owner's amendment. |
