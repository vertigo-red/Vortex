import type { DuckDBConnection } from "@duckdb/node-api";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { log } from "../logging";
import type { ParsedQuery, ParsedQueryParam } from "./queryParser";
import QueryRegistry from "./QueryRegistry";

vi.mock("../logging", () => ({
  log: vi.fn(),
}));

const makeQuery = (
  type: ParsedQuery["type"],
  name: string,
  sql: string,
  params: ParsedQueryParam[] = [],
): ParsedQuery => ({
  name,
  type,
  sql,
  params,
  description: "",
  filePath: "query.sql",
});

const makeConnection = (): {
  connection: DuckDBConnection;
  run: Mock;
  getTableNames: Mock;
  runAndReadAll: Mock;
} => {
  const run = vi.fn();
  const getTableNames = vi.fn().mockReturnValue(new Set<string>());
  const runAndReadAll = vi.fn();
  const connection = { run, getTableNames, runAndReadAll } as unknown as DuckDBConnection;
  return { connection, run, getTableNames, runAndReadAll };
};

const makeResult = (rows: unknown) => ({
  getRowObjectsJson: () => rows,
});

describe("QueryRegistry", () => {
  it("reports no queries before initialization", () => {
    const { connection } = makeConnection();
    const registry = new QueryRegistry(connection);

    expect(registry.hasQueries).toBe(false);
    expect(registry.getQueryNames()).toEqual([]);
  });

  it("runs setup and view queries and registers select queries", async () => {
    const { connection, run } = makeConnection();
    run.mockResolvedValue(undefined);
    const registry = new QueryRegistry(connection);

    await registry.initialize([
      makeQuery("setup", "pivotTable", "CREATE TABLE pivot AS SELECT 1;"),
      makeQuery("view", "modsView", "CREATE VIEW mods_v AS SELECT * FROM pivot;"),
      makeQuery("select", "modList", "SELECT * FROM mods_v;"),
    ]);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(1, "CREATE TABLE pivot AS SELECT 1;");
    expect(run).toHaveBeenNthCalledWith(2, "CREATE VIEW mods_v AS SELECT * FROM pivot;");
    expect(registry.hasQueries).toBe(true);
    expect(registry.getQueryNames()).toEqual(["modList"]);
  });

  it("builds a reverse index from dirty tables to queries", async () => {
    const { connection, getTableNames } = makeConnection();
    getTableNames
      .mockReturnValueOnce(new Set(["mods", "profiles"]))
      .mockReturnValueOnce(new Set(["mods"]));
    const registry = new QueryRegistry(connection);

    await registry.initialize([
      makeQuery("select", "modList", "SELECT * FROM mods;"),
      makeQuery("select", "profileList", "SELECT * FROM profiles;"),
    ]);

    expect(getTableNames).toHaveBeenNthCalledWith(1, "SELECT * FROM mods;", true);
    expect(getTableNames).toHaveBeenNthCalledWith(2, "SELECT * FROM profiles;", true);
    expect(registry.getAffectedQueries(["mods"])).toEqual(["modList", "profileList"]);
    expect(registry.getAffectedQueries(["profiles"])).toEqual(["modList"]);
    expect(registry.getAffectedQueries(["mods", "profiles"])).toEqual(["modList", "profileList"]);
    expect(registry.getAffectedQueries(["otherTable"])).toEqual([]);
    expect(registry.getAffectedQueries([])).toEqual([]);
  });

  it("falls back to no dependencies when table extraction fails", async () => {
    const { connection, getTableNames } = makeConnection();
    getTableNames.mockImplementation(() => {
      throw new Error("duckdb refused");
    });
    const registry = new QueryRegistry(connection);

    await registry.initialize([makeQuery("select", "modList", "SELECT * FROM mods;")]);

    expect(registry.getAffectedQueries(["mods"])).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "warn",
      "query-registry: could not extract table names",
      expect.objectContaining({ name: "modList" }),
    );
  });

  it("executes a registered query and returns row objects", async () => {
    const { connection, runAndReadAll, getTableNames } = makeConnection();
    getTableNames.mockReturnValue(new Set(["mods"]));
    runAndReadAll.mockResolvedValue(makeResult([{ id: 1 }]));
    const registry = new QueryRegistry(connection);

    await registry.initialize([
      makeQuery("select", "modById", "SELECT * FROM mods WHERE id = $id;", [
        { name: "id", duckdbType: "BIGINT" },
      ]),
    ]);

    await expect(registry.executeQuery("modById", { id: 5 })).resolves.toEqual([{ id: 1 }]);
    expect(runAndReadAll).toHaveBeenCalledWith("SELECT * FROM mods WHERE id = $id;", {
      id: 5,
    });
  });

  it("filters parameters to the declared query parameters", async () => {
    const { connection, runAndReadAll, getTableNames } = makeConnection();
    getTableNames.mockReturnValue(new Set(["mods"]));
    runAndReadAll.mockResolvedValue(makeResult([]));
    const registry = new QueryRegistry(connection);

    await registry.initialize([
      makeQuery("select", "modById", "SELECT * FROM mods WHERE id = $id;", [
        { name: "id", duckdbType: "BIGINT" },
      ]),
    ]);

    await registry.executeQuery("modById", { id: 5, nothing: "ignored" });
    expect(runAndReadAll).toHaveBeenLastCalledWith("SELECT * FROM mods WHERE id = $id;", {
      id: 5,
    });

    await registry.executeQuery("modById", {});
    expect(runAndReadAll).toHaveBeenLastCalledWith("SELECT * FROM mods WHERE id = $id;", {});
  });

  it("does not pass values when the query declares no parameters", async () => {
    const { connection, runAndReadAll } = makeConnection();
    runAndReadAll.mockResolvedValue(makeResult([]));
    const registry = new QueryRegistry(connection);

    await registry.initialize([makeQuery("select", "modList", "SELECT * FROM mods;")]);

    await registry.executeQuery("modList", {});
    expect(runAndReadAll).toHaveBeenCalledWith("SELECT * FROM mods;", undefined);
  });

  it("throws for unknown queries", async () => {
    const { connection } = makeConnection();
    const registry = new QueryRegistry(connection);

    await expect(registry.executeQuery("missing")).rejects.toThrow("Unknown query: 'missing'");
  });
});
