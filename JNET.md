# jnet dashboard

This fork tracks upstream v1.28.0 on its `jnet` branch. The proxy server is
maintained separately at https://github.com/jsugg/CLIProxyAPI. This frontend
change does not replace or restart the deployed server binary.

The Providers workbench includes Claude Code and Codex OAuth subscriptions in
its category badges and header totals. Each category shows subscription and
API-key counts separately. A read-only subscription card links to the existing
Auth Files management page; subscription credentials never become API-key
resources or pass through API-key edit/delete actions.

Counts come from the authenticated v8 credentials endpoint. Disabled,
unavailable and non-active accounts are not counted as active. An active
credential is not a guarantee of remaining quota. Loading and failed requests
show an explicit unknown state rather than a false zero. Stale responses are
discarded after connection changes or unmounting.

Use the pinned Bun version from package.json:

```sh
bun install --frozen-lockfile
VERSION=v1.28.0-jnet.1 bun run verify
```

The build produces one `dist/index.html`. Tagged releases run tests, lint and
build, and publish `management.html` plus its SHA256 manifest. Preview tags are
prereleases. Deploy the verified HTML atomically into the hub's private
`static/management.html`, retaining the previous asset for rollback. No proxy
restart, configuration change, account relinking or inference call is needed.
