# Program Scope Files

`shannon program` starts one end-to-end Shannon scan for every runnable in-scope web target in a local JSON or YAML program file.

```bash
./shannon program --file program.yaml --repo /path/to/source --workspace acme
```

Omit `--repo` for black-box mode:

```bash
./shannon program --file program.yaml --workspace acme
```

Preview what will run first:

```bash
./shannon program --file program.yaml --repo /path/to/source --dry-run
```

The command accepts simple target lists:

```yaml
name: acme
targets:
  - name: app
    url: https://app.example.com
  - name: api
    url: https://api.example.com
    config: ./configs/api.yaml
```

It also accepts common exported scope shapes:

```yaml
name: acme
policy_scopes:
  - asset_type: URL
    asset_identifier: https://app.example.com
    eligible_for_bounty: true
  - asset_type: WILDCARD
    asset_identifier: "*.example.com"
```

Runnable web URLs and domains are included. Explicitly out-of-scope entries are skipped when they use fields like `in_scope: false`, `out_of_scope: true`, `scope: out`, `status: archived`, or `eligible_for_submission: false`.

Wildcard, mobile, binary, and other non-runnable assets are listed as skipped because Shannon needs a concrete web URL plus a source repository for each scan.

Per-target fields:

- `url`, `web_url`, `asset_identifier`, `identifier`, or `domain`
- `name` or `handle`
- `repo` or `repository`
- `config`

If a target does not specify `repo`, the command uses `--repo`. If neither is present, Shannon creates a generated black-box context repo automatically. If a target does not specify `config`, the command uses `--config` when provided. Workspaces are named `<program>_<target>`.
