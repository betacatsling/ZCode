# Codex app-server schema fixture

The two root documents are generated protocol fixtures from the first-party Codex CLI `codex-cli 0.157.1` executable. The exact generator command is:

```sh
codex app-server generate-json-schema --out <temporary-output-directory>
```

Generation was re-run in an isolated temporary `HOME`, `CODEX_HOME`, and `TMPDIR`; the v1 and v2 root documents matched byte-for-byte. The generator also emits one JSON file per schema definition. Those per-definition files are omitted because the adapter consumes only the committed root documents as test fixtures.

SHA-256:

- `codex_app_server_protocol.schemas.json`: `a65bd8a8c714ffd36ef035ade0928cf059a24b8610b61c66f72d047c6ca6f0aa`
- `codex_app_server_protocol.v2.schemas.json`: `2719fccd25a97a7ce355497ca5e9123a63f6dce7f9f83724a5b73fd927811f59`

The generated schema files contain no separate license metadata, and the installed standalone release manifest exposes version/layout metadata only. This repository keeps them under test fixtures rather than the services source or runtime package. Do not redistribute the raw fixtures outside this repository without confirming the applicable upstream license.
