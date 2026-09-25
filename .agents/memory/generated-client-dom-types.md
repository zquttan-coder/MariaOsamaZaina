---
name: Generated client DOM types
description: TypeScript lib requirements for Orval-generated fetch helpers
---

When OpenAPI endpoints gain query parameters, the generated React client may use `Headers.entries()` while merging request headers. Keep `dom.iterable` enabled in the API client package's TypeScript `lib` list.

**Why:** The generated helper compiles against the DOM `Headers` type, and `dom` alone does not expose its iterable methods.

**How to apply:** If codegen adds or refreshes generated fetch helpers and TypeScript reports that `Headers.entries` is missing, check the API client `tsconfig.json` before changing generated files.