---
description: Smoke-test skill that verifies the Tyran plugin is installed and namespaced correctly. Invoke with /tyran:hello.
disable-model-invocation: true
---

# Hello (installation smoke test)

Reply with exactly one short paragraph:

1. Confirm the Tyran plugin is loaded and state its version by reading
   `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`.
2. State the resolved value of `${CLAUDE_PLUGIN_ROOT}` so the user can see
   where the plugin is installed from.

Do not perform any other action. This skill exists only to verify
installation, namespacing, and path resolution.
