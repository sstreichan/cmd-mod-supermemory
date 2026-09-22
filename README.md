# cmd-mod-supermemory

A [Command Code](https://commandcode.ai/docs/mods) mod that gives your agent persistent memory,
backed by [Supermemory](https://supermemory.ai) — project knowledge that survives sessions, plus
personal preferences scoped to the repository you are in.

**Tested against** Command Code 0.1.37 / `@commandcode/harness` 0.1.0. The ModApi is documented as
*experimental* — pin the version you ship against.

## What it does

- **Project memory** — architecture, conventions, setup steps, accepted decisions (`scope: "project"`)
- **Personal memory** — your preferences for this repo (`scope: "user"`)
- **Automatic capture** — saves the conversation at run end (`onRunEnd`)
- **Automatic recall** — injects a first-message context block plus a per-turn recall directive
- **Repo-scoped** — memories are keyed by a container tag derived from the git remote
  (`repo_<name>__<hash>`), so two clones of the same repo share memory and unrelated projects
  never collide. Outside a git repo the absolute path is used instead.

Without an API key the mod still loads, notifies you once, and does nothing else:

```
supermemory: no API key — set SUPERMEMORY_API_KEY or --mod-option api-key=sm_...
```

## Install

```bash
# 1. drop-in file
cp supermemory.ts ~/.commandcode/mods/

# 2. local directory, referenced in place (user scope)
cmd mods add -g ./

# 3. from git
cmd mods add owner/repo
```

The package manifest declares the mod file explicitly:

```json
{"commandcode": {"mods": ["./supermemory.ts"]}}
```

## Configure

Set the API key in one of these — first match wins:

1. `--mod-option api-key=sm_...`
2. `apiKey` in `~/.commandcode/supermemory.jsonc`
3. the `SUPERMEMORY_API_KEY` environment variable

The base URL follows the same order (`base-url`, `baseUrl`, then `SUPERMEMORY_API_URL` /
`SUPERMEMORY_BASE_URL`), defaulting to `https://api.supermemory.ai`.

Everything else lives in `~/.commandcode/supermemory.jsonc` — see
[`supermemory.jsonc.example`](./supermemory.jsonc.example) for the full list with defaults:

| Key | Default | Meaning |
|---|---|---|
| `similarityThreshold` | `0.55` | Minimum similarity for retrieval |
| `maxMemories` | `5` | Memories injected per request |
| `maxProjectMemories` | `10` | Project memories in the first-message context |
| `maxProfileItems` | `5` | Profile facts injected per section |
| `injectProfile` | `true` | Include the Supermemory user profile |
| `autoIngest` | `true` | Save the conversation at run end |
| `autoRecall` | `true` | Append the recall directive each turn |
| `captureEveryNTurns` | `3` | Save every N messages (`0` = one batch at session end) |
| `compactionThreshold` | `0.8` | Context ratio that triggers the compaction injection |
| `keywordPatterns` | `[]` | Extra regexes that trigger the "remember this" nudge (added to the defaults) |
| `projectContainerTag` / `userContainerTag` | – | Extra container tags to read on top of the derived one |

The numeric and boolean keys are also settable per launch as flags, e.g.
`cmd --mod-option api-key=sm_... --mod-option max-memories=8`. `supermemory.jsonc` may contain
`//` and `/* */` comments.

## Usage

The model can call the `supermemory` tool directly, or you can drive it:

| Command | Does |
|---|---|
| `/memory add <text>` | Store a memory |
| `/memory search <query>` | Search memories |
| `/memory profile [query]` | Show the user profile |
| `/memory list [scope]` | List recent memories |
| `/memory forget <id>` | Delete a memory |
| `/memory help` | Usage guide |
| `/supermemory-index` | Explore the codebase and store architecture as project memory |

Tool modes: `add`, `search`, `profile`, `list`, `forget`, `help`. `scope` is `project` (default)
or `user`. Types: `project-config`, `architecture`, `error-solution`, `preference`,
`learned-pattern`, `conversation`.

## Privacy

- Wrapping text in `<private>…</private>` redacts it before it is sent to the API.
- Content that is *only* private is never stored — `add` rejects it and automatic capture skips it.
- Automatic capture truncates each message to 2000 characters and one batch to 100,000 characters.

Automatic capture is on by default. Turn it off with `"autoIngest": false` if you would rather
decide per memory.

## How it works

| Hook | Does |
|---|---|
| `transformInput` | Detects "remember this"-style keywords in typed prompts (outside code blocks) and prepends a nudge telling the model to store the memory |
| `appendSystemPrompt` | Injects the profile, project knowledge and relevant memories **once per session**, then the recall directive every turn |
| `onRunEnd` | Batches the conversation and stores it as a `conversation` memory |
| `onTurnEnd` | Near context capacity, injects a project-facts reminder so compaction keeps them |

The `appendSystemPrompt` output is deliberately kept **byte-stable per session** — the context is
fetched once via a closure flag and the directive is a constant, because the provider's
prompt-prefix cache keys off the system prompt bytes. Do not turn the one-time fetch into a
per-round fetch.

## Development

```bash
npm install
npm run typecheck        # tsc --noEmit
```

Try it without installing:

```bash
cp ~/.commandcode/supermemory.jsonc.example ~/.commandcode/  # optional
cmd --mod ./supermemory.ts
```

Then `/reload` after editing — mods load once per process. Verify registration with
`cmd mods list`; it must list `supermemory` with no load warning.

### About `types/commandcode-harness.d.ts`

The harness is bundled inside the Command Code app and ships **no** `.d.ts` files, so this repo
carries a small hand-written type surface for the `ModApi` members the mod uses, wired up through
`compilerOptions.paths`. It is a convenience for `tsc` and your editor — the
[mods documentation](https://commandcode.ai/docs/mods) is the source of truth. It is intentionally
permissive: when something needs to be loosened, loosen the shim, not the mod.

## License

MIT
