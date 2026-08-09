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
    <section className="long-task-queue" aria-label="长时任务">
      <div className="long-task-queue-head">
        <div>
          <strong>长时任务</strong>
          <span>{tasks.length} 个</span>
        </div>
        {hasFinished && <button className="text-btn" onClick={onClear}>清理已结束</button>}
      </div>
      <div className="long-task-list">
        {tasks.map((task) => (
          <div className={"long-task-item " + task.status} key={task.id}>
            <span className="long-task-dot" aria-hidden="true" />
            <div className="long-task-copy">
              <div className="long-task-title" title={task.text}>{task.text}</div>
              <div className="long-task-meta">
                <span>{statusLabels[task.status]}</span>
                {task.error && <span title={task.error}>执行失败</span>}
              </div>
            </div>
            {task.status === "queued" && <button className="text-btn danger" onClick={() => onCancel(task.id)}>取消</button>}
          </div>
        ))}
      </div>
    </section>
  );
}
