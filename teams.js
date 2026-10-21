import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../config/arabic-teams.json");

function normalizeAlias(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, " ").trim();
}

// Aliases come from a config file, never from requests. They are escaped and
// turned into plain word-boundary searches, so no configured value can create
// a catastrophic-backtracking regular expression.
export function compileTeams(definition) {
  const teams = Array.isArray(definition?.teams) ? definition.teams : [];
  return teams
    .filter((team) => team && typeof team.name === "string" && team.name.trim())
    .map((team) => ({
      name: team.name.trim(),
      aliases: [...new Set((team.aliases || []).map(normalizeAlias).filter((alias) => alias.length >= 3 && alias.length <= 60))],
      providers: Array.isArray(team.providers) ? team.providers.map(String) : []
    }));
}

export function loadTeams(file = process.env.ARABIC_TEAMS_FILE || DEFAULT_FILE) {
  try {
    return compileTeams(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return compileTeams(JSON.parse(readFileSync(DEFAULT_FILE, "utf8")));
  }
}

let teams = loadTeams();

export function setTeams(definition) {
  teams = compileTeams(definition);
}

export function findArabicTeam(candidate = {}, list = teams) {
  const haystack = ` ${normalizeAlias(`${candidate.fileName || ""} ${candidate.release || ""} ${candidate.translator || ""} ${candidate.uploader || ""}`)} `;
  for (const team of list) {
    if (team.aliases.some((alias) => haystack.includes(` ${alias} `))) return team.name;
  }
  for (const team of list) {
    if (team.providers.includes(candidate.provider)) return team.name;
  }
  return "";
}
