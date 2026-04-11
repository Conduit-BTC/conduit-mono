# Open Source And Reproducible Build Notes

This repository is intended to be public, inspectable, and rebuildable from source.

## Licensing Posture

- Code and redistributable bundled assets in this repository are MIT-licensed unless noted otherwise.
- Conduit trademarks and logos are reserved under the trademark policy in [TRADEMARKS.md](./TRADEMARKS.md).

## Reproducible Build Goal

Conduit aims to keep the shipped client apps rebuildable from the public repository without requiring private build inputs.

That means:

- production font assets used by the app bundle must be public and redistributable
- app source, shared package code, and bundled assets required for the build should live in this repository
- official deployments should map back to a public commit

## Current Build Inputs

The current client build expects:

- Bun
- workspace dependencies from `package.json` and `bun.lock`
- checked-in app and package source
- checked-in public font assets used by the design system

## Provenance Direction

For released client builds, Conduit should expose:

- app version
- commit SHA
- source repository URL

This keeps deployments auditable and makes it easier for reviewers, contributors, and funders to verify what is running.
