---
name: Local OIDC integration test provider
description: Constraints for exercising the bundled openid-client flow against a local provider
---

Local OIDC integration tests must serve discovery, authorization, token, JWKS, and end-session endpoints over HTTPS. The bundled openid-client enforces HTTPS for discovered endpoints, so the test provider uses a temporary self-signed certificate and the child API process disables certificate verification only for the test.

**Why:** A plain HTTP mock provider is rejected before discovery or token exchange, which leaves callback coverage untested rather than exposing a meaningful application failure.

**How to apply:** Keep the provider ephemeral, verify PKCE and signed ID-token claims, and never carry the test-only TLS override into application or production configuration.