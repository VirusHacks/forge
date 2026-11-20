// Append a labelled marker to a recording's timeline (wall clock is converted later).
import { appendFileSync } from "node:fs";
appendFileSync(`../recordings/${process.argv[2]}/marks.tsv`, `${Date.now()}\t${process.argv.slice(3).join(" ")}\n`);
