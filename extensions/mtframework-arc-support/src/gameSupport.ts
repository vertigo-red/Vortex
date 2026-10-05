import { ArcGame } from "./types";

const gameSupport = {
  dragonsdogma: {
    arcId: "DD",
    arcVersion: 7,
  },
};

export function gameSupported(gameMode: string): boolean {
  return gameSupport[gameMode] !== undefined;
}

export function arcGameId(gameMode: string): ArcGame {
  return gameSupport[gameMode]?.arcId;
}

export function arcVersion(gameMode: string): number {
  return gameSupport[gameMode]?.arcVersion;
}
