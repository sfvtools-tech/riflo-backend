# Backend CI and deployment

`.github/workflows/ci.yml` checks pull requests, pushes to `main`, and manual runs. Successful pushes to `main` deploy tested code and configuration together. A manual **Apply configuration** run on `main` updates only the currently active backend release, without rebuilding or deploying newer application code. Other branches cannot deploy, and pull requests never obtain a cloud identity. CI uses Node 24.22.2 because locked Firebase packages require Node >=24.12.0; the production VM has been upgraded and verified on Node 24.22.2.

Checks run on Ubuntu 22.04 with Java 21, Python 3.11.18, pinned Firebase CLI and the existing pinned media installer. Auth, Firestore and Storage use a fresh `demo-riflo` emulator project. The complete test suite must finish with zero skips. Linux production dependencies are pruned after testing and packaged with compiled code, package manifests and a release identity. Only the archive and its SHA-256 file enter the one-day GitHub artifact; environment files and cloud credentials are excluded.

Protect `main` with pull requests and the required `Backend checks` status check. No approval gate is configured by this workflow.

Configure these repository variables:

| Variable | Value |
| --- | --- |
| `GCP_PROJECT_ID` | Deployment project ID |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full workload identity provider resource name |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | Dedicated backend deploy service account email |
| `GCP_INSTANCE` | Existing backend instance name |
| `GCP_ZONE` | Instance zone |

The Workload Identity provider must accept only the intended numeric repository/owner identities, `refs/heads/main`, the `push` or `workflow_dispatch` event and this repository's `.github/workflows/ci.yml` workflow. Grant the dedicated identity access to this instance through IAP and non-admin OS Login, plus the service-account impersonation permissions required for its attached runtime identity. Use a separate identity for frontend hosting. Do not grant project Editor or OS Admin Login to CI. Enabling OS Login changes existing SSH access; preserve operator access before enabling it.

An operator installs the reviewed root-owned helper and activation probes once on the existing VM:

```sh
sudo bash deploy/install-deployer.sh SERVICE_ACCOUNT_OS_LOGIN_USERNAME
```

The installer writes a narrow sudo rule for `/usr/local/sbin/riflo-deploy-release`. Obtain the actual POSIX username from that service account's OS Login profile. The helper receives a bounded configuration JSON line followed by archive bytes through stdin, verifies the expected SHA-256, rejects traversal, special entries, hardlinks and escaping symlinks, and creates a root-owned release that the CI identity cannot overwrite. Limits are 512 MiB compressed, 2 GiB unpacked and 100,000 entries. It invokes a separately installed trusted activator; scripts from the artifact are never executed as root. Review and reinstall the trusted helper/probes separately when their source changes.

Deployment uses an ephemeral runner SSH key and IAP; no stored personal SSH key or service-account key is needed. Deploy jobs are serialized without cancellation. Superseded commits are skipped before authentication. A newer push arriving during an active deployment waits; the completed release remains available until the next one activates. Release identity comes from the tested artifact, so retrying only a failed deploy job keeps the correct identity. A matching previously extracted release can be retried; different bytes cannot overwrite it.

The activator checks caption fonts and rendering as the application user before stopping services, drains the worker, activates the release, and checks both services and local API health. The candidate configuration is validated with the target application before either service stops. Failure restores both the prior release and runtime configuration. Configuration-only runs validate with the active release and fail safely if it predates configuration validation support. The existing `/etc/riflo/runtime.env` remains the runtime file; systemd units, media tools, networking and font installation remain host-managed. A failed preflight can leave an unused release directory for operator cleanup; releases are not automatically pruned.

For a deliberate rollback, an operator uses the trusted activator with an existing release ID:

```sh
sudo bash /usr/local/lib/riflo-deploy/activate-release.sh RELEASE_ID
```

The CI identity cannot invoke arbitrary rollback commands. This operator code-only rollback does not restore configuration, runtime tools, credentials, database contents or schema. Pair it with compatible configuration when necessary; automated failed activation restores code and configuration together.

## Production application configuration

Use repository **Settings → Secrets and variables → Actions**. Do not put private keys in Variables. These settings are read only by the trusted final deployment step; they never enter the release artifact.

| Kind | Required names |
| --- | --- |
| Secrets | `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY` |
| Variables | `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`, `CORS_ALLOWED_ORIGINS` |
| Variables | `ANTHROPIC_TEXT_MODEL`, `ANTHROPIC_VIDEO_MODEL`, `ANTHROPIC_NEWSLETTER_MODEL`, `DEEPGRAM_MODEL`, `DEEPGRAM_LANGUAGE` |
| Variables | `GENERATION_MAX_OUTPUT_TOKENS`, `GENERATION_LONG_FORM_MAX_OUTPUT_TOKENS`, `GENERATION_STAGE_TIMEOUT_MS`, `TRIAL_ENABLED`, `RETENTION_ENABLED` |

Keep current model, token, timeout and feature values during the first migration. Missing required settings fail before services are touched. GitHub is authoritative for application settings: absent optional values explicitly remove the corresponding override, returning it to its application default. Transfer any wanted existing optional overrides into GitHub before migrating. Host-owned settings remain unchanged.

Drive is optional and requires all four settings together: Variables `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_REDIRECT_URI`; Secrets `GOOGLE_DRIVE_CLIENT_SECRET`, `DRIVE_TOKEN_ENCRYPTION_KEY`. `TRIAL_ABUSE_HMAC_KEY` is a Secret if configured. Once either encryption or abuse key exists on the VM, deployments reject its replacement or removal. Keep the identical key in GitHub; key rotation or removal requires a separate operator procedure to protect saved connections and abuse history. Deployment never generates these keys.

The workflow also forwards existing model-rate, media-limit, source-validation, stream-limit and worker-trace overrides as Variables. The root helper rejects unapproved names. Host-owned values such as `NODE_ENV`, `PORT`, media tool paths, source IPv6 settings and credential paths cannot be injected through GitHub application settings.

For a code change, update the relevant GitHub settings before merging; the normal main deployment applies them with the code. For configuration alone, update settings and run **Actions → Backend CI and deploy → Run workflow → main → Apply configuration**. It uses the same production lock and health checks. Frontend public settings require a separate frontend rebuild. GitHub does not atomically snapshot edits across several settings: finish the settings edit before starting deployment.

The runner creates a private temporary payload, transfers it over IAP/SSH, then removes local and remote copies. Configuration values must be single-line strings; newlines, NULs and oversized values are rejected without printing their contents. The VM retains one protected previous environment file for failed-activation recovery. Reinstall the reviewed root-owned helpers before the first deployment of this workflow, and extend each exact-workflow WIF condition to permit main `workflow_dispatch` as well as `push`.
