import { probeInstalledCodex } from "./compatibility.js";

const result = probeInstalledCodex();
console.log(JSON.stringify(result, null, 2));
if (!result.compatible) process.exitCode = 1;
