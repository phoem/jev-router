# jev-router

A Claude Code mod that asks [TypeSafe](https://docs.typesafe.ai)'s Jev model how hard each prompt is and picks the Claude model for that turn. It is off until you turn it on in a session, and a band above the prompt shows whether it is on and what it picked.

## Requirements

- A Claude Code build with function hooks (mods). They are early access, so the API this mod uses can change between releases.
- A TypeSafe API key in the `TYPESAFE_API_KEY` environment variable. To scope the key to Claude Code only, put it in the `env` block of `~/.claude/settings.json`:

  ```json
  { "env": { "TYPESAFE_API_KEY": "<your key>" } }
  ```

## Install

From a copy of this folder:

```bash
claude plugin marketplace add "<path to this folder>"
```

```bash
claude plugin install jev-router@jev-router
```

A plugin installed from a folder is read from that folder, so after editing the code run `/reload-plugins` (or start a new session) to pick up the change. No reinstall is needed.

From a GitHub repository that holds this folder:

```bash
claude plugin install jev-router --marketplace <owner>/<repo>
```

In the desktop app, click + next to the prompt box, then Plugins, then Add marketplace, then Add plugin.

To try it without installing, start a session with `claude --plugin-dir "<path to this folder>"`.

## Use

The band above the prompt shows the state and two buttons. The mode button reads **Mode: Report only** or **Mode: Apply** and flips between the two when clicked. **Turn on** / **Turn off** switches routing on in that mode, or off. Flipping the mode while routing is off only picks it; while it is on, it switches straight away.

Routing is off in every new chat, so nothing is sent to TypeSafe until you turn it on in that chat. A chat you reopen picks up where it left off (see "Reopening a chat" below).

Everything is also a `/jev` command:

| Command | What it does |
| --- | --- |
| `/jev on` | Turns routing on for this session, in the mode last picked (the `defaultMode` setting until you pick one) |
| `/jev report` | Picks report mode and turns routing on: shows the model Jev would pick for each prompt and changes nothing |
| `/jev apply` | Picks apply mode and turns routing on: runs each turn on the picked model |
| `/jev off` | Turns it off: nothing more is sent to TypeSafe |
| `/jev status` | Shows the current state |
| `/jev usage` | Reports what the router's lookups have used at TypeSafe (see below) |
| `/jev usage money` / `tokens` / `limits` / `hide` | Shows one TypeSafe figure, or hides it (hidden by default) |
| `/jev stats` | Reports how many lookups picked each model, and the tokens the turns routed to it used (see below) |
| `/jev stats show` / `/jev stats hide` | Shows those stats as rows on the band, or hides them (hidden by default) |
| `/jev debug show` / `/jev debug hide` | Shows Jev's raw answer for the last lookup, or hides it (hidden by default) |
| `/jev details top` / `/jev details status` | Where the debug values, the usage figure and the stats show: as rows on the top band (the default), or after the routing text on the status line |
| `/jev debuglog on` / `/jev debuglog off` | Starts or stops the lookup log (off by default, and off again in every new or reopened chat). See below, since it writes your prompts to a file |
| `/jev debuglog clear` | Empties the log. `/jev debuglog` alone says whether it is on and where the file is |
| `/jev log [n]` | Shows the last `n` logged lookups in the chat (5 by default, 20 at most) |
| `/jev topband show` / `/jev topband hide` | Shows or hides the band above the prompt (shown by default) |
| `/jev statusband show` / `/jev statusband hide` | Shows or hides the status line under the prompt (hidden by default) |
| `/jev help` | Lists these commands, the current state and the settings in use. A bare `/jev` does the same |

The same words without the slash (`jev on`, `jev off` and so on) also work when typed as a prompt on their own, but the desktop app then shows "A hook blocked your prompt" beside the result. Use the slash form to avoid that.

The band and the status line show the same routing text, for example `Jev: off`, `Jev: on (report) → sonnet` or `Jev: on (apply) → haiku`. The arrow points at the model Jev picked: in report mode the one it would pick, in apply mode the one the turn runs on. A failed lookup reads `Jev: on (apply) · no pick: <reason>`.

The debug values, the usage figure and the stats are the details. By default they show as rows under the routing text on the top band, which is full width and wraps. The desktop app draws the status line as one short line beside the model name, so a long one is cut off with "…" and shown in full only when you hover over it; it does not show line breaks. If you prefer the status line anyway, `/jev details status` puts the details after the routing text there, separated by `|`. What is shown is remembered across sessions. Routing itself starts off in a new chat.

### Usage

All the usage figures are TypeSafe's (Jev's), not Claude's. `/jev usage` prints them, one fact a line:

```
TypeSafe (Jev) usage, counting this router's lookups only:
This session: 12 requests, 8292 input tokens, 600 output tokens, about $0.000348
All sessions: 340 requests, 235000 input tokens, 17000 output tokens, about $0.009870
Rate-limited by TypeSafe: 0 times this session, 2 times in all
Cost is an estimate at $0.042 per million input tokens; output tokens are free (docs.typesafe.ai/models).
What is left: TypeSafe's API reports no balance or limit figures. Rate limits are set per organization and shown at console.typesafe.ai/rate-limits.
```

- **What is counted:** only the lookups this router makes, taken from the token counts TypeSafe returns with each answer. Other use of the same API key is not included. "All sessions" is kept in the mod's saved data and adds up across sessions, including ones open at the same time.
- **Cost:** input tokens times the published price, which is a constant at the top of `hooks/display.ts`. Update it if TypeSafe's price changes. It is an estimate, not an invoice.
- **What is left:** TypeSafe's API (`/v1/models` and `/v1/systemone` are all it has) returns no balance, quota or rate-limit figures, so the router cannot show how much you have left. Your organization's limits are in TypeSafe's developer console.

`money` shows the estimated cost, `tokens` the input tokens, and `limits` how many requests TypeSafe rate-limited (HTTP 429), each for this session and for all sessions. The figure updates after each lookup.

### Debug values

With `/jev debug show`, Jev's answer for the last lookup is added to the details:

```
depth 1.09, confidence 0.84, p 0/91/9/0% · stakes 0.28 · follow-up 0.02 · level 1
```

`depth` is the Score's position on levels 0 to 3, `confidence` how concentrated its probabilities are, and `p` the probability of each level. `stakes` and `follow-up` are Nouls, each a single probability, so they have no separate confidence. `level` is what the policy made of them.

### Stats

`/jev stats` shows, for each model in your `models` setting, what routing came to, for this session and for all sessions:

```
Jev routing stats, counting this router's lookups only:
This session:
  haiku: picked 5, applied 3 · 3 requests, 10200 input tokens, 1100 output tokens
  sonnet: picked 12, applied 12 · 31 requests, 80000 input tokens, 5200 output tokens
  opus: picked 1, applied 0 · 0 requests, 0 input tokens, 0 output tokens
  fable: picked 0, applied 0 · 0 requests, 0 input tokens, 0 output tokens
All sessions:
  ...
```

- **Picked** counts the lookups whose policy chose that model, in report mode too, where nothing is rerouted. **Applied** counts those made in apply mode.
- **Requests and tokens** are the Claude requests that actually ran on that model, which only happens in apply mode, with the tokens each reported. Input includes cached input. Subagents, and turns that were not routed, are not counted.
- A lookup that failed picked nothing, so it counts for no model. Models you remove from the `models` setting keep their old counts and are listed after the current ones.

`/jev stats show` adds two rows to the details: `Picked this session: haiku 5 · sonnet 12` and `Tokens in/out by model, apply mode: haiku 10.2k/1.1k · sonnet 80k/5.2k`. The `/jev stats` totals are kept in the mod's saved data and add up across sessions, including ones open at the same time.

### Reopening a chat

Each chat keeps its own routing state, under its session id, in the mod's saved data. When you reopen a chat, the mod picks it up again and shows a short notice, `Jev picked up where this chat left off: Jev: on (apply)`. What comes back:

- the routing mode (on or off, report or apply) and the mode last picked, so the band reads as you left it;
- the usage and routing stats counted in that chat, so `/jev usage` and `/jev stats` carry on from their last figures under "This session". The all-sessions totals are kept separately and are not affected.

What does not come back: the lookup log, which starts off in every chat because it writes your prompts to a file, and the last pick shown on the band, which is shown again after your next prompt. The display choices (which bands show, where the details show, the usage figure and the stats rows) are the same in every chat, whether new or reopened.

A new chat has no record, so it starts with routing off. The mod keeps the newest 50 chats and forgets older ones. A chat you reopen with a different session id, such as a fork or a copy, starts as a new one. The mod only knows a chat by its session id, so if your Claude app gave a reopened chat a new id, nothing would be found for it. A reopened chat that already has routing on (after `/reload-plugins`, say) keeps what it has instead.

### Lookup log

`/jev debuglog on` starts a log of every lookup the router makes, so you can see exactly what was asked, what Jev answered and which model the policy chose. It is **off by default and starts off again in every new or reopened chat**, because it writes what you type to a file. While it is on, the top band says `· logging`.

Each lookup adds one line of JSON to `jev-router/lookups.jsonl` in your Claude config folder (`~/.claude`, or `CLAUDE_CONFIG_DIR` if you set it). It is not written into any project, so it cannot be committed by accident. A line has:

- the time (UTC), the session id, the mode (`report` or `apply`), how long the request took in milliseconds, and the HTTP status;
- **your prompt text**, as sent to TypeSafe (the first 4,000 characters), and how many recent messages went along with it (their text is not logged);
- Jev's answers: the depth score, its confidence and the four level probabilities, and the `stakes` and `follow_up` probabilities;
- what the policy made of them: the level and the model picked, and the tokens the request was billed for;
- instead of the answers, `error` when the lookup failed.

`/jev log` prints the latest entries in the chat, one line each:

```
2026-11-16 14:03:11Z report → sonnet (level 1) · depth 1.09, confidence 0.84 · stakes 0.28 · follow-up 0.02 · 691 in/50 out · 112ms · "add a retry to the upload call in api/cl…"
```

The file is plain text, so you can also open it, or load it into a spreadsheet or a script. It holds at most about 800,000 characters: past that the oldest lines are dropped, so it never grows without end. `/jev debuglog off` stops adding to it, and `/jev debuglog clear` empties it; delete the file to remove it. If a write fails (a folder you cannot write to), the top band says `· log error` and `/jev debuglog` says why.

## Settings

Two options, set in the plugin's settings (`/config`, or `claude plugin configure jev-router`):

| Option | Default | Meaning |
| --- | --- | --- |
| `defaultMode` | `report` | The mode `/jev on` starts: `report` or `apply` |
| `models` | `haiku,sonnet,opus,fable` | The model for difficulty level 0, 1, 2 and 3, easiest first. Aliases or full model ids. With fewer than four, the last one covers the higher levels |

## How it decides

For each prompt you type, the mod sends one request to Jev with three questions (`hooks/policy.ts`):

- **depth** (Score, levels 0 to 3): how much reasoning the work needs, from a mechanical edit up to a task at the limit of difficulty.
- **stakes** (Noul): whether a mistake would be costly or hard to undo.
- **follow_up** (Noul): whether the prompt continues the task under way.

Code then applies the policy:

1. Take the level nearest the depth score.
2. If stakes is 0.6 or more, go up one level.
3. If follow_up is 0.6 or more, do not go below the level of the previous pick, so "yes, do it" stays on the model that made the plan.
4. Look the level up in `models`.

The thresholds are constants at the top of `hooks/policy.ts`. They are starting values, not tuned ones: run in report mode for a while and adjust them to your own prompts.

In apply mode the mod changes the model on each request of that turn's main loop. Subagents keep their own models, and turns that were not started by a typed prompt (background notifications, scheduled tasks) run on the session's model. If the lookup fails, times out after 5 seconds or the key is missing, the status line says so and the turn runs on the session's model.

## Things to know

- **Files the mod writes:** the mod's saved data (display choices, the usage and routing totals, and each recent chat's mode and counts, all as numbers and words, never prompts) under `~/.claude/plugins/store/`, and, only while you have turned the lookup log on, the log file above. It reads `TYPESAFE_API_KEY`, and the home and config folder variables to find the log; `claude plugin validate .` lists every environment variable and file call it makes.
- **What is sent to TypeSafe:** while routing is on, each prompt you type (its first 4,000 characters) and the text of the last 6 messages (600 characters each) go to `api.typesafe.ai`. Nothing is sent while it is off. Check that this fits your organization's data policy.
- **Prompt cache:** each model keeps its own prompt cache. In a long conversation, a turn routed to a different model re-reads the conversation without that cache, which can cost more than the cheaper model saves. Routing pays off most in short sessions or when most turns land on the same model.
- **Latency:** report mode does not hold the prompt back. Apply mode waits for Jev before the turn starts; the calls measured while building this took about 0.1 to 0.3 seconds.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

The tests in `tests/` run the mod against the engine with TypeSafe mocked, so they need no key and send nothing.

| File | What it holds |
| --- | --- |
| `hooks/register.tsx` | The hooks: the commands, the lookup, the band and status line, the model rewrite |
| `hooks/policy.ts` | The Jev questions and the level-to-model policy |
| `hooks/display.ts` | The text of the routing line, the usage figures, the debug values, the stats and the log lines |
| `types/index.d.ts` | The session state the mod keeps |
| `.claude-plugin/plugin.json` | The manifest and the two settings |
| `.claude-plugin/marketplace.json` | Makes this folder installable as a marketplace |
