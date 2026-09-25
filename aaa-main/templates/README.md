# Project templates

`default-project/` is copied into every new AAA project. It is a reference example of the agents, skills, prompts, and MCP configuration AAA can run. Replace its contents with your own tuned versions for the target environment.

| Path | Purpose |
| --- | --- |
| `.github/agents/*.agent.md` | Agents shown in the composer picker. The body is the agent's instructions. `tools` is retained for VS Code compatibility but never narrows AAA: all enabled built-ins and MCP servers are available. Optional `foundry-*` frontmatter delegates the selected agent to an environment-referenced Foundry Responses endpoint. |
| `.github/skills/<id>/SKILL.md` | Skills the agent loads with `load_skill`. Put files the skill copies under the skill's `assets/` folder. |
| `.github/prompts/*.prompt.md` | Slash commands. The `agent` frontmatter picks the agent that runs the prompt. |
| `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` | Editable standing instructions. Instruction files can use `applyTo` globs. |
| `.vscode/mcp.json` | HTTP MCP servers (`"type": "http"`, `"url"`, optional environment-referenced headers/auth). |
| `evidence/` | Provenance guidance and the default `evidence/screenshots/` target for captures and root-level image uploads. |
| `security-package/` (optional) | Starting package files. If absent, AAA copies `.github/skills/initialize-security-package/assets/security-package-template/` when that folder exists. |

AAA does not execute scripts. A skill that needs to create files should copy them from its `assets/` folder with the `copy_path` tool, or write them with `write_file`.

The reference template includes `capture-web-evidence` for the deterministic `browser_capture` tool and `create-architecture-diagram` for safe, evidence-grounded SVG documents. Rendered HTTP(S) links can prepare an Edge capture, and the Web tab can inspect/fill reviewed form values and attach validated project artifacts without submitting. Replace or tune those skills with the rest of the template for the high-side workflow.

Set `AAA_PROJECT_TEMPLATE` to use a template folder outside this repository. Existing projects are not changed when the template changes.
