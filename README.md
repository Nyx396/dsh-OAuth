# DSH ChatGPT OAuth adapter

[中文](README.zh.md)

Standalone community plugin `dsh-llm-oauth`, local revision **0.2.0-local.2**, for DeepSeek Harness Desktop **0.2.1-rc.3**. This revision connects the `openai` route through ChatGPT sign-in and loads the account's available models after sign-in. It is a local derivative of the upstream plugin, not a new upstream release.

## Runtime files and dependencies

This directory includes prebuilt `lib/index.js` and `lib/client.js`; the public runtime source does not require a TypeScript build or `prepare`. The three pinned runtime dependencies are `@earendil-works/pi-ai` **1.3.0**, `jose` **6.1.3**, and `proper-lockfile` **4.1.2**. Their transitive dependencies must also be installed. Dependency directories are not included here.

Use Node.js matching `package.json` (`^22.19.0 || >=24.0.0`) and pnpm. From this directory, restore production dependencies without running lifecycle scripts:

```sh
pnpm install --prod --ignore-scripts
```

The `@deepseek-ai/*` peers and React are provided by the DSH profile. This is a host plugin, not a standalone application. Keep dependencies available when copying or registering this directory.

## Register in DSH

Replace the example path with the absolute path of this source directory. Use the DSH CLI corresponding to the target desktop installation:

```powershell
dsh plugin --profile desktop add "C:\path\to\oauth-source"
```

Restart DSH after registration. Open Settings → OAuth / ChatGPT subscription, enable `openai` if needed, and complete sign-in in the system browser. The public bundle starts with `providers: {}`; installing it does not enable a route automatically. An existing `openai` API-key route conflicts with this subscription route; use one route owner at a time.

This revision supports the new ChatGPT route only. The old standalone CLI login entry (`bin/login.mjs`) is intentionally disabled and prints a pointer to DSH settings. Older upstream instructions for other subscriptions and legacy device-code login do not describe this revision.

Credentials are created locally under `<DSH_HOME>/openai-chatgpt-local/credentials.json` unless an alternate auth path is configured. They are not part of this source distribution. Do not upload credentials, profile settings, or login callback data.

## Source distribution

`SHA256SUMS.txt` covers the public distribution files. The public tree contains prebuilt runtime code, its manifest, the bundle patch, minimal documentation, and the MIT license. It omits tests, development dependencies, source maps, screenshots, machine-specific records, and credentials. Runtime dependency restoration requires access to a package registry; this directory is not an offline installation bundle.

MIT; see [LICENSE](LICENSE). Upstream source: [ziyou979/dsh-llm-oauth](https://github.com/ziyou979/dsh-llm-oauth), base commit `da363b000e325f244bd666a82394e5d59ad18ec7`. This local revision preserves the package version `0.2.0-local.2`.
