"use client";

import { memo, type ReactNode } from "react";
import { cx } from "@/components/ui/cx";

export type Column<Row> = {
  key: string;
  header: ReactNode;
  align?: "left" | "right" | "center";
  width?: string;
  numeric?: boolean;
  render: (row: Row) => ReactNode;
};

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" } as const;

/**
 * Sticky-header table. Numeric columns are right-aligned with tabular digits.
 * rowActions render on hover or keyboard focus at the end of the row.
 */
export function Table<Row>({ columns, rows, rowKey, empty, rowActions, onRowClick, label, dense = false, className }: {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  empty?: ReactNode;
  rowActions?: (row: Row) => ReactNode;
  onRowClick?: (row: Row) => void;
  label: string;
  dense?: boolean;
  className?: string;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div className={cx("min-h-0 overflow-auto", className)}>
      <table aria-label={label} className={cx("ui-table w-full border-separate border-spacing-0 text-data", dense && "dense")}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" style={column.width ? { width: column.width } : undefined} className={cx("sticky top-0 z-[1] border-b border-border bg-panel/95 backdrop-blur-sm", ALIGN[column.align ?? (column.numeric ? "right" : "left")])}>
                {column.header}
              </th>
            ))}
            {rowActions ? <th scope="col" className="sticky top-0 z-[1] w-px border-b border-border bg-panel/95 backdrop-blur-sm"><span className="sr-only">Actions</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => <TableRow key={rowKey(row)} row={row} columns={columns} rowActions={rowActions} onRowClick={onRowClick} />)}
        </tbody>
      </table>
    </div>
  );
}

function RowImpl<Row>({ row, columns, rowActions, onRowClick }: { row: Row; columns: Column<Row>[]; rowActions?: (row: Row) => ReactNode; onRowClick?: (row: Row) => void }) {
  return (
    <tr className={cx("group", onRowClick && "cursor-pointer")} onClick={onRowClick ? () => onRowClick(row) : undefined}>
      {columns.map((column) => (
        <td key={column.key} className={cx("border-b border-border-soft", ALIGN[column.align ?? (column.numeric ? "right" : "left")], column.numeric && "num whitespace-nowrap")}>
          {column.render(row)}
        </td>
      ))}
      {rowActions ? (
        <td className={"border-b border-border-soft text-right"} onClick={(event) => event.stopPropagation()}>
          <div className="flex justify-end gap-1 opacity-100 transition-opacity duration-150 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">{rowActions(row)}</div>
        </td>
      ) : null}
    </tr>
  );
}

const TableRow = memo(RowImpl) as typeof RowImpl;

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {icon ? <div className="mb-4 grid h-12 w-12 place-items-center rounded-lg border border-border-soft bg-sunken text-muted shadow-e1 [&_svg]:h-5 [&_svg]:w-5">{icon}</div> : null}
      <p className="text-title font-semibold text-text">{title}</p>
      {body ? <p className="mt-1.5 max-w-sm text-dense text-muted">{body}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cx("skel block rounded-sm", className)} />;
}
