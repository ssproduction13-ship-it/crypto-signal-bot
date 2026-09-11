export type ExecutionMode = "simulated" | "sandbox";

export const DEFAULT_EXECUTION_MODE: ExecutionMode = "simulated";

/**
 * Parse the execution mode without changing the existing default behaviour.
 *
 * This is intentionally separate from the scheduler until the sandbox
 * execution path, reconciliation and order persistence are complete.
 */
export function parseExecutionMode(
  rawValue: string | undefined = process.env["EXECUTION_MODE"],
): ExecutionMode {
  const value = rawValue?.trim().toLowerCase();

  if (!value) return DEFAULT_EXECUTION_MODE;
  if (value === "simulated" || value === "sandbox") return value;

  throw new Error(
    `Invalid EXECUTION_MODE "${rawValue}". Expected "simulated" or "sandbox".`,
  );
}