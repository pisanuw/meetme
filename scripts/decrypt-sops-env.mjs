import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const inputPath = process.argv[2] || ".env.enc";
const outputPath = process.argv[3] || ".env";

let decrypted;
try {
  decrypted = execFileSync("sops", ["--decrypt", inputPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  const detail = error?.stderr?.toString?.().trim() || error.message;
  console.error(`Failed to decrypt ${inputPath}: ${detail}`);
  process.exit(1);
}

let envContent = decrypted;
try {
  const parsed = JSON.parse(decrypted);
  if (parsed && typeof parsed.data === "string") {
    envContent = parsed.data;
  }
} catch {
  // Plain decrypted dotenv content is also supported.
}

if (!envContent.endsWith("\n")) envContent += "\n";
writeFileSync(outputPath, envContent, { mode: 0o600 });
console.log(`Wrote ${outputPath}`);
