import type { CanonicalTask, TaskSnapshot } from "@phaseatlas/contracts";

export function canonicalAgentTaskKey(task: Pick<CanonicalTask, "key">): string {
  return `${task.key.workspaceSlug}/${task.key.taskId}`;
}

export function resolveAgentTaskReference(snapshot: TaskSnapshot, taskReference: string): CanonicalTask {
  const normalizedReference = taskReference.trim();
  const matches = snapshot.tasks.filter((task) =>
    task.key.taskId === normalizedReference || canonicalAgentTaskKey(task) === normalizedReference
  );
  if (matches.length !== 1) throw new Error("Agent task reference does not resolve to one canonical task.");
  return matches[0] as CanonicalTask;
}

export class AgentTaskRunGuard {
  private readonly startingTaskKeys = new Set<string>();

  acquire(taskKey: string): () => void {
    if (this.startingTaskKeys.has(taskKey)) throw new Error("Another agent run is already starting for this task.");
    this.startingTaskKeys.add(taskKey);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.startingTaskKeys.delete(taskKey);
    };
  }

  has(taskKey: string): boolean {
    return this.startingTaskKeys.has(taskKey);
  }
}
