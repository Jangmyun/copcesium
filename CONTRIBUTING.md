# Contributing to copcesium

Thanks for your interest in contributing! This project is a CesiumJS provider for streaming
[COPC](https://copc.io/) point clouds — contributions of all sizes are welcome, from typo fixes
to new features.

## Getting started

```bash
git clone https://github.com/Jangmyun/copcesium.git
cd copcesium
npm install
```

Requires Node.js 22 (matches CI).

### Common commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Build the library (`vite build` + type declarations) |
| `npm test` | Run the test suite (`vitest`) |
| `npm run lint` | Lint `src/` |
| `npm run lint:fix` | Lint with autofix |
| `npm run format` | Format `src/` and `examples/` with Prettier |

To try changes against a real viewer, run one of the example apps:

```bash
cd examples/basic-viewer
npm install
npm run dev
```

## Making a change

1. Open an issue first for anything beyond a trivial fix, so the approach can be discussed before
   you invest time in it.
2. Branch off `main`. This repo doesn't enforce a naming scheme, but branches are typically named
   `<type>/<issue-number>-<short-description>` (e.g. `fix/86-node-fetch-cancellation`).
3. Keep changes focused — a PR should do one thing. Don't refactor unrelated code or reformat
   files you didn't otherwise need to touch.
4. Match the existing code style; `npm run lint` and `npm run format` enforce it automatically.
5. Add or update tests for behavior you change. `npm test` must pass.
6. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `build:`, ...) — see `git log` for examples.

## Submitting a pull request

- Fill out the PR template — it asks for a summary, the related issue, and how you tested the
  change (unit tests, manual viewer testing, and/or real COPC data).
- Make sure CI passes: build, tests, and lint all run on every PR.
- Small, reviewable PRs get merged faster than large ones.

## Reporting bugs / requesting features

Use the issue templates (bug report, feature request, question) — they ask for the context
maintainers need to act on the report quickly.

## Security issues

Please don't open a public issue for security vulnerabilities — see [SECURITY.md](./SECURITY.md).
