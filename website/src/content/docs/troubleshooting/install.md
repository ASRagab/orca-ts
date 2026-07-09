---
title: Install Troubleshooting
description: Common npm package, binary install, and PATH problems.
---

## `bunx -p @twelvehart/orcats orcats` cannot find the local CLI

Install the package in the project first:

```bash
npm i @twelvehart/orcats
```

Then retry from the same project directory:

```bash
bunx -p @twelvehart/orcats orcats --version
```

## Standalone `orcats` is not found

The installer defaults to `$HOME/.local/bin`. Add it to `PATH` if your shell does not already include it:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Then retry:

```bash
orcats --version
```

## Checksum or download failure

Download the tarball and `SHA256SUMS.txt` from the GitHub Release, verify the checksum with `shasum -a 256 -c SHA256SUMS.txt` or `sha256sum -c SHA256SUMS.txt`, then move `orcats` onto `PATH`.

## Unsupported platform

Windows and musl/Alpine users should build from source for now.
