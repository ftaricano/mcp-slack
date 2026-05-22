#!/usr/bin/env node
import('../dist/cli/index.js')
  .then((m) => m.run(process.argv))
  .catch((err) => {
    console.error(err?.stack || err?.message || err);
    process.exit(1);
  });
