---
name: Package install config side effect
description: Workspace package installation can add unrelated protected Replit configuration
---

After a workspace package install, inspect `.replit` for unrelated Nix configuration changes before finishing.

**Why:** A package install added a `[nix]` channel block to a Node-only workspace, creating configuration drift unrelated to the code change.

**How to apply:** If the block is not part of the project’s intended setup, restore the prior file through the protected configuration validation flow rather than editing `.replit` directly.