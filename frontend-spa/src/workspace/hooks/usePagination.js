import { useState } from 'react';
import useDepsChanged from '../../hooks/useDepsChanged';

// Shared paging state for PaginatedTable/PaginatedCardGrid/any future
// paginated view (e.g. an activity timeline) — one hook so all of them page
// identically and reset to page 1 the same way when the row count/page size
// changes out from under them (a filter narrowing results, etc).
export function usePagination(count, { pageSizeOptions, initialPageSize }) {
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [page, setPage] = useState(1);

  if (useDepsChanged([count, pageSize])) setPage(1);

  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const start = (clampedPage - 1) * pageSize;
  const end = Math.min(start + pageSize, count);

  return { page: clampedPage, setPage, pageSize, setPageSize, pageSizeOptions, totalPages, start, end };
}

// Numbered-page pager (‹ 1 2 [3] 4 5 … N ›) + a page-size picker rendered as
// its own row of circular buttons — replaces the old Prev/Next + dropdown
// footer to match the reference pagination design. Windows 2 pages on each
// side of the current one, always keeping page 1 and the last page visible
// with a single-ellipsis gap between, since jumping straight to the last of
// hundreds of pages is common (e.g. "578" in the activity log).
export function paginationPageList(current, total) {
  const delta = 2;
  const pages = [];
  for (let i = 1; i <= total; i += 1) {
    if (i === 1 || i === total || (i >= current - delta && i <= current + delta)) pages.push(i);
  }
  const withGaps = [];
  let prev;
  pages.forEach((p) => {
    if (prev != null && p - prev > 1) withGaps.push('…');
    withGaps.push(p);
    prev = p;
  });
  return withGaps;
}
