#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_DIR_NAME = "x402";
const MANIFEST_FILE = ".install-manifest.json";
const TARGETS = [
  { name: "Claude Code", dir: path.join(os.homedir(), ".claude", "skills", SKILL_DIR_NAME) },
  { name: "Cursor",      dir: path.join(os.homedir(), ".cursor", "skills", SKILL_DIR_NAME) },
];

// Source paths — relative to this script (package root)
const REPO_ROOT = path.resolve(__dirname, "..");
const SKILLS_SRC = path.join(REPO_ROOT, "skills");
const SKILLS_MD_SRC = path.join(REPO_ROOT, "SKILLS.md");
const SKILLS_JSON_SRC = path.join(REPO_ROOT, "skills.json");
const PKG_JSON = path.join(REPO_ROOT, "package.json");
const TEMPLATES_DIR = path.join(REPO_ROOT, "templates");
const CLIENT_TEMPLATE = path.join(TEMPLATES_DIR, "client-template");
const GATEWAY_TEMPLATE = path.join(TEMPLATES_DIR, "gateway-template");

// Files to skip when copying templates (compiled binaries, npm artifacts)
const INIT_SKIP_FILES = new Set(["x402-gateway", ".npmignore"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(msg + "\n");
}

function err(msg) {
  process.stderr.write("error: " + msg + "\n");
}

/**
 * Read package version from package.json.
 */
function getPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(PKG_JSON, "utf8")).version || "0.0.0";
  } catch (_) {
    return "0.0.0";
  }
}

/**
 * Read the install manifest from a target directory.
 * Returns null if the manifest is missing or invalid.
 */
function readManifest(targetDir) {
  const manifestPath = path.join(targetDir, MANIFEST_FILE);
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (_) {
    return null;
  }
}

/**
 * Write the install manifest after a successful install.
 */
function writeManifest(targetDir, skillsCount) {
  const manifest = {
    package: "@merkleworks/x402-skills",
    version: getPackageVersion(),
    installedAt: new Date().toISOString(),
    skillsCount: skillsCount,
  };
  fs.writeFileSync(
    path.join(targetDir, MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + "\n"
  );
}

/**
 * Recursively copy a directory tree.
 * Creates destination directories as needed.
 */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Copy the skills directory tree into the target, preserving the exact structure.
 * skills/<category>/<skill-name>/SKILL.md becomes
 * target/<category>/<skill-name>/SKILL.md
 * (e.g. ~/.claude/skills/x402/protocol/explain-x402-protocol/SKILL.md).
 *
 * The target directory is removed first to prevent stale files from
 * previous installations (e.g. flat .md files from older versions) from persisting.
 */
function copySkillsTreeSync(sourceSkillsDir, targetSkillsDir) {
  rmDirSync(targetSkillsDir);
  copyDirSync(sourceSkillsDir, targetSkillsDir);
}

/**
 * Recursively remove a directory tree.
 */
function rmDirSync(dir) {
  if (!fs.existsSync(dir)) return;
  if (fs.rmSync) {
    fs.rmSync(dir, { recursive: true, force: true });
  } else {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        rmDirSync(full);
      } else {
        fs.unlinkSync(full);
      }
    }
    fs.rmdirSync(dir);
  }
}

/**
 * Count SKILL.md files recursively (only counts actual skill modules).
 */
function countSkills(dir) {
  let count = 0;
  if (!fs.existsSync(dir)) return 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += countSkills(path.join(dir, entry.name));
    } else if (entry.name === "SKILL.md") {
      count++;
    }
  }
  return count;
}

/**
 * Count all files recursively.
 */
function countFiles(dir) {
  let count = 0;
  if (!fs.existsSync(dir)) return 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += countFiles(path.join(dir, entry.name));
    } else {
      count++;
    }
  }
  return count;
}

/**
 * Collect all skill paths (category/skill-name) from a directory.
 * Expects: dir/<category>/<skill-name>/SKILL.md
 */
function collectSkillPaths(dir) {
  const skills = [];
  if (!fs.existsSync(dir)) return skills;
  const categories = fs.readdirSync(dir, { withFileTypes: true });
  for (const cat of categories) {
    if (!cat.isDirectory()) continue;
    const catDir = path.join(dir, cat.name);
    const entries = fs.readdirSync(catDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      skills.push(cat.name + "/" + entry.name);
    }
  }
  return skills;
}

/**
 * Install skills into a single target directory.
 * Returns true if installed, false if skipped or failed.
 */
function installTarget(target, version, forceReinstall) {
  // Check if already installed at the correct version
  if (!forceReinstall) {
    const manifest = readManifest(target.dir);
    if (manifest && manifest.version === version) {
      log("  – " + target.name + ": already installed (v" + version + ")");
      return false;
    }
  }

  copySkillsTreeSync(SKILLS_SRC, target.dir);

  // Copy SKILLS.md and skills.json from package root into target
  if (fs.existsSync(SKILLS_MD_SRC)) {
    fs.copyFileSync(SKILLS_MD_SRC, path.join(target.dir, "SKILLS.md"));
  }
  if (fs.existsSync(SKILLS_JSON_SRC)) {
    fs.copyFileSync(SKILLS_JSON_SRC, path.join(target.dir, "skills.json"));
  }

  // Write install manifest
  const skillsCount = countSkills(target.dir);
  writeManifest(target.dir, skillsCount);

  const fileCount = countFiles(target.dir);
  log("  ✓ " + target.name + " → " + target.dir + " (" + fileCount + " files, " + skillsCount + " skills)");
  return true;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function install() {
  if (!fs.existsSync(SKILLS_SRC)) {
    err("Skills source directory not found: " + SKILLS_SRC);
    err("Run this command from within the x402-developer-skills repository.");
    process.exit(1);
  }

  const version = getPackageVersion();
  log("Installing x402 developer skills v" + version + "...\n");

  let installed = 0;

  for (const target of TARGETS) {
    try {
      if (installTarget(target, version, false)) {
        installed++;
      }
    } catch (e) {
      err("  ✗ " + target.name + " → " + target.dir + ": " + e.message);
    }
  }

  log("");
  if (installed > 0) {
    log("Done. " + installed + " target(s) installed.");
    log("");
    log("Usage in Claude Code:");
    log("  @x402/protocol/explain-x402-protocol  (skill module: category/skill-name/SKILL.md)");
    log("");
    log("Usage in Cursor:");
    log("  Reference skills from ~/.cursor/skills/x402/");
  } else {
    log("All targets already up to date.");
  }
}

function uninstall() {
  log("Uninstalling x402 developer skills...\n");

  let removed = 0;

  for (const target of TARGETS) {
    if (fs.existsSync(target.dir)) {
      try {
        rmDirSync(target.dir);

        log("  ✓ Removed " + target.dir);
        removed++;
      } catch (e) {
        err("  ✗ " + target.dir + ": " + e.message);
      }
    } else {
      log("  – " + target.name + ": not installed");
    }
  }

  log("");
  log("Done. " + removed + " target(s) removed.");
}

function update() {
  log("Updating x402 developer skills...\n");

  if (!fs.existsSync(SKILLS_SRC)) {
    err("Skills source directory not found: " + SKILLS_SRC);
    process.exit(1);
  }

  const version = getPackageVersion();
  let updated = 0;

  for (const target of TARGETS) {
    try {
      installTarget(target, version, true);
      updated++;
    } catch (e) {
      err("  ✗ " + target.name + " → " + target.dir + ": " + e.message);
    }
  }

  log("");
  log("Done. " + updated + " target(s) updated to v" + version + ".");
}

function doctor() {
  log("x402-skills doctor\n");

  const version = getPackageVersion();
  const sourceSkills = collectSkillPaths(SKILLS_SRC);
  let healthy = true;

  for (const target of TARGETS) {
    if (!fs.existsSync(target.dir)) {
      log("  ✗ " + target.name + ": not installed");
      healthy = false;
      continue;
    }

    // Check manifest
    const manifest = readManifest(target.dir);
    if (!manifest) {
      log("  ✗ " + target.name + ": missing install manifest");
      healthy = false;
    } else if (manifest.version !== version) {
      log("  ✗ " + target.name + ": version mismatch (installed v" + manifest.version + ", expected v" + version + ")");
      healthy = false;
    } else {
      log("  ✓ " + target.name + " installed (v" + manifest.version + ")");
    }

    // Check skill structure — every source skill must exist as category/skill-name/SKILL.md
    let structureOk = true;
    for (const skillPath of sourceSkills) {
      const skillFile = path.join(target.dir, skillPath, "SKILL.md");
      if (!fs.existsSync(skillFile)) {
        log("    ✗ Missing " + skillPath + "/SKILL.md");
        structureOk = false;
        healthy = false;
      }
    }

    // Check for stale flat .md files (sign of old corrupted install)
    const categories = fs.readdirSync(target.dir, { withFileTypes: true });
    for (const cat of categories) {
      if (!cat.isDirectory()) continue;
      const catDir = path.join(target.dir, cat.name);
      const entries = fs.readdirSync(catDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && entry.name.endsWith(".md")) {
          log("    ✗ Stale flat file: " + cat.name + "/" + entry.name);
          structureOk = false;
          healthy = false;
        }
      }
    }

    if (structureOk) {
      log("  ✓ " + target.name + " skill structure valid");
    }
  }

  // Auto-repair if unhealthy
  if (!healthy) {
    log("");
    log("Repairing installation...\n");

    if (!fs.existsSync(SKILLS_SRC)) {
      err("Cannot repair: skills source directory not found.");
      err("Run: npx @merkleworks/x402-skills update");
      process.exit(1);
    }

    for (const target of TARGETS) {
      try {
        installTarget(target, version, true);
      } catch (e) {
        err("  ✗ " + target.name + ": " + e.message);
      }
    }

    log("");
    log("Environment repaired.");
  } else {
    log("");
    log("Environment healthy.");
  }
}

function init() {
  var projectName = process.argv[3] || "x402-project";

  // Sanitise — only allow alphanumeric, hyphens, underscores, dots
  if (!/^[a-zA-Z0-9._-]+$/.test(projectName)) {
    err('Invalid project name: "' + projectName + '"');
    err("Use only letters, numbers, hyphens, underscores, and dots.");
    process.exit(1);
  }

  var projectDir = path.resolve(process.cwd(), projectName);

  if (fs.existsSync(projectDir)) {
    err("Directory already exists: " + projectDir);
    err("Choose a different name or remove the existing directory.");
    process.exit(1);
  }

  if (!fs.existsSync(CLIENT_TEMPLATE) || !fs.existsSync(GATEWAY_TEMPLATE)) {
    err("Templates not found. Ensure the package includes templates/client-template and templates/gateway-template.");
    process.exit(1);
  }

  log("Scaffolding x402 project: " + projectName + "\n");

  // Create project root
  fs.mkdirSync(projectDir, { recursive: true });

  // Copy client template
  copyDirFilteredSync(CLIENT_TEMPLATE, path.join(projectDir, "client"));
  // Rename .env.example → .env if present
  promoteEnvExample(path.join(projectDir, "client"));
  log("  ✓ client/          — x402 payment client (TypeScript)");

  // Copy gateway template
  copyDirFilteredSync(GATEWAY_TEMPLATE, path.join(projectDir, "gateway"));
  promoteEnvExample(path.join(projectDir, "gateway"));
  log("  ✓ gateway/         — x402 gateway server (Go)");

  // Create root docker-compose.yml that orchestrates both services
  var rootCompose = [
    'version: "3.8"',
    "",
    "services:",
    "  gateway:",
    "    build: ./gateway",
    "    ports:",
    '      - "8402:8402"',
    "    env_file:",
    "      - ./gateway/.env",
    "    depends_on:",
    "      - redis",
    "",
    "  redis:",
    "    image: redis:7-alpine",
    "    ports:",
    '      - "6379:6379"',
    "    volumes:",
    "      - redis-data:/data",
    "",
    "volumes:",
    "  redis-data:",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(projectDir, "docker-compose.yml"), rootCompose);
  log("  ✓ docker-compose.yml");

  // Create root .env with combined defaults
  var rootEnv = [
    "# x402 Project Configuration",
    "#",
    "# Gateway",
    "LISTEN_ADDR=:8402",
    "PAYEE_LOCKING_SCRIPT_HEX=76a914YOUR_PUBKEY_HASH_HERE88ac",
    "CHALLENGE_TTL=300",
    "BSV_NETWORK=mainnet",
    "#",
    "# Client",
    "TARGET_URL=http://localhost:8402/v1/resource",
    "DELEGATOR_URL=http://localhost:8402",
    "DELEGATOR_PATH=/delegate/x402",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(projectDir, ".env"), rootEnv);
  log("  ✓ .env");

  // Create .gitignore
  var gitignore = [
    "node_modules/",
    ".env",
    "*.log",
    ".DS_Store",
    "target/",
    "x402-gateway",
    "dist/",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(projectDir, ".gitignore"), gitignore);
  log("  ✓ .gitignore");

  // Create a minimal README
  var readme = [
    "# " + projectName,
    "",
    "An x402 payment-gated API project.",
    "",
    "## Quick start",
    "",
    "```bash",
    "# Start the gateway + Redis",
    "docker compose up -d",
    "",
    "# Run the client",
    "cd client && npm install && npm start",
    "```",
    "",
    "## Structure",
    "",
    "```",
    "client/     — x402 payment client (TypeScript)",
    "gateway/    — x402 gateway server (Go + Docker)",
    ".env        — root configuration",
    "```",
    "",
    "## Learn more",
    "",
    "Install x402 developer skills for Claude Code / Cursor:",
    "",
    "```bash",
    "npx @merkleworks/x402-skills install",
    "```",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(projectDir, "README.md"), readme);
  log("  ✓ README.md");

  log("");
  log("Done. Project created at: " + projectDir);
  log("");
  log("Next steps:");
  log("");
  log("  cd " + projectName);
  log("  docker compose up -d          # start gateway + Redis");
  log("  cd client && npm install       # install client deps");
  log("  npm start                      # run the client");
  log("");
  log("Edit .env to configure your payee locking script and endpoints.");
}

/**
 * Copy a directory tree, skipping files in INIT_SKIP_FILES.
 */
function copyDirFilteredSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  var entries = fs.readdirSync(src, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (INIT_SKIP_FILES.has(entry.name)) continue;
    var srcPath = path.join(src, entry.name);
    var destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirFilteredSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * If .env.example exists and .env does not, rename it.
 */
function promoteEnvExample(dir) {
  var example = path.join(dir, ".env.example");
  var env = path.join(dir, ".env");
  if (fs.existsSync(example) && !fs.existsSync(env)) {
    fs.renameSync(example, env);
  }
}

function showHelp() {
  log("x402-skills — AI developer skills for the x402 protocol\n");
  log("Usage:");
  log("  x402-skills install     Install skills to ~/.claude and ~/.cursor");
  log("  x402-skills uninstall   Remove installed skills");
  log("  x402-skills update      Force reinstall with latest skills");
  log("  x402-skills doctor      Diagnose and repair environment");
  log("  x402-skills init [name] Scaffold a new x402 project");
  log("  x402-skills help        Show this help message");
  log("");
  log("Install targets:");
  for (const target of TARGETS) {
    log("  " + target.name + ": " + target.dir);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2];

switch (command) {
  case "install":
    install();
    break;
  case "uninstall":
  case "remove":
    uninstall();
    break;
  case "update":
  case "upgrade":
    update();
    break;
  case "doctor":
  case "check":
    doctor();
    break;
  case "init":
  case "new":
  case "create":
    init();
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    showHelp();
    break;
  default:
    err('Unknown command: "' + command + '"');
    log("");
    showHelp();
    process.exit(1);
}
