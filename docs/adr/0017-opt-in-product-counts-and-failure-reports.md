# ADR 0017: Opt-in product counts and kernel failure reports

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** owner (approved [docs/NORTH-STAR.md](../NORTH-STAR.md))
- **Plan reference:** [NORTH-STAR.md](../NORTH-STAR.md) §8 B12 and §7 (product NHL). Amends the Consequences of [ADR 0009](0009-model-agnostic-llm-gateway.md) and [ADR 0010](0010-local-first.md), and the data policy in [ARCHITECTURE.md §8](../ARCHITECTURE.md#data-flywheel).

## Context

- **The north-star metric needs real use.** Product NHL is the share of exported parts whose session had zero manual geometry operations (NORTH-STAR §7). Its gate: ≥50% of accepted parts by beta, on ≥200 exported parts from ≥20 alpha makers.
- **Today's policy measures nothing for most users.**
  - ARCHITECTURE §8 turns the data flywheel off for BYO-key users and private projects.
  - ADR 0009 says learning comes only from opted-in hosted usage.
  - Hosted AI arrives at beta (ROADMAP). Until then every user brings their own key, CLI agent ([ADR 0014](0014-cli-agents-as-providers.md)) or local model. In this ADR, "CLI users" means users whose AI runs through a CLI agent inside the app.
  - So every alpha user is outside the flywheel, and product NHL cannot be measured. The only other path is a recruited alpha study under study consent.
- **Real-world kernel failures are invisible.** "0 silent-wrong" covers only what we sample (NORTH-STAR §9). The Phase 0 audit found H1 and H2 outside the generator corpus. A failure a user hits today reaches us only if they file an issue by hand. The failure zoo needs those cases.
- **Trust is the product.** Makers expect local tools that keep their files private (ADR 0010). PartZero is built never to lie (NORTH-STAR). Silent or broad collection would break both.
- **What exists today:**
  - No telemetry code, no ingest service and no privacy notice.
  - The command layer already tags each transaction with an origin (`TransactionOrigin` in `packages/app/src/doc/history.ts`: `user`, `command`, `agent`, `system`).
  - Forge errors carry stable codes from one catalogue (`ERROR_CODES` in `forge/crates/forge-ir/schema/ir-v1.constants.json`).
- **"Anonymous" needs care.** Counting distinct makers (≥20) and distinct parts (≥200) needs a random install ID and a random part token. With them the data is pseudonymous, not strictly anonymous, and some laws (the EU GDPR, for example) may treat it as personal data. We treat it that way: consent, deletion and retention limits.

## Decision

We will add two opt-in, content-free data streams for every user, whatever their AI provider, plus a per-report path for minimized kernel failure cases. Nothing is sent by default. The content flywheel in ARCHITECTURE §8 (trajectories, prompts, sketches, edits) does not change: it stays off for BYO-key and CLI users and for private projects.

### 1. Three streams, each consented separately

| Stream | What it is | Consent | Default |
|---|---|---|---|
| Usage counts | Counters and yes/no flags per part and per day (§3) | Switch "Share usage counts" | Off |
| Failure signatures | One row per kernel failure kind: error code, operation, versions, platform (§4) | Switch "Share kernel failure signatures" | Off |
| Minimized failure case | A shrunk, stripped IR program that still reproduces one kernel failure (§5) | The user reviews it and presses Send, for every case | Never sent without that press |

Separate switches continue ARCHITECTURE §8's rule.

### 2. Consent UX

- **Asked once,** on one onboarding screen at first launch. Both switches are shown off. The user turns on what they want and presses Continue. No pre-ticked boxes, no "Accept all" button, no nagging.
- **The screen's text,** in substance:
  > **Help us measure whether PartZero works.** If you turn these on, PartZero sends counts: parts accepted, parts exported, whether geometry was edited by hand, and which kernel errors happened. It never sends your designs, dimensions, file names, prompts, chats or keys. Both are off unless you turn them on. You can change this any time in Settings → Privacy, and see exactly what is sent.
- **Never asked again,** unless a new kind of data needs consent (§3). Then only the new part is asked, off by default.
- **Settings → Privacy** shows:
  - both switches;
  - "Show what will be sent": the exact pending JSON;
  - a log of the batches sent in the last 30 days;
  - "Don't count this part", per open part, stored in app storage, not in the file;
  - "Delete my data" and "Reset install ID" (§7).
- **Turning a switch off** stops recording at once and discards the unsent queue.
- **The app works the same with both off.** No feature depends on these streams. With both switches off the app makes no request to our ingest at all, not even a ping.
- **Headless runs never send and never ask:** the `aicad` CLI, headless MCP, evals, CI, tests and dev builds.
- **Managed machines** can force both switches off and hide the screen with an environment variable or config file (for example `PARTZERO_TELEMETRY=off`).
- **Closed alpha.** The invitation may ask makers to turn on usage counts, because product NHL depends on them. It stays their switch, with the same allowlist. Anything more, such as coupon photos for FTPS or interviews, goes under a separate written study consent, not this ADR.

### 3. Usage counts: the allowlist (schema v1)

Every payload is JSON that the app validates against a checked-in JSON Schema before sending. A payload that fails validation is dropped, not sent. The schema has **no free-text strings**: every string is an enum from a checked-in list, or a fixed-format value (semver, hex hash, random UUID, UTC date). A CI test enforces this.

| Field | Values | Why |
|---|---|---|
| `install` | Random UUID made on the device; the user can reset it | Count distinct makers |
| `day` | UTC date of the batch; nothing finer | Trends by week and build |
| App version, release channel, Forge version and build hash | semver, enum, hex | Tie numbers to builds |
| OS family, CPU architecture | `macos` / `windows` / `linux`; `arm64` / `x64` | Platform issues |
| `part` | Random token per part, kept in local app storage and **never written into the design file** | Count distinct parts; a re-export counts once |
| `origin` | `new`, `opened`, `imported` | Report parts made elsewhere separately |
| `provider` | Kind `api`, `cli`, `local` or `none`. The profile name only if it is a profile we ship (for example `claude-cli:opus`), otherwise `custom` | NHL by provider for the ADR 0009 leaderboard. Never an endpoint URL, model path or account |
| `proposals` | Agent features offered, accepted, rejected (counts) | Accept rate |
| `exports` | Count; formats from a list (`3mf`, `stl`, `step`, `obj`, `dxf`, `svg`, …); process kind from `PROCESS_KINDS`, the one checked-in list that the design context also uses ([ADR 0018](0018-design-context-in-the-ir.md): `fdm`, `resin`, `sls`, `laser`, `cnc_router`, …; `any` when no process is set) | The NHL denominator |
| `manual_geometry` | Yes/no since the part was created; plus which kinds occurred: `sketch`, `feature`, `parameter`, `code` | The NHL numerator |
| `manual_after_accept` | Number of accepted agent features with 0, 1, 2 or 3+ manual edits before export | The existing gate "≥60% of proposals accepted with at most 2 manual edits" |

**Definitions.**
- A part's **session** runs from its creation to its export.
- A **manual geometry operation** is a transaction a person makes (origin `user` or `command`) that changes geometry-bearing IR: sketch entities, constraints or dimensions; features; parameter values; or CadScript that changes the compiled IR. Undo, redo, accept, reject, selection, viewing and export are not manual geometry operations.
- **Agent edits** follow NORTH-STAR §2 (ADR 0015): a feature is agent-authored until the user accepts or edits it. Edits from external agents over MCP count as agent edits.
- **Product NHL** is computed exactly as NORTH-STAR §7 defines it, from `exports` and `manual_geometry`. The kind flags let us also report, separately, parts whose only manual edits were parameter values. They do not change the metric.

**Adding a field.**
- A new field of a kind already here (a count, a yes/no flag, an enum from a checked-in list) may join with a schema version bump, a changelog line and an update to the in-app "what we send" page. The existing switch covers it. Tab offer, accept and undo counts (NORTH-STAR §7's Tab gate) are the expected first addition.
- Anything else needs a new ADR and fresh consent, off by default. That includes free text, geometry, any number taken from the design, timings finer than a day, and anything that identifies a person or a machine.

### 4. Failure signatures

The host app collects these, not Forge. Forge crates get no network code. When a Forge call fails, the host records one row per distinct signature per day, with a count:
- the error code from the catalogue, or an internal-failure class: `panic` (caught by the host), `invalid_result` (a validity check failed on a result) or `timeout`;
- the operation kind (`extrude`, `revolve`, `boolean`, `fillet`, …) and the stage (`validate`, `evaluate`, `check`, `mesh`, `export`);
- for a panic, the names of the top five stack frames in our own crates. These are our open-source code, not user data. No file paths, addresses or values;
- the envelope fields from §3 (install ID, day, versions, platform).

An error's `details` (entity IDs, values, feasible ranges) are never sent, because they come from the design.

### 5. Minimized failure cases

The app offers a case only for internal failures (`panic`, `invalid_result`, `timeout`) and for error codes that the catalogue marks as kernel limitations: a valid input that Forge cannot handle yet. It does not need either switch, because each case has its own consent.

1. **Shrink on the device.** A local minimizer (the one the failure zoo uses, once built) removes features, sketch entities and parameters and rounds numbers. It keeps each step only if the same signature still fails. It runs in the background with a time cap (60 s to start) and never blocks work.
2. **Strip.** The result is IR JSON only, never CadScript.
   - Names of features, sketches and parameters become generic (`f1`, `s1`, `p1`).
   - Expressions become literal values.
   - Comments, metadata, design context (ADR 0018), materials, file names and paths are removed.
3. **Show.** A banner that does not block work offers "Review and send". The review shows:
   - a render of the case and its exact JSON;
   - its size next to the original part's, with a warning when the shrink kept most of the part;
   - who reads it: the owner and the AI coding agents that fix Forge. Those agents run on an AI vendor's plan (today Claude Code), under that vendor's terms.
4. **Send only on a press.** Each case needs its own press. There is no "always send" option. The case carries a random report ID, not the install ID, so it cannot be joined to the usage counts. The app keeps the report IDs locally so the user can delete them later.
5. **Publishing is a second, separate choice.** An unticked box: "Allow this case to be published in the public failure zoo as a permanent test." Without it, we fix the bug, write our own regression case, and delete the report on the schedule in §7.

"Don't offer again" on the banner turns the offers off. Settings turns them back on.

### 6. What is never collected

- **Design content:** IR, CadScript, sketches, geometry, meshes, renders or thumbnails, dimensions and parameter values, the names of parts, features, parameters, files or projects, file paths, design context. The one exception is a minimized case the user reviewed and sent (§5).
- **AI content:** prompts, chat messages, agent plans and transcripts, tool-call arguments, model outputs.
- **Credentials and accounts:** API keys, CLI logins or login status, vendor account names, plan tiers, emails. This keeps ADR 0014's rule: we never read or forward the user's credentials.
- **Identity and device data:** IP addresses (dropped at ingest), location, hostnames, user names, hardware serials, MAC addresses, advertising IDs, device fingerprints, lists of installed software.
- **Error `details`,** and any timing finer than a day.

The install ID never goes into design files, exports, receipts, AI provider calls or any other network request. We never sell rows or share them with third parties. Only aggregates are published.

### 7. Where it runs and how long we keep it

- **Client:** a small first-party module in the desktop host (the Electron main process). The web app later uses the same schema.
- **Transport:** batched on the device and sent at most once a day over HTTPS to an ingest we run. An offline device keeps its queue for 30 days, then drops it.
- **No third-party analytics or crash SDK in the app.** The store behind our ingest is an implementation choice, as long as it meets the rules here.
- **Access:** raw rows are read by the metric jobs and the owner; everyone else, agents included, sees aggregates. Minimized cases are read by the owner and the agents fixing Forge.
- **Aggregates** are published or shared only for groups of at least 10 installs. Smaller groups merge into "other".

| Data | Kept | Then |
|---|---|---|
| Unsent queue (device) | Until sent, at most 30 days | Dropped |
| Log of sent batches (device) | 30 days | Deleted |
| Usage counts and failure signatures (server, with install ID) | 12 months | Rolled up into aggregates without the install ID; raw rows deleted |
| Aggregates (no install ID) | Kept | May be published |
| Minimized case, publishing not allowed | Until 90 days after its fix ships, and at most 12 months | Deleted. The regression test uses a case we write ourselves |
| Minimized case, publishing allowed | In the public failure zoo | Kept forever, like every zoo case |
| Transport logs that hold IP addresses | At most 7 days, or off where the host allows | Deleted |

**Deletion.** "Delete my data" sends a request with the install ID and the locally kept report IDs. We delete the matching raw rows and unpublished cases within 30 days, and the app makes a new install ID. Aggregates hold no install ID, so they stay. A published case cannot be recalled; the publishing box says so.

**Tighten freely, loosen only by ADR.** We may shorten retention, raise the group size or drop fields without a new ADR. Anything longer, looser or broader needs one.

### 8. Honesty rules for these numbers

- Every product NHL figure is published with its count of parts and installs, its 95% interval and a note that opted-in users choose themselves.
- The gate stays NORTH-STAR §7's. If opted-in users cannot reach its sample (≥200 exported parts from ≥20 alpha makers) by beta, the fallback is the recruited alpha study under study consent, which NORTH-STAR already allows.
- Anyone can post to the ingest, so counts can be forged. We report them as self-reported product data, never as verified results, and cross-check them against the study group where one exists.

## Consequences

- **Positive:**
  - Product NHL becomes measurable for BYO-key, CLI and local-model users, which today means every alpha user.
  - The Forge team sees real-world failure rates by error code, operation and build, and gets consented minimal cases for the failure zoo. These cover what the generated corpora miss.
  - The policy can be checked by code: a schema with no free text, a CI test, and a payload the user can inspect.
  - The content flywheel's promise to BYO-key and CLI users stays intact.
- **Negative / costs:**
  - A service to build, run and secure: the ingest, its store, and the retention and deletion jobs.
  - Opt-in data is self-selected and may be thin. The product NHL gate may still need the alpha study.
  - Counts are self-reported and can be spoofed.
  - A minimized case is still derived from a user's design. Per-case consent, stripping and the review screen reduce that risk; they do not remove it.
  - AI coding agents read the cases under a vendor's terms. We disclose it, and it may put some users off.
  - A privacy notice to write and keep in step with the schema.
  - NORTH-STAR §2's learned Tab model bet cites "consented accept logs (ADR 0017)". This ADR gives accept and reject **counts**, not the feature content a model would train on. Training data needs a separate content consent (a study consent or a later ADR). ARCHITECTURE §8 also rules out fine-tuning before M13.
- **Follow-ups:**
  - **ADR 0009 and ADR 0010:** per the ADR README, each gets a status line plus a dated addendum; the original text stays as written. Each status line adds "Amended by ADR 0017 (Consequences: data handling)". What the addenda say:
    - ADR 0009, "Data handling depends on the key": the content flywheel stays off for BYO-key users. Opted-in users of any provider may share content-free usage counts and failure signatures, and send reviewed minimized cases, under ADR 0017.
    - ADR 0010, "The data flywheel is opt-in only, with separate switches": still true. ADR 0017's streams are opt-in too, with separate switches, off by default, and no offline feature depends on them.
  - **ARCHITECTURE §8, "Data flywheel":** its first line becomes "Two layers, both opt-in with separate switches. (1) Usage counts and kernel failure reports (ADR 0017): content-free, for every user whatever the provider, off by default. (2) Content logging (the list below): off for BYO-key and CLI users and for private projects." In §8 "Metrics", the "Live product" row notes that, for BYO-key and CLI users, it comes only from ADR 0017 counts.
  - **ADR README:** add this ADR to the index.
  - **Build for closed alpha** (NORTH-STAR B12, S–M): the payload schema and its CI test; the host module; the onboarding screen and Settings → Privacy; the ingest with its retention and deletion jobs; the on-device minimizer and review screen; stable codes for the internal-failure classes and a "kernel limitation" flag in the error catalogue.
  - **A plain-language privacy notice** that states these rules, reviewed by the owner before closed alpha.
  - **Tab counts** join the allowlist when Tab ships, under the §3 rule.
  - **Beta's adoption gates** (ROADMAP Phase 1 exit: ≥99.5% crash-free sessions, 300 weekly active users) have no stream here yet: failure signatures cover kernel failures only. Add a daily count of app runs and a count of runs that ended in an app crash (detected by the host, never by a crash SDK) as count fields under the §3 rule. Until then, the alpha study measures these gates. Weekly active users counted from opted-in installs are a lower bound.
  - **Process kinds** in `exports` come from `PROCESS_KINDS` in the IR constants file, shared with ADR 0018. If these counts ship before IR v1.1, the list lands in the constants file first.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Keep today's policy: nothing for BYO-key and CLI users | Product NHL cannot be measured, and real-world kernel failures stay invisible |
| A recruited alpha study only | Small, costly in the owner's time, and it ends with the alpha. Kept as the fallback, and for FTPS coupon photos |
| On by default (opt-out) | Breaks the private, local-first promise makers expect (ADR 0010). In some regions (the EU, for example) non-essential analytics needs prior consent |
| Opt-in content logging for BYO-key and CLI users (trajectories, IR) | The most learning value, but it sends designs and prompts and reverses ADR 0009's promise. Content stays with hosted opt-in and study consent |
| A third-party analytics or crash-reporting SDK | Collects more by default (IP, device data, breadcrumbs, stack variables), keeps data under the vendor's retention, and makes the allowlist hard to prove |
| Upload the whole document on a kernel failure | That is design content. Minimized, stripped and reviewed cases give most of the debugging value |
| An "always send" option for minimized cases | Shrinking may leave most of a small part intact, so every case needs its own review |
| Local counters that users copy and send by hand | Participation near zero, and hand-copied numbers are error-prone |
| Randomized response or differential privacy on the flags | At alpha scale (≥20 makers, ≥200 parts) the noise would swamp the gate's signal. Revisit once counts are large |
