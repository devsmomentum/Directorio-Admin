'use client';

import { useEffect, useState } from 'react';

const LS_KEY = 'millennium_per_page';
const PER_PAGE_OPTIONS = [5, 10, 20, 50];

function getStoredPerPage(): number {
  if (typeof window === 'undefined') return 10;
  const stored = localStorage.getItem(LS_KEY);
  const parsed = stored ? parseInt(stored) : NaN;
  return PER_PAGE_OPTIONS.includes(parsed) ? parsed : 10;
}

export function usePagination<T>(items: T[]) {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(10);

  useEffect(() => {
    setPerPage(getStoredPerPage());
  }, []);

  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const safePage = Math.min(page, totalPages);
  const paginated = items.slice((safePage - 1) * perPage, safePage * perPage);

  const changePerPage = (val: number) => {
    localStorage.setItem(LS_KEY, String(val));
    setPerPage(val);
    setPage(1);
  };

  return { page: safePage, setPage, perPage, changePerPage, totalPages, paginated, total: items.length };
}

interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  perPage: number;
  label: string;
  onPageChange: (page: number) => void;
  onPerPageChange: (perPage: number) => void;
}

export default function Pagination({ page, totalPages, total, perPage, label, onPageChange, onPerPageChange }: PaginationProps) {
  return (
    <div className="flex items-center justify-between px-5 py-3 border-t border-white/5">
      {/* Left: per page selector */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-white/20">{total} {label}</span>
        <span className="text-white/10">|</span>
        <select
          value={perPage}
          onChange={(e) => onPerPageChange(parseInt(e.target.value))}
          className="bg-transparent text-[11px] text-white/30 focus:outline-none cursor-pointer"
        >
          {PER_PAGE_OPTIONS.map(n => (
            <option key={n} value={n} className="bg-[#111] text-white">{n} por pag.</option>
          ))}
        </select>
      </div>

      {/* Right: page navigation */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page === 1}
          className="p-1 text-white/30 hover:text-white/60 transition-colors disabled:opacity-20 disabled:pointer-events-none"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19l-7-7 7-7" /></svg>
        </button>

        <div className="flex items-center gap-1 text-[11px]">
          <span className="text-white/30">pag.</span>
          <select
            value={page}
            onChange={(e) => onPageChange(parseInt(e.target.value))}
            className="bg-white/5 text-white text-[11px] rounded-md px-1.5 py-1 focus:outline-none cursor-pointer border border-white/10 min-w-[40px] text-center"
          >
            {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
              <option key={p} value={p} className="bg-[#111] text-white">{p}</option>
            ))}
          </select>
          <span className="text-white/30">de {totalPages}</span>
        </div>

        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page === totalPages}
          className="p-1 text-white/30 hover:text-white/60 transition-colors disabled:opacity-20 disabled:pointer-events-none"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5l7 7-7 7" /></svg>
        </button>
      </div>
    </div>
  );
}
