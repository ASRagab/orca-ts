---
title: Install Troubleshooting
description: Common npm package, binary install, and PATH problems.
---

## `npx orca` cannot find the local CLI

Install the package in the project first:

```bash
npm i @twelvehart/orca-ts
```

Then retry from the same project directory:

```bash
npx orca --version
```

## Standalone `orca` is not found

The installer defaults to `$HOME/.local/bin`. Add it to `PATH` if your shell does not already include it:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Then retry:

```bash
orca --version
```

## Checksum or download failure

Download the tarball and `SHA256SUMS.txt` from the GitHub Release, verify the checksum with `shasum -a 256 -c SHA256SUMS.txt` or `sha256sum -c SHA256SUMS.txt`, then move `orca` onto `PATH`.

## Unsupported platform

Windows and musl/Alpine users should build from source for now.
