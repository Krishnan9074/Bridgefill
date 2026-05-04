# Repository Instructions

- Never mock external services, LLM providers, or API integrations in this repository.
- If a real LLM call is needed, require a real API key from the environment and use the actual provider.
- Prefer conditional live-integration tests over mocked behavior when credentials are unavailable.
