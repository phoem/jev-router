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

The band above the prompt shows the state with a button for each other mode: **Report only**, **Apply** and **Off**. Click one to switch.

Everything is also a `/jev` command:

| Command | What it does |
| --- | --- |
| `/jev on` | Turns routing on for this session, in the default mode (report unless you changed it) |
| `/jev report` | Shows the model Jev would pick for each prompt and changes nothing |
| `/jev apply` | Runs each turn on the picked model |
| `/jev off` | Turns it off: nothing more is sent to TypeSafe |
| `/jev status` | Shows the current state |
| `/jev topband show` / `/jev topband hide` | Shows or hides the band above the prompt (shown by default) |
| `/jev statusband show` / `/jev statusband hide` | Shows or hides the status line under the prompt (hidden by default) |
| `/jev help` | Lists these commands, the current state and the settings in use. A bare `/jev` does the same |

The same words without the slash (`jev on`, `jev off` and so on) also work when typed as a prompt on their own, but the desktop app then shows "A hook blocked your prompt" beside the result. Use the slash form to avoid that.

The band and the status line show the same text, for example `Jev: off`, `Jev: on (report only) · would pick sonnet` or `Jev: on (routing) · this turn runs on haiku`. Which of the two is shown is remembered across sessions. Routing itself always starts off in a new session.

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
| `hooks/register.ts` | The hooks: the toggle, the lookup, the status line, the model rewrite |
| `hooks/policy.ts` | The Jev questions and the level-to-model policy |
| `types/index.d.ts` | The session state the mod keeps |
| `.claude-plugin/plugin.json` | The manifest and the two settings |
| `.claude-plugin/marketplace.json` | Makes this folder installable as a marketplace |
