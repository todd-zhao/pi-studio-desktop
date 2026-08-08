import type { LongTask } from "../types";

interface Props {
  tasks: LongTask[];
  onCancel: (id: string) => void;
  onClear: () => void;
}

const statusLabels: Record<LongTask["status"], string> = {
  queued: "\u6392\u961f\u4e2d",
  running: "\u6267\u884c\u4e2d",
  completed: "\u5df2\u5b8c\u6210",
  failed: "\u5931\u8d25",
  cancelled: "\u5df2\u53d6\u6d88",
};

export function LongTaskQueue({ tasks, onCancel, onClear }: Props) {
  if (tasks.length === 0) return null;
  const hasFinished = tasks.some((task) => task.status === "completed" || task.status === "failed" || task.status === "cancelled");
  return (
    <section className="long-task-queue" aria-label="\u957f\u65f6\u4efb\u52a1">
      <div className="long-task-queue-head">
        <div>
          <strong>\u957f\u65f6\u4efb\u52a1</strong>
          <span>{tasks.length} \u4e2a</span>
        </div>
        {hasFinished && <button className="text-btn" onClick={onClear}>\u6e05\u7406\u5df2\u7ed3\u675f</button>}
      </div>
      <div className="long-task-list">
        {tasks.map((task) => (
          <div className={"long-task-item " + task.status} key={task.id}>
            <span className="long-task-dot" aria-hidden="true" />
            <div className="long-task-copy">
              <div className="long-task-title" title={task.text}>{task.text}</div>
              <div className="long-task-meta">
                <span>{statusLabels[task.status]}</span>
                {task.error && <span title={task.error}>\u6267\u884c\u5931\u8d25</span>}
              </div>
            </div>
            {task.status === "queued" && <button className="text-btn danger" onClick={() => onCancel(task.id)}>\u53d6\u6d88</button>}
          </div>
        ))}
      </div>
    </section>
  );
}
