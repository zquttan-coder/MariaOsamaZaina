---
name: Workspace links before browser checks
description: Fresh workspace prerequisites for running Vite browser validation reliably.
---

Run the workspace package install and build referenced library declarations before browser validation. A missing local workspace link or declaration can make Vite show an import-error overlay, causing a browser test to report absent UI for the wrong reason.

**Why:** The frontend depends on local workspace packages whose symlinks and declaration outputs may not exist in a fresh or partially restored workspace.

**How to apply:** Before diagnosing a browser test as an application failure, verify workspace links and run the library typecheck/build step; keep the browser assertion focused on the rendered product behavior.