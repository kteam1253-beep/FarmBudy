import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");

  // On Railway (or API-only deployments) we sometimes intentionally skip building the client.
  // In that case, don't crash the whole process — just serve the API.
  if (!fs.existsSync(distPath)) {
    const msg = `Static client not found at ${distPath} (skipping static hosting).`;
    // eslint-disable-next-line no-console
    console.log(msg);

    // Optional: basic root route so the service isn't "blank" in the browser.
    app.get("/", (_req, res) => {
      res.status(200).send("FarmBuddy API is running. Client build not present.");
    });

    return;
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
