const fs = require("fs");

function checkScript(source, label) {
  try {
    new Function(source);
  } catch (error) {
    error.message = `${label}: ${error.message}`;
    throw error;
  }
}

for (const file of ["docs/index.html", "docs/index-secure.html"]) {
  const html = fs.readFileSync(file, "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!scripts.length) throw new Error(`${file}: no inline script found`);
  scripts.forEach((script, index) => checkScript(script, `${file} script ${index + 1}`));
  console.log(`${file}: ok`);
}

checkScript(fs.readFileSync("docs/supabase.js", "utf8"), "docs/supabase.js");
console.log("docs/supabase.js: ok");
