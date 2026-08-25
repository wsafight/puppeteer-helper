---
name: pptr-helper-render
description: Render webpages to images or PDFs and extract structured page data with pptr-helper. Use for deterministic browser output, remote Chrome, guarded extraction, or bounded batch rendering through the pptr-helper JSON CLI. Do not use for general interactive browsing that depends on an existing signed-in browser session.
---

# pptr-helper Render

Use the JSON CLI for screenshots, PDFs, structured extraction, browser provisioning, and batches. Use the TypeScript API only when the task requires page hooks, a custom request callback, or another operation that cannot be represented as JSON.

## Workflow

1. Confirm Node.js 24 or newer and that `pptr-helper` is installed in the working project. Inside the pptr-helper source repository, run `pnpm build` before using `node bin/pptr-helper.mjs`.
2. Read [references/cli.md](references/cli.md) for the selected action and create a JSON request at a task-scoped path. Use explicit output paths for images and PDFs; omit the path only when base64 output is actually needed.
3. Run `pnpm exec pptr-helper --input <request.json>`. In the source repository, run `node bin/pptr-helper.mjs --input <request.json>`.
4. Parse the JSON response. Preserve structured error codes and report output paths plus relevant metadata such as status, attempts, timing, and final URL.
5. Remove task-scoped request files only when cleanup is part of the user's request or normal temporary-file handling.

## Safety

For untrusted or AI-selected URLs, set a narrow `renderer.security.allowlist`, keep `allowPrivateNetwork` false, and configure request and byte limits. Do not broaden an allowlist merely to make a failing request succeed. These controls are browser guardrails, not a replacement for container or operating-system network isolation.

Do not place secrets in request JSON committed to the repository. Remote browser headers, proxy credentials, cookies, and HTTP credentials may be sensitive; use task-scoped files and existing secret injection mechanisms.

## Advanced API

Read [references/api.md](references/api.md) only when the CLI schema is insufficient. Keep retries opt-in for tasks with side effects, close every renderer in `finally`, and prefer result methods when metadata is useful.
