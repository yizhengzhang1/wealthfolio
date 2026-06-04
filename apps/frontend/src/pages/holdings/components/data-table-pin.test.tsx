import { DataTable } from "@wealthfolio/ui/components/ui/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

interface Row {
  name: string;
  value: number;
}

const columns: ColumnDef<Row>[] = [
  { id: "name", header: () => <span>Name</span>, cell: ({ row }) => <span>{row.original.name}</span> },
  { id: "value", header: () => <span>Value</span>, cell: ({ row }) => <span>{row.original.value}</span> },
];

const data: Row[] = [{ name: "AAPL", value: 1 }];

describe("DataTable pinFirstColumn", () => {
  it("does not add sticky class to the first cell by default", () => {
    render(<DataTable columns={columns} data={data} />);
    const cell = screen.getByText("AAPL").closest("td");
    expect(cell?.className).not.toContain("sticky");
  });

  it("makes the first header and body cell sticky when pinFirstColumn is set", () => {
    render(<DataTable columns={columns} data={data} pinFirstColumn scrollable />);
    const firstBodyCell = screen.getByText("AAPL").closest("td");
    expect(firstBodyCell?.className).toContain("sticky");
    expect(firstBodyCell?.className).toContain("left-0");

    const firstHeaderCell = screen.getByText("Name").closest("th");
    expect(firstHeaderCell?.className).toContain("sticky");
    expect(firstHeaderCell?.className).toContain("left-0");

    // Non-first cells stay unpinned.
    const secondBodyCell = screen.getByText("1").closest("td");
    expect(secondBodyCell?.className).not.toContain("sticky");
  });
});
