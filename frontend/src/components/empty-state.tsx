import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="rounded-3xl border border-dashed border-orange-200 dark:border-gray-700 bg-white/70 dark:bg-card/70 px-6 py-12 text-center">
      <p className="type-section text-gray-900 dark:text-gray-100">{title}</p>
      <p className="type-body-sm mx-auto mt-2 max-w-sm text-gray-600 dark:text-gray-400">{description}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}
