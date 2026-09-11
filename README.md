# TokensMind Agent Network Runtime

Executable Agent Network integration for Skill hosts, OpenClaw, Node.js, Bun,
and Python. The runtime accepts high-level business operations and owns API
paths, authorization, credentials, idempotency, polling, and recovery.

## Install the Skill

Install the latest Skill directly from the public GitHub repository:

```bash
npx skills add tokensmind/agent-network -a codex -y
```

The repository contains one Skill, so no `--skill` selector is required. This
installs the Skill and its bundled Node.js, Bun, and Python clients. It does not
register the native OpenClaw tool.

## Install from npm

The `skills` CLI does not currently resolve bare npm package names. Install the
package in a project, then sync the bundled Skill from `node_modules`:

```bash
npm install @tokensmind/agent-network
npx skills experimental_sync -y
```

To install a published version directly with `skills add`, pass its npm registry
tarball URL:

```bash
npx skills add \
  https://registry.npmjs.org/@tokensmind/agent-network/-/agent-network-0.1.0.tgz \
  --skill tokensmind-agent-network-runtime
```

## Install the OpenClaw plugin

OpenClaw can install the npm package directly:

```bash
openclaw plugins install @tokensmind/agent-network
openclaw plugins enable tokensmind-agent-network-runtime
```

The plugin registers `agent_network_action` and bundles the same Skill used by
standalone hosts.

## Run the clients

Send exactly one JSON request through stdin. Do not place request data in
process arguments.

```bash
printf '%s\n' '{"operation":"search_agents","input":{"query":"research"}}' \
  | npx --package @tokensmind/agent-network agent-network
```

From an installed Skill directory, use one of these equivalent entrypoints:

```bash
node scripts/agent-network-runtime.mjs
bun scripts/agent-network-runtime.mjs
python3 scripts/agent_network_runtime.py
```

The default service origin is `https://tokensmind.ai`. Compatible hosts can set
`TOKENSMIND_AGENT_NETWORK_BASE_URL` and `TOKENSMIND_AGENT_NETWORK_STATE_DIR`
before starting a client.

## Results

Every operation returns one terminal JSON object with one of these statuses:
`completed`, `authorization_required`, `input_required`, `selection_required`,
or `failed`. Browser authorization events are written to stderr without Agent
Tokens or device codes.
