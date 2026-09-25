# ADR 0022: The agent edits the open model live, with the modeling tools

- **Status:** Accepted (the owner's binding feedback for the full-modeling build, 2026-09-25)
- **Date:** 2026-09-25
- **Plan reference:** [FULL-MODELING-PLAN.md](../FULL-MODELING-PLAN.md) §2.1, §2.10, §5.5
- **Amends:** [ADR 0015](0015-autonomy-dial.md) §1, §4 (how agent work lands; what the three settings mean), and the parts of [ADR 0014](0014-cli-agents-as-providers.md) Decision 2 and [ARCHITECTURE.md](../ARCHITECTURE.md) §6–§7 that say agent work lands as a proposal on a draft branch. Details: [docs/fm/agent-live.md](../fm/agent-live.md).

## Context

- The owner's feedback for the full-modeling build (2026-09-25) is binding: no code in the default UI; every hand tool is a first-class command the AI can call and chain; **the AI must not primarily write code, it operates the tools**; and **it edits live**: each command it applies is visible at once in the viewport and the timeline, step by step, with a one-line narration in the chat; Stop keeps what was built; one undo group per agent turn; agent-authored features marked (ADR 0015).
- ADR 0015 made "Propose per feature" the default: the agent builds on a draft branch (CadScript) and the user accepts or rejects each feature afterwards. That contradicts "edits live" and "does not primarily write code".
- The command layer (C1, `@aicad/model-ops`) already gives the agent every op as a tool, with the failure rule, the commit check (`unapproved_user_change`), authorship and undo groups. What was missing was a loop that drives those tools on the open document, and a way to pass the user's approval to it.

## Decision

1. **On an IR v1 model the in-app agent is the live operator.** It changes the model only through the op catalogue's tools, applied through the app's command registry as the agent, on the open document. It writes no CadScript. The CadScript proposal path stays as a fallback (a document that is not an IR v1 model, or the user's `agent.setSurface { surface: "code" }`).
2. **Every step lands live.** A committed op is visible at once in the viewport and timeline and is narrated in one line in the chat. Every change carries Forge's check of the whole model; `finish` is refused once while a feature fails.
3. **One undo group per turn.** The host opens the group before the run and seals it when the run ends, however it ends. **Stop keeps what was built.** A run whose CLI broke its lockdown is the exception: its group is aborted.
4. **The dial for live edits** (replacing ADR 0015 §4's first two columns; still set only by the user):
   - **Ask at each step**: after every committed step the run waits; the user keeps it or undoes it (the agent is told and replans).
   - **Review the turn** (default, replacing "Propose per feature"): steps land live and stay agent-authored; at the end the user keeps the turn (its features become theirs) or undoes it (one step). A feature can still be kept or deleted on its own from the timeline.
   - **Auto** (replacing "Auto-apply checked quick edits"): steps land live; a notice only.
5. **ADR 0015 §3 is unchanged and enforced at every setting**: no change to the user's features, parameters, marker or colours without their approval. The agent asks with `request_approval`; the user's Allow is recorded by the host on the turn's group only (host code, never an op or command an agent can reach) and ends with the turn.

## Consequences

- **Positive:**
  - The owner's "the AI operates the tools, live" holds: the same commands, checks and undo as the user's own tools; nothing reviewed as code.
  - Faster and cheaper than the draft-and-propose loop: no spec-writer call, no CadScript compile/typecheck; two real Claude Code runs built their parts in 23 s and 42 s ([agent-live.md](../fm/agent-live.md)).
  - An approval channel exists: the agent can now change the user's work when, and only as far as, the user allows it.
- **Negative / costs:**
  - The user's features are protected by the commit check, but agent features land before anyone reviews them; a bad turn is undone as a whole (or feature by feature from the timeline), not rejected per feature before it lands.
  - The independent spec-writer tests (L3) do not run in the live loop; verification is Forge's check per step and the agent's own measurements.
  - While a turn runs, the user's own edits are refused (they wait for Stop or the end of the turn).
  - Checkpoints (ADR 0015 §7) are not built; undo is the recovery.
- **Follow-ups:** checkpoints before every turn; ADR 0015 §5.7's "user features rebuild the same" check at commit; a per-project dial; spec tests as an optional final gate; the MCP bridge so external clients can operate the live document on their own branch.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Keep ADR 0015's draft branch and per-feature proposal, render the draft as a live ghost | The user still reviews a proposal instead of watching the model being built; Stop would hand back a proposal, not keep the work; the agent would keep writing code. Contradicts the owner's feedback. |
| Live edits on a hidden draft document, merged at the end | Two models to keep in sync, and the viewport/timeline would not show the real model; merge conflicts at the end instead of the group's simple rule (the user waits or stops). |
| Let the agent approve its own changes to the user's work (e.g. via `ack`) | Violates ADR 0015 §3's invariant; approvals must come from the user through host code. |
