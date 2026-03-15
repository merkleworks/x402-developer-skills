#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_DIR_NAME = "x402";
const TARGETS = [
  { name: "Claude Code", dir: path.join(os.homedir(), ".claude", "skills", SKILL_DIR_NAME) },
  { name: "Cursor",      dir: path.join(os.homedir(), ".cursor", "skills", SKILL_DIR_NAME) },
];

// Source paths — relative to this script (package root)
const REPO_ROOT = path.resolve(__dirname, "..");
const SKILLS_SRC = path.join(REPO_ROOT, "skills");
const SKILLS_MD_SRC = path.join(REPO_ROOT, "SKILLS.md");
const SKILLS_JSON_SRC = path.join(REPO_ROOT, "skills.json");

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
 * Recursively remove a directory tree.
 */
function rmDirSync(dir) {
  if (!fs.existsSync(dir)) return;
  // Node 14.14+ supports fs.rmSync
  if (fs.rmSync) {
    fs.rmSync(dir, { recursive: true, force: true });
  } else {
    // Fallback for older Node
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
 * Count files recursively.
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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function install() {
  if (!fs.existsSync(SKILLS_SRC)) {
    err("Skills source directory not found: " + SKILLS_SRC);
    err("Run this command from within the x402-developer-skills repository.");
    process.exit(1);
  }

  log("Installing x402 developer skills...\n");

  let installed = 0;

  for (const target of TARGETS) {
    try {
      copyDirSync(SKILLS_SRC, target.dir);

      // Copy SKILLS.md and skills.json from package root into target
      if (fs.existsSync(SKILLS_MD_SRC)) {
        fs.copyFileSync(SKILLS_MD_SRC, path.join(target.dir, "SKILLS.md"));
      }
      if (fs.existsSync(SKILLS_JSON_SRC)) {
        fs.copyFileSync(SKILLS_JSON_SRC, path.join(target.dir, "skills.json"));
      }

      const fileCount = countFiles(target.dir);
      log("  ✓ " + target.name + " → " + target.dir + " (" + fileCount + " files)");
      installed++;
    } catch (e) {
      err("  ✗ " + target.name + " → " + target.dir + ": " + e.message);
    }
  }

  log("");
  if (installed > 0) {
    log("Done. " + installed + " target(s) installed.");
    log("");
    log("Usage in Claude Code:");
    log('  @x402/protocol/explain-x402-protocol.md');
    log("");
    log("Usage in Cursor:");
    log("  Reference skills from ~/.cursor/skills/x402/");
  } else {
    err("No targets installed.");
    process.exit(1);
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

  // Remove then reinstall
  for (const target of TARGETS) {
    if (fs.existsSync(target.dir)) {
      rmDirSync(target.dir);
    }
  }

  install();
}

function showHelp() {
  log("x402-skills — AI developer skills for the x402 protocol\n");
  log("Usage:");
  log("  x402-skills install     Install skills to ~/.claude and ~/.cursor");
  log("  x402-skills uninstall   Remove installed skills");
  log("  x402-skills update      Reinstall with latest skills");
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
