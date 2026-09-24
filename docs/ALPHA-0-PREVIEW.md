# Alpha 0 preview: how to try it

- **What it is:** an early PartZero.app for this Mac, built today (2026-09-25) from the `alpha0-preview` branch. It has the packaging work (W1) and Open in Bambu Studio (W5) from [ALPHA-0-PLAN.md](ALPHA-0-PLAN.md). The design agent still uses the current design language, IR v0. The IR v1 features from Phase C (hole features, fillets, chamfers, shells, patterns) are not in it yet.
- **What you can do with it:** open the app, see that it found your Claude Code, ask for a simple part in chat, accept it, and send it to Bambu Studio.
- **Privacy:** the only data that leaves your Mac is what Claude Code sends to Anthropic under your plan (your prompt and the design). There's no telemetry and no API key.

## 1. Install

If a coding agent has already installed it, `/Applications/PartZero.app` exists and you can skip this step.

To install it yourself, run this in Terminal:

```bash
cd ~/Developer/AiNative3DCAD/.claude/worktrees/alpha0-preview   # or any checkout of the alpha0-preview branch
scripts/alpha0-mac.sh --install
```

The script:
1. builds the app;
2. checks its signature and fuses, and runs its self-test;
3. quits PartZero if it's running;
4. keeps the app it replaces for rollback;
5. copies the new app into `/Applications`.

It takes a few minutes the first time and under a minute after that. If macOS says the terminal isn't allowed to change apps, allow it once in System Settings → Privacy & Security → App Management. Only you can change that setting.

## 2. First launch

1. Double-click **PartZero** in Applications. It isn't expected to show a "damaged" warning. If macOS blocks it, go to System Settings → Privacy & Security and click **Open Anyway**.
2. No keychain or password prompt is expected. **If anything asks for your login password, cancel it and tell a coding agent. Never type your password for an agent.**
3. There's no welcome card yet. Open **Settings** (the gear at the top right, or ⌘,) to check two things:
   - It says **"Using Claude Code (detected)"**, with version 2.1.260 and "Logged in · Max plan". If it says **Log in needed**, run `claude auth login` in Terminal, then press **Re-check**.
   - **Printing** shows **Bambu Lab P2S · 0.4 mm · PLA** and the Bambu Studio it found in `/Applications`.

## 3. Make a part and send it to Bambu Studio (about 2 minutes)

1. In the **Assistant** box at the bottom right, type a simple part and press Enter. For example: *"A 60 x 40 x 4 mm plate with a 5 mm hole 8 mm in from each corner"*.
2. Wait about a minute. The card shows its progress, then **Proposal ready**, a short summary and the plan usage. If the agent asks you a question, pick an answer or the default.
3. Click **Accept**. The part replaces the starting block. ⌘Z undoes the whole change in one step.
4. Optional: save with ⌘S and give it a name. The print file is named after the document, so an unsaved one is called `untitled-….3mf`.
5. Click **Open in Bambu Studio** in the toolbar. PartZero:
   - checks that the part is valid and fits the P2S bed with 10 mm kept free on each side;
   - saves `~/PartZero/Prints/<name>-<code>.3mf`, with a `.receipt.json` beside it recording what was checked;
   - opens the file in Bambu Studio, centred on the plate.
6. In Bambu Studio:
   - A dialog says **"The 3mf is not from Bambu Lab, load geometry data and color data only"**. Click **OK**.
   - **Check the printer preset:** in our test, Bambu Studio had the **0.2 mm nozzle** selected. Pick the P2S **0.4 mm nozzle** preset if that's what your printer has.
   - Pick your filament, slice and print as usual.

### What our test run of this build showed

We ran it once, live with your Claude Code, on the same code as the installed app (driven by a test script with a throwaway profile):

| Step | Result |
|---|---|
| Claude Code | Found and ready: 2.1.260, logged in, Max plan. |
| Agent | **Proposal ready in 54 s**, with no questions, after 7 turns and one build. Model: Claude Opus through Claude Code. |
| Plan usage | About **$0.24** at API list prices, against the $1.00 per-task budget. That's not billed: it counts against your plan. Afterwards the 5-hour window showed 5 % and the 7-day window 61 %. |
| Part | 1 body, 60 × 40 × 4 mm, four 5 mm through-holes with centres 8 mm in from each edge, 0 problems. The mesh is watertight. Its volume is within 0.01 % of the exact value. |
| Open in Bambu Studio | The 3MF and receipt were saved in 0.2 s, centred at (128, 128) on the bed with the bottom at z = 0. Bambu Studio started with the file and showed the dialog above. |

## 4. What works in this preview

- PartZero.app is a private build, ad-hoc signed, for this Mac only. It stores no API keys and shows no API-key fields.
- It detects Claude Code without any setup and runs the agent on your plan. The run card shows plan usage, and **Stop** is always available.
- The agent works in chat and builds simple parts: sketches with lines, arcs and circles (circles make holes), extrudes and revolves. Each proposal is checked by Forge before you see it. Accept applies it as one undo step, and Reject discards it.
- The code view (CadScript), the timeline and the problems panel update live as you edit.
- **Open in Bambu Studio:**
  - It refuses a part that isn't valid or doesn't fit the bed, and says why.
  - A receipt is saved next to every print file.
  - If Bambu Studio can't be found, you get a plain export with **Show in Finder**.
- **Settings → Printing** shows the P2S profile and the PLA clearances. You can set a different path to Bambu Studio there.
- Logs are in `~/Library/Logs/PartZero/` (`main.log`, `agent.log`).

## 5. What doesn't work yet

These come with IR v1 (Phase C) and the rest of drop 0.1:
- **No v1 features:** no countersunk or tapped hole features, fillets, chamfers, shells or patterns. The agent can't make parts that need them (P1, P3, P4 and P5 in the plan). A plain round through-hole works.
- **No Parameters panel:** it says parameters arrive with IR v1. To change a size, ask the agent or edit the number in the code.
- **No welcome card, starter chips or gallery.** A new document starts as a 40 × 30 × 10 mm block, and the agent edits it into your part.
- **No 6-minute limit on a run.** Press **Stop** if one takes too long.
- **No ⌘P shortcut** for Open in Bambu Studio. Use the toolbar button.
- These come in drop 0.2: the Fit Lab, a material picker (PLA only for now) and Help → Report Issue.

## 6. Known issues

- **The toolbar still says "aicad".** The app, window and menus are PartZero. The rename inside the page comes with W2.
- **Bambu Studio's nozzle preset:** as described in step 3, check that it's the 0.4 mm nozzle before you slice.
- **Sending the same part again while Bambu Studio has one open** starts a second Bambu Studio window, which uses about 1 GB of memory. Close the old window when you're done with it.
- **The camera doesn't re-fit after Accept.** Press **F**, or click **Zoom to fit** in the viewport toolbar.
- **Parts with several bodies stacked on top of each other** are refused by Open in Bambu Studio, with the reason. Lay them out side by side.
- If something goes wrong, tell a Claude Code session in the repo what you did, and point it at `~/Library/Logs/PartZero/`.

## 7. Roll back or remove

- **Go back to the previous PartZero build:**

  ```bash
  scripts/alpha0-mac.sh --rollback
  ```

  This only works if an older PartZero was installed before this one. The newer build is kept as `/Applications/.PartZero-builds/rolled-back`.
- **Remove it completely:**
  1. Quit PartZero.
  2. Move `/Applications/PartZero.app` to the Trash.
  3. If you like, also delete the hidden `/Applications/.PartZero-builds` folder.
- **Your data stays where it is unless you delete it:**
  - `~/Library/Application Support/PartZero`: settings and recent files;
  - `~/Library/Logs/PartZero`: logs;
  - `~/PartZero/Prints`: your print files and receipts.
