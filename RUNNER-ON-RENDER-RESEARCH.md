# Parachute Runner on Render: Feasibility Research

**Date:** 2026-05-25  
**Scope:** Can `parachute-runner` execute autonomous agent jobs via `claude -p` on a Render Starter container ($7/mo, 512MB RAM, 1GiB persistent disk)?

---

## TL;DR

**Is it feasible?** Yes. Runner is explicitly designed for this ("friend-deploy ready against hub-as-supervisor on v0.6 single-container + Render" per `parachute-runner` README).

**Recommended approach:** Option A (bundled in the same container). Hub supervises runner alongside vault/scribe/app; runner spawns `claude -p` as a subprocess; all live in one Render web service backed by `/parachute` persistent disk.

**Biggest risk:** Auth ergonomics and operator-side setup friction. The CLI requires an ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN) in the container environment—operator must provide this via Render dashboard env var or hub admin UI (currently unsupported, would need a feature). Second-order risk: 512MB RAM is tight for concurrent jobs; recommend maxConcurrentJobs=1 initially.

**Unknowns requiring a spike:** 
- Does `claude -p` work headless (no TTY) in a container without interactive prompts hanging?
- What's the actual RAM footprint of `claude` native binary per invocation on a Starter box?
- Does credential refresh (CLAUDE_CODE_OAUTH_TOKEN) work reliably in a long-running container?

---

## Current Runner Shape (Phase 1.3)

**What ships:** Runner is a Bun daemon that polls a vault for `tag:job` notes, parses YAML frontmatter (schedule, model, allowed_tools, timeout), renders templates ({{date}}, {{job_name}}, {{run_id}}), synthesizes inline MCP config, and spawns `claude -p` per job. Outputs (success or failure) write back to vault as new notes.

**File references:**
- **README:** `/Users/parachute/ParachuteComputer/parachute-runner/README.md` — Phase 1.3 ships "friend-deploy ready...Render" explicitly.
- **Design doc:** `parachute.computer/design/2026-05-21-parachute-runner-design.md` — subprocess env scrubbing (trust-gradient-isolation), timeout handling, bearer credential security.
- **Spawn logic:** `parachute-runner/src/spawn.ts:spawnClaude()` — invokes `claude -p --strict-mcp-config --mcp-config '<json>' --allowedTools '<list>' --permission-mode bypassPermissions --model <model> --no-session-persistence --output-format text`, with prompt on stdin (file:158–207).
- **Concurrency:** `parachute-runner/src/scheduler.ts:9-13` — semaphore caps concurrent spawns at `maxConcurrentJobs`; default appears to be unset but the scheduling loop respects it.

**Lifecycle:**
- Long-running daemon (`parachute-runner serve`) with internal cron scheduler + HTTP healthz on `:1945`.
- Or one-shot (`parachute-runner once`) for external cron / manual invocation.
- Auto-registers to `~/.parachute/services.json` on first boot so hub sees it.

---

## Claude CLI vs Claude Agent SDK

### Claude Code CLI (current runner approach)

**Current distribution (April 2026):**
- Native binary (compiled Go/Rust, not JavaScript) shipped via `@anthropic-ai/claude-code` npm package.
- Install: `npm install -g @anthropic-ai/claude-code` or `curl -fsSL https://claude.ai/install.sh | bash`.
- **No Node.js required at runtime** — native binary has zero runtime dependencies (as of v2.1.113).
- Works on macOS, Linux, Windows; alpine-compatible.

**Authentication (non-interactive / headless):**
- Precedence chain per [code.claude.com/docs/en/authentication.md](https://code.claude.com/docs/en/authentication.md):
  1. Cloud provider env vars (CLAUDE_CODE_USE_BEDROCK, etc.) — not relevant here.
  2. `ANTHROPIC_AUTH_TOKEN` — bearer token for proxies/gateways.
  3. **`ANTHROPIC_API_KEY`** — direct Anthropic Console API key. In non-interactive mode (`-p`), always used when present.
  4. `apiKeyHelper` script — dynamic credentials (vault fetch, etc.).
  5. `CLAUDE_CODE_OAUTH_TOKEN` — long-lived OAuth token from `claude setup-token`. **Single-token auth for scripts/CI.**
  6. Subscription OAuth — requires browser login (interactive).

- **For a container:** Either set `ANTHROPIC_API_KEY` (Console key from https://console.anthropic.com) or `CLAUDE_CODE_OAUTH_TOKEN` (one-year OAuth token generated on-device with `claude setup-token`, then pasted into Render env).

**Headless behavior:**
- `claude -p "query"` runs one-shot, no TTY required.
- Runner passes the prompt via stdin (not as an arg), closes stdin immediately, collects stdout/stderr.
- No interactive prompts expected — the CLI should work headless in a container.

**Open questions:**
- Does the native binary silently fail if HOME is not writable or doesn't exist (container path)? The docs mention credentials stored at `~/.claude/.credentials.json` (Linux) — in a container, HOME is typically a tmpfs or non-writable layer unless explicitly mapped.
- When does credential refresh happen for CLAUDE_CODE_OAUTH_TOKEN? The auth docs don't specify; assume it's on-demand or long-lived (no refresh for a one-year token).

### Claude Agent SDK

**Current state (as of May 2026):**
- Agent Skills (the SDK layer for agents) is documented at [platform.claude.com/docs/en/agents-and-tools/agent-skills/overview.md](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview.md).
- SDK is **for building agents that use Skills (tools) within Claude's platform**, not a CLI replacement.
- Supported languages: Python, TypeScript, Node.js (references to `@anthropic-ai/claude-agent-sdk` in docs).
- No standalone command-line interface like `claude -p`.
- Requires the same auth chain (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, etc.) but uses programmatic APIs.

**For runner's use case (spawning short-lived agent jobs):**
- **Rejected.** The Agent SDK is for building persistent agent apps with sessions, memory, multi-agent orchestration. Runner's model is "spawn-and-exit per job" — simpler and more suitable for job substrate automation.
- `claude -p` is the right primitive here: stateless, subprocess-driven, no session overhead.

---

## Render Container Compatibility

### Constraints (Render Starter plan)

| Constraint | Value | Impact on Runner |
|---|---|---|
| **Memory** | 512 MB | Tight. See "Resource limits" below. |
| **CPU** | ~0.5 CPU (estimated, not officially stated) | Job spawning is I/O-bound (waiting for API), CPU-light. OK. |
| **Persistent disk** | 1 GiB at `/parachute` | Sufficient for vault data + runner config + job outputs. No problem. |
| **Ephemeral filesystem** | ~100MB (container layer) | `/parachute` is mounted, so runner's working dir + HOME can live there. OK. |
| **Process model** | Single container, signal-forwarded via tini | Hub's docker-entrypoint.sh handles this. Runner runs as a supervised child of hub. OK. |
| **Network egress** | Unrestricted HTTPS | anthropic.com:443 reachable. OK. |
| **Logging** | Render's log viewer (stdout/stderr) | Runner logs to stdout; Claude's output comes via stdout from the child process. Logs are readable. Minor: ANSI escapes in Claude's output may need stripping for some log viewers. |

### Filesystem considerations

**Credential storage:**
- `claude -p` expects `~/.claude/.credentials.json` (Linux) or macOS Keychain.
- In a container, HOME defaults to `/root` or a tmpfs unless explicitly set.
- **Problem:** On each Render redeploy, the ephemeral `/root` is wiped.
- **Solution:** Set `CLAUDE_CONFIG_DIR=/parachute/claude-config` (per auth docs, a supported override). This pins credential storage to the persistent disk.

**Runner's own state:**
- Config: `$PARACHUTE_HOME/runner/config.json` — already mounted at `/parachute`.
- Vault token: `$PARACHUTE_HOME/runner/secrets.db` (encrypted, AES-256-GCM) — already on persistent disk.
- Job outputs: written back to vault (not on disk).

**PATH and binary resolution:**
- Runner spawns `claude -p` by name (no full path). Relies on PATH to find the binary.
- Hub's Dockerfile (line 129) extends PATH: `/parachute/modules/bin:/usr/local/sbin:/usr/local/bin:...`
- When runner is installed via `parachute install runner`, it lands in `$BUN_INSTALL/install/global/node_modules/@openparachute/runner`.
- The native `claude` binary: if installed via `npm install -g @anthropic-ai/claude-code` under `$BUN_INSTALL`, it lands in `/parachute/modules/bin/claude` (via BUN_INSTALL_BIN).
- **Works as-is.** Hub's Dockerfile already pin BUN_INSTALL and BUN_INSTALL_BIN to the persistent disk.

### Authentication delivery to the container

**Current bottleneck:** Render's blueprint (`parachute-hub/render.yaml`) allows env vars via the dashboard, but there's no automated UI flow to collect ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.

**Operator experience (status quo):**
1. Operator gets a Render-assigned domain or brings their own.
2. Operator visits `/admin/setup` and creates an admin account.
3. Hub admin SPA launches; operator navigates to `/admin/modules` → "Install" → picks `runner`.
4. Current flow: config form collects `vault_url` + `vault_token` and submits to runner's PUT config endpoint.
5. **Missing:** the config form doesn't have fields for ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.

**Workaround (current):**
- Operator manually sets ANTHROPIC_API_KEY in Render's service environment variables (dashboard → Settings → Environment).
- Or: operator generates CLAUDE_CODE_OAUTH_TOKEN locally (`claude setup-token` on their machine), then pastes it into the dashboard.

**Longer-term improvement (out of scope for this spike):**
- Extend runner's config schema to include `anthropic_api_key` or `anthropic_oauth_token`.
- Hub's admin form would render fields for these (from `/.parachute/config/schema`).
- Runner stores them encrypted (like vault_token today).
- On spawn, runner injects ANTHROPIC_API_KEY into the child's env (or uses apiKeyHelper for dynamic refresh).

### Resource limits: RAM concern

**Calculation:**
- Hub itself: ~80–150 MB (Bun + Express-like server + DB).
- Vault module (if installed): ~50–100 MB.
- Scribe module (if installed): ~50 MB.
- Runner daemon: ~30 MB (Bun + scheduler + HTTP).
- **In-flight `claude -p` job:** Native binary footprint unknown. Estimate 50–150 MB per invocation (includes model inference, context buffering).

**Scenario:**
- Starter plan: 512 MB total.
- Hub + vault + scribe + runner: ~250 MB.
- Remaining: ~260 MB.
- **One concurrent job:** fits (single job ~100–150 MB).
- **Two concurrent jobs:** likely OOM kill on one or both.

**Recommendation:** Set `maxConcurrentJobs=1` initially. Monitor RAM during a live job; if consistent headroom exists, increase to 2. Long jobs with large prompts (>10KB) or broad vault queries may push the memory footprint upward.

**Note:** Runner's design doc acknowledges this: "OOM risk on the parent process remains a residual risk worth monitoring during Phase 2 health-check development."

---

## Architecture Options

### Option A: Bundled in the same container ← **RECOMMENDED**

**Setup:** Hub supervises runner as a sibling service alongside vault/scribe/app. All share one Render container, one persistent disk at `/parachute`, one IP + port (hub on :1939, runner on :1945 internally, both exposed via hub's proxy).

**Pros:**
- Minimal complexity. Uses existing hub-as-supervisor pattern (tini/gosu already in Dockerfile).
- Single image build, single Render service, single $7/mo cost.
- Fast inter-service communication (localhost loopback).
- Job outputs write directly to vault (both in-process, same container, same disk).
- Credential auth happens once on container boot (operator sets ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in Render dashboard).

**Cons:**
- 512MB RAM is shared across all services. If operator also runs vault + scribe + app, concurrency is severely limited (maxConcurrentJobs=1 is likely).
- If a job run causes OOM, it may crash the entire hub + all modules.
- No isolation: a runaway `claude -p` can consume all CPU or disk I/O, impacting hub responsiveness.

**Verdict:** Right for v0.6 single-container "good defaults" phase. Fine for owner-operated, trusted-vault use case (see CLAUDE.md governance note on trust-gradient-isolation).

### Option B: Separate Render service

**Setup:** Runner gets its own Render web service ($7/mo + $7/mo for hub = $14/mo total). Runner calls hub via HTTP (using hub-issued JWT with `runner:admin` scope) to access vault.

**Pros:**
- Isolation: runner's OOM doesn't crash hub.
- More headroom: runner could upgrade to a larger plan without paying for hub to scale.
- Architectural pattern matches future multi-container cloud deployment.

**Cons:**
- **Double cost** ($14/mo instead of $7/mo for friend-deploy use case).
- Cross-service HTTP adds latency, complexity, failure modes (network partition, auth token refresh timing).
- Vault token storage on runner's disk is separate from hub's — credential rotation must sync across two disks.
- Overkill for owner-operated single-operator vaults with low job volume.

**When to prefer:** Multi-tenant Parachute Cloud (many operators sharing one hub deployment). Not for v0.6.

### Option C: Cron-fired one-shot runner

**Setup:** Instead of `parachute-runner serve`, use `parachute-runner once` invoked by an external cron job (e.g., a Render cron service, or a GitHub Actions workflow triggered on schedule).

**Pros:**
- No persistent daemon overhead (runner doesn't consume RAM while idle).
- Good for low-frequency schedules (e.g., daily jobs).

**Cons:**
- Adds operational friction: operator must configure cron externally.
- No internal cron table — each job must be a separate cron entry or a wrapper script.
- Render's cron service is a separate resource (cost TBD, likely not free).
- Job startup latency (container cold-start, bun parsing, vault poll) adds overhead per invocation.

**When to prefer:** Very low-frequency jobs (< 1 per day) where daemon overhead is wasteful. Not general-purpose.

### Option D: Direct Claude API (no CLI/SDK)

**Setup:** Runner directly calls the Anthropic API (`POST /v1/messages`) instead of spawning `claude -p`. Uses `@anthropic-ai/sdk` (Node.js SDK).

**Pros:**
- No CLI install/PATH/binary-resolution headaches.
- Direct control over model selection, parameters, streaming.
- Smaller footprint (SDK is a library, no subprocess overhead).

**Cons:**
- **Loses tool/MCP support.** Runner's MCP config synthesis is built for `claude -p --mcp-config`. Direct API calls don't read MCP config from a file; you'd need to manually translate vault MCP endpoints into tool_use format. Significant refactoring.
- Loses the trust-gradient-isolation pattern (no subprocess env scrubbing; API key is visible in the runner's process).
- Less compatible with "Claude-in-containers" framing of the parachute-agent predecessor.

**When to prefer:** Jobs that don't need MCP tools. Not general-purpose for a vault-as-job-substrate engine.

---

## Open Risks & Unknowns

### High-confidence unknowns (worth a spike)

1. **Headless `claude -p` behavior in a container:**
   - Current assumption: native binary works non-interactively when stdin is closed.
   - Unknown: does the CLI ever prompt for input (e.g., "choose model" if not specified)? Does it hang waiting for a TTY? Do ANSI escape codes in output cause issues in containerized logs?
   - **Spike:** Run `claude -p "hello" < /dev/null` in an alpine container; capture stdout/stderr/exit code. Repeat with a multi-line prompt and allowed_tools arg.

2. **RAM footprint of `claude` native binary per invocation:**
   - Current assumption: ~50–150 MB per job (educated guess from similar CLI tools).
   - Unknown: actual measurement on a 512MB box running a typical job (e.g., 5KB prompt, query-notes MCP tool, 10s execution).
   - **Spike:** Deploy runner on Render Starter, instrument with `/proc/self/status` logging, run a job, measure peak RSS. Repeat with 2KB and 20KB prompts.

3. **Credential refresh for long-running containers:**
   - CLAUDE_CODE_OAUTH_TOKEN is claimed as "one-year" in docs, but no refresh strategy is specified.
   - Unknown: if the token is revoked / expires mid-deployment, does the runner gracefully fail or hang?
   - **Spike:** Generate a token, wait 5 minutes, attempt a job spawn. Check if the CLI retries or asks for re-auth.

4. **CLAUDE_CONFIG_DIR persistence on Render redeploy:**
   - Setting `CLAUDE_CONFIG_DIR=/parachute/claude-config` should keep credentials on the persistent disk.
   - Unknown: does the Dockerfile / entrypoint need adjustment to ensure this dir is created with correct ownership (bun:bun)?
   - **Spike:** Add CLAUDE_CONFIG_DIR to render.yaml, deploy, verify `ls -la /parachute/claude-config` post-boot.

### Lower-confidence risks (watch, don't spike yet)

- **Cost runaway:** If a job prompt is large or makes many vault queries, Anthropic API costs could balloon. No built-in cost control. Runner's timeout (default 600s) is the only brake.
- **Vault availability:** If vault is unavailable or slow, jobs block on MCP config synthesis (`parachute-vault mcp-config` call). Could cascade into timeout failures. Mitigation: vault and runner coexist in the same container, so vault availability = container health.
- **Logging noise:** Claude's verbose output (model selection, tool calls, etc.) may fill logs. Minor: Render's log viewer is generous with storage, but searching logs becomes harder.
- **Signal forwarding on container restart:** tini `-g` (process group signal forwarding) is in the Dockerfile (line 161), so SIGTERM should propagate to runner's child jobs. **Assumption:** a job in-flight when Render issues a stop signal will get SIGTERM → graceful shutdown per runner's scheduler (line 120–137). **Risk:** if a `claude -p` process doesn't respect SIGTERM, Render's grace period (30s?) may expire before shutdown completes.

---

## Recommended Next Step

**Spike: "Runner on Render Starter – Headless Auth + Memory Test"**

**Scope:** 2–4 hours of investigation + 1 hour live deploy test.

**Deliverable:** A document confirming (or refuting) these assertions:
1. Native `claude -p` works headless (no TTY, stdin closed) without hanging or prompting.
2. A typical job (5KB prompt, one MCP query) fits in <100MB on a Starter box.
3. CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY can be reliably injected via Render env var and read by the native binary on container boot.
4. CLAUDE_CONFIG_DIR=/parachute/claude-config survives redeploys and is owned by bun:bun.

**Steps:**
1. Build a minimal test harness:
   ```bash
   docker run --rm -e ANTHROPIC_API_KEY=<key> \
     -e CLAUDE_CONFIG_DIR=/tmp/claude \
     --entrypoint /bin/sh \
     oven/bun:1.3-alpine \
     -c "echo 'what is 2+2?' | claude -p"
   ```
   Verify exit code, stdout (should be "4"), no hanging.

2. Deploy runner to Render Starter (either Option A bundled with hub, or a test runner instance).
3. Create a minimal job note with `schedule: manual` and `allowed_tools: []` (no MCP).
4. Trigger via `/runner/jobs/<path>/run-now` HTTP endpoint or `parachute-runner once --only <path>`.
5. Monitor Render metrics (memory, CPU, duration). Log the output note.
6. If successful, scale: add an MCP-using job (query-notes) and measure again.

**Success criteria:**
- Job completes in <30s with "ok" status.
- No OOM kill on 512MB Starter.
- Output note contains the expected result.
- Logs are readable (no hung processes, no timeout).

**Failure modes to watch:**
- "command not found: claude" → PATH not including /parachute/modules/bin (Dockerfile issue).
- "unauthorized" or "401" → ANTHROPIC_API_KEY not set or incorrect (Render env var issue).
- Job timeout or empty stdout → `claude -p` hanging (TTY/headless issue).
- OOM after ~5s → memory footprint is worse than estimated (re-evaluate concurrency).

---

## Why This Matters

If runner works on Render Starter, the Parachute Cloud v0.6 shape is complete: **a $7/mo self-hosted box that includes vault (knowledge graph), app (UI), scribe (transcription), and now runner (autonomous agents).** No separate execution substrate, no Lambda/K8s, no vendor lock-in. Operators can automate workflows—daily summaries, periodic data refreshes, smart actions triggered by vault notes—without leaving the Parachute ecosystem.

This validates Aaron's "trust-gradient-isolation" / "owner-operated" framing. If agent execution lives in the same trusted container as the vault, there's no need for complex multi-tenant sandboxing (the parachute-agent retirement rationale). Runner becomes the lightweight automation substrate for Phase 2 and beyond.
