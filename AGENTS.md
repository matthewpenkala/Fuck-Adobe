# Repository instructions

These instructions apply throughout this repository. Follow the user's current task and any applicable, more specific repository instructions.

## Context

This is a collection of practical Adobe workarounds, primarily After Effects expressions. Read [README.md](./README.md) and the documentation for the tool you are changing before editing.

- [Expressions](./Expressions): expression source, often embedded in Markdown alongside setup, behavior, and limitations. Editing a code block is a code change.
- [JSX scripts](./JSX-Plugins): After Effects scripts; see the [installation instructions](./JSX-Plugins/Instructions.md) and each script's own requirements.
- [Effects](./Effects): packaged effects and [installation instructions](./Effects/Instructions.md).
- [Keyboard shortcuts](./Keyboard-Shortcuts): separate macOS and Windows presets.

## Keep documentation in the same change

**A change is not complete until the affected README links, descriptions, and usage instructions match it. Make those edits yourself as part of implementation, without waiting for a separate documentation request.**

Review the files you added, changed, moved, renamed, or deleted against the root README and relevant documentation:

| Change | Required documentation work |
| --- | --- |
| Add a user-facing expression, script, effect, or preset | Document its purpose, setup, and relevant limits in the file or appropriate nearby instructions. Ensure readers can find it through the README's existing navigation; add navigation for a new category. Add a highlight only when it merits one. |
| Rename or move a file, directory, or documented heading | Search for the old path, filename, and affected anchor; repair incoming links and references, including those in the README and this file. |
| Delete or replace a documented tool | Remove or redirect its links and descriptions. Document a replacement only if it exists and serves the stated purpose. Check category links if a directory disappears. |
| Change behavior, controls, setup, dependencies, compatibility, or limitations | Update the tool's documentation and any README statement made inaccurate by the change. |
| Refactor internals, add tests, or change tooling without affecting the reader's view | Review the README for impact; leave it unchanged when its navigation and claims remain accurate. |

The README is a short introduction with selected highlights, not an exhaustive file inventory or changelog. An existing category link can already make a new file discoverable. Do not add a bullet for every file or rewrite accurate copy just to produce a README diff.

Use relative repository links, exact filename casing, and valid fragment targets. Search references with `rg -n --hidden -g '!.git/**' -F -- 'old-name-or-path' .` or an equivalent repository search that includes hidden configuration directories. Read the implementation before describing behavior; a filename alone is not evidence.

## README voice and formatting

- Keep the established casual, irreverent voice and contempt for Adobe. Avoid sanitizing it into corporate copy or intensifying it with extra insults, fashionable slang, and rehearsed punchlines.
- Keep tool descriptions plain, concise, and technically accurate. Use bold linked names for highlights and normal-weight descriptions. Let the work demonstrate expertise; do not add claims about the author's mastery.
- Preserve the authored opener and AI-authorship note unless the user asks to revise them. The opening sentence is bold except for the asterisk; `[**I**\*](#ai-authorship)` keeps the bold I and normal-weight asterisk in one link. Preserve its destination anchor and the blockquoted note.
- Put detailed setup, exceptions, and validation evidence in the individual tool docs, not the root README. Keep agent instructions in this file.

## Generated repository title

The heading between `<!-- repo-title:start -->` and `<!-- repo-title:end -->` is maintained by [.github/workflows/update-readme-title.yml](./.github/workflows/update-readme-title.yml) using `GITHUB_REPOSITORY`.

- Preserve exactly one ordered pair of markers. Ordinary documentation edits belong outside that region.
- The workflow synchronizes the title only; the coding agent is responsible for maintaining the README body.
- If changing title generation, preserve all bytes outside the marker region, Markdown-escape the repository name, and fail without writing on missing, duplicate, or reversed markers. Keep unchanged runs as no-ops and never force-push.

## Validation and delivery

- Inspect `git status --short` before editing and before finishing. Preserve unrelated changes; stage only the requested files. Keep temporary previews and research outside the repository.
- This collection has no repository-wide build or test command. Use checks appropriate to the changed tool and its documented runtime; do not invent package-manager commands or assume JSX/AE APIs run in Node.js.
- For behavior changes, check representative normal and edge cases. Distinguish static or mathematical checks from execution inside After Effects or Premiere; report host validation as unavailable when it was not performed.
- For documentation changes, verify affected links and anchors and inspect the rendered Markdown when formatting changes. Check descriptions against the final implementation.
- Run `git diff --check`; also run `git diff --cached --check` when changes are staged. Review added/untracked files as well as the tracked diff.
- For title-workflow changes, run `actionlint .github/workflows/update-readme-title.yml` if available and exercise the embedded generator with the current name, a name containing underscores, an unchanged title, and malformed markers. Check body preservation and no-write behavior on invalid input. Report unavailable checks.
- In the handoff, state which documentation changed, or briefly why no documentation update was needed, and summarize validation and remaining limitations.
- Follow the user's requested staging, review, commit, and publishing scope. Completing code and documentation does not itself authorize a commit or push.

Keep this file current when repository conventions change. Prefer one shared set of instructions; add nested or tool-specific files only when a real scope or compatibility need appears.
