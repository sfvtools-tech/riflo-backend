# Backend CI and deployment

`.github/workflows/ci.yml` checks pull requests, pushes to `main`, and manual runs. Only successful pushes to `main` deploy. Pull requests and manual runs never obtain a cloud identity. CI uses Node 24.22.2 because locked Firebase packages require Node >=24.12.0; the production VM has been upgraded and verified on Node 24.22.2.

Checks run on Ubuntu 22.04 with Java 21, pinned Firebase CLI and the existing pinned media installer. Auth, Firestore and Storage use a fresh `demo-riflo` emulator project. The complete test suite must finish with zero skips. Linux production dependencies are pruned after testing and packaged with compiled code, package manifests and a release identity. Only the archive and its SHA-256 file enter the one-day GitHub artifact; environment files and cloud credentials are excluded.

Protect `main` with pull requests and the required `Backend checks` status check. No approval gate is configured by this workflow.

Configure these repository variables:

| Variable | Value |
| --- | --- |
| `GCP_PROJECT_ID` | Deployment project ID |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full workload identity provider resource name |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | Dedicated backend deploy service account email |
| `GCP_INSTANCE` | Existing backend instance name |
| `GCP_ZONE` | Instance zone |

The Workload Identity provider must accept only the intended numeric repository/owner identities, `refs/heads/main`, the `push` event and this repository's `.github/workflows/ci.yml` workflow. Grant the dedicated identity access to this instance through IAP and non-admin OS Login, plus the service-account impersonation permissions required for its attached runtime identity. Use a separate identity for frontend hosting. Do not grant project Editor or OS Admin Login to CI. Enabling OS Login changes existing SSH access; preserve operator access before enabling it.

An operator installs the reviewed root-owned helper and activation probes once on the existing VM:

```sh
sudo bash deploy/install-deployer.sh SERVICE_ACCOUNT_OS_LOGIN_USERNAME
```

The installer writes a narrow sudo rule for `/usr/local/sbin/riflo-deploy-release`. Obtain the actual POSIX username from that service account's OS Login profile. The helper receives archive bytes through stdin, verifies the expected SHA-256, rejects traversal, special entries, hardlinks and escaping symlinks, and creates a root-owned release that the CI identity cannot overwrite. Limits are 512 MiB compressed, 2 GiB unpacked and 100,000 entries. It invokes a separately installed trusted activator; scripts from the artifact are never executed as root. Review and reinstall the trusted helper/probes separately when their source changes.

Deployment uses an ephemeral runner SSH key and IAP; no stored personal SSH key or service-account key is needed. Deploy jobs are serialized without cancellation. Superseded commits are skipped before authentication. A newer push arriving during an active deployment waits; the completed release remains available until the next one activates. Each GitHub run attempt has a distinct release directory.

The activator checks caption fonts and rendering as the application user before stopping services, drains the worker, activates the release, and checks both services and local API health. Failure restores the prior application release. The existing `/etc/riflo/runtime.env`, systemd units, media tools and font installation are managed separately. A failed preflight can leave an unused release directory for operator cleanup; releases are not automatically pruned.

For a deliberate rollback, an operator uses the trusted activator with an existing release ID:

```sh
sudo bash /usr/local/lib/riflo-deploy/activate-release.sh RELEASE_ID
```

The CI identity cannot invoke arbitrary rollback commands. Application rollback does not roll back runtime tools, credentials, database contents or schema.
