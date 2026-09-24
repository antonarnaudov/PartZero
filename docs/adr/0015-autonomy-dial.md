# ADR 0015: The autonomy dial

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** owner (approved docs/NORTH-STAR.md)
- **Plan reference:** [NORTH-STAR.md](../NORTH-STAR.md) §2 ("The autonomy dial", "Ways to work with the agent") and §8 B5; related rows B3 (Tab, ⌘K on canvas) and B4 (checkpoints); §7 gate "Silent changes to user features"
- **Amends:** [VISION.md](../VISION.md) "Humans stay in charge" (point 6), [ARCHITECTURE.md](../ARCHITECTURE.md) §6 (loop: PROPOSE, then per-feature accept) and §7 (draft branch), [ADR 0004](0004-feature-graph-ir.md) (agent edits on a draft branch) and the PROPOSE gate in [ADR 0014](0014-cli-agents-as-providers.md)'s runtime mode. Details are in [Texts this ADR amends](#texts-this-adr-amends).

## Context

- **The owner approved NORTH-STAR.md on 2026-09-24,** including B5: a user-set autonomy dial that ships at Phase 1 beta (~M10, Jul 2027). "Autonomy" means this dial only. It does not mean background jobs, and it does not mean a CLI's own permission modes.
- **Today there is one setting: per-feature accept.** What is built, in dev builds only ([AGENT-IN-APP.md](../AGENT-IN-APP.md)):
  - a Proposal tab with the diff, per-feature checkboxes and a viewport preview;
  - Accept, Accept n of m, and Reject, with dependency-aware rejection;
  - an accepted proposal lands as one undo step;
  - the proposal rebases onto your edits at accept time, and it refuses on conflicts;
  - the agent checkpoints its own draft after each apply and rolls back to the last verified state during REPAIR/REPLAN. Those checkpoints never touch the document.
- **What is not built:**
  - the dial, a per-step pause, and user-facing checkpoints (today there is undo only; B4 plans checkpoints for Phase 1 alpha);
  - any record of who authored a feature. The IR has a free-text `author` field (ADR 0004; SPEC-v1 §6.0.1: not semantic), and no code sets it yet;
  - Tab and on-canvas ⌘K (⌘K exists in the chat panel only);
  - the agent pausing when you edit (Planned);
  - a translucent ghost: the preview is a tinted toggle;
  - running the agent in packaged builds.
- **The rule we keep.** VISION's non-goal says the agent never touches user-authored features without approval. NORTH-STAR §2 keeps it. §6 adds a UX norm: nothing is committed, accepted or exported that Forge has not built and checked.
- **Why a dial.** Cursor-style tools let the user choose how much the agent does between reviews (our Cursor analogues are from memory). One setting does not fit everyone. A maker iterating on a bracket the agent just drew should not click Accept for every 0.5 mm change. A cautious user wants to see every step. The dial must never become a way around the rule above.
- **Risks:**
  - An edit to one feature changes the geometry of every feature built on it. "Only the agent's own features" must include what depends on them.
  - An auto-applied mistake is easy to miss, and a part may already be printed before anyone notices.
  - Trust earned on easy edits could be spent on hard ones.
- **Gates already set (NORTH-STAR §7).** Silent changes to user features: 0. They are detected two ways: every agent transaction is diffed against user-authored features at commit, and any change without an approval record fails; MakerBench T4 edit tasks assert unchanged features. Checkpoint restore: 100% correct. Tab: ≤300 ms, ≥30% accepted, ≤5% undone within 60 s, on ≥2,000 offers in the alpha study group, and off by default until met. Today the silent-change rule is policy only; no check enforces it.

## Decision

### 1. One dial, three settings

We will add one autonomy setting per project, with three values:

| Setting | In one line |
|---|---|
| **Ask at each step** | The agent stops after every plan step, and you accept or reject that step before it goes on |
| **Propose per feature** (default) | The agent builds the whole task on its draft branch, then you accept or reject each feature |
| **Auto-apply checked quick edits** | A checked quick edit that touches only agent-authored features lands without a click. Everything else is proposed per feature |

- **Only you set it.** The control sits in the Assistant panel header, which always shows the current value, and in Settings.
  - No agent tool, MCP scope, skill, file or model-provider CLI flag can set or raise it.
  - Headless runs of our own agent (evals, scripted runs) take the setting as an explicit option from whoever starts them. The default is Propose per feature. External agents never auto-apply (§6).
- **It is stored per project in app settings, not in the IR.** A new project starts at Propose per feature. The setting is not design content, so the oracle never sees it.
- **The app never raises it by itself.** After a clean record it may *offer* the next setting up, once, as a dismissible note after a commit, never during a run.
  - Clean record (provisional): the last 20 agent tasks in this project committed with no rejected feature or step, no undo within 60 s and no known issues.
  - A dismissed offer comes back only after 20 more clean tasks.
  - After you undo an auto-applied edit, the app may offer the setting below. It never lowers the setting by itself either.
- **The dial affects only how work lands.** It does not change the verification ladder, the ask and stop rules, the budget, or which model runs.

### 2. Who authored a feature

- **A feature counts as agent-authored until you accept it or edit it. From then on it is yours.**
- **We record this in the existing `author` field** of each feature (ADR 0004). The host's command layer is the only writer:
  - it writes `"agent"` on every feature an agent surface creates;
  - it rewrites it to `"user"` when you accept the feature, press **Keep** on it, or issue any op on it (a field edit, a drag, a rename, a suppress, a move or a code edit to it);
  - features you create get `"user"`;
  - any other value, including an empty one (every file today), reads as `"user"`. When unsure, a feature is yours.
- **Agents cannot write authorship.** An agent or MCP op that sets `author` is refused. An `author` value in agent-written CadScript is ignored and replaced by the host's value.
- **Parameters have no `author` field in IR v1.** So every existing parameter counts as yours. Auto-apply may add a new parameter that only agent-authored features use. It never changes or removes an existing one.
- Marks survive save, reopen, undo and checkpoint restore. The IR and SPEC do not change: `author` stays non-semantic free text that engines ignore.

### 3. Nothing is auto-applied to your features

This holds at every setting and on every surface.
- **A change to a user-authored feature needs your approval of that feature:** a per-feature accept, a per-step accept that lists it, or your accept of a Tab or ⌘K ghost that shows it. ARCHITECTURE §6's stop rule stays: the agent stops and asks before a step that would touch user-authored features or anything outside the selection.
- **Every commit of agent work carries an approval record** in the decision log. It lists the run, the surface, the dial setting, every feature and parameter added, changed or removed, each one's authorship before the commit, and how each was approved (your per-feature accept, your per-step accept, your ghost accept, or auto-apply).
- **The commit check** runs in the command layer, so the UI, the agent, the CLI and MCP all pass through it. It diffs the transaction against the user-authored features and parameters as they were before it. Any change to one of them without a matching user approval in the record refuses the whole commit with the code `unapproved_user_change`. The draft stays intact as a proposal. A refusal means we have a bug: it is shown, and it gets a regression test.

### 4. How each setting works

| | Ask at each step | Propose per feature (default) | Auto-apply checked quick edits |
|---|---|---|---|
| **When the agent waits for you** | After every plan step (ACT, 1–3 features, checked through L2), and at PROPOSE if the final gate reports issues | At PROPOSE, once per task | Only when the edit does not qualify (§5). It then waits exactly as Propose does |
| **What you accept or reject** | Each step's features, on the draft branch. Rejecting a step rolls the draft back to the last accepted step; the agent replans that step once (you can add a note), then asks again | Each feature: Accept, Accept n of m, Reject. Rejection stays dependency-aware | Nothing up front. Afterwards: **Undo**, **Review** (the same diff UI) or **Keep** |
| **What lands in the document** | When the last step is accepted, the PROPOSE gate runs on the whole draft. If it passes clean, the accepted steps commit together. If it reports issues, you get a final per-feature review. Stopping early turns the accepted steps into a normal proposal | The accepted features | The quick edit, marked with an "agent" badge in the timeline and a notice naming what changed |
| **Undo** | The whole task is one undo step | One undo step | One undo step per auto-applied edit |
| **Checkpoint** | One before the commit | One before the commit | One before every auto-apply |
| **Authorship afterwards** | Accepted features are yours | Accepted features are yours | The edited and added features stay agent-authored until you Keep or edit them |
| **Your features** | Changed only with your per-feature approval | Changed only with your per-feature approval | Never. The edit falls back to Propose |

- **Edits you make during a run.** At Ask and Propose, the proposal rebases onto your edits at accept time, and it refuses on conflicts (as today). At Auto-apply, any edit of yours during the run turns that task into a proposal. It never auto-rebases over fresh work of yours.
- **Runtime mode.** At Ask at each step, the per-step pause uses the broker's user-wait path, as `ask_user` does. If a CLI cannot hold a tool call open long enough for your answer, BUILD runs in completion mode for that task. There our orchestrator owns the loop and can pause between steps (ADR 0014 already allows completion mode for any tool loop).
- **Keep all.** The Assistant shows how many agent-authored features the project has. **Keep all** makes every one of them yours in one undoable op.

### 5. What auto-apply may apply

An edit auto-applies only if **every** condition holds. Otherwise it becomes a per-feature proposal, and the notice says which condition failed.
1. The setting is Auto-apply, and the surface is the in-app Agent (§6).
2. Triage routed the task to QUICK_EDIT (ARCHITECTURE §6), and it adds, changes or removes at most 3 features (provisional). The host counts them itself and does not rely on the route.
3. It passed the PROPOSE gate: L0–L3 green, no failing test, no acknowledged test, no known issues. It is committed only as Forge built and checked it.
4. Always-on checks, once built, report no new finding.
5. Every changed or removed feature is agent-authored. New features are agent-authored by definition.
6. It changes or removes no existing parameter (§2).
7. No user-authored feature depends on an added, changed or removed feature in the derived dependency graph. At commit, every user-authored feature regenerates with the same resolved references and diagnostics as before.
8. The part is not marked safety-critical. That still needs an explicit acknowledgment.
9. You made no edit during the run.

Exports are never auto-applied. `export` still needs approval (ARCHITECTURE §6).

### 6. Surfaces

| Surface | How the dial applies |
|---|---|
| Always-on checks (no LLM) | They never edit. A check's Fix is always a proposal |
| Tab | Always a checked ghost. Tab accepts it, and Esc dismisses it. An accepted ghost is yours |
| ⌘K | Always a checked ghost at the selection. You accept it, and it is then yours |
| Agent (in-app, any provider, completion or runtime mode) | Follows the dial |
| Background (variants, part families, drawings) | Always lands on its own branch. Merging is a per-feature review at every setting |
| External agents (MCP, CLI) | Never auto-apply. Always the `mcp/<client>` branch, reviewed in the same diff UI (ARCHITECTURE §9) |

A model provider's own permission or approval mode (for example Claude Code's `--permission-mode dontAsk`, or Codex's approval policy) is part of ADR 0014's lockdown. It is never the user's approval and never a dial setting.

### 7. Checkpoints

- **A checkpoint is a named, restorable snapshot of the committed document:** its IR, CadScript and authorship marks. Checkpoints are local and stay out of the IR.
- **The app takes one before every commit of agent work,** at any setting and from any surface, and before every branch merge. You can take one by hand at any time.
- **Restore is one undoable transaction.** The app takes a checkpoint of the current state first, so restoring never loses work. A correct restore gives canonical IR equal to the snapshot and an identical regenerated report. That is how the §7 gate "checkpoint restore 100% correct" is measured.
- **Pruning.** Retention of automatic checkpoints is a setting. Manual checkpoints are never pruned automatically.
- **Agent-internal checkpoints stay separate.** The agent's `checkpoint`/`rollback` tools and REPAIR rollbacks act on the draft branch only.

### 8. Gates and timing

- **The dial ships at Phase 1 beta (B5).** Checkpoints ship at Phase 1 alpha (B4), because every setting relies on them. Tab ships at beta and stays off by default until its gate is met (B3).
- **The dial gates only itself** (NORTH-STAR §8 group B). The Auto-apply setting is offered only in builds where:
  - the commit check and checkpoints are in place;
  - the §7 gate "silent changes to user features: 0" holds on MakerBench T4 and on the commit check's own tests;
  - checkpoint restore is 100% correct on its test corpus.
- **Measurement.** Accept and undo numbers come from the alpha study group under study consent, or from ADR 0017's opt-in counts where they fall inside its scope. The dial adds nothing to what is logged.
- All numbers here are provisional (NORTH-STAR decision 6).

### Texts this ADR amends

ADRs stay immutable. This ADR amends the texts below and supersedes none of them.

| Text | Today | Amended to |
|---|---|---|
| VISION "Humans stay in charge" (point 6) | "Agent work lands on a draft branch as a per-feature diff that you accept, reject or edit. A whole agent task is one undo step." | "Agent work lands on a draft branch. By default you accept, reject or edit it per feature. The autonomy dial (ADR 0015) lets you review each step instead, or let checked quick edits to the agent's own features apply without a click. Nothing is auto-applied to your features. A whole agent task is one undo step, with a checkpoint before it lands." The non-goal "No silent changes" stays word for word |
| ARCHITECTURE §6, Loop | "PROPOSE (draft-branch diff) → per-feature accept/reject → COMMIT + decision log" | DESIGN: "per step: ACT → REGEN → L0–L2 [→ step accept/reject at Ask at each step]" and "PROPOSE (draft-branch diff) → per-feature accept/reject, or the accepted steps at Ask at each step (ADR 0015) → CHECKPOINT → COMMIT + decision log with an approval record". QUICK_EDIT: "PROPOSE → by the autonomy dial: per-feature accept/reject, or auto-commit (ADR 0015) → CHECKPOINT → COMMIT + decision log with an approval record". Add below the diagram: "The dial never changes the ladder, the stop rules or the budget." The stop rule on user-authored features stays |
| ARCHITECTURE §7, "Draft branch and diff" row | Accept, Reject or Edit each feature; the whole task is one undo step | "Accept, Reject or Edit each feature (default) or each step (Ask at each step). A qualifying quick edit to agent-authored features may auto-apply with a notice (Undo, Review, Keep) and an 'agent' badge (ADR 0015). A checkpoint precedes every commit of agent work." Add rows "Autonomy dial" and "Checkpoints" |
| ADR 0004, Consequences | "The agent has no special path. Its edits are ordinary transactions on a draft branch." | Still true. Add: "They reach the document only through a commit the autonomy dial allows (ADR 0015). The host records agent authorship in the feature's `author` field." |
| ADR 0014, Decision 2 (agent-runtime mode: "nothing changes in … the PROPOSE and REFINE gates") | The PROPOSE gate ends in a per-feature proposal | The gate is unchanged. What follows a passing gate is set by the dial and decided by our orchestrator and the host's commit check, never by the CLI. Runtime and completion modes behave the same. A CLI's permission or approval mode never counts as the user's approval. At Ask at each step, a CLI that cannot wait for the user's answer inside a tool call runs BUILD in completion mode |

## Consequences

- **Positive:**
  - You choose the pace: review every step, review per feature, or let the agent iterate on its own work without clicks.
  - One rule covers every surface. The rule that matters most, nothing auto-applied to your features, is enforced by a check at commit, not left as policy. That makes the §7 silent-change gate measurable.
  - Checkpoints make every setting cheap to try and to reverse.
  - Authorship uses a field the IR already has, so the IR contract, the SPEC and the oracle do not change.
- **Negative / costs:**
  - **Auto-apply is narrow on purpose.** It covers quick edits only, it never changes an existing parameter, and it stops at user-authored dependents. Users may find it rarely fires. Widening it needs a new ADR.
  - **Authorship marks add state** to keep correct through undo, restore, rebase, code edits and merges. A bug there could leave a feature marked `agent` when it should be yours.
  - **A file from someone else can carry `agent` marks.** A checked quick edit you asked for could then change those features without a click. The effect is bounded: a notice, one undo step and a checkpoint. Keep all clears the marks.
  - **Ask at each step costs more** time and plan usage: more pauses, and completion mode for some CLIs.
  - The approval record and the commit check add work to every commit of agent work. Their latency needs measuring. Your own edits and drags are user ops and skip the check.
  - The settings UI, badges and notices add surface area to design and test.
- **Follow-ups:**
  - **Build:** host-side authorship writes in the command layer; the approval record; the commit check and `unapproved_user_change`; user-facing checkpoints (B4, alpha); the per-step pause, and the completion-mode fallback for runtime mode; the dial control, the notice, the badge, Keep and Keep all; the offer logic.
  - **Tests:** a property test in which random agent transactions never commit a change to a user-authored feature or parameter without an approval record; MakerBench T4 tasks that assert unchanged user features at every setting; a checkpoint restore corpus (IR equality and report equality); tests that agent and MCP ops cannot write `author` or the dial.
  - **Docs:**
    - apply the amendments in the table above to VISION.md and ARCHITECTURE.md §6 and §7;
    - add "Amended by ADR 0015" to the status lines of ADR 0004 and ADR 0014, and add this ADR to the [ADR index](README.md);
    - in CLI-PROVIDERS.md, note that the PROPOSE gate's outcome follows the dial, and describe the step-pause fallback. Reword the `destructiveHint: false` rationale to "every edit lands on the draft branch and reaches the document only through the dial's commit rules". The exact wording is recorded in [NORTH-STAR-DEFERRED.md](../NORTH-STAR-DEFERRED.md);
    - give ROADMAP Phase 1 beta a dial row, and Phase 1 alpha a checkpoints row;
    - add a dial section to AGENT-IN-APP.md when it ships.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Keep per-feature accept as the only mode | Every 0.5 mm tweak to the agent's own fresh work costs a click, and a cautious user still cannot review step by step. NORTH-STAR approved the dial |
| Full auto-apply, including user features (a "just do it" mode) | Breaks VISION's non-goal. A geometry change to your feature can quietly break a fit you rely on, and a printed part cannot be undone |
| Let the app raise the setting after a good record | Trust has to be granted, not assumed. It would also break the non-goal against applying learned preferences silently. The app offers; you decide |
| A separate dial per surface (Tab, ⌘K, Agent, Background, MCP) | More settings to understand for little gain. Tab and ⌘K are single ghosts that cost one key to accept. Background and external work is long or foreign and belongs on a branch |
| Authorship by timeline position ("everything after your last feature is the agent's") | Wrong after any reorder or insert, and it cannot express a user feature added after agent features |
| Authorship in a separate ledger outside the IR | Splits a feature's metadata across two stores that can drift. ADR 0004 already gives each feature an `author` field |
| Session-only authorship (every feature becomes yours when the document closes) | Simpler and cannot be forged, but closing a file would count as acceptance without you saying so. That contradicts "until you accept it or edit it" |
| Auto-apply whole DESIGN tasks, not just quick edits | A full design touches many features, runs the spec and milestone checks, and is exactly what per-feature review is for. NORTH-STAR approved quick edits only |
| Use the CLI's own approval or permission modes as the dial | They gate tool calls, not design commits. They differ per CLI, and ADR 0014's lockdown fixes them for non-interactive runs. The dial has to be ours and the same for every provider |
