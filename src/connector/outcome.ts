import { z } from "zod";
export const executionOutcome = z
  .object({
    status: z.enum(["completed", "blocked", "failed"]),
    summary: z.string().min(1),
    tests: z.array(z.string()),
    limitations: z.array(z.string()),
  })
  .strict();
export const outcomeJsonSchema = z.toJSONSchema(executionOutcome);
export class ExecutionOutcomeError extends Error {}
export function taskReport(text: string) {
  const outcome = executionOutcome.parse(JSON.parse(text));
  if (outcome.status !== "completed")
    throw new ExecutionOutcomeError(
      outcome.summary + "\n" + outcome.limitations.join("\n"),
    );
  return (
    outcome.summary +
    "\n\nPruebas y verificaciones:\n" +
    (outcome.tests.map((t) => "- " + t).join("\n") || "No se informaron pruebas.") +
    (outcome.limitations.length
      ? "\n\nLimitaciones:\n" + outcome.limitations.map((l) => "- " + l).join("\n")
      : "")
  );
}
