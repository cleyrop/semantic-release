# Historical release baselines

The Cleyrop fork accepts `releaseBaselineFile`, relative to the release working directory. This opt-in JSON ledger preserves release continuity after source relocation or an approved rebase without importing or recreating historical tags.

```json
{
  "schemaVersion": 1,
  "tagFormat": "service-v${version}",
  "releases": [
    {
      "version": "1.5.0-alpha.7",
      "gitHead": "0123456789012345678901234567890123456789",
      "channels": ["develop"],
      "source": { "project": "old-project", "tag": "v1.5.0-alpha.7" }
    }
  ]
}
```

Use verified complete mapped commit IDs, canonical SemVer versions and explicit channel membership (`null` for the default stable channel). Preserve each release unit's real semantic rules and normalize legacy version spellings when preparing the reviewed ledger. The example version and SHA are illustrative only. Version entries must be unique; include all channel memberships in one entry.

Records are applied before branch normalization and version/range selection, only where the mapped commit is reachable. Missing commit objects and contradictory reachable tags fail validation. `lastRelease.gitHead` is the mapped commit; `lastRelease.historical` identifies ledger state, and optional `source` metadata is available to notes adapters. No synthetic Git ref is created. Historical records cannot trigger add-channel publication.

Later real tags take part in normal version selection. Keep the ledger while any supported channel needs it. Publication pushes exactly the intended tag and its dedicated channel note; unrelated local tags and branch heads are not pushed by the core publisher. Plugins that create source commits, manipulate tags or require an actual previous-tag ref need their own migration review.

Ledger correctness remains a migration responsibility: verify original/mapped source equivalence, released artifacts and channel notes before enabling publication. Back up original refs and do not move existing release tags.
