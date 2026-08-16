---
name: acp
description: Runs git add + commit in one step. Use this skill when the user says "acp", "commit", "add and commit", or similar. Analyzes the changes, auto-generates a commit message, and commits without a Co-Authored-By line.
disable-model-invocation: true
allowed-tools: Bash(git status *) Bash(git diff *) Bash(git log *) Bash(git add *) Bash(git commit *)
---

# acp Skill

## Purpose

Run `git add` → `git commit` in sequence.
The commit message is auto-generated from the diff. **Never include a Co-Authored-By line.**

---

## Steps

### Step 1 — Inspect changes

Run these in parallel to understand the current state.

```bash
git status
git diff
git log --oneline -5
```

- `git status` — which files changed, added, or deleted
- `git diff` — actual content changes (basis for the commit message)
- `git log --oneline -5` — learn this repo's commit message style

### Step 2 — Write the commit message

Follow the style observed in git log.

**Rules:**

- Follow Conventional Commits format: `<type>(<scope>): <description>` — e.g. `feat(auth): add login`, `fix: correct null check`, `chore(deps): bump vite`
- Accurately summarize what changed and why
- Match the repo's existing style (prefix conventions, language, etc.)
- **Do not include a Co-Authored-By line**

### Step 3 — Stage and commit

Stage only the relevant changed files, then commit.

```bash
git add <changed files>
```

Pass the commit message via HEREDOC to avoid escaping issues:

```bash
git commit -m "$(cat <<'EOF'
commit message here
EOF
)"
```

---

## Constraints

- Never use `git add -A` or `git add .` — specify files explicitly to avoid accidentally staging sensitive files (.env, credentials, etc.)
- Never include a `Co-Authored-By:` line in the commit message
- Do not create an empty commit when there are no changes
