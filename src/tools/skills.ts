import type { Skill, Tool } from "../types.js";

/**
 * The two built-in skill tools (skills spec §3.4, §3.5).
 *
 * Unlike every other built-in, these are registered unconditionally — a
 * profile that enumerates its Profile→Tool edges still gets them, because
 * skills are global to the session (§3.8).
 */
export const SKILL_TOOL_NAMES = ["list_skills", "read_skill"] as const;

/** The header the skill index carries in the system prompt (§3.3). */
export const SKILL_INDEX_HEADER = "## Available Skills";

/** An empty store, used wherever a caller supplies no skills. */
export const NO_SKILLS: ReadonlyMap<string, Skill> = new Map();

/**
 * The body of the skill index: one `{name}: {description}` line per skill, in
 * creation order (global first, then project). Empty string for an empty
 * store (skills spec §6, `list_skills` output).
 */
export function skillIndexLines(skills: ReadonlyMap<string, Skill>): string {
  return [...skills.values()]
    .map((skill) => `${skill.name}: ${skill.description}`)
    .join("\n");
}

/**
 * The skill-index section appended to a system prompt (skills spec §3.3):
 * the `## Available Skills` header followed by one `- {name}: {description}`
 * line per skill.
 *
 * Returns `""` for an empty store, so the section is omitted entirely rather
 * than emitting a bare header (AC-6).
 */
export function skillIndexSection(skills: ReadonlyMap<string, Skill>): string {
  if (skills.size === 0) return "";
  const lines = [...skills.values()].map(
    (skill) => `- ${skill.name}: ${skill.description}`,
  );
  return `${SKILL_INDEX_HEADER}\n${lines.join("\n")}`;
}

/**
 * Append the skill index to a resolved system prompt (skills spec §3.3).
 * A session with no skills gets its prompt back unchanged.
 */
export function appendSkillIndex(
  systemPrompt: string,
  skills: ReadonlyMap<string, Skill>,
): string {
  const section = skillIndexSection(skills);
  return section === "" ? systemPrompt : `${systemPrompt}\n\n${section}`;
}

/**
 * list_skills (skills spec §3.4).
 *
 * Returns the names and descriptions of every skill — the same content as the
 * system-prompt index, without its header — so a model that has lost the index
 * to compaction can still discover what is available.
 */
export function makeListSkillsTool(
  skills: ReadonlyMap<string, Skill> = NO_SKILLS,
): Tool {
  return {
    name: "list_skills",
    mutating: false,
    description:
      "List all available skills (name and description). Use read_skill to " +
      "load a skill's full content.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    async handler() {
      if (skills.size === 0) return "No skills available.";
      return skillIndexLines(skills);
    },
  };
}

/**
 * read_skill (skills spec §3.5).
 *
 * Returns one skill's full body, verbatim and untruncated (`noTruncate`).
 * An unknown or empty name is returned as an error *string*, not a throw:
 * tool errors are data the model self-corrects from (§8.1).
 */
export function makeReadSkillTool(
  skills: ReadonlyMap<string, Skill> = NO_SKILLS,
): Tool {
  return {
    name: "read_skill",
    mutating: false,
    noTruncate: true,
    description:
      "Load the full content of a skill by name. Use list_skills to see " +
      "available skills.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the skill to load.",
        },
      },
      required: ["name"],
    },
    async handler(args) {
      const name = String(args.name ?? "");
      if (name === "") return "Skill name must be non-empty.";
      const skill = skills.get(name);
      if (skill !== undefined) return skill.text;
      const known = [...skills.keys()];
      return known.length === 0
        ? `Unknown skill "${name}". No skills available.`
        : `Unknown skill "${name}". Available skills: ${known.join(", ")}.`;
    },
  };
}
