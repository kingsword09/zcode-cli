#!/usr/bin/env bun

import { main } from "../src/launcher.ts";

process.exitCode = await main(process.argv.slice(2));
