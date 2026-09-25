---
name: API validation prerequisites
description: Requirements for running database-backed API validation in a fresh workspace
---

API package validation depends on the workspace library declarations being generated and the development database schema being applied first.

**Why:** The API imports types and schemas from workspace libraries whose committed declaration output may be stale, and a fresh development database may not yet contain the application tables. Without both prerequisites, validation fails before exercising the API.

**How to apply:** Run the repository library typecheck/build step before API typechecking, and apply the existing development database schema command before running tests that create or query database records. Do not treat either setup step as a production migration.