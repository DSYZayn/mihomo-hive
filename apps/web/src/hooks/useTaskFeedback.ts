import React from "react";
import type { ToastMessage } from "../components/ui.js";

export type TaskState = "idle" | "pending" | "success" | "error";

export interface TaskFeedback {
  state: TaskState;
  title: string;
  detail: string;
  startedAt?: number;
  technical?: string;
}

const initialTask: TaskFeedback = {
  state: "idle",
  title: "等待操作",
  detail: "从左侧任务流开始，先添加或拉取订阅。"
};

export interface TaskFeedbackController {
  task: TaskFeedback;
  setTask: React.Dispatch<React.SetStateAction<TaskFeedback>>;
  toasts: ToastMessage[];
  pushToast: (tone: ToastMessage["tone"], title: string, detail?: string) => void;
  dismissToast: (id: string) => void;
  startTask: (title: string, detail: string) => void;
  finishTask: (title: string, detail: string) => Promise<void>;
  failTask: (title: string, detail: string) => void;
}

export function useTaskFeedback(): TaskFeedbackController {
  const [task, setTask] = React.useState<TaskFeedback>(initialTask);
  const [toasts, setToasts] = React.useState<ToastMessage[]>([]);
  const toastSequence = React.useRef(0);

  const dismissToast = React.useCallback((id: string) => {
    setToasts((items) => items.filter((item) => item.id !== id));
  }, []);

  const pushToast = React.useCallback<TaskFeedbackController["pushToast"]>((tone, title, detail) => {
    // IDs only identify toasts in this hook; public HTTP has no crypto.randomUUID.
    const id = `toast-${++toastSequence.current}`;
    setToasts((items) => [...items.slice(-3), { id, tone, title, detail }]);
    window.setTimeout(() => {
      setToasts((items) => items.filter((item) => item.id !== id));
    }, 5000);
  }, []);

  const startTask = React.useCallback<TaskFeedbackController["startTask"]>((title, detail) => {
    setTask({ state: "pending", title, detail, startedAt: Date.now() });
  }, []);

  const finishTask = React.useCallback<TaskFeedbackController["finishTask"]>(
    async (title, detail) => {
      setTask({ state: "success", title, detail });
      pushToast("success", title, detail);
    },
    [pushToast]
  );

  const failTask = React.useCallback<TaskFeedbackController["failTask"]>(
    (title, detail) => {
      setTask({ state: "error", title, detail, technical: detail });
      pushToast("danger", title, detail);
    },
    [pushToast]
  );

  return {
    task,
    setTask,
    toasts,
    pushToast,
    dismissToast,
    startTask,
    finishTask,
    failTask
  };
}
