import { DataTable } from "@wealthfolio/ui/components/ui/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

interface Row {
  name: string;
  subRows?: Row[];
}

const columns: ColumnDef<Row>[] = [
  {
    id: "name",
    header: () => <span>Name</span>,
    cell: ({ row }) => (
      <button
        type="button"
        data-testid={`row-${row.original.name}`}
        onClick={row.getToggleExpandedHandler()}
        disabled={!row.getCanExpand()}
      >
        {row.original.name}
      </button>
    ),
  },
];

describe("DataTable opt-in sub-rows", () => {
  it("hides children until parent expanded, then shows them", async () => {
    const data: Row[] = [{ name: "Parent", subRows: [{ name: "Child" }] }];
    render(
      <DataTable
        data={data}
        columns={columns}
        getSubRows={(row) => row.subRows}
        defaultExpanded={{}}
      />,
    );

    expect(screen.getByText("Parent")).toBeInTheDocument();
    expect(screen.queryByText("Child")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("row-Parent"));
    expect(screen.getByText("Child")).toBeInTheDocument();
  });

  it("expands all when defaultExpanded is true", () => {
    const data: Row[] = [{ name: "Parent", subRows: [{ name: "Child" }] }];
    render(
      <DataTable data={data} columns={columns} getSubRows={(row) => row.subRows} defaultExpanded={true} />,
    );
    expect(screen.getByText("Child")).toBeInTheDocument();
  });

  it("renders flat (no expansion) when getSubRows not provided", () => {
    const data: Row[] = [{ name: "A" }, { name: "B" }];
    render(<DataTable data={data} columns={columns} />);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
});
