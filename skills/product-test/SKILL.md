---
name: product-test
description: Product-local testing guidance for TraceCue.
---

# Product Test

## Phase 0

Run scaffold checks only:

```bash
./tools/test_product_repository.sh
```

## Later Phases

Run:

```bash
npm test
npm run test:browser
```

Add headed-mode checks and CI checks in later approved phases.
