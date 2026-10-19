import { bot } from './bot';
import 'dotenv/config';
import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { readSyncSnapshot } from "./syncStatus";
const app = express();
const httpServer = createServer(app);

// ── Global crash handlers → report to Discord ──
process.on('uncaughtException', async (error) => {
  console.error('[CRASH] Uncaught Exception:', error);
  try {
    await bot.sendCrashReport('Bot se srušio (Uncaught Exception)', error);
  } catch {}
  // Don't exit — let the bot keep running if possible
});

process.on('unhandledRejection', async (reason) => {
  console.error('[CRASH] Unhandled Rejection:', reason);
  try {
    await bot.sendCrashReport('Unhandled Promise Rejection', reason);
  } catch {}
});

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

declare module "node:http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

declare module "express-session" {
  interface SessionData {
    user?: {
      id: string;
      username: string;
      avatar: string | null;
      roles: string[];
    };
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// Trust proxy for Railway (secure cookies behind reverse proxy)
// MUST be before session middleware so req.protocol returns 'https'
if (process.env.RAILWAY_ENVIRONMENT) {
  app.set('trust proxy', 1);
}

// Session middleware for Discord OAuth
app.use(session({
  secret: process.env.SESSION_SECRET || 'farmbuddy-secret-' + (process.env.DISCORD_TOKEN || '').slice(0, 10),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: !!process.env.RAILWAY_ENVIRONMENT,
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'lax',
  },
}));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

type EnvHealthReport = {
  ok: boolean;
  missingRequired: string[];
  missingOptional: string[];
  requiredPresent: string[];
};

function hasEnv(key: string): boolean {
  return String(process.env[key] || '').trim().length > 0;
}

function pickAnyEnv(keys: string[]): { ok: boolean; present: string[] } {
  const present = keys.filter(hasEnv);
  return { ok: present.length > 0, present };
}

function buildEnvHealthReport(): EnvHealthReport {
  const missingRequired: string[] = [];
  const requiredPresent: string[] = [];

  const requiredSingles = ['DISCORD_TOKEN', 'DATABASE_URL'];
  for (const key of requiredSingles) {
    if (hasEnv(key)) requiredPresent.push(key);
    else missingRequired.push(key);
  }

  const guildAny = pickAnyEnv(['DISCORD_GUILD_ID', 'GUILD_ID']);
  if (guildAny.ok) requiredPresent.push(...guildAny.present);
  else missingRequired.push('DISCORD_GUILD_ID|GUILD_ID');

  const clientAny = pickAnyEnv(['DISCORD_CLIENT_ID', 'CLIENT_ID']);
  if (clientAny.ok) requiredPresent.push(...clientAny.present);
  else missingRequired.push('DISCORD_CLIENT_ID|CLIENT_ID');

  const optional = ['LOG_CHANNEL_ID', 'PANEL_CHANNEL_ID', 'ADMIN_ROLE_ID', 'PORT'];
  const missingOptional = optional.filter(k => !hasEnv(k));

  return {
    ok: missingRequired.length === 0,
    missingRequired,
    missingOptional,
    requiredPresent,
  };
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

app.get('/api/health/env', (_req, res) => {
  const report = buildEnvHealthReport();
  const status = report.ok ? 200 : 503;
  return res.status(status).json({
    ok: report.ok,
    missingRequired: report.missingRequired,
    missingOptional: report.missingOptional,
    requiredPresent: report.requiredPresent,
    checkedAt: new Date().toISOString(),
  });
});

// Railway healthcheck endpoint
app.get('/api/health', (_req, res) => {
  try {
    const info = bot.getStatus();
    res.json({ ok: true, uptime: process.uptime(), botStatus: info.status });
  } catch {
    res.json({ ok: true, uptime: process.uptime(), botStatus: 'unknown' });
  }
});

(async () => {
  const envHealth = buildEnvHealthReport();
  if (envHealth.ok) {
    log(`ENV check OK | required present: ${envHealth.requiredPresent.join(', ')}`, 'startup');
  } else {
    log(`ENV check WARN | missing required: ${envHealth.missingRequired.join(', ')}`, 'startup');
  }

  // Restore last known sync snapshot (so status panel has data immediately after restart)
  await readSyncSnapshot();
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
    httpServer.listen(port, () => {
      log(`serving on port ${port}`);
    });
})();
