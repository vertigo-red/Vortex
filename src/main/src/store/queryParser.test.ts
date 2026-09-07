import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import { parseAllQueries } from "./queryParser";

let tempDirs: string[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-query-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function writeQuery(dir: string, relative: string, content: string): string {
  const filePath = path.join(dir, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("parseAllQueries", () => {
  describe("single query parsing", () => {
    it("parses a select query with name, description and sql", () => {
      const dir = makeDir();
      writeQuery(
        dir,
        "mods.sql",
        `-- @type select
-- @name modList
-- @description Lists all mods
SELECT * FROM mods`,
      );

      const queries = parseAllQueries(dir);

      expect(queries).toHaveLength(1);
      expect(queries[0]?.name).toBe("modList");
      expect(queries[0]?.type).toBe("select");
      expect(queries[0]?.description).toBe("Lists all mods");
      expect(queries[0]?.sql).toBe("SELECT * FROM mods");
      expect(queries[0]?.params).toEqual([]);
      expect(queries[0]?.alias).toBeUndefined();
    });

    it("parses parameters", () => {
      const dir = makeDir();
      writeQuery(
        dir,
        "mods.sql",
        `-- @type select
-- @name modById
-- @param modId BIGINT
SELECT * FROM mods WHERE mod_id = $modId`,
      );

      const queries = parseAllQueries(dir);

      expect(queries[0]?.params).toEqual([{ name: "modId", duckdbType: "BIGINT" }]);
    });

    it("records an alias when declared", () => {
      const dir = makeDir();
      writeQuery(
        dir,
        "mods.sql",
        `-- @type select
-- @name modList
-- @alias mod_list
SELECT * FROM mods`,
      );

      expect(parseAllQueries(dir)[0]?.alias).toBe("mod_list");
    });

    it("keeps interior blank lines in the sql body", () => {
      const dir = makeDir();
      writeQuery(
        dir,
        "mods.sql",
        `-- @type select
-- @name modList
SELECT 1

UNION ALL

SELECT 2`,
      );

      expect(parseAllQueries(dir)[0]?.sql).toBe("SELECT 1\n\nUNION ALL\n\nSELECT 2");
    });

    it("trims leading and trailing whitespace from the sql body", () => {
      const dir = makeDir();
      writeQuery(
        dir,
        "mods.sql",
        `-- @type select
-- @name modList

SELECT 1

`,
      );

      expect(parseAllQueries(dir)[0]?.sql).toBe("SELECT 1");
    });
  });

  describe("multi-query files", () => {
    it("parses every query in one file", () => {
      const dir = makeDir();
      writeQuery(
        dir,
        "mods.sql",
        `-- @type select
-- @name first
SELECT 1

-- @name second
SELECT 2`,
      );

      const queries = parseAllQueries(dir);
      expect(queries.map((q) => q.name)).toEqual(["first", "second"]);
    });

    it("uses file-level setup type for every query in its scope", () => {
      const dir = makeDir();
      writeQuery(
        dir,
        "pivots.sql",
        `-- @type setup
-- @name pivot_a
CREATE TABLE a

-- @name pivot_b
CREATE TABLE b`,
      );

      const queries = parseAllQueries(dir);
      expect(queries.map((q) => q.type)).toEqual(["setup", "setup"]);
    });
  });

  describe("invalid input", () => {
    it("throws when queries exist without a @type declaration", () => {
      const dir = makeDir();
      writeQuery(dir, "bad.sql", `-- @name orphan\nSELECT 1`);

      expect(() => parseAllQueries(dir)).toThrow("Missing @type declaration");
    });

    it("throws on duplicate query names across files", () => {
      const dir = makeDir();
      writeQuery(dir, "a.sql", `-- @type select\n-- @name dup\nSELECT 1`);
      writeQuery(dir, "b.sql", `-- @type select\n-- @name dup\nSELECT 2`);

      expect(() => parseAllQueries(dir)).toThrow(/Duplicate query name 'dup'/);
    });

    it("returns an empty list for a directory without @name queries", () => {
      const dir = makeDir();
      writeQuery(dir, "a.sql", `-- @type select\nSELECT 1`);

      expect(parseAllQueries(dir)).toEqual([]);
    });
  });

  describe("directory traversal", () => {
    it("discovers .sql files recursively", () => {
      const dir = makeDir();
      writeQuery(
        dir,
        "nested/deep/mods.sql",
        `-- @type view\n-- @name viewA\nCREATE VIEW a AS SELECT 1`,
      );

      const queries = parseAllQueries(dir);
      expect(queries).toHaveLength(1);
      expect(queries[0]?.name).toBe("viewA");
    });

    it("ignores non-sql files", () => {
      const dir = makeDir();
      writeQuery(dir, "notes.txt", "hello");
      writeQuery(dir, "real.sql", `-- @type select\n-- @name only\nSELECT 1`);

      expect(parseAllQueries(dir)).toHaveLength(1);
    });

    it("returns an empty list for an empty directory", () => {
      const dir = makeDir();
      expect(parseAllQueries(dir)).toEqual([]);
    });

    it("returns an empty list for a missing directory", () => {
      expect(parseAllQueries(path.join(makeDir(), "does-not-exist"))).toEqual([]);
    });
  });
});
