import type { NeedsYouProjectProblem } from '@shared/contracts';
import type { MappedError, ProblemInit } from '@worker/core';
import { GitHubError } from '@worker/github';
import { ProjectConfigError } from '@worker/read-models';

/** 422 `project-config-invalid`: project.yml is too large, not plain YAML, or not the expected shape (#9 row 9). */
export function projectConfigProblem(error: ProjectConfigError): ProblemInit {
  return {
    type: 'project-config-invalid',
    title: "The project's .product-team/project.yml cannot be used",
    status: 422,
    // Our own reason code only; the file's content is never echoed.
    detail: `project.yml: ${error.failure}`,
  };
}

/** `createWorkerApp`'s `mapError` for read-model failures. */
export function mapReadModelError(error: unknown): MappedError | undefined {
  if (error instanceof ProjectConfigError) {
    return { problem: projectConfigProblem(error), logFields: { configFailure: error.failure } };
  }
  return undefined;
}

/** A project's failure as "Needs you" lists it; `undefined` for anything that is not a known problem. */
export function projectProblemOf(error: unknown): NeedsYouProjectProblem | undefined {
  const problem =
    error instanceof GitHubError
      ? error.problem
      : error instanceof ProjectConfigError
        ? projectConfigProblem(error)
        : undefined;
  return problem === undefined
    ? undefined
    : { type: problem.type, title: problem.title, status: problem.status };
}
