import type { DuckDBConnection } from "@duckdb/node-api";
import { describe, it, expect, vi } from "vitest";

import type { ParsedQuery } from "./queryParser";
import QueryRegistry from "./QueryRegistry";

function createConnection() {
  return {
    run: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getTableNames: vi
      .fn<(sql: string, allowError?: boolean) => Set<string>>()
      .mockReturnValue(new Set()),
    runAndReadAll: vi.fn().mockResolvedValue({ getRowObjectsJson: () => [] }),
  };
}

function asConnection(connection: ReturnType<typeof createConnection>): DuckDBConnection {
  return connection as unknown as DuckDBConnection;
}

function query(
  name: string,
  type: ParsedQuery["type"],
  sql: string,
  params: ParsedQuery["params"] = [],
): ParsedQuery {
  return { name, type, sql, params, description: "", filePath: "q.sql" };
}

describe("QueryRegistry", () => {
  describe("hasQueries", () => {
    it("is false before any query is registered", () => {
      const registry = new QueryRegistry(asConnection(createConnection()));
      expect(registry.hasQueries).toBe(false);
    });
  });

  describe("initialize", () => {
    it("runs setup queries before view queries and registers select queries", async () => {
      const connection = createConnection();
      connection.getTableNames.mockReturnValue(new Set(["mods"]));
      const registry = new QueryRegistry(asConnection(connection));

      await registry.initialize([
        query("pivot", "setup", "CREATE TABLE mods_pivot AS SELECT 1"),
        query("list", "select", "SELECT * FROM mods"),
        query("viewA", "view", "CREATE VIEW mods_view AS SELECT * FROM mods"),
      ]);

      expect(connection.run).toHaveBeenCalledTimes(2);
      expect(connection.run).toHaveBeenNthCalledWith(1, "CREATE TABLE mods_pivot AS SELECT 1");
      expect(connection.run).toHaveBeenNthCalledWith(
        2,
        "CREATE VIEW mods_view AS SELECT * FROM mods",
      );
      expect(connection.getTableNames).toHaveBeenCalledWith("SELECT * FROM mods", true);
      expect(registry.hasQueries).toBe(true);
      expect(registry.getQueryNames()).toEqual(["list"]);
    });

    it("builds a reverse index from the extracted table names", async () => {
      const connection = createConnection();
      connection.getTableNames.mockImplementation((sql: string) =>
        sql.includes("load_order") ? new Set(["load_order"]) : new Set(["mods", "mods_pivot"]),
      );
      const registry = new QueryRegistry(asConnection(connection));

      await registry.initialize([
        query("listByGame", "select", "SELECT * FROM mods WHERE game_id = $gameId"),
        query("loadOrder", "select", "SELECT * FROM load_order"),
      ]);

      expect(registry.getAffectedQueries(["mods"])).toEqual(["listByGame"]);
      expect(registry.getAffectedQueries(["mods_pivot"])).toEqual(["listByGame"]);
      expect(registry.getAffectedQueries(["load_order"])).toEqual(["loadOrder"]);
      expect(registry.getAffectedQueries(["mods", "load_order"])).toEqual([
        "listByGame",
        "loadOrder",
      ]);
      expect(registry.getAffectedQueries(["unknown_table"])).toEqual([]);
    });

    it("falls back to an empty table list when getTableNames fails", async () => {
      const connection = createConnection();
      connection.getTableNames.mockImplementation(() => {
        throw new Error("parse failed");
      });
      const registry = new QueryRegistry(asConnection(connection));

      await registry.initialize([query("list", "select", "SELECT * FROM mods")]);

      expect(registry.getQueryNames()).toEqual(["list"]);
      expect(registry.getAffectedQueries(["mods"])).toEqual([]);
    });
  });

  describe("executeQuery", () => {
    it("throws for an unregistered query name", async () => {
      const registry = new QueryRegistry(asConnection(createConnection()));
      await expect(registry.executeQuery("nope")).rejects.toThrow("Unknown query: 'nope'");
    });

    it("binds only the declared parameters", async () => {
      const connection = createConnection();
      connection.runAndReadAll.mockResolvedValue({ getRowObjectsJson: () => [{ id: 1 }] });
      const registry = new QueryRegistry(asConnection(connection));
      await registry.initialize([
        query("byId", "select", "SELECT * FROM mods WHERE id = $modId", [
          { name: "modId", duckdbType: "BIGINT" },
        ]),
      ]);

      const result = await registry.executeQuery("byId", { modId: 5, extra: "ignored" });

      expect(connection.runAndReadAll).toHaveBeenCalledWith(
        "SELECT * FROM mods WHERE id = $modId",
        { modId: 5 },
      );
      expect(result).toEqual([{ id: 1 }]);
    });

    it("executes with no bindings for a query without parameters", async () => {
      const connection = createConnection();
      const registry = new QueryRegistry(asConnection(connection));
      await registry.initialize([query("all", "select", "SELECT * FROM mods")]);

      await registry.executeQuery("all", { unused: true });

      expect(connection.runAndReadAll).toHaveBeenCalledWith("SELECT * FROM mods", undefined);
    });
  });
});
