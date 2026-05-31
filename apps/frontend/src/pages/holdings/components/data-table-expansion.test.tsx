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

describe("DataTable depth-2 recursion", () => {
  it("expands grandchildren only after both ancestors are expanded", async () => {
    const data: Row[] = [
      { name: "Underlying", subRows: [{ name: "Strategy", subRows: [{ name: "Leg" }] }] },
    ];
    render(
      <DataTable
        data={data}
        columns={columns}
        getSubRows={(row) => row.subRows}
        defaultExpanded={{}}
      />,
    );

    expect(screen.getByText("Underlying")).toBeInTheDocument();
    expect(screen.queryByText("Strategy")).not.toBeInTheDocument();
    expect(screen.queryByText("Leg")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("row-Underlying"));
    expect(screen.getByText("Strategy")).toBeInTheDocument();
    expect(screen.queryByText("Leg")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("row-Strategy"));
    expect(screen.getByText("Leg")).toBeInTheDocument();
  });

  it("exposes row.depth of 0/1/2 across the three levels", () => {
    const data: Row[] = [
      { name: "U", subRows: [{ name: "S", subRows: [{ name: "L" }] }] },
    ];
    const depthCols: ColumnDef<Row>[] = [
      {
        id: "name",
        header: () => <span>Name</span>,
        cell: ({ row }) => (
          <span data-testid={`depth-${row.original.name}`}>{row.depth}</span>
        ),
      },
    ];
    render(
      <DataTable data={data} columns={depthCols} getSubRows={(row) => row.subRows} defaultExpanded={true} />,
    );
    expect(screen.getByTestId("depth-U")).toHaveTextContent("0");
    expect(screen.getByTestId("depth-S")).toHaveTextContent("1");
    expect(screen.getByTestId("depth-L")).toHaveTextContent("2");
  });
});
