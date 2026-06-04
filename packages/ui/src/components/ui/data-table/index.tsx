import {
  ColumnDef,
  ColumnFiltersState,
  ExpandedState,
  SortingState,
  VisibilityState,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import * as React from "react";

import { Icons } from "../icons";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../table";
import { usePersistentState } from "../../../hooks/use-persistent-state";

import type { DataTableFacetedFilterProps } from "./data-table-faceted-filter";
import { DataTableToolbar } from "./data-table-toolbar";

export { DataTableColumnHeader } from "./data-table-column-header";
export type { DataTableFacetedFilterProps } from "./data-table-faceted-filter";

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  searchBy?: string;
  filters?: DataTableFacetedFilterProps<TData, TValue>[];
  defaultColumnVisibility?: VisibilityState;
  defaultSorting?: SortingState;
  defaultColumnFilters?: ColumnFiltersState;
  storageKey?: string;
  data: TData[];
  manualPagination?: boolean;
  scrollable?: boolean;
  showColumnToggle?: boolean;
  toolbarActions?: React.ReactNode;
  getSubRows?: (originalRow: TData, index: number) => TData[] | undefined;
  defaultExpanded?: ExpandedState;
  filterFromLeafRows?: boolean;
  pinFirstColumn?: boolean;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  searchBy,
  filters,
  manualPagination = false,
  defaultColumnVisibility,
  defaultSorting,
  defaultColumnFilters,
  storageKey,
  scrollable = false,
  showColumnToggle = false,
  toolbarActions,
  getSubRows,
  defaultExpanded,
  filterFromLeafRows = false,
  pinFirstColumn = false,
}: DataTableProps<TData, TValue>) {
  const [rowSelection, setRowSelection] = React.useState({});
  const [columnVisibility, setColumnVisibility] = storageKey
    ? usePersistentState<VisibilityState>(`${storageKey}:column-visibility`, defaultColumnVisibility || {})
    : React.useState<VisibilityState>(defaultColumnVisibility || {});
  const [columnFilters, setColumnFilters] = storageKey
    ? usePersistentState<ColumnFiltersState>(`${storageKey}:column-filters`, defaultColumnFilters || [])
    : React.useState<ColumnFiltersState>(defaultColumnFilters || []);
  const [sorting, setSorting] = storageKey
    ? usePersistentState<SortingState>(`${storageKey}:sorting`, defaultSorting || [])
    : React.useState<SortingState>(defaultSorting || []);
  const expandedDefault = defaultExpanded ?? {};
  const [expanded, setExpanded] = storageKey && getSubRows
    ? usePersistentState<ExpandedState>(`${storageKey}:expanded`, expandedDefault)
    : React.useState<ExpandedState>(expandedDefault);

  const table = useReactTable({
    data,
    columns,
    manualPagination: true,
    getSubRows,
    ...(getSubRows ? { filterFromLeafRows } : {}),
    state: {
      sorting,
      columnVisibility,
      rowSelection,
      columnFilters,
      expanded,
      pagination: manualPagination
        ? undefined
        : {
            pageSize: 500,
            pageIndex: 0,
          },
    },

    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 shrink-0">
        <DataTableToolbar
          table={table}
          searchBy={searchBy}
          filters={filters}
          showColumnToggle={showColumnToggle}
          actions={toolbarActions}
        />
      </div>
      <div className={`min-h-0 flex-1 rounded-md border ${scrollable ? "overflow-auto" : ""}`}>
        <Table>
          <TableHeader className="bg-muted/50 sticky top-0 z-10">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header, index) => {
                  const pinned = pinFirstColumn && index === 0;
                  return (
                    <TableHead
                      key={header.id}
                      className={pinned ? "bg-muted/50 sticky left-0 z-20" : undefined}
                    >
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && "selected"}>
                  {row.getVisibleCells().map((cell, index) => (
                    <TableCell
                      key={cell.id}
                      className={
                        pinFirstColumn && index === 0
                          ? "bg-background sticky left-0 z-10"
                          : undefined
                      }
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  <div className="flex flex-col items-center justify-center">
                    <Icons.FileText className="text-muted-foreground mb-2 h-10 w-10" />
                    <p className="text-muted-foreground text-sm">No results found.</p>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
