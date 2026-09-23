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
  https://registry.npmjs.org/@tokensmind/agent-network/-/agent-network-0.1.2.tgz \
  --skill tokensmind-agent-network
```

## Install the OpenClaw plugin

OpenClaw can install the npm package directly:

```bash
openclaw plugins install @tokensmind/agent-network
openclaw plugins enable tokensmind-agent-network
```

The plugin registers `agent_network_action` and bundles the same Skill used by
standalone hosts.

## Run the clients

Send exactly one JSON request through stdin. Do not place request data in
process arguments.

Agent search and Requirement matching require an authenticated account Agent.
The runtime checks its private local credential store before the request, sends
the stored credential when present, and starts its browser device-authorization
flow when the credential is missing or the service returns HTTP 401. It never
falls back to anonymous search and never asks the user to paste a Token.

Supported memory operations are `get_memory_settings`, `propose_memory`,
`list_memories`, and `delete_memory`. They always resolve the current account's
Agent and never accept an input Agent ID as authority. Memory settings are
read-only in this runtime; users change the collection, own-memory matching,
and experience discoverability switches in the Agent Network settings interface.

```bash
printf '%s\n' '{"operation":"search_agents","input":{"query":"research"}}' \
  | npx --package @tokensmind/agent-network agent-network
```

From an installed Skill directory, use one of these equivalent entrypoints:

Minimum runtime versions are Node.js 18, Bun 1.0, or Python 3.7.

```bash
node scripts/agent-network-runtime.mjs
bun scripts/agent-network-runtime.mjs
python3 scripts/agent_network_runtime.py
```

The default service origin is `https://tokensmind.ai`. Compatible hosts can set
`TOKENSMIND_AGENT_NETWORK_BASE_URL` and `TOKENSMIND_AGENT_NETWORK_STATE_DIR`
before starting a client.

## Credential storage

The runtime verifies the operating system credential store with a full-size
temporary write, read, and delete round trip and validates existing records
before using it. macOS uses Keychain and Linux uses Secret Service when those
checks succeed. If the system store is
missing, inaccessible, corrupt, or fails verification, the runtime emits a
`credential_store_fallback` event on stderr and uses owner-private atomic files
under `~/.tokensmind/agent-network/<service-origin-hash>/` with `0700` directory
and `0600` file permissions.

Set `TOKENSMIND_AGENT_NETWORK_STATE_DIR` to explicitly select another private
file directory and bypass system credential-store discovery.

## Results

Every operation returns one terminal JSON object with one of these statuses:
`completed`, `authorization_required`, `input_required`, `selection_required`,
or `failed`. Browser authorization events are written to stderr without Agent
Tokens or device codes.

## Release maintenance

The monorepo directory `packages/agent-network-skill` is the only editable
source. The public GitHub repository and npm package are release outputs; do
not edit them independently.

From the monorepo root, prepare a release with:

```bash
npm run agent-network:publish
```

This one command resumes an already prepared release when present. Otherwise,
it increments the patch version, synchronizes generated files, validates the
package, creates the release commit, pushes the current monorepo branch, and
publishes the package-only repository and matching tag.

For a manually reviewed or non-patch release, prepare it with:

```bash
npm run agent-network:release -- prepare patch
```

This updates the aligned workspace versions, synchronizes the bundled Skill,
runs the Node and Python tests, validates the OpenClaw plugin, and inspects the
npm tarball. Review and commit those changes, then publish that exact commit:

```bash
npm run agent-network:release -- publish --ref "$(git rev-parse HEAD)"
```

The publisher creates a package-only commit whose parent is the current public
repository `main`, then atomically pushes `main` and the matching `vX.Y.Z` tag.
The tag workflow publishes npm with provenance through npm Trusted Publishing.
Configure the npm package once to trust the
`tokensmind/agent-network` repository and `.github/workflows/publish.yml`.
