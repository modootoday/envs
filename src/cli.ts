#!/usr/bin/env node
import { dispatch } from "./commands/index.js";

// Not top-level await: the same source is bundled for CJS consumers, where
// esbuild cannot express it. A rejection stays unhandled, as it was before.
void Promise.resolve(dispatch(process.argv.slice(2))).then((code) => {
  process.exitCode = code;
});
