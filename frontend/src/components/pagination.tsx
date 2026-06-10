"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface PaginationProps {
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  className?: string;
}

export function Pagination({ page, total, pageSize, onPageChange, className }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  const goTo = (nextPage: number) => {
    if (nextPage < 1 || nextPage > totalPages || nextPage === page) return;
    onPageChange(nextPage);
  };

  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
      <p className="type-body-sm text-gray-600 dark:text-gray-400">
        第 {page} / {totalPages} 页，共 {total} 条
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => goTo(page - 1)}
          disabled={page <= 1}
          className="retro-btn-secondary min-h-[44px] px-3 type-action"
        >
          <ChevronLeft className="h-4 w-4" /> 上一页
        </button>
        <button
          type="button"
          onClick={() => goTo(page + 1)}
          disabled={page >= totalPages}
          className="retro-btn-secondary min-h-[44px] px-3 type-action"
        >
          下一页 <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
