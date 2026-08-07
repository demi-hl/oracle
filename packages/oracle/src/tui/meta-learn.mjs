/**
 * Meta-learning: automatically create skills from successful agent workflows.
 */

import { createSkill, listSkills } from "./skills-loader.mjs";

const HISTORY = [];
const SKILL_THRESHOLD = 5;
const ERROR_RECOVERY_THRESHOLD = 1;

export function recordTurn(record) {
  HISTORY.push(record);
  if (HISTORY.length > 20) HISTORY.shift();
}

export function analyzeForSkill() {
  const recent = HISTORY.slice(-3);
  if (recent.length < 1) return null;

  const last = recent[recent.length - 1];

  if (last.toolCalls >= SKILL_THRESHOLD && last.errors === 0) {
    return {
      shouldCreate: true,
      suggestion: `You completed a ${last.toolCalls}-step workflow. Save it as a skill with skill_create.`,
    };
  }

  const recoveries = recent.filter((t) => t.errors > 0 && t.recovered);
  if (recoveries.length >= ERROR_RECOVERY_THRESHOLD && last.toolCalls >= 3) {
    return {
      shouldCreate: true,
      suggestion: "You recovered from errors. Save the corrected approach as a skill.",
    };
  }

  return { shouldCreate: false, suggestion: "No skill suggestions yet." };
}

export function generateSkillTemplate(taskDescription, toolNames) {
  const name = taskDescription
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 48);

  const toolsList = toolNames.map((t) => `  - ${t}`).join("\n");

  return [
    "---",
    `name: ${name}`,
    `description: ${taskDescription}`,
    "---",
    "",
    `# ${taskDescription}`,
    "",
    "## Trigger",
    "Use when: <describe when to use this skill>",
    "",
    "## Steps",
    "1. <first step>",
    "2. <second step>",
    "",
    "## Tools used",
    toolsList,
    "",
    "## Pitfalls",
    "- <common mistake>",
    "",
    "## Verification",
    "- <how to verify>",
  ].join("\n");
}

export const META_TOOLS = [
  {
    type: "function",
    function: {
      name: "meta_analyze",
      description: "Analyze recent interactions and suggest skills to create.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];