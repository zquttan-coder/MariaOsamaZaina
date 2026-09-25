---
name: Python shell side effect
description: Replit workspace configuration can change when Python is invoked from shell commands
---

Running a Python command from the shell may cause Replit to add `python-base-3.13` to the `.replit` modules list even when the project is Node-only.

**Why:** This adds unrelated configuration drift to an otherwise focused change and can affect the project’s configured runtime modules.

**How to apply:** Prefer Node or shell tooling for quick checks in Node workspaces. If Python is invoked, inspect `.replit` afterward and restore it through the protected configuration validation flow if it changed.