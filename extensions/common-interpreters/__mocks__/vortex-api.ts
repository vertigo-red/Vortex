import { vi } from "vitest";

import { MissingInterpreter } from "../../../src/shared/src/types/errors";

export const log = vi.fn<(...args: unknown[]) => void>();
export const util = { MissingInterpreter };
