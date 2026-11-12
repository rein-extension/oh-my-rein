# Release validation

The npm beta can proceed while the maintainer considers licensing separately.

## Automated checks

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run check:package
```

CI runs these on macOS and Linux without model credentials. A configured workflow is not evidence of a passing hosted CI run.

## Clean-machine acceptance

For each advertised main/worker combination, record the exact Node, npm, Git, harness and provider/model versions, OS, source commit and archive SHA-256. Use the packed archive, not the source checkout.

- Install into a clean local environment, run setup against a separate machine, and activate in the native harness.
- Dispatch two independent tasks; change A's requirements while B runs. Collect and review each result separately.
- Disconnect the local client, resume the original conversation, and sync without duplicate execution.
- Verify reports and apply the intended patch to a separate clean checkout; confirm unrelated work is unchanged.
- Verify selected project context in a new conversation without granting control over another conversation's tasks.
- Test model authentication failure, an interrupted setup, runner failure, Host restart, unknown-execution recovery, and a blocked update while work remains active.
- Change permissions/model and upgrade the runtime with `setup --update`; verify history, endpoint identity and native plugin reload.
- Disable/unregister the plugin and stop the Host; uninstall the package while retaining task data.

Do not describe simulated SSH, a local Host, or a staged plugin as a real remote installation. Keep private transcripts and credentials out of the repository; publish only a sanitized version/check matrix.

## Before publishing

- The current archive, its SHA-256, the production dependency audit and the checks performed are in the [validation record](validation.md). Run hosted CI against the intended release commit and rerun native acceptance against its final archive.
- Record real human approval UI acceptance separately from scripted protocol decisions. Unverified harness/worker combinations remain experimental.
- Confirm access to the intended GitHub repository and the npm publishing account/name before publication.

## Cut a candidate

1. Resolve outstanding acceptance failures and set honest integration labels. Defer unverified combinations to experimental status.
2. Choose a prerelease version (for example `0.1.0-beta.1`), update the lockfile, manifests and public installation examples, and finalize the changelog. When publication is authorized, remove `private: true` before the final build.
3. Commit the reviewed source and run CI against that commit. Build the archive once, install/test that archive, and record its checksum.
4. Check README images and links on the intended GitHub/npm pages. Confirm the package name and publishing account.
5. Publish the reviewed archive with the `beta` tag only when publication is explicitly intended. Publish a GitHub release pointing to the same source commit and archive.

Subsequent releases must use a new version and repeat upgrade/recovery checks. This document does not authorize publication.
