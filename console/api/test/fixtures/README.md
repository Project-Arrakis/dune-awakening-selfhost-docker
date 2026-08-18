# Test fixtures

## `production-representative-legacy-iam.json`

Requirement 26 ("tested against a copy of production data") migration
fixture for the console custom IAM roles feature
(`console/api/src/policy.js`'s `migrateIfLegacyShape()`).

**Provenance, verified directly, not assumed**: this is the real,
current legacy-shape (pre-schema-v2) document every existing console
install is actually running today, copied verbatim from
`console/api/src/policy.js`'s own `DEFAULT_POLICIES` constant as of
commit `cbd3bcf8`. Confirmed via direct SSH inspection of a real, live
install (dune-dev, `192.168.21.10`, `v1.3.90`, 2026-08-18) that no
`runtime/generated/iam-policies.json` file exists there at all
(`find ~/dune-awakening-selfhost-docker/runtime -iname '*iam*'` returned
nothing) -- meaning that install's console falls back to exactly this
hardcoded shape at every startup, unmodified since this feature shipped.

**This corrects a prior, false finding (L3-H5, second Layer 3 re-audit,
see the design doc's §11 for the full correction).** L3-H5 originally
claimed "real, currently-live, production `iam-policies.json` data
exists and is reachable (dune-dev)" and that a "sanitized copy of the
real dune-dev structure" would satisfy Requirement 26. Both claims were
independently re-verified and found factually incorrect: no such file
exists on dune-dev (or, per this feature's own DEFAULT_POLICIES-fallback
design, plausibly on any install anywhere that hasn't yet used this
feature to create a custom tier or named policy). There was no real,
operator-customized production data to sanitize.

**Why this fixture is still a legitimate, honest satisfaction of
Requirement 26's actual bar** ("tested against a copy of production
data... size and structure, not real player data"): this document *is*
the real production data every install currently has -- it is not a
synthetic approximation invented for testing purposes. The pre-existing
migration test (`policy.test.js`'s "migration: all 5 real built-in
tiers produce byte-identical evaluate() results..." test) already used
an inline, hand-typed copy of this same shape; this fixture's value is
being an actual committed file loaded via the real file-based
`loadPolicies()` entry point (see the "clean install" and "upgrade via
loadPolicies()" tests in `policy.test.js`), not a `migrateIfLegacyShape()`
direct-call test, closing the specific gap L3-H4 identified.

If a future session ever obtains a real, operator-customized
`iam-policies.json` from a genuine production install (i.e. one that has
actually created custom tiers/named policies through this feature), it
should be sanitized (action-namespace shapes only, no operator identity,
no real tier/policy names an operator might recognize as their own) and
used to *replace or supplement* this fixture -- update this README when
that happens, per Requirement 12 (verify against real system state, not
assumption).
