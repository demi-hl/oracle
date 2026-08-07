/**
 * Skills loader for the Oracle standalone agent.
 * Scans ~/.config/oracle/skills/*.md and injects relevant skills into context.
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = process.env.ORACLE_CONFIG_DIR || path.join(homedir(), ".config", "oracle");
const SKILLS_DIR = path.join(CONFIG_DIR, "skills");
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function skillPath(name) {
  const value = String(name ?? "").trim();
  if (!SKILL_NAME_RE.test(value)) throw new Error("invalid skill name");
  return path.join(SKILLS_DIR, `${value}.md`);
}

export function listSkills() {
  ensureDir(SKILLS_DIR);
  const skills = [];
  try {
    for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const filePath = path.join(SKILLS_DIR, entry.name);
      const content = fs.readFileSync(filePath, "utf8");
      const name = entry.name.replace(/\.md$/, "");
      let description = "";
      const fmMatch = content.match(/^description:\s*(.+)$/m);
      if (fmMatch) {
        description = fmMatch[1].trim();
      } else {
        const firstLine = content.split("\n")[0].replace(/^#+\s*/, "").trim();
        description = firstLine || name;
      }
      skills.push({ name, description, path: filePath, size: content.length });
    }
  } catch {
    // no skills dir yet
  }
  return skills;
}

export function loadSkill(name) {
  try {
    const filePath = skillPath(name);
    if (!fs.lstatSync(filePath).isFile()) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function getSkillsBlock(query) {
  const skills = listSkills();
  if (skills.length === 0) {
    return "## Skills\nNo skills installed. Use skill_create to save a successful workflow.\n";
  }
  let ranked = skills;
  if (query) {
    const q = query.toLowerCase();
    ranked = [...skills].sort((a, b) => {
      const aScore = (a.name.toLowerCase().includes(q) ? 2 : 0) +
        (a.description.toLowerCase().includes(q) ? 1 : 0);
      const bScore = (b.name.toLowerCase().includes(q) ? 2 : 0) +
        (b.description.toLowerCase().includes(q) ? 1 : 0);
      return bScore - aScore;
    });
  }
  const lines = ranked.map((s) => `- **${s.name}**: ${s.description}`);
  return ["## Skills", "Available (use skill_load <name>):", ...lines].join("\n");
}

export function createSkill(name, content) {
  ensureDir(SKILLS_DIR);
  const filePath = skillPath(name);
  if (fs.existsSync(filePath) && !fs.lstatSync(filePath).isFile()) {
    throw new Error("skill path must be a regular file");
  }
  fs.writeFileSync(filePath, content, { mode: 0o600 });
}

export const SKILL_TOOLS = [
  {
    type: "function",
    function: {
      name: "skill_load",
      description: "Load full content of a skill by name.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            pattern: "^[a-z0-9][a-z0-9_-]{0,63}$",
            description: "Skill name using lowercase letters, digits, hyphens, or underscores",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_create",
      description: "Save a new skill from a workflow or pattern.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            pattern: "^[a-z0-9][a-z0-9_-]{0,63}$",
            description: "Lowercase letters, digits, hyphens, or underscores",
          },
          content: { type: "string", description: "Full SKILL.md content" },
        },
        required: ["name", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_list",
      description: "List all installed skills.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];