#!/usr/bin/env node
if (process.argv[2] === "handoff") {
  const { runHandoff } = await import("../src/handoff.ts");
  try {
    await runHandoff(process.argv.slice(3));
  } catch (error) {
    // Never echo arbitrary filesystem errors or transcript content.
    console.error(error instanceof Error && error.name === "HandoffDiagnostic" ? error.message : "Handoff failed. Check the transcript format, working directory and file permissions.");
    process.exitCode = 1;
  }
} else {
  await import("../src/cli.ts");
}
