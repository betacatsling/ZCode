# Harness directory and static icon contract

This is the P1 directory contract. It describes trusted display metadata and
the read-only bridge to the existing `HarnessRegistry`; it does not create a
second execution registry and it does not claim that a Harness is runnable.

## Ownership and boundary

The target Host owns the trusted directory snapshot used by a picker, sidebar,
and chat header. The existing `HarnessRegistry` remains the owner of executable
adapters and their `probe`, `capabilities`, and session behavior. A directory
entry may have a manifest without a registered adapter; that entry remains
displayable with an unavailable status and cannot be admitted.

The manifest is static metadata:

- stable Harness `id`, display `name`, and adapter `version`;
- optional static light/dark asset IDs;
- a generic or initials fallback policy.

An asset ID is an opaque, validated identifier. It is never a URL, filesystem
path, SVG body, script, or renderer executable. The renderer receives the
validated ID through the trusted resource mechanism selected by the Host.

Capabilities and availability come from the existing adapter's target probe and
session admission. A logo or manifest never grants tools, approvals, model
routes, resume, or target access.

## Required invariants

1. Manifest IDs are unique after schema normalization.
2. A manifest that matches a registered adapter must have the same `id` and
   adapter `version`; mismatches fail closed during directory construction.
3. Registered adapters without a trusted manifest are not invented into the
   directory. Their execution remains possible through the existing registry,
   while UI metadata resolves to the unknown fallback until a manifest is
   explicitly supplied.
4. An unregistered manifest is listed as unavailable and cannot be used to
   construct or dispatch a session.
5. Missing, unknown, or invalid icon metadata resolves to a safe generic or
   initials fallback and never requests an arbitrary resource.

## Deferred integration

The first implementation accepts a trusted manifest list as an additive port.
The next Host integration can have each built-in factory supply its manifest
alongside registration in the existing Registry. Plugin discovery, remote
installation, arbitrary asset loading, and dynamic code execution are outside
this slice.
